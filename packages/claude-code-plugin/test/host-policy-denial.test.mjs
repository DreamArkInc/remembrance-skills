import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HOST_POLICY_ALERT_TEXT } from "../scripts/hook-core.mjs";
import { handleHookInput } from "../scripts/query-on-prompt.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";
import { handleHostPolicyDenial } from "../scripts/report-host-policy-denial.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-claude-denial-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("Claude Code host-policy denial observer", () => {
  it("emits one bounded user-visible alert for a classified pre-transport denial", () => {
    const record = vi.fn(() => ({ id: "observation-1" }));
    const mark = vi.fn(() => true);
    const result = handleHostPolicyDenial(
      {
        hook_event_name: "PermissionDenied",
        session_id: "session-a",
        tool_name: "mcp__remembrance__propose_private_skill",
        permission_decision_reason:
          "Blocked by workspace privacy and data-export policy.",
        tool_input: { proprietary: "must not be returned" },
      },
      {
        env: {},
        recordHostPolicyDenial: record,
        markHostPolicyAlertDelivered: mark,
      },
    );

    expect(result).toMatchObject({
      systemMessage: HOST_POLICY_ALERT_TEXT,
      hookSpecificOutput: {
        hookEventName: "PermissionDenied",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must not be returned");
    expect(mark).toHaveBeenCalledWith(
      "claude_code",
      "session-a",
      "observation-1",
      {},
    );
  });

  it("stays silent for ordinary API authorization failures", () => {
    expect(
      handleHostPolicyDenial(
        {
          hook_event_name: "PostToolUseFailure",
          session_id: "session-b",
          tool_name: "mcp__remembrance__submit_feedback",
          error: "HTTP 403 Forbidden",
        },
        { env: {}, recordHostPolicyDenial: () => null },
      ),
    ).toBeNull();
  });

  it("does not emit a duplicate warning for a previously delivered denial", () => {
    const mark = vi.fn();
    expect(
      handleHostPolicyDenial(
        { session_id: "same-session" },
        {
          env: {},
          recordHostPolicyDenial: () => ({
            id: "same-observation",
            alerted_at: new Date().toISOString(),
          }),
          markHostPolicyAlertDelivered: mark,
        },
      ),
    ).toBeNull();
    expect(mark).not.toHaveBeenCalled();
  });

  // The adapters end to end: the host's denial of one exact private submit
  // parks that draft (whatever its wording), the next prompt lists only the
  // other one, and a submit the host lets through brings the denied draft
  // back once, as a user decision, never as its own line.
  it("parks the exact draft a permission denial names until the host allows the lane again", async () => {
    const env = {
      XDG_STATE_HOME: join(tempRoot, "state"),
      XDG_CONFIG_HOME: join(tempRoot, "config"),
      REMEMBRANCE_USAGE_DIR: join(tempRoot, "usage"),
      REMEMBRANCE_PLUGIN_ALERT_DIR: join(tempRoot, "alerts"),
      REMEMBRANCE_PLUGIN_HEALTH_DIR: join(tempRoot, "health"),
      REMEMBRANCE_API_KEY: "rk_synthetic_claude_denial",
      REMEMBRANCE_API_URL: "http://127.0.0.1:9",
      REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
      REMEMBRANCE_CLIENT_UPDATE_CHECK: "0",
    };
    const outbox = join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
    const lifecycle = join(
      env.XDG_STATE_HOME,
      "remembrance",
      "private-learning-lifecycle",
    );
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    chmodSync(outbox, 0o700);
    const [denied, kept] = ["pld_claude_denied", "pld_claude_kept"];
    const envelopes = [denied, kept].map((draftId) => {
      const path = join(outbox, `${draftId}.lesson.json`);
      writeFileSync(
        path,
        JSON.stringify({
          version: "private-lesson-outbox-envelope-v1",
          draft_id: draftId,
          state: "ready",
          hold_telemetry_status: "not_required",
          next_retry_at: null,
          updated_at: "2026-10-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      return [path, readFileSync(path)];
    });
    const name = (tool) => `mcp__plugin_remembrance_remembrance__${tool}`;
    const text = (body) => ({
      content: [{ type: "text", text: JSON.stringify(body) }],
    });
    const options = { env, recordHealth: vi.fn() };
    for (const draftId of [denied, kept]) {
      await handlePostToolUse(
        {
          session_id: "claude-denial",
          hook_event_name: "PostToolUse",
          tool_name: name("capture_learning"),
          tool_input: {},
          tool_response: text({
            capture_route: "private_lesson",
            draft_id: draftId,
            state: "ready",
            next_action: {
              tool: "submit_private_lesson_candidate",
              arguments: { draft_id: draftId },
            },
          }),
        },
        options,
      );
    }
    const prompt = async () =>
      (
        await handleHookInput(
          {
            hook_event_name: "UserPromptSubmit",
            session_id: "claude-denial",
            prompt: "rename a local variable",
          },
          {
            ...options,
            fetchImpl: vi.fn(async () => {
              throw new Error("offline");
            }),
          },
        )
      )?.hookSpecificOutput?.additionalContext ?? "";
    const line = (draftId) =>
      `call submit_private_lesson_candidate with draft_id ${draftId}`;
    const parked = () => {
      const path = join(lifecycle, `${denied}.parked.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    };

    handleHostPolicyDenial(
      {
        hook_event_name: "PermissionDenied",
        session_id: "claude-denial",
        tool_name: name("submit_private_lesson_candidate"),
        tool_input: { draft_id: denied },
        permission_decision_reason: "Denied for this session.",
      },
      { env },
    );
    expect(parked()).toMatchObject({
      reason: "host_policy_denied",
      notices: 0,
    });
    const listed = await prompt();
    expect(listed).toContain(line(kept));
    expect(listed).not.toContain(line(denied));

    await handlePostToolUse(
      {
        session_id: "claude-denial",
        hook_event_name: "PostToolUse",
        tool_name: name("submit_private_lesson_candidate"),
        tool_input: { draft_id: kept },
        tool_response: text({
          draft_id: kept,
          state: "submitted",
          accepted_private_candidate: true,
        }),
      },
      options,
    );
    expect(parked().lane_allowed_at).toEqual(expect.any(String));
    const notice = await prompt();
    const orphan = createHash("sha256")
      .update("private_draft_notice:awaiting_user", "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(notice).toContain(`action_id ${orphan}`);
    expect(notice).not.toContain(line(denied));
    // The delivered notice counts as shown: the draft waits for its next
    // interval, and the next prompt does not repeat it.
    expect(parked()).toMatchObject({ notices: 1 });
    expect(existsSync(join(lifecycle, "orphan-notice.json"))).toBe(true);
    expect(await prompt()).not.toContain(orphan);
    for (const [path, bytes] of envelopes) expect(readFileSync(path)).toEqual(bytes);
  });
});
