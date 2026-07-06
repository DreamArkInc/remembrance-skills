import { describe, expect, it, vi } from "vitest";
import { cursorSessionId, handleMcpUse } from "../scripts/record-mcp-use.mjs";

describe("Cursor afterMCPExecution hook", () => {
  it("records registry consumption for Remembrance query/fetch tools", () => {
    const recordRegistryUse = vi.fn(() => 3);
    const result = handleMcpUse(
      { tool_name: "query_skills", conversation_id: "conv_123" },
      { env: {}, recordRegistryUse },
    );

    expect(result).toEqual({
      recorded: true,
      kind: "consumption",
      tool: "query_skills",
      count: 3,
    });
    expect(recordRegistryUse).toHaveBeenCalledWith("conv_123", {});
  });

  it("normalizes MCP namespace-style tool names", () => {
    const recordRegistryUse = vi.fn(() => 1);
    const result = handleMcpUse(
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

  it("marks the current use as handled after an explicit contribution", () => {
    const writePromptedCount = vi.fn();
    const result = handleMcpUse(
      { tool_name: "submit_remembrance", session_id: "session_1" },
      {
        env: {},
        readRegistryUseCount: () => 2,
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

  it("ignores unrelated MCP tools", () => {
    const recordRegistryUse = vi.fn();
    expect(
      handleMcpUse(
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
      cursorSessionId({}, { CURSOR_TRANSCRIPT_PATH: "/tmp/cursor-transcript.json" }),
    ).toBe("/tmp/cursor-transcript.json");
  });
});
