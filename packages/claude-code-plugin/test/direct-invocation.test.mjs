import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

describe("Claude Code direct skill invocation hook", () => {
  it("ships one argument-driven use command that resolves before invoking", () => {
    const command = readFileSync(
      new URL("../skills/use/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(command).toContain("argument-hint: <skill slug or exact name>");
    expect(command).toContain("`$ARGUMENTS`");
    expect(command).toContain("call `list_skills`");
    expect(command).toContain("call `invoke_skill`");
    expect(command).toContain("Never guess");
    expect(command).toContain("Do not submit query-fit feedback");
    expect(command).toContain(
      "Do not treat a catalog listing or MCP resource handle as use",
    );
  });

  it("records a successful invocation and suppresses completion after feedback", async () => {
    const recordRegistryUse = vi.fn(() => 1);
    const recordDirectSelection = vi.fn();
    const recordValueEpisode = vi.fn();
    const result = await handlePostToolUse(
      {
        session_id: "claude_direct",
        tool_name: "mcp__remembrance__invoke_skill",
        tool_response: {
          selection_mode: "explicit",
          query_id: "rinv_claude",
          result_id: "qres_claude",
          skill: {
            slug: "mongodb-aggregation",
            version: 2,
            version_id: "skv_claude",
            skill_md: "# Instructions",
            task_outcome_eligible: true,
          },
          feedback: { available: true },
          task_outcome: {
            available: true,
            eligible_result_ids: ["qres_claude"],
          },
        },
      },
      {
        env: {},
        recordRegistryUse,
        recordDirectSelection,
        recordValueEpisode,
        clearHighMatchSurfaceForExplicitSelection: () => false,
      },
    );
    expect(result).toMatchObject({
      recorded: true,
      why: "direct_skill_invoked",
      count: 1,
    });
    expect(recordDirectSelection).toHaveBeenCalledWith(
      "claude_direct",
      expect.objectContaining({ slug: "mongodb-aggregation", use_count: 1 }),
      {},
    );
    expect(recordValueEpisode).toHaveBeenCalledWith(
      "claude_direct",
      expect.objectContaining({
        interaction_kind: "direct_selection",
        selected_result_ids: ["qres_claude"],
      }),
      {},
    );

    const markCurrentEngagementHandled = vi.fn(() => 1);
    expect(
      await handlePostToolUse(
        {
          session_id: "claude_direct",
          tool_name: "mcp__remembrance__submit_remembrance",
          tool_response: { id: "rpub_test" },
        },
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toMatchObject({
      recorded: true,
      why: "contribution_handled",
    });
  });

  it("does not count a failed invocation, resource handle, or content-free invocation", async () => {
    const recordRegistryUse = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "claude_failed",
          tool_name: "invoke_skill",
          tool_response: { isError: true },
        },
        { env: {}, recordRegistryUse },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(
      await handlePostToolUse(
        {
          session_id: "claude_resource",
          tool_name: "resources/read",
          tool_response: {
            contents: [
              {
                uri: "remembrance://skills/not-loaded",
                text: '{"selection_handle":{"slug":"not-loaded"}}',
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
          session_id: "claude_empty",
          tool_name: "invoke_skill",
          tool_response: {
            selection_mode: "explicit",
            skill: { slug: "not-loaded" },
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

  it("does not close the loop for an HTTP-rejected contribution", async () => {
    const markCurrentEngagementHandled = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "claude_rejected_feedback",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            ok: false,
            status: 403,
            body: { error: "Missing submission:create scope" },
          },
        },
        { env: {}, markCurrentEngagementHandled },
      ),
    ).toEqual({ cleared: false, why: "tool_failed" });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });

  it("keeps completion pending for a feedback-generated remembrance", async () => {
    const markCurrentEngagementHandled = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "claude_feedback_followup",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            next_step: {
              submit_remembrance_payload: {
                type: "skill_feedback",
                lesson: "Reusable correction.",
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
