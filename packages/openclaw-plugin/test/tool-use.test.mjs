import { describe, expect, it, vi } from "vitest";
import { handleAfterToolCall } from "../src/index.mjs";

describe("OpenClaw after_tool_call hook", () => {
  it("clears a correlated high match after a successful detail open", async () => {
    const clear = vi.fn(() => true);
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
      { env: {}, clearHighMatchSurfaceIfOpened: clear },
    );

    expect(result).toEqual({
      cleared: true,
      why: "matched_detail_open",
    });
    expect(clear).toHaveBeenCalledWith(
      "run_openclaw",
      "mcp__remembrance__get_resource",
      {
        slug: "vercel-docs",
        query_id: "rq_openclaw",
        result_id: "qres_openclaw",
      },
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

  it("records a successful query against the active directive", async () => {
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const result = await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__query_skills",
        result: { body: { query_id: "rq_openclaw_directive" } },
        context: { runId: "run_directive" },
      },
      { env: {}, recordDirectiveFollowThrough },
    );

    expect(result).toEqual({
      cleared: false,
      directive_followed: true,
      why: "directive_followed",
    });
    expect(recordDirectiveFollowThrough).toHaveBeenCalledWith(
      "run_directive",
      "mcp__remembrance__query_skills",
      { body: { query_id: "rq_openclaw_directive" } },
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
    const markCurrentEngagementHandled = vi.fn(() => 2);
    expect(
      await handleAfterToolCall(
        {
          toolName: "submit_feedback",
          result: { accepted: true },
          context: { runId: "run_feedback" },
        },
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "contribution_handled",
      count: 2,
    });
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const markCurrentEngagementHandled = vi.fn();
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
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });

  it("keeps completion pending for a feedback-generated remembrance", async () => {
    const markCurrentEngagementHandled = vi.fn();
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
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({
      recorded: false,
      cleared: false,
      why: "remembrance_followup_pending",
    });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });
});
