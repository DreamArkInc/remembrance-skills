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
import { pendingCompletionRecoveryInstruction } from "../scripts/hook-core.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-codex-posttool-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("native post-tool detail tracking", () => {
  it("clears the current high match after the correlated detail opens", async () => {
    const clear = vi.fn(() => true);
    const result = await handlePostToolUse(
      {
        turn_id: "turn_1",
        tool_name: "mcp__remembrance__get_skill",
        tool_input: {
          slug: "web-ui-ux-qa",
          query_id: "rq_1",
          result_id: "qres_1",
        },
      },
      { env: {}, clearHighMatchSurfaceIfOpened: clear },
    );

    expect(result).toEqual({
      cleared: true,
      why: "matched_detail_open",
    });
    expect(clear).toHaveBeenCalledWith(
      "turn_1",
      "mcp__remembrance__get_skill",
      {
        slug: "web-ui-ux-qa",
        query_id: "rq_1",
        result_id: "qres_1",
      },
      {},
    );
  });

  it("does not clear a marker after a failed detail call", async () => {
    const clear = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "session_1",
          tool_name: "remembrance.get_resource",
          tool_input: '{"slug":"docs"}',
          tool_response: { isError: true },
        },
        { env: {}, clearHighMatchSurfaceIfOpened: clear },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("records a successful query as directive follow-through", async () => {
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const result = await handlePostToolUse(
      {
        turn_id: "turn_directive",
        tool_name: "mcp__remembrancequery_skills",
        tool_response: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ body: { query_id: "rq_directive" } }),
            },
          ],
        },
      },
      { env: {}, recordDirectiveFollowThrough },
    );

    expect(result).toEqual({
      cleared: false,
      directive_followed: true,
      why: "directive_followed",
    });
    expect(recordDirectiveFollowThrough).toHaveBeenCalledWith(
      "turn_directive",
      "mcp__remembrancequery_skills",
      expect.objectContaining({ content: expect.any(Array) }),
      expect.objectContaining({ env: {} }),
    );
  });

  it("records only a successful direct invocation as use and selects its outcome", async () => {
    const recordRegistryUse = vi.fn(() => 4);
    const recordDirectSelection = vi.fn();
    const recordValueEpisode = vi.fn();
    const clearExplicit = vi.fn(() => true);
    const response = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            body: {
              invocation_id: "rinv_hook",
              query_id: "rinv_hook",
              result_id: "qres_hook",
              selection_mode: "explicit",
              skill: {
                slug: "mongodb-aggregation",
                version: 3,
                version_id: "skv_hook",
                source: "org_overlay",
                skill_md: "# Instructions",
                task_outcome_eligible: true,
              },
              feedback: { available: true },
              task_outcome: {
                available: true,
                eligible_result_ids: ["qres_hook"],
              },
            },
          }),
        },
      ],
    };

    const result = await handlePostToolUse(
      {
        turn_id: "turn_invoke",
        tool_name: "mcp__remembrance__invoke_skill",
        tool_response: response,
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
      count: 4,
    });
    expect(recordDirectSelection).toHaveBeenCalledWith(
      "turn_invoke",
      expect.objectContaining({
        slug: "mongodb-aggregation",
        version_id: "skv_hook",
        use_count: 4,
      }),
      {},
    );
    expect(recordValueEpisode).toHaveBeenCalledWith(
      "turn_invoke",
      expect.objectContaining({
        interaction_kind: "direct_selection",
        selected_result_ids: ["qres_hook"],
      }),
      {},
    );
    expect(clearExplicit).toHaveBeenCalledWith(
      "turn_invoke",
      "mongodb-aggregation",
      {},
    );
  });

  it("does not count catalog handles or malformed invocation responses as use", async () => {
    const recordRegistryUse = vi.fn();
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_list",
          tool_name: "mcp__remembrance__list_skills",
          tool_response: { skills: [{ slug: "catalog-only" }] },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toMatchObject({ why: "not_current_match" });
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_resource",
          tool_name: "resources/read",
          tool_response: {
            contents: [
              {
                uri: "remembrance://skills/catalog-only",
                text: '{"selection_handle":{"slug":"catalog-only"}}',
              },
            ],
          },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toMatchObject({ why: "not_current_match" });
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_bad_invoke",
          tool_name: "mcp__remembrance__invoke_skill",
          tool_response: {
            selection_mode: "explicit",
            skill: { slug: "missing-body" },
          },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({
      recorded: false,
      cleared: false,
      why: "invocation_not_loaded",
    });
    expect(recordRegistryUse).not.toHaveBeenCalled();
  });

  it("marks successful feedback as handled so completion does not repeat it", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [{ kind: "post_use_feedback" }],
      pending: [],
      handled_count: 2,
    }));
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_feedback",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: { accepted: true },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "contribution_handled",
      count: 2,
    });
    expect(observeCompletionTool).toHaveBeenCalledWith(
      "turn_feedback",
      "mcp__remembrance__submit_feedback",
      {},
      { accepted: true },
      {},
    );
  });

  it("observes preference compatibility feedback without closing post-use contribution", async () => {
    const observeCompletionTool = vi.fn();
    const clearHighMatchSurfaceIfOpened = vi.fn();
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_preference_feedback",
          tool_name:
            "mcp__remembrance__submit_preference_compatibility_feedback",
          tool_response: { accepted: true },
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

  it("marks an explicit private-skill proposal as a handled contribution", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [],
      pending: [],
      handled_count: 1,
    }));
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_private_skill",
          tool_name: "mcp__remembrance__propose_private_skill",
          tool_response: { ok: true, status: 201 },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toMatchObject({
      recorded: true,
      why: "contribution_handled",
    });
  });

  it.each([
    "submit_private_lesson_candidate",
    "retry_private_lesson_candidate",
  ])("marks a successful %s as handled", async (toolName) => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [{ kind: "private_lesson" }],
      pending: [],
      handled_count: 1,
    }));
    expect(
      await handlePostToolUse(
        {
          turn_id: `turn_${toolName}`,
          tool_name: `mcp__remembrance__${toolName}`,
          tool_input: { draft_id: "pld_adapterlesson" },
          tool_response: { accepted_private_candidate: true },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toMatchObject({
      recorded: true,
      why: "contribution_handled",
      count: 1,
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const observeCompletionTool = vi.fn();
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_rejected_feedback",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  status: 403,
                  body: { error: "Missing submission:create scope" },
                }),
              },
            ],
          },
        },
        { env: {}, observeCompletionTool },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(observeCompletionTool).not.toHaveBeenCalled();
  });

  it("keeps completion pending when feedback requests a remembrance follow-up", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [{ kind: "remembrance_followup" }],
      closed: [{ kind: "post_use_feedback" }],
      pending: [{ kind: "remembrance_followup" }],
      handled_count: 0,
    }));
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_feedback_followup",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            body: {
              next_step: {
                submit_remembrance_payload: {
                  type: "skill_feedback",
                  lesson: "Reusable correction.",
                },
              },
            },
          },
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

  // A failed private submit parks its own draft only when the classifier
  // recognizes a host denial; an API refusal parks nothing.
  it("parks the draft of a failed private submit the host denied, and only that draft", async () => {
    const env = {
      XDG_STATE_HOME: join(tempRoot, "state"),
      XDG_CONFIG_HOME: join(tempRoot, "config"),
      REMEMBRANCE_USAGE_DIR: join(tempRoot, "usage"),
      REMEMBRANCE_PLUGIN_ALERT_DIR: join(tempRoot, "alerts"),
      REMEMBRANCE_API_KEY: "rk_synthetic_codex_denial",
      REMEMBRANCE_API_URL: "http://127.0.0.1:9",
      REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
    };
    const outbox = join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    chmodSync(outbox, 0o700);
    const ids = ["pld_codex_denied", "pld_codex_refused", "pld_codex_kept"];
    const envelopes = ids.map((draftId) => {
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
    const observe = (tool, toolInput, response) =>
      handlePostToolUse(
        {
          session_id: "codex-denial",
          hook_event_name: "PostToolUse",
          tool_name: `mcp__remembrance__${tool}`,
          tool_input: toolInput,
          tool_response: response,
        },
        { env, recordHealth: () => {} },
      );
    for (const draftId of ids) {
      await observe(
        "capture_learning",
        {},
        {
          capture_route: "private_lesson",
          draft_id: draftId,
          state: "ready",
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: draftId },
          },
        },
      );
    }
    const fail = (draftId, error) =>
      handlePostToolUse(
        {
          session_id: "codex-denial",
          hook_event_name: "PostToolUse",
          tool_name: "mcp__remembrance__submit_private_lesson_candidate",
          tool_input: { draft_id: draftId },
          error,
        },
        { env, recordHealth: () => {} },
      );
    expect(await fail(ids[0], "Tool execution denied by host policy.")).toEqual({
      cleared: false,
      why: "tool_failed",
    });
    await fail(ids[1], "Request failed: HTTP 403 Forbidden.");
    const parked = (draftId) => {
      const path = join(
        env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        `${draftId}.parked.json`,
      );
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    };
    expect(parked(ids[0])).toMatchObject({ reason: "host_policy_denied" });
    expect(parked(ids[1])).toBeNull();
    expect(parked(ids[2])).toBeNull();
    const pending = pendingCompletionRecoveryInstruction("codex-denial", env);
    const line = (draftId) =>
      `call submit_private_lesson_candidate with draft_id ${draftId}`;
    expect(pending).not.toContain(line(ids[0]));
    expect(pending).toContain(line(ids[1]));
    expect(pending).toContain(line(ids[2]));
    for (const [path, bytes] of envelopes) expect(readFileSync(path)).toEqual(bytes);
  });
});
