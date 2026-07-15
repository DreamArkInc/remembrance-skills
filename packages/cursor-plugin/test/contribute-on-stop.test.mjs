import { describe, expect, it, vi } from "vitest";
import { handleStop, handleStopHook } from "../scripts/contribute-on-stop.mjs";

describe("Cursor stop hook", () => {
  it("reports the native task outcome before applying the stop decision", async () => {
    const reportTaskOutcomes = vi.fn().mockResolvedValue(1);
    const result = await handleStopHook(
      { loop_count: 1, conversation_id: "conv-outcome" },
      {
        env: {},
        reportTaskOutcomes,
        readUseCount: () => 0,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
      },
    );
    expect(reportTaskOutcomes).toHaveBeenCalledWith(
      "conv-outcome",
      expect.any(Object),
      expect.objectContaining({
        env: {},
        userAgent: "@remembrance/cursor-plugin",
      }),
    );
    expect(result).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("returns a followup_message when Remembrance was used and no contribution was prompted", () => {
    const writePromptedCount = vi.fn();
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv_123" },
      {
        env: {},
        readUseCount: () => 1,
        readEligibilityCount: () => 0,
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
        readEligibilityCount: () => 0,
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
        readEligibilityCount: () => 0,
        readPromptedCount: () => 2,
      },
    );

    expect(result).toEqual({ allow: true, why: "no_new_usage" });
  });

  it("recovers a reusable prompt when Cursor never called Remembrance", () => {
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv-context" },
      {
        env: {},
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
        readPromptedCount: () => 0,
        writePromptedCount: () => {},
      },
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
    expect(result.output.followup_message).toContain("full conversation");
  });

  it("recovers a later reusable prompt after an earlier query was handled", () => {
    expect(
      handleStop(
        {
          status: "completed",
          loop_count: 0,
          conversation_id: "conv-later-context",
        },
        {
          env: {},
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
          writePromptedCount: () => {},
        },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
  });

  it("nudges on a high-value self-correction even without a registry marker", () => {
    const writePromptedCount = vi.fn();
    const result = handleStop(
      {
        status: "completed",
        loop_count: 0,
        conversation_id: "conv_version",
        last_assistant_message:
          "I missed the MCP package version bump after publish-impacting plugin changes.",
      },
      {
        env: {},
        readUseCount: () => 0,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result.allow).toBe(false);
    expect(result.why).toBe("prompt_high_value_lesson_contribution");
    expect(result.output.followup_message).toContain(
      "High-value lesson detected",
    );
    expect(writePromptedCount).toHaveBeenCalledWith("conv_version", 1, {});
  });
});
