import { describe, expect, it } from "vitest";
import { handleCompletion } from "../src/index.mjs";
import { contributionReason } from "../src/hook-core.mjs";

// A fake OpenClaw before_agent_finalize event.
function event(ctx = {}) {
  return { context: { sessionId: "s1", runId: "r1", ...ctx } };
}

// Injectable base: no FS, no network. useCount/promptedCount are stubbed.
function base(overrides = {}) {
  return {
    env: {},
    readUseCount: () => 1,
    readPromptedCount: () => 0,
    writePromptedCount: () => {},
    ...overrides,
  };
}

describe("OpenClaw completion hook (before_agent_finalize)", () => {
  it("revises with the contribution reason on new registry use", () => {
    const written = [];
    const result = handleCompletion(
      event(),
      base({ writePromptedCount: (id, count) => written.push([id, count]) }),
    );
    expect(result.action).toBe("revise");
    expect(result.reason).toBe(contributionReason());
    expect(result.retry.instruction).toBe(contributionReason());
    // It records the new prompted count so it won't re-revise the same use.
    expect(written).toEqual([["r1", 1]]);
  });

  it("re-prompts only when use increased since the last prompt", () => {
    // Already prompted at count 1, still 1 use → finalize.
    expect(
      handleCompletion(event(), base({ readUseCount: () => 1, readPromptedCount: () => 1 })),
    ).toMatchObject({ action: "finalize", why: "no_new_usage" });
    // A second distinct use (2 > prior 1) → revise again.
    expect(
      handleCompletion(event(), base({ readUseCount: () => 2, readPromptedCount: () => 1 })),
    ).toMatchObject({ action: "revise", why: "prompt_contribution" });
  });

  it("finalizes when disabled via env", () => {
    expect(
      handleCompletion(event(), base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } })),
    ).toMatchObject({ action: "finalize", why: "disabled" });
    expect(
      handleCompletion(event(), base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "false" } })),
    ).toMatchObject({ action: "finalize", why: "disabled" });
  });

  it("does not nag when the session never used Remembrance", () => {
    expect(
      handleCompletion(event(), base({ readUseCount: () => 0 })),
    ).toMatchObject({ action: "finalize", why: "registry_not_used" });
  });

  it("fails open (finalizes) when the decision path throws", () => {
    // A reader that throws → the try/catch in handleCompletion finalizes.
    expect(
      handleCompletion(
        event(),
        base({
          readUseCount: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toMatchObject({ action: "finalize", why: "error" });
  });
});
