import { describe, expect, it, vi } from "vitest";
import { handleStop } from "../scripts/contribute-on-stop.mjs";

describe("Cursor stop hook", () => {
  it("returns a followup_message when Remembrance was used and no contribution was prompted", () => {
    const writePromptedCount = vi.fn();
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv_123" },
      {
        env: {},
        readUseCount: () => 1,
        readPromptedCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result.allow).toBe(false);
    expect(result.output.followup_message).toContain("Before you finish");
    expect(result.output.followup_message).toContain("submit_remembrance");
    expect(writePromptedCount).toHaveBeenCalledWith("conv_123", 1, {});
  });

  it("does not auto-follow-up when Cursor is already running a stop-loop follow-up", () => {
    const result = handleStop(
      { status: "completed", loop_count: 1, conversation_id: "conv_123" },
      {
        env: {},
        readUseCount: () => 1,
        readPromptedCount: () => 0,
      },
    );

    expect(result).toEqual({ allow: true, why: "stop_hook_active" });
  });

  it("does not nudge when an explicit contribution already handled the use", () => {
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv_123" },
      {
        env: {},
        readUseCount: () => 2,
        readPromptedCount: () => 2,
      },
    );

    expect(result).toEqual({ allow: true, why: "no_new_usage" });
  });
});
