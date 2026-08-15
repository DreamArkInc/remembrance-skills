import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStop, handleStopHook } from "../scripts/contribute-on-stop.mjs";
import { contributionReason } from "../scripts/hook-core.mjs";

// Injectable base: no FS, no network. useCount/promptedCount are stubbed.
function base(overrides = {}) {
  return {
    env: {
      XDG_CONFIG_HOME: join(tmpdir(), "remembrance-codex-stop-no-config"),
    },
    readUseCount: () => 1,
    readEligibilityCount: () => 0,
    readPromptedCount: () => 0,
    writePromptedCount: () => {},
    ...overrides,
  };
}

describe("Codex contribute-on-stop adapter", () => {
  it("reports the native task outcome before applying the stop decision", async () => {
    const calls = [];
    const result = await handleStopHook(
      { turn_id: "t-outcome", stop_hook_active: true },
      base({
        reportTaskOutcomes: async (...args) => calls.push(args),
      }),
    );
    expect(calls[0]?.[0]).toBe("t-outcome");
    expect(calls[0]?.[2]).toMatchObject({
      env: {},
      userAgent: "@remembrance/codex-plugin",
    });
    expect(result).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("keeps auto-contribution active with a compact, silent continuation", () => {
    const written = [];
    const result = handleStop(
      { turn_id: "t1", stop_hook_active: false },
      base({ writePromptedCount: (id, count) => written.push([id, count]) }),
    );
    expect(result.allow).toBe(false);
    expect(result.output.decision).toBe("block");
    expect(result.output.reason).toBe(contributionReason());
    expect(result.output.reason).toContain(
      "Use Remembrance MCP tools when available",
    );
    expect(result.output.reason).toContain("REMEMBRANCE_SUBMISSION_PAYLOAD");
    expect(result.output.reason).toContain(
      "Do not mention routine Remembrance calls",
    );
    expect(result.output.reason).toContain("submit_remembrance");
    expect(result.output.reason).toContain("propose_private_skill");
    expect(result.output.reason).toContain("propose_skill_idea");
    expect(result.output.reason.length).toBeLessThan(1_200);
    // It records the new prompted count so it won't re-block the same use.
    expect(written).toEqual([["t1", 1]]);
  });

  it("routes new organization lessons through the exact private two-stage action", () => {
    const result = handleStop(
      { turn_id: "t-private-lesson", stop_hook_active: false },
      base({
        env: {
          XDG_CONFIG_HOME: join(
            tmpdir(),
            "remembrance-codex-stop-private-lesson",
          ),
          REMEMBRANCE_API_KEY: "rk_private_lesson_adapter",
        },
      }),
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
    expect(result.output.reason).toContain("prepare_private_lesson_candidate");
    expect(result.output.reason).toContain("submit_private_lesson_candidate");
    expect(result.output.reason).toContain("with exactly its draft_id");
    expect(result.output.reason).toContain(
      "Do not mention routine Remembrance calls",
    );
  });

  it("repeats a high-match fetch-or-explain obligation once at completion", () => {
    const result = handleStop(
      { turn_id: "t-high", stop_hook_active: false },
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

    expect(result.output.reason).toContain("High-confidence result surfaced");
    expect(result.output.reason).toContain("If you have not opened it");
    expect(result.output.reason).toContain('"query_id":"rq_high"');
    expect(result.output.reason).toContain("fit poor plus the reason");
  });

  it("re-prompts only when use increased since the last prompt", () => {
    // Already prompted at count 1, still 1 use → allow.
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ readUseCount: () => 1, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
    // A second distinct use (2 > prior 1) → block again.
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ readUseCount: () => 2, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ allow: false, why: "prompt_contribution" });
  });

  it("does not re-block when stop_hook_active is true (loop guard)", () => {
    expect(
      handleStop({ turn_id: "t1", stop_hook_active: true }, base()),
    ).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("allows the stop when disabled via env", () => {
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } }),
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "false" } }),
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
  });

  it("does not nag when the session never used Remembrance", () => {
    expect(
      handleStop(
        { turn_id: "t2", stop_hook_active: false },
        base({ readUseCount: () => 0 }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("recovers an eligible task even when no query use was recorded", () => {
    const written = [];
    const result = handleStop(
      { turn_id: "t-context", stop_hook_active: false },
      base({
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
    expect(result.output.reason).toContain("no completed Remembrance query");
    expect(result.output.reason).toContain("full conversation");
    expect(written).toEqual([["t-context", 1]]);
  });

  it("recovers a later eligible task after an earlier query was already handled", () => {
    expect(
      handleStop(
        { turn_id: "t-later-context", stop_hook_active: false },
        base({
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
  });

  it("asks for contribution once the later eligible task also completed a query", () => {
    expect(
      handleStop(
        { turn_id: "t-later-query", stop_hook_active: false },
        base({
          readUseCount: () => 2,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
  });

  it("prompts on high-value self-corrections even without a new registry marker", () => {
    const written = [];
    const result = handleStop(
      {
        turn_id: "t-version-miss",
        stop_hook_active: false,
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
      allow: false,
      why: "prompt_high_value_lesson_contribution",
    });
    expect(result.output.reason).toContain("High-value lesson detected");
    expect(result.output.reason).toContain("release versioning miss");
    expect(written).toEqual([["t-version-miss", 1]]);
  });

  it("does not prompt when the high-value lesson was already submitted", () => {
    expect(
      handleStop(
        {
          turn_id: "t-submitted",
          stop_hook_active: false,
          last_assistant_message:
            "I submitted it to Remembrance as rpub_769ded635ea04884a8.",
        },
        base({
          readUseCount: () => 0,
          readPromptedCount: () => 0,
        }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("fails open (allows) when the use marker cannot be read", () => {
    // A reader that returns 0 (its fail-open contract) → treated as not used.
    expect(
      handleStop(
        { turn_id: "t3", stop_hook_active: false },
        base({ readUseCount: () => 0 }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });
});
