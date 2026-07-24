import { describe, expect, it, vi } from "vitest";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

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
        tool_name: "mcp__remembrance__query_skills",
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
      "mcp__remembrance__query_skills",
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
    const markCurrentEngagementHandled = vi.fn(() => 2);
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_feedback",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: { accepted: true },
        },
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({
      recorded: true,
      cleared: false,
      why: "contribution_handled",
      count: 2,
    });
    expect(markCurrentEngagementHandled).toHaveBeenCalledWith(
      "turn_feedback",
      {},
    );
  });

  it("marks an explicit private-skill proposal as a handled contribution", async () => {
    const markCurrentEngagementHandled = vi.fn(() => 1);
    expect(
      await handlePostToolUse(
        {
          turn_id: "turn_private_skill",
          tool_name: "mcp__remembrance__propose_private_skill",
          tool_response: { ok: true, status: 201 },
        },
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toMatchObject({
      recorded: true,
      why: "contribution_handled",
    });
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const markCurrentEngagementHandled = vi.fn();
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
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });

  it("keeps completion pending when feedback requests a remembrance follow-up", async () => {
    const markCurrentEngagementHandled = vi.fn();
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
