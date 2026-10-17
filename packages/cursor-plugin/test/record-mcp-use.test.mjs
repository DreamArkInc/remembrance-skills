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
import { describe, expect, it, vi } from "vitest";
import { handleStop } from "../scripts/contribute-on-stop.mjs";
import {
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  recordQueryFeedbackObligation,
} from "../scripts/hook-core.mjs";
import { cursorSessionId, handleMcpUse } from "../scripts/record-mcp-use.mjs";

describe("Cursor afterMCPExecution hook", () => {
  it("records registry consumption for Remembrance query/fetch tools", async () => {
    const recordRegistryUse = vi.fn(() => 3);
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const recordHealth = vi.fn();
    const observeCompletionTool = vi.fn(() => ({
      opened: [{ kind: "query_feedback" }],
      closed: [],
      pending: [{ kind: "query_feedback" }],
      handled_count: 0,
    }));
    const result = await handleMcpUse(
      {
        tool_name: "query_skills",
        conversation_id: "conv_123",
        result: {
          body: {
            skills: [{ slug: "release-review" }],
            resources: [],
            query_feedback: {
              available: true,
              query_id: "rq_cursor_observed",
            },
          },
        },
      },
      {
        env: {},
        recordRegistryUse,
        recordDirectiveFollowThrough,
        recordHealth,
        observeCompletionTool,
      },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "consumption",
      tool: "query_skills",
      count: 3,
    });
    expect(recordRegistryUse).toHaveBeenCalledWith("conv_123", {});
    expect(recordDirectiveFollowThrough).toHaveBeenCalledWith(
      "conv_123",
      "query_skills",
      {
        body: {
          query_feedback: {
            available: true,
            query_id: "rq_cursor_observed",
          },
          resources: [],
          skills: [{ slug: "release-review" }],
        },
      },
      expect.objectContaining({ env: {} }),
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cursor",
        component: "tool_observer",
      }),
      {},
    );
    expect(observeCompletionTool).toHaveBeenCalledWith(
      "conv_123",
      "query_skills",
      {},
      expect.objectContaining({
        body: expect.objectContaining({
          query_feedback: {
            available: true,
            query_id: "rq_cursor_observed",
          },
        }),
      }),
      {},
    );
  });

  it("normalizes MCP namespace-style tool names", async () => {
    const recordRegistryUse = vi.fn(() => 1);
    const result = await handleMcpUse(
      {
        tool_name: "mcp__remembrance__query_skills",
        conversation_id: "conv_123",
        result: {
          body: {
            skills: [{ slug: "release-review" }],
            resources: [],
          },
        },
      },
      { env: {}, recordRegistryUse },
    );

    expect(result.recorded).toBe(true);
    expect(result.tool).toBe("query_skills");
    expect(recordRegistryUse).toHaveBeenCalledWith("conv_123", {});
  });

  it("normalizes collapsed Remembrance MCP tool names defensively", async () => {
    const recordRegistryUse = vi.fn(() => 1);
    const result = await handleMcpUse(
      {
        tool_name: "mcp__remembrancequery_skills",
        conversation_id: "conv_collapsed",
        result: {
          body: {
            skills: [{ slug: "release-review" }],
            resources: [],
          },
        },
      },
      { env: {}, recordRegistryUse },
    );

    expect(result).toMatchObject({
      recorded: true,
      kind: "consumption",
      tool: "query_skills",
    });
    expect(recordRegistryUse).toHaveBeenCalledWith("conv_collapsed", {});
  });

  it("keeps an empty query observable without counting registry consumption", async () => {
    const recordRegistryUse = vi.fn();
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const result = await handleMcpUse(
      {
        tool_name: "query_skills",
        conversation_id: "conv_empty",
        result: { body: { query_id: "rq_empty", skills: [], resources: [] } },
      },
      { env: {}, recordRegistryUse, recordDirectiveFollowThrough },
    );

    expect(result).toEqual({
      recorded: false,
      kind: "empty_query",
      tool: "query_skills",
      count: 0,
    });
    expect(recordRegistryUse).not.toHaveBeenCalled();
    expect(recordDirectiveFollowThrough).toHaveBeenCalledOnce();
  });

  it("records a high match when Cursor exposes the MCP result payload", async () => {
    const recordHighMatch = vi.fn();
    await handleMcpUse(
      {
        tool_name: "query_skills",
        conversation_id: "conv_high",
        result: {
          body: {
            query_id: "rq_cursor",
            skills: [
              {
                slug: "web-ui-ux-qa",
                result_id: "qres_cursor",
                match_tier: "high",
                match_reason: "Strong task coverage",
                estimated_tokens: 420,
                verified_uses: 12,
                risk_level: "low",
              },
            ],
          },
        },
      },
      {
        env: {},
        recordRegistryUse: () => 1,
        recordHighMatch,
      },
    );

    expect(recordHighMatch).toHaveBeenCalledWith(
      "conv_high",
      expect.objectContaining({
        query_id: "rq_cursor",
        result_id: "qres_cursor",
        slug: "web-ui-ux-qa",
      }),
      {},
    );
  });

  it("clears the current high match after the correlated detail opens", async () => {
    const clearHighMatch = vi.fn(() => true);
    await handleMcpUse(
      {
        tool_name: "mcp__remembrance__get_skill",
        conversation_id: "conv_high",
        arguments: {
          slug: "web-ui-ux-qa",
          query_id: "rq_cursor",
          result_id: "qres_cursor",
        },
      },
      {
        env: {},
        recordRegistryUse: () => 2,
        clearHighMatch,
      },
    );

    expect(clearHighMatch).toHaveBeenCalledWith(
      "conv_high",
      "remembrance.get_skill",
      {
        slug: "web-ui-ux-qa",
        query_id: "rq_cursor",
        result_id: "qres_cursor",
      },
      {},
    );
  });

  it("records a successful explicit invocation and its selected value episode", async () => {
    const recordRegistryUse = vi.fn(() => 2);
    const recordDirectSelection = vi.fn();
    const recordValueEpisode = vi.fn();
    const clearExplicit = vi.fn(() => true);
    const result = await handleMcpUse(
      {
        tool_name: "invoke_skill",
        conversation_id: "conv_direct",
        result: {
          selection_mode: "explicit",
          query_id: "rinv_cursor",
          result_id: "qres_cursor_direct",
          skill: {
            slug: "web-ui-ux-qa",
            version: 5,
            version_id: "skv_cursor",
            skill_md: "# Instructions",
            task_outcome_eligible: true,
          },
          feedback: { available: true },
          task_outcome: {
            available: true,
            eligible_result_ids: ["qres_cursor_direct"],
          },
        },
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
      kind: "direct_selection",
      tool: "invoke_skill",
      count: 2,
    });
    expect(recordDirectSelection).toHaveBeenCalledWith(
      "conv_direct",
      expect.objectContaining({ slug: "web-ui-ux-qa", use_count: 2 }),
      {},
    );
    expect(recordValueEpisode).toHaveBeenCalledWith(
      "conv_direct",
      expect.objectContaining({
        interaction_kind: "direct_selection",
        selected_result_ids: ["qres_cursor_direct"],
      }),
      {},
    );
    expect(clearExplicit).toHaveBeenCalledWith(
      "conv_direct",
      "web-ui-ux-qa",
      {},
    );
  });

  it("does not count failed invocations or catalog browsing as skill use", async () => {
    const recordRegistryUse = vi.fn();
    expect(
      await handleMcpUse(
        {
          tool_name: "invoke_skill",
          conversation_id: "conv_failed",
          result: { isError: true },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({
      recorded: false,
      kind: "failed",
      tool: "invoke_skill",
    });
    expect(
      await handleMcpUse(
        {
          tool_name: "list_skills",
          conversation_id: "conv_list",
          result: { skills: [{ slug: "listed-only" }] },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({
      recorded: false,
      kind: "ignored",
      tool: "list_skills",
    });
    expect(
      await handleMcpUse(
        {
          tool_name: "resources/read",
          conversation_id: "conv_resource",
          result: {
            contents: [
              {
                uri: "remembrance://skills/listed-only",
                text: '{"selection_handle":{"slug":"listed-only"}}',
              },
            ],
          },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({
      recorded: false,
      kind: "ignored",
      tool: "read",
    });
    expect(recordRegistryUse).not.toHaveBeenCalled();
  });

  it("records a classified host-policy failure without treating ordinary 403s as policy", async () => {
    const recordHostPolicyDenial = vi.fn(() => ({ id: "policy-1" }));
    await expect(
      handleMcpUse(
        {
          tool_name: "mcp__remembrance__propose_private_skill",
          conversation_id: "conv_policy",
          isError: true,
          error: "Blocked by workspace data-export policy.",
        },
        { env: {}, recordHostPolicyDenial },
      ),
    ).resolves.toMatchObject({ kind: "failed" });
    expect(recordHostPolicyDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cursor",
        sessionId: "conv_policy",
        eventType: "afterMCPExecution",
        toolName: "propose_private_skill",
      }),
      {},
    );

    const ignored = vi.fn(() => null);
    await handleMcpUse(
      {
        tool_name: "mcp__remembrance__submit_feedback",
        conversation_id: "conv_403",
        isError: true,
        error: "HTTP 403 Forbidden",
      },
      { env: {}, recordHostPolicyDenial: ignored },
    );
    expect(ignored).toHaveBeenCalledOnce();
  });

  it("marks the current use as handled after an explicit contribution", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [],
      pending: [],
      handled_count: 2,
    }));
    const result = await handleMcpUse(
      { tool_name: "propose_private_skill", session_id: "session_1" },
      {
        env: {},
        observeCompletionTool,
      },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "contribution",
      tool: "propose_private_skill",
      count: 2,
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it.each([
    "submit_private_lesson_candidate",
    "retry_private_lesson_candidate",
  ])("marks %s as a completed contribution", async (toolName) => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [{ kind: "private_lesson" }],
      pending: [],
      handled_count: 1,
    }));
    const result = await handleMcpUse(
      {
        tool_name: toolName,
        session_id: "session_private_lesson",
        arguments: { draft_id: "pld_cursorlesson" },
      },
      {
        env: {},
        observeCompletionTool,
      },
    );

    expect(result).toMatchObject({
      recorded: true,
      kind: "contribution",
      tool: toolName,
      count: 1,
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("keeps completion pending for a feedback-generated remembrance", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [{ kind: "remembrance_followup" }],
      closed: [],
      pending: [{ kind: "remembrance_followup" }],
      handled_count: 0,
    }));
    const result = await handleMcpUse(
      {
        tool_name: "submit_feedback",
        session_id: "session_feedback_followup",
        result: {
          next_step: {
            submit_remembrance_payload: {
              type: "skill_feedback",
              lesson: "Reusable correction.",
            },
          },
        },
      },
      {
        env: {},
        observeCompletionTool,
      },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "remembrance_followup_pending",
      tool: "submit_feedback",
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("observes preference compatibility feedback without closing post-use contribution", async () => {
    const writePromptedCount = vi.fn();
    const result = await handleMcpUse(
      {
        tool_name: "submit_preference_compatibility_feedback",
        session_id: "session_preference_feedback",
      },
      {
        env: {},
        readRegistryUseCount: () => 1,
        readTaskEligibilityCount: () => 1,
        writePromptedCount,
      },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "preference_compatibility_feedback",
      tool: "submit_preference_compatibility_feedback",
    });
    expect(writePromptedCount).not.toHaveBeenCalled();
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const writePromptedCount = vi.fn();
    const result = await handleMcpUse(
      {
        tool_name: "submit_feedback",
        session_id: "session_rejected_feedback",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                status: 503,
                body: { error: "Feedback unavailable" },
              }),
            },
          ],
        },
      },
      {
        env: {},
        readRegistryUseCount: () => 1,
        readTaskEligibilityCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result).toEqual({
      recorded: false,
      kind: "failed",
      tool: "submit_feedback",
    });
    expect(writePromptedCount).not.toHaveBeenCalled();
  });

  it("closes a declined pending action in this conversation's ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-cursor-decline-"));
    const env = {
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
    };
    try {
      recordQueryFeedbackObligation(
        "conv_decline",
        { available: true, query_id: "rq_cursor_decline" },
        env,
      );
      const actionId = /\n {2}action_id ([a-f0-9]{16})\n/u.exec(
        pendingCompletionRecoveryInstruction("conv_decline", env),
      )?.[1];
      expect(actionId).toMatch(/^[a-f0-9]{16}$/u);
      const args = { action_id: actionId, reason: "duplicate" };
      const result = await handleMcpUse(
        {
          tool_name: "decline_pending_action",
          conversation_id: "conv_decline",
          tool_input: JSON.stringify(args),
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "declined",
                  ...args,
                  submitted: false,
                  local_only: true,
                }),
              },
            ],
          },
        },
        { env, recordHealth: vi.fn() },
      );
      expect(result).toMatchObject({
        recorded: true,
        kind: "contribution",
        tool: "decline_pending_action",
      });
      expect(readCompletionObligations("conv_decline", env)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats explicit query-fit feedback as a completed contribution", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [{ kind: "query_feedback" }],
      pending: [],
      handled_count: 1,
    }));
    const result = await handleMcpUse(
      { tool_name: "submit_query_feedback", session_id: "session_query_fit" },
      {
        env: {},
        observeCompletionTool,
      },
    );

    expect(result).toMatchObject({
      recorded: true,
      kind: "contribution",
      tool: "submit_query_feedback",
      count: 1,
    });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("marks an eligibility-only task handled after proactive contribution", async () => {
    const observeCompletionTool = vi.fn(() => ({
      opened: [],
      closed: [],
      pending: [],
      handled_count: 1,
    }));
    const result = await handleMcpUse(
      { tool_name: "submit_remembrance", session_id: "session-eligible" },
      {
        env: {},
        observeCompletionTool,
      },
    );

    expect(result).toMatchObject({ recorded: true, count: 1 });
    expect(observeCompletionTool).toHaveBeenCalledOnce();
  });

  it("ignores unrelated MCP tools", async () => {
    const recordRegistryUse = vi.fn();
    expect(
      await handleMcpUse(
        { tool_name: "filesystem.read_file", conversation_id: "conv_123" },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({
      recorded: false,
      kind: "ignored",
      tool: "read_file",
    });
    expect(recordRegistryUse).not.toHaveBeenCalled();
  });

  it("falls back to Cursor environment values when the hook input has no session id", () => {
    expect(
      cursorSessionId(
        {},
        { CURSOR_TRANSCRIPT_PATH: "/tmp/cursor-transcript.json" },
      ),
    ).toBe("/tmp/cursor-transcript.json");
  });

  // Cursor lists pending actions only in a visible-mode Stop: after the host
  // denies one exact private submit, that draft is parked and the stop asks
  // only for the other one.
  it("parks the denied private draft and a visible-mode stop lists only the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-cursor-denial-"));
    try {
      const env = {
        XDG_STATE_HOME: join(root, "state"),
        XDG_CONFIG_HOME: join(root, "config"),
        REMEMBRANCE_USAGE_DIR: join(root, "usage"),
        REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
        REMEMBRANCE_API_KEY: "rk_synthetic_cursor_denial",
        REMEMBRANCE_API_URL: "http://127.0.0.1:9",
        REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
        REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      };
      const outbox = join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
      mkdirSync(outbox, { recursive: true, mode: 0o700 });
      chmodSync(outbox, 0o700);
      const [denied, kept] = ["pld_cursor_denied", "pld_cursor_kept"];
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
      const options = { env, recordHealth: vi.fn() };
      for (const draftId of [denied, kept]) {
        await handleMcpUse(
          {
            tool_name: "capture_learning",
            conversation_id: "conv-denial",
            tool_input: "{}",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    capture_route: "private_lesson",
                    draft_id: draftId,
                    state: "ready",
                    next_action: {
                      tool: "submit_private_lesson_candidate",
                      arguments: { draft_id: draftId },
                    },
                  }),
                },
              ],
            },
          },
          options,
        );
      }
      expect(
        await handleMcpUse(
          {
            tool_name: "submit_private_lesson_candidate",
            conversation_id: "conv-denial",
            tool_input: JSON.stringify({ draft_id: denied }),
            error:
              "Blocked by workspace data-export policy before reaching Remembrance.",
          },
          options,
        ),
      ).toMatchObject({ kind: "failed" });
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
      const stopOptions = {
        env,
        readUseCount: () => 1,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
        readHighMatch: () => null,
        readDirectSelections: () => [],
        writePromptedCount: vi.fn(),
      };
      // The host-policy alert is delivered first, then the pending actions.
      expect(
        handleStop({ conversation_id: "conv-denial", loop_count: 0 }, stopOptions),
      ).toMatchObject({ allow: false, why: "host_policy_denial" });
      const stop = handleStop(
        { conversation_id: "conv-denial", loop_count: 0 },
        stopOptions,
      );
      expect(stop).toMatchObject({ allow: false, why: "prompt_pending_obligations" });
      const line = (draftId) =>
        `call submit_private_lesson_candidate with draft_id ${draftId}`;
      expect(stop.output.followup_message).toContain(line(kept));
      expect(stop.output.followup_message).not.toContain(line(denied));
      for (const [path, bytes] of envelopes)
        expect(readFileSync(path)).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
