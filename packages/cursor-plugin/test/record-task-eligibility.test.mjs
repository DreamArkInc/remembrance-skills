import { describe, expect, it, vi } from "vitest";
import {
  handlePromptEligibility,
  promptFromCursorInput,
} from "../scripts/record-task-eligibility.mjs";

describe("Cursor beforeSubmitPrompt eligibility observer", () => {
  it("records explicit reusable work without changing the prompt", async () => {
    const recordEligibility = vi.fn(() => 1);
    const result = await handlePromptEligibility(
      {
        prompt: "Fix the responsive review-card workflow and run Playwright.",
        conversation_id: "conv-explicit",
      },
      {
        env: {},
        recordEligibility,
        recordDirective: vi.fn(),
        fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "tool_or_framework",
      sessionId: "conv-explicit",
    });
    expect(recordEligibility).toHaveBeenCalledWith("conv-explicit", {});
  });

  it("records context-dependent follow-ups so Stop can recover a missed query", async () => {
    const recordEligibility = vi.fn(() => 1);
    const result = await handlePromptEligibility(
      { userPrompt: "fix these issues", session_id: "session-followup" },
      {
        env: {},
        recordEligibility,
        recordDirective: vi.fn(),
        fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "contextual_continuation",
      sessionId: "session-followup",
    });
    expect(recordEligibility).toHaveBeenCalledOnce();
  });

  it("skips one-off facts and honors the disable flag", async () => {
    const recordEligibility = vi.fn();
    expect(
      await handlePromptEligibility(
        { prompt: "What is the capital of France?" },
        { env: {}, recordEligibility },
      ),
    ).toMatchObject({ eligible: false });
    expect(
      await handlePromptEligibility(
        { prompt: "Set up Vercel", session_id: "disabled" },
        { env: { REMEMBRANCE_AUTO_QUERY: "0" }, recordEligibility },
      ),
    ).toEqual({ eligible: false, reason: "disabled" });
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it("reads the documented prompt field variants", () => {
    expect(promptFromCursorInput({ prompt: "a" })).toBe("a");
    expect(promptFromCursorInput({ user_prompt: "b" })).toBe("b");
    expect(promptFromCursorInput({ userPrompt: "c" })).toBe("c");
    expect(promptFromCursorInput({ input: { prompt: "d" } })).toBe("d");
    expect(promptFromCursorInput({ message: "e" })).toBe("e");
  });
});
