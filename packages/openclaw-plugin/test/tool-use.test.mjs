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
import { pendingCompletionRecoveryInstruction } from "../src/hook-core.mjs";
import { handleAfterToolCall } from "../src/index.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-openclaw-tool-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("OpenClaw after_tool_call hook", () => {
  it("clears a correlated high match after a successful detail open", async () => {
    const clear = vi.fn(() => true);
    const recordHealth = vi.fn();
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__get_resource",
        params: {
          slug: "vercel-docs",
          query_id: "rq_openclaw",
          result_id: "qres_openclaw",
        },
        context: { runId: "run_openclaw", sessionId: "session_openclaw" },
      },
      { env: {}, clearHighMatchSurfaceIfOpened: clear, recordHealth },
    );

    expect(result).toEqual({
      cleared: true,
      why: "matched_detail_open",
    });
    // The high match is the session's: a later run of it may open the match.
    expect(clear).toHaveBeenCalledWith(
      "session_openclaw",
      "mcp__remembrance__get_resource",
      {
        slug: "vercel-docs",
        query_id: "rq_openclaw",
        result_id: "qres_openclaw",
      },
      {},
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "openclaw",
        component: "tool_observer",
      }),
      {},
    );
  });

  it("does not clear state for a failed detail call", async () => {
    const clear = vi.fn();
    expect(
      await handleAfterToolCall(
        {
          toolName: "get_skill",
          params: { slug: "web-ui-ux-qa" },
          error: "network failure",
        },
        { env: {}, clearHighMatchSurfaceIfOpened: clear },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("records a host-policy denial without persisting or returning raw failure details", async () => {
    const recordHostPolicyDenial = vi.fn(() => ({ id: "policy-1" }));
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__propose_private_skill",
        error: "Blocked by organization data-export policy: private payload",
        context: { runId: "run_policy" },
      },
      { env: {}, recordHostPolicyDenial },
    );
    expect(result).toEqual({
      cleared: false,
      why: "tool_failed",
      host_policy_denial: true,
    });
    expect(JSON.stringify(result)).not.toContain("private payload");
    expect(recordHostPolicyDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "openclaw",
        sessionId: "run_policy",
        eventType: "after_tool_call",
      }),
      {},
    );
  });

  it("records a successful query against the active directive", async () => {
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const observeCompletionTool = vi.fn(() => ({
      opened: [{ kind: "query_feedback" }],
      closed: [],
      pending: [{ kind: "query_feedback" }],
      handled_count: 0,
    }));
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__query_skills",
        result: {
          body: {
            query_id: "rq_openclaw_directive",
            query_feedback: {
              available: true,
              query_id: "rq_openclaw_directive",
            },
          },
        },
        context: { runId: "run_directive" },
      },
      { env: {}, recordDirectiveFollowThrough, observeCompletionTool },
    );

    expect(result).toEqual({
      cleared: false,
      directive_followed: true,
      why: "directive_followed",
    });
    expect(recordDirectiveFollowThrough).toHaveBeenCalledWith(
      "run_directive",
      "mcp__remembrance__query_skills",
      {
        body: {
          query_id: "rq_openclaw_directive",
          query_feedback: {
            available: true,
            query_id: "rq_openclaw_directive",
          },
        },
      },
      expect.objectContaining({ env: {} }),
    );
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("observes collapsed Remembrance MCP tool names defensively", async () => {
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrancequery_skills",
        result: { body: { query_id: "rq_openclaw_collapsed" } },
        context: { runId: "run_collapsed" },
      },
      { env: {}, recordDirectiveFollowThrough },
    );

    expect(result).toMatchObject({
      directive_followed: true,
      why: "directive_followed",
    });
    expect(recordDirectiveFollowThrough).toHaveBeenCalledWith(
      "run_collapsed",
      "mcp__remembrancequery_skills",
      { body: { query_id: "rq_openclaw_collapsed" } },
      expect.objectContaining({ env: {} }),
    );
  });

  it("records a successful explicit invocation and not a catalog handle", async () => {
    const recordRegistryUse = vi.fn(() => 3);
    const recordDirectSelection = vi.fn();
    const recordValueEpisode = vi.fn();
    const clearExplicit = vi.fn(() => true);
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__invoke_skill",
        result: {
          selection_mode: "explicit",
          query_id: "rinv_openclaw",
          result_id: "qres_openclaw_direct",
          skill: {
            slug: "mongodb-aggregation",
            version: 6,
            version_id: "skv_openclaw",
            skill_md: "# Instructions",
            task_outcome_eligible: true,
          },
          feedback: { available: true },
          task_outcome: {
            available: true,
            eligible_result_ids: ["qres_openclaw_direct"],
          },
        },
        context: { runId: "run_openclaw_direct" },
      },
      {
        env: {},
        recordRegistryUse,
        recordDirectSelection,
        recordValueEpisode,
        clearHighMatchSurfaceForExplicitSelection: clearExplicit,
      },
    );
    expect(result).toEqual({
      recorded: true,
      cleared: true,
      why: "direct_skill_invoked",
      count: 3,
    });
    expect(recordDirectSelection).toHaveBeenCalledWith(
      "run_openclaw_direct",
      expect.objectContaining({ slug: "mongodb-aggregation", use_count: 3 }),
      {},
    );
    expect(recordValueEpisode).toHaveBeenCalledWith(
      "run_openclaw_direct",
      expect.objectContaining({
        interaction_kind: "direct_selection",
        selected_result_ids: ["qres_openclaw_direct"],
      }),
      {},
    );
    expect(
      await handleAfterToolCall(
        {
          toolName: "list_skills",
          result: { skills: [{ slug: "catalog-only" }] },
          context: { runId: "run_openclaw_list" },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toMatchObject({ why: "not_current_match" });
    expect(
      await handleAfterToolCall(
        {
          toolName: "resources/read",
          result: {
            contents: [
              {
                uri: "remembrance://skills/catalog-only",
                text: '{"selection_handle":{"slug":"catalog-only"}}',
              },
            ],
          },
          context: { runId: "run_openclaw_resource" },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toMatchObject({ why: "not_current_match" });
    expect(recordRegistryUse).toHaveBeenCalledTimes(1);
  });

  it("marks successful contribution tools as handled", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [],
      pending: [],
      handled_count: 2,
    }));
    expect(
      await handleAfterToolCall(
        {
          toolName: "propose_private_skill",
          result: { accepted: true },
          context: { runId: "run_feedback" },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "contribution_handled",
      count: 2,
    });
  });

  it.each([
    "submit_private_lesson_candidate",
    "retry_private_lesson_candidate",
  ])("marks successful %s calls as handled", async (toolName) => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [{ kind: "private_lesson" }],
      pending: [],
      handled_count: 1,
    }));
    expect(
      await handleAfterToolCall(
        {
          toolName,
          params: { draft_id: "pld_openclawlesson" },
          result: { accepted_private_candidate: true },
          context: { runId: "run_private_lesson" },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toMatchObject({
      recorded: true,
      why: "contribution_handled",
      count: 1,
    });
  });

  it("observes preference compatibility feedback without closing post-use contribution", async () => {
    const observeCompletionTool = vi.fn();
    const clearHighMatchSurfaceIfOpened = vi.fn();
    expect(
      await handleAfterToolCall(
        {
          toolName: "submit_preference_compatibility_feedback",
          result: { accepted: true },
          context: { runId: "run_preference_feedback" },
        },
        {
          env: {},
          observeCompletionTool,
          clearHighMatchSurfaceIfOpened,
        },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "preference_compatibility_feedback_recorded",
    });
    expect(observeCompletionTool).not.toHaveBeenCalled();
    expect(clearHighMatchSurfaceIfOpened).not.toHaveBeenCalled();
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const observeCompletionTool = vi.fn();
    expect(
      await handleAfterToolCall(
        {
          toolName: "submit_feedback",
          result: {
            ok: false,
            status: 422,
            body: { error: "Feedback rejected" },
          },
          context: { runId: "run_rejected_feedback" },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(observeCompletionTool).not.toHaveBeenCalled();
  });

  it("keeps completion pending for a feedback-generated remembrance", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [{ kind: "remembrance_followup" }],
      closed: [],
      pending: [{ kind: "remembrance_followup" }],
      handled_count: 0,
    }));
    expect(
      await handleAfterToolCall(
        {
          toolName: "submit_feedback",
          result: {
            next_step: {
              submit_remembrance_payload: {
                type: "skill_feedback",
                lesson: "Reusable correction.",
              },
            },
          },
          context: { runId: "run_feedback_followup" },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "remembrance_followup_pending",
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  // The failed call's own params name the draft the host denied.
  it("parks the exact private draft whose submit the host denied", async () => {
    const env = {
      XDG_STATE_HOME: join(tempRoot, "state"),
      XDG_CONFIG_HOME: join(tempRoot, "config"),
      REMEMBRANCE_USAGE_DIR: join(tempRoot, "usage"),
      REMEMBRANCE_PLUGIN_ALERT_DIR: join(tempRoot, "alerts"),
      REMEMBRANCE_API_KEY: "rk_synthetic_openclaw_denial",
      REMEMBRANCE_API_URL: "http://127.0.0.1:9",
      REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
    };
    const outbox = join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    chmodSync(outbox, 0o700);
    const [denied, kept] = ["pld_openclaw_denied", "pld_openclaw_kept"];
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
    const context = { sessionId: "openclaw-denial" };
    const options = { env, recordHealth: vi.fn() };
    for (const draftId of [denied, kept]) {
      await handleAfterToolCall(
        {
          toolName: "capture_learning",
          params: {},
          result: {
            capture_route: "private_lesson",
            draft_id: draftId,
            state: "ready",
            next_action: {
              tool: "submit_private_lesson_candidate",
              arguments: { draft_id: draftId },
            },
          },
          context,
        },
        options,
      );
    }
    expect(
      await handleAfterToolCall(
        {
          toolName: "submit_private_lesson_candidate",
          params: { draft_id: denied },
          error:
            "Blocked by workspace data-export policy before reaching Remembrance.",
          context,
        },
        options,
      ),
    ).toMatchObject({ cleared: false, why: "tool_failed" });
    const parked = (draftId) => {
      const path = join(
        env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        `${draftId}.parked.json`,
      );
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    };
    expect(parked(denied)).toMatchObject({ reason: "host_policy_denied" });
    expect(parked(kept)).toBeNull();
    const pending = pendingCompletionRecoveryInstruction("openclaw-denial", env);
    const line = (draftId) =>
      `call submit_private_lesson_candidate with draft_id ${draftId}`;
    expect(pending).toContain(line(kept));
    expect(pending).not.toContain(line(denied));
    for (const [path, bytes] of envelopes)
      expect(readFileSync(path)).toEqual(bytes);
  });
});
