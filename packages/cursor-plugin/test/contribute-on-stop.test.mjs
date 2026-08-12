import { describe, expect, it, vi } from "vitest";
import { HOST_POLICY_ALERT_TEXT } from "../scripts/hook-core.mjs";
import { handleStop, handleStopHook } from "../scripts/contribute-on-stop.mjs";

describe("Cursor stop hook", () => {
  it("surfaces a pending host-policy alert exactly once before normal completion logic", () => {
    const markDelivered = vi.fn(() => true);
    const options = {
      env: {},
      readPendingHostPolicyAlert: () => ({ id: "policy-1" }),
      markHostPolicyAlertDelivered: markDelivered,
      readUseCount: () => 0,
      readEligibilityCount: () => 0,
      readPromptedCount: () => 0,
    };
    expect(
      handleStop(
        { loop_count: 0, conversation_id: "conv-policy" },
        options,
      ),
    ).toEqual({
      allow: false,
      why: "host_policy_denial",
      output: { followup_message: HOST_POLICY_ALERT_TEXT },
    });
    expect(markDelivered).toHaveBeenCalledWith(
      "cursor",
      "conv-policy",
      "policy-1",
      {},
    );
  });
  it("reports the native task outcome before applying the stop decision", async () => {
    const reportTaskOutcomes = vi.fn().mockResolvedValue(1);
    const recordHealth = vi.fn();
    const result = await handleStopHook(
      { loop_count: 1, conversation_id: "conv-outcome" },
      {
        env: {},
        reportTaskOutcomes,
        recordHealth,
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
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cursor",
        component: "completion_hook",
        sessionId: "conv-outcome",
      }),
      {},
    );
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
    expect(result.output.followup_message).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(result.output.followup_message).toContain("submit_remembrance");
    expect(result.output.followup_message).toContain(
      "Do not mention routine Remembrance calls",
    );
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
