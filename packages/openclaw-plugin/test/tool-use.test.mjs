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
});
