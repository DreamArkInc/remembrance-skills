import { describe, expect, it } from "vitest";
import { handleCompletion, handleFinalize } from "../src/index.mjs";
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
    readEligibilityCount: () => 0,
    readPromptedCount: () => 0,
    writePromptedCount: () => {},
    ...overrides,
  };
}

describe("OpenClaw completion hook (before_agent_finalize)", () => {
  it("reports the native task outcome before applying the finalize decision", async () => {
    const calls = [];
    const result = await handleFinalize(
      event(),
      base({
        reportTaskOutcomes: async (...args) => calls.push(args),
        readUseCount: () => 0,
      }),
    );
    expect(calls[0]?.[0]).toBe("r1");
    expect(calls[0]?.[2]).toMatchObject({
      env: {},
      userAgent: "@remembrance/openclaw-plugin",
    });
    expect(result).toMatchObject({
      action: "finalize",
      why: "registry_not_used",
    });
  });

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

  it("revises with a conditional high-match fetch instruction", () => {
    const result = handleCompletion(
      event(),
      base({
        readHighMatch: () => ({
          query_id: "rq_high",
          result_id: "qres_high",
          target_type: "skill",
          slug: "web-ui-ux-qa",
          estimated_tokens: 420,
          verified_uses: 12,
          risk_level: "low",
        }),
      }),
    );

    expect(result.reason).toContain("High-confidence result surfaced");
    expect(result.reason).toContain("If you have not opened it");
  });

  it("re-prompts only when use increased since the last prompt", () => {
    // Already prompted at count 1, still 1 use → finalize.
    expect(
      handleCompletion(
        event(),
        base({ readUseCount: () => 1, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ action: "finalize", why: "no_new_usage" });
    // A second distinct use (2 > prior 1) → revise again.
    expect(
      handleCompletion(
        event(),
        base({ readUseCount: () => 2, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ action: "revise", why: "prompt_contribution" });
  });

  it("finalizes when disabled via env", () => {
    expect(
      handleCompletion(
        event(),
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } }),
      ),
    ).toMatchObject({ action: "finalize", why: "disabled" });
    expect(
      handleCompletion(
        event(),
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "false" } }),
      ),
    ).toMatchObject({ action: "finalize", why: "disabled" });
  });

  it("does not nag when the session never used Remembrance", () => {
    expect(
      handleCompletion(event(), base({ readUseCount: () => 0 })),
    ).toMatchObject({ action: "finalize", why: "registry_not_used" });
  });

  it("revises an eligible reusable task even when no query completed", () => {
    const result = handleCompletion(
      event(),
      base({
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
      }),
    );

    expect(result).toMatchObject({
      action: "revise",
      why: "prompt_task_closure",
    });
    expect(result.reason).toContain("no completed Remembrance query");
  });

  it("revises a later eligible task after an earlier query was handled", () => {
    expect(
      handleCompletion(
        event(),
        base({
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      action: "revise",
      why: "prompt_task_closure",
    });
  });

  it("revises on high-value self-corrections even without a registry marker", () => {
    const written = [];
    const result = handleCompletion(
      {
        context: { runId: "r-version" },
        last_assistant_message:
          "I missed the MCP package version bump after publish-impacting plugin changes.",
      },
      base({
        readUseCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );

    expect(result).toMatchObject({
      action: "revise",
      why: "prompt_high_value_lesson_contribution",
    });
    expect(result.reason).toContain("High-value lesson detected");
    expect(written).toEqual([["r-version", 1]]);
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
