import { describe, expect, it, vi } from "vitest";
import {
  contributeDisabled,
  contributionReason,
  countRegistryConsumption,
  decideContribution,
  handleStopHook,
  sessionUsedRemembrance,
} from "../scripts/contribute-on-stop.mjs";

const usedTranscript =
  '{"role":"user"}\n{"content":"Remembrance auto-query context: Trigger: external_service. Skills: ..."}\n';
const unusedTranscript =
  '{"role":"user","content":"rename a local variable"}\n{"role":"assistant","content":"done"}\n';
// Two distinct consumption markers (a query context + a query_skills tool call).
const twoUsesTranscript = `${usedTranscript}{"tool":"mcp__plugin_remembrance_remembrance__query_skills"}\n`;

const base = {
  env: {},
  readCount: () => 0,
  readUseCount: () => 0,
  readEligibilityCount: () => 0,
  readTranscript: () => usedTranscript,
  writeCount: () => {},
};

describe("Remembrance contribute-on-stop hook", () => {
  it("detects registry engagement from transcript markers", () => {
    expect(sessionUsedRemembrance(usedTranscript)).toBe(true);
    expect(
      sessionUsedRemembrance(
        "call mcp__plugin_remembrance_remembrance__submit_remembrance",
      ),
    ).toBe(true);
    expect(
      sessionUsedRemembrance(
        "call mcp__plugin_remembrance_remembrance__submit_query_feedback",
      ),
    ).toBe(true);
    expect(sessionUsedRemembrance(unusedTranscript)).toBe(false);
  });

  it("counts only CONSUMPTION (query/use), not the agent's own submissions", () => {
    expect(countRegistryConsumption(usedTranscript)).toBe(1);
    expect(countRegistryConsumption(twoUsesTranscript)).toBe(2);
    expect(countRegistryConsumption(unusedTranscript)).toBe(0);
    expect(
      countRegistryConsumption(
        '{"role":"assistant","content":"Nothing worth capturing from remembrancer."}',
      ),
    ).toBe(0);
    // A submission does not count as consumption (so contributing never re-prompts).
    expect(
      countRegistryConsumption(
        "POST /api/v1/agent/query-feedback and mcp__x_remembrance__submit_query_feedback",
      ),
    ).toBe(0);
  });

  it("blocks the stop to prompt contribution on first registry use", async () => {
    const result = await handleStopHook(
      { session_id: "s1", transcript_path: "/x", stop_hook_active: false },
      base,
    );
    expect(result.allow).toBe(false);
    expect(result.output.decision).toBe("block");
    expect(result.output.reason).toBe(contributionReason());
  });

  it("re-prompts only when consumption increased since the last prompt", () => {
    // Prompted at count 1 already; still only 1 use → no re-prompt.
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        { ...base, readCount: () => 1, readTranscript: () => usedTranscript },
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
    // A second distinct use (count 2 > prior 1) → prompt again.
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        {
          ...base,
          readCount: () => 1,
          readTranscript: () => twoUsesTranscript,
        },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
      consumption: 2,
    });
  });

  it("prompts once for every newly invoked skill and marks the batch prompted", async () => {
    const selections = [
      {
        slug: "first-skill",
        query_id: "rinv_first",
        result_id: "qres_first",
        feedback_available: true,
        use_count: 1,
        prompted_at: null,
      },
      {
        slug: "second-skill",
        query_id: "rinv_second",
        result_id: "qres_second",
        feedback_available: true,
        use_count: 2,
        prompted_at: null,
      },
    ];
    const writeCount = vi.fn();
    const markDirectSelectionsPrompted = vi.fn();
    const result = await handleStopHook(
      {
        session_id: "s-direct-batch",
        transcript_path: "/x",
        stop_hook_active: false,
      },
      {
        ...base,
        readTranscript: () => twoUsesTranscript,
        readUseCount: () => 2,
        readDirectSelections: () => selections,
        reportTaskOutcomes: async () => 2,
        writeCount,
        markDirectSelectionsPrompted,
      },
    );
    expect(result.allow).toBe(false);
    expect(result.output.reason).toContain("2 Remembrance skills");
    expect(result.output.reason).toContain("first-skill");
    expect(result.output.reason).toContain("second-skill");
    expect(writeCount).toHaveBeenCalledWith("s-direct-batch", 2);
    expect(markDirectSelectionsPrompted).toHaveBeenCalledWith(
      "s-direct-batch",
      2,
      {},
    );
  });

  it("does not re-prompt after a decline when only free-text remembrancer is mentioned", () => {
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        {
          ...base,
          readCount: () => 1,
          readTranscript: () =>
            `${usedTranscript}{"role":"assistant","content":"Nothing worth capturing from remembrancer."}\n`,
        },
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
  });

  it("allows the stop when disabled via env", () => {
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        { ...base, env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } },
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
    expect(contributeDisabled("0")).toBe(true);
    expect(contributeDisabled("false")).toBe(true);
    expect(contributeDisabled("1")).toBe(false);
    expect(contributeDisabled(undefined)).toBe(false);
  });

  it("never loops: allows the stop when stop_hook_active is set", () => {
    expect(
      decideContribution({ session_id: "s1", stop_hook_active: true }, base),
    ).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("does not nag when the session never touched Remembrance", () => {
    expect(
      decideContribution(
        { session_id: "s2", stop_hook_active: false },
        { ...base, readTranscript: () => unusedTranscript },
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("recovers a contextual task even when no query completed", () => {
    const transcript =
      '{"content":"Remembrance task-continuation reminder: infer the task from the full thread."}\n';
    expect(
      decideContribution(
        { session_id: "s-context", stop_hook_active: false },
        { ...base, readTranscript: () => transcript },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
      consumption: 1,
    });
  });

  it("recovers a later contextual task in a session with an earlier handled query", () => {
    expect(
      decideContribution(
        { session_id: "s-later-context", stop_hook_active: false },
        {
          ...base,
          readTranscript: () => unusedTranscript,
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readCount: () => 1,
        },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
      consumption: 2,
    });
  });

  it("prompts on high-value self-corrections even without registry consumption", () => {
    const transcript =
      '{"role":"assistant","content":"I missed the MCP package version bump after publish-impacting plugin changes."}\n';
    expect(
      decideContribution(
        { session_id: "s-version-miss", stop_hook_active: false },
        { ...base, readCount: () => 0, readTranscript: () => transcript },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_high_value_lesson_contribution",
      consumption: 1,
    });
  });

  it("does not prompt when the high-value lesson was already submitted", () => {
    const transcript =
      '{"role":"assistant","content":"I submitted it to Remembrance as rpub_769ded635ea04884a8."}\n';
    expect(
      decideContribution(
        { session_id: "s-submitted", stop_hook_active: false },
        { ...base, readCount: () => 0, readTranscript: () => transcript },
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("fails open (allows stop) when the transcript can't be read", () => {
    expect(
      decideContribution(
        { session_id: "s3", stop_hook_active: false },
        { ...base, readTranscript: () => "" },
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });
});
