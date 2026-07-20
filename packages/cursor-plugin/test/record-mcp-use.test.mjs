import { describe, expect, it, vi } from "vitest";
import { cursorSessionId, handleMcpUse } from "../scripts/record-mcp-use.mjs";

describe("Cursor afterMCPExecution hook", () => {
  it("records registry consumption for Remembrance query/fetch tools", async () => {
    const recordRegistryUse = vi.fn(() => 3);
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    const result = await handleMcpUse(
      { tool_name: "query_skills", conversation_id: "conv_123" },
      { env: {}, recordRegistryUse, recordDirectiveFollowThrough },
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
      null,
      expect.objectContaining({ env: {} }),
    );
  });

  it("normalizes MCP namespace-style tool names", async () => {
    const recordRegistryUse = vi.fn(() => 1);
    const result = await handleMcpUse(
      {
        tool_name: "mcp__remembrance__query_skills",
        conversation_id: "conv_123",
      },
      { env: {}, recordRegistryUse },
    );

    expect(result.recorded).toBe(true);
    expect(result.tool).toBe("query_skills");
    expect(recordRegistryUse).toHaveBeenCalledWith("conv_123", {});
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

  it("marks the current use as handled after an explicit contribution", async () => {
    const writePromptedCount = vi.fn();
    const result = await handleMcpUse(
      { tool_name: "submit_remembrance", session_id: "session_1" },
      {
        env: {},
        readRegistryUseCount: () => 2,
        readTaskEligibilityCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "contribution",
      tool: "submit_remembrance",
      count: 2,
    });
    expect(writePromptedCount).toHaveBeenCalledWith("session_1", 2, {});
  });

  it("keeps completion pending for a feedback-generated remembrance", async () => {
    const writePromptedCount = vi.fn();
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
        readRegistryUseCount: () => 1,
        readTaskEligibilityCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result).toEqual({
      recorded: false,
      kind: "remembrance_followup_pending",
      tool: "submit_feedback",
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

  it("treats explicit query-fit feedback as a completed contribution", async () => {
    const writePromptedCount = vi.fn();
    const result = await handleMcpUse(
      { tool_name: "submit_query_feedback", session_id: "session_query_fit" },
      {
        env: {},
        readRegistryUseCount: () => 1,
        readTaskEligibilityCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result).toMatchObject({
      recorded: true,
      kind: "contribution",
      tool: "submit_query_feedback",
      count: 1,
    });
    expect(writePromptedCount).toHaveBeenCalledWith("session_query_fit", 1, {});
  });

  it("marks an eligibility-only task handled after proactive contribution", async () => {
    const writePromptedCount = vi.fn();
    const result = await handleMcpUse(
      { tool_name: "submit_remembrance", session_id: "session-eligible" },
      {
        env: {},
        readRegistryUseCount: () => 0,
        readTaskEligibilityCount: () => 1,
        writePromptedCount,
      },
    );

    expect(result).toMatchObject({ recorded: true, count: 1 });
    expect(writePromptedCount).toHaveBeenCalledWith("session-eligible", 1, {});
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
});
