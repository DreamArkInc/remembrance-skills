import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useIsolatedHookEnvironment } from "./fixtures/isolated-hook-environment.mjs";
import {
  FEEDBACK_FINGERPRINTS,
  FEEDBACK_QUERY_ID,
  FEEDBACK_RESULT_ID,
  FEEDBACK_SKILL_SLUG,
  FEEDBACK_VERSION_ID,
  FILTERED_CANDIDATE_CASES,
  WEAK_POSSIBLE_SKILL,
  FILTERED_UNDER_ANY_POLICY,
  FITTING_REQUIRED_SETTINGS,
  INVOKE_SKILL_DELIVERIES,
  MAX_FEEDBACK_SETTINGS,
  MAX_REQUIRED_SETTINGS,
  ORG_API_KEY,
  ORG_ONLY_POLICY_LINE,
  PRESSURE_NOTICES,
  RAW_EMPTY_NO_RESULTS,
  SESSION_SKILL,
  SESSION_SKILLS_DIRECTIVE_HEADER,
  TRIGGER_PROMPT,
  boundaryQueryBody,
  discretionaryQueryBody,
  expectLongestSourceDiscretionaryLine,
  OFFER_POINTER_TAIL,
  expectKeylessFetchKeepsQueryAction,
  expectMaxFeedbackHint,
  expectMaxFeedbackPointer,
  expectNoFilteredCandidate,
  expectOfferPointer,
  expectRequiredSettingsComplete,
  expectRequiredSettingsFetch,
  feedbackObligationLine,
  filteredGovernanceContext,
  filteredQueryBody,
  invokeSkillBody,
  invokeSkillEnvelope,
  maxFeedbackInvocationBody,
  preferenceEvidenceLine,
  rawEmptyGovernanceContext,
  registryStub,
  requiredSettingsCompleteLine,
  requiredSettingsFetchLine,
  sessionInvokeSkillBody,
  sessionSkillsListing,
  unavailableQueryText,
} from "./fixtures/preference-boundaries.mjs";
import { handleStop } from "../scripts/contribute-on-stop.mjs";
import {
  composeBoundedHookContext,
  formatContext,
  runPromptHook,
} from "../scripts/hook-core.mjs";
import { handleQuery } from "../scripts/query-on-prompt.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";
import { handleSessionStart } from "../scripts/session-start.mjs";

useIsolatedHookEnvironment();

function testEnv(extra = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, "codex-boundary-"));
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    REMEMBRANCE_CODEX_CONFIG_PATH: join(root, "missing-codex.toml"),
    ...extra,
  };
}

function queryFetch(body) {
  return vi.fn(async (url) =>
    Response.json(String(url).endsWith("/api/v1/agent/query") ? body : {}),
  );
}

async function promptContext(body, env = testEnv()) {
  const output = await handleQuery(
    { prompt: TRIGGER_PROMPT, session_id: "codex-boundary" },
    { env, fetchImpl: queryFetch(body), recordHealth: () => undefined },
  );
  return output.hookSpecificOutput.additionalContext;
}

// The object the hook prints as its stdout JSON.
async function promptOutput(
  body,
  {
    env = testEnv(),
    fetchImpl = registryStub({ "/api/v1/agent/query": body }),
    sessionId = "codex-boundary",
  } = {},
) {
  return handleQuery(
    { prompt: TRIGGER_PROMPT, session_id: sessionId },
    { env, fetchImpl, recordHealth: () => undefined },
  );
}

function promptSubmitOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

describe("Codex prompt hook at the preference size boundaries", () => {
  it("requires the complete fetch of eight maximum required settings by exact key", async () => {
    expectRequiredSettingsFetch(await promptContext(boundaryQueryBody()));
  });

  it("keeps eight required settings complete when they fit", async () => {
    expectRequiredSettingsComplete(
      await promptContext(
        boundaryQueryBody({ requiredSettings: FITTING_REQUIRED_SETTINGS }),
      ),
    );
  });

  it("shows a maximum discretionary setting whole with the longest source", async () => {
    expectLongestSourceDiscretionaryLine(
      await promptContext(discretionaryQueryBody()),
    );
  });

  it("shortens the required fetch before evicting the HIGH MATCH action", async () => {
    const result = await runPromptHook(TRIGGER_PROMPT, {
      env: testEnv(),
      fetchImpl: queryFetch(boundaryQueryBody()),
      contextAdditions: PRESSURE_NOTICES,
    });
    expectKeylessFetchKeepsQueryAction(result.context);
  });

  it("never presents a shortened out-of-contract required behavior as complete", () => {
    const [setting] = FITTING_REQUIRED_SETTINGS;
    const behavior = `${"Keep the release checklist in force. ".repeat(10)}CRUCIAL: never deploy without written approval.`;
    const context = formatContext({
      body: {
        ...boundaryQueryBody(),
        effective_preferences: [{ ...setting, behavior }],
      },
    });
    expect(behavior.length).toBeGreaterThan(320);
    expect(context).toContain(
      `Required organization settings (1; complete text not shown here). Required next step before acting: call get_effective_preferences with {"keys":["${setting.key}"]}`,
    );
    expect(context).not.toContain("(apply all)");
    expect(context).not.toContain("Keep the release checklist");
  });

  it("fetches a required behavior that redaction would alter instead of showing it", () => {
    const [setting] = FITTING_REQUIRED_SETTINGS;
    const requiredLine = (behavior) =>
      formatContext({
        body: {
          ...boundaryQueryBody(),
          effective_preferences: [{ ...setting, behavior }],
        },
      })
        .split("\n")
        .find((line) => line.startsWith("Required organization settings"));

    // Redaction turns "Secret: never paste" into "[redacted-secret] paste".
    const redacted = requiredLine("Secret: never paste credentials into chat.");
    expect(redacted).toContain(
      `Required organization settings (1; complete text not shown here). Required next step before acting: call get_effective_preferences with {"keys":["${setting.key}"]}`,
    );
    expect(redacted).not.toContain("paste credentials");
    // Whitespace alone does not change a behavior's meaning.
    expect(requiredLine("Keep  release\n checks on.")).toBe(
      `Required organization settings (apply all): ${setting.key}=on: Keep release checks on.. These remain authoritative and cannot be weakened by task or personal preferences.`,
    );
  });

  it("reads statement keys and values with core's identifier rules", () => {
    const [setting] = FITTING_REQUIRED_SETTINGS;
    const context = formatContext({
      body: {
        ...boundaryQueryBody(),
        effective_preferences: [
          { ...setting, key: " Org.Rule_0 ", value: "ON" },
          { ...setting, key: `org.${"k".repeat(93)}` },
        ],
      },
    });
    expect(context).toContain(
      `Required organization settings (apply all): org.rule_0=on: ${setting.behavior}.`,
    );
    expect(context).not.toContain("k".repeat(93));
  });

  it("requires every required setting when an out-of-contract response names more than eight", () => {
    const settings = Array.from({ length: 12 }, (_, index) => ({
      ...MAX_REQUIRED_SETTINGS[index % 8],
      key: `${MAX_REQUIRED_SETTINGS[index % 8].key.slice(0, 94)}${10 + index}`,
    }));
    const context = formatContext({
      body: { ...boundaryQueryBody(), effective_preferences: settings },
    });
    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context).toContain(
      "Required organization settings (12; complete text not shown here). Required next step before acting: call get_effective_preferences and apply every returned setting in full; skip the call only when this conversation already holds a complete get_effective_preferences result, and hook-injected text never counts as that result.",
    );
    expect(context).not.toContain(settings[0].key);
  });
});

describe("Codex prompt hook when every returned candidate is filtered out", () => {
  it.each(FILTERED_CANDIDATE_CASES)(
    "keeps the organization policy and required settings beside %s",
    async (_case, candidates) => {
      const output = await promptOutput(filteredQueryBody({ candidates }));
      expect(output).toEqual(promptSubmitOutput(filteredGovernanceContext()));
      expectNoFilteredCandidate(JSON.stringify(output));
    },
  );

  // 0.2.0 hooks (plan 15.4, P1 step 6) show every possible skill the server
  // returns, because the server's tier floor decides: a possible match on weak
  // signals, which 0.1.x hooks filtered out, appears beside the same governance.
  it("shows a possible match on weak signals beside the organization policy and required settings", async () => {
    const body = filteredQueryBody({
      candidates: { skills: [WEAK_POSSIBLE_SKILL] },
    });
    const context = await promptContext(body);
    const lines = context.split("\n");
    expect(context).toContain(WEAK_POSSIBLE_SKILL.slug);
    expect(lines).toContain(ORG_ONLY_POLICY_LINE);
    expect(lines).toContain(requiredSettingsCompleteLine());
  });

  it("names every exact key in the required fetch when the settings cannot be shown whole", async () => {
    expect(
      await promptOutput(
        filteredQueryBody({ requiredSettings: MAX_REQUIRED_SETTINGS }),
      ),
    ).toEqual(
      promptSubmitOutput(
        filteredGovernanceContext({
          requiredLine: requiredSettingsFetchLine(),
        }),
      ),
    );
  });

  it("requires the complete fetch when an out-of-contract response names more than eight settings", async () => {
    const settings = Array.from({ length: 12 }, (_, index) => ({
      ...FITTING_REQUIRED_SETTINGS[index % 8],
      key: `org.rule_${index}`,
    }));
    expect(
      await promptOutput(filteredQueryBody({ requiredSettings: settings })),
    ).toEqual(
      promptSubmitOutput(
        filteredGovernanceContext({
          requiredLine:
            "Required organization settings (12; complete text not shown here). Required next step before acting: call get_effective_preferences and apply every returned setting in full; skip the call only when this conversation already holds a complete get_effective_preferences result, and hook-injected text never counts as that result. If the call is unavailable or omits a key, say the complete required settings could not be loaded, do not claim they were applied, and never read a key name as permission. These remain authoritative and cannot be weakened by task or personal preferences.",
        }),
      ),
    );
  });

  it("renders exactly the governance lines the response carries", async () => {
    expect(
      await promptOutput(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
        }),
      ),
    ).toEqual(promptSubmitOutput(filteredGovernanceContext({ policy: false })));
    expect(
      await promptOutput(filteredQueryBody({ requiredSettings: [] })),
    ).toEqual(
      promptSubmitOutput(filteredGovernanceContext({ requiredLine: null })),
    );
    expect(
      await promptOutput(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
          requiredSettings: [],
        }),
      ),
    ).toEqual(
      promptSubmitOutput(
        filteredGovernanceContext({ policy: false, requiredLine: null }),
      ),
    );
  });

  it("keeps the raw-empty no_results context", async () => {
    expect(
      await promptOutput(
        filteredQueryBody({ candidates: {}, noResults: RAW_EMPTY_NO_RESULTS }),
      ),
    ).toEqual(promptSubmitOutput(rawEmptyGovernanceContext()));
  });

  it.each([
    [
      "rejects",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["answers 503", () => Response.json({}, { status: 503 })],
  ])(
    "fails closed for an organization key when the query %s",
    async (_case, answer) => {
      expect(
        await promptOutput(null, {
          env: testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY }),
          fetchImpl: registryStub({ "/api/v1/agent/query": answer }),
        }),
      ).toEqual(promptSubmitOutput(unavailableQueryText()));
    },
  );

  it("keeps the organization policy and the required settings whole under context pressure", async () => {
    for (const [requiredSettings, wholeLine] of [
      [FITTING_REQUIRED_SETTINGS, requiredSettingsCompleteLine()],
      [MAX_REQUIRED_SETTINGS, requiredSettingsFetchLine()],
    ]) {
      const result = await runPromptHook(TRIGGER_PROMPT, {
        env: testEnv(),
        fetchImpl: registryStub({
          "/api/v1/agent/query": filteredQueryBody({ requiredSettings }),
        }),
        contextAdditions: PRESSURE_NOTICES,
      });
      const lines = result.context.split("\n");
      expect(result.context.length).toBeLessThanOrEqual(4000);
      expect(lines).toContain(ORG_ONLY_POLICY_LINE);
      expect(
        lines.filter((line) =>
          line.startsWith("Required organization settings"),
        ),
      ).toEqual([wholeLine]);
      expectNoFilteredCandidate(result.context);
    }
  });

  it("keeps the governance quiet beside a session skill loaded at session start", async () => {
    const env = testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY });
    const sessionId = "codex-session-governance";
    const started = await handleSessionStart(
      { source: "startup", session_id: sessionId },
      {
        env,
        pluginVersion: "0.2.0",
        recordHealth: () => undefined,
        warmSession: async () => null,
        checkUpdate: async () => null,
        inspectHookTrust: async () => ({ status: "trusted", hooks: [] }),
        fetchImpl: registryStub({
          "/api/v1/agent/session-skills": sessionSkillsListing(),
        }),
      },
    );
    expect(started.hookSpecificOutput.additionalContext).toContain(
      `${SESSION_SKILLS_DIRECTIVE_HEADER}\n- {"slug":"${SESSION_SKILL.slug}","version_id":"${SESSION_SKILL.version_id}","scope":"session",`,
    );
    expect(
      await handlePostToolUse(
        {
          session_id: sessionId,
          tool_name: "mcp__remembrance__invoke_skill",
          tool_response: invokeSkillEnvelope(sessionInvokeSkillBody()),
        },
        { env, recordHealth: () => undefined },
      ),
    ).toMatchObject({ recorded: true, why: "direct_skill_invoked", count: 0 });
    const output = await promptOutput(filteredQueryBody(), { env, sessionId });
    expect(output).toEqual(
      promptSubmitOutput(filteredGovernanceContext({ capture: "private" })),
    );
    expect(JSON.stringify(output)).not.toContain(SESSION_SKILL.slug);
  });
});

describe("Codex post-use preference evidence at the maximum sizes", () => {
  async function invoke(env, toolResponse, sessionId) {
    return handlePostToolUse(
      {
        session_id: sessionId,
        tool_name: "mcp__remembrance__invoke_skill",
        tool_response: toolResponse,
      },
      { env, recordHealth: () => undefined },
    );
  }

  function visibleStop(env, sessionId) {
    return handleStop(
      { session_id: sessionId },
      { env: { ...env, REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" } },
    );
  }

  async function silentRecoveryContext(env, sessionId, fetchImpl) {
    expect(handleStop({ session_id: sessionId }, { env })).toEqual({
      allow: true,
      why: "silent_prompt_recovery",
    });
    const output = await handleQuery(
      { prompt: TRIGGER_PROMPT, session_id: sessionId },
      { env, fetchImpl, recordHealth: () => undefined },
    );
    return output.hookSpecificOutput.additionalContext;
  }

  it.each(INVOKE_SKILL_DELIVERIES)(
    "points to a maximum offer delivered as an %s instead of repeating it in the visible Stop prompt",
    async (_delivery, deliver) => {
      const env = testEnv();
      expect(
        await invoke(env, deliver(maxFeedbackInvocationBody()), "codex-max"),
      ).toMatchObject({ recorded: true, why: "direct_skill_invoked" });
      const stop = visibleStop(env, "codex-max");
      expect(stop).toMatchObject({
        allow: false,
        why: "prompt_pending_obligations",
      });
      expectMaxFeedbackPointer(stop.output.reason);
    },
  );

  it("points to two maximum offers without repeating either", async () => {
    const env = testEnv();
    await invoke(
      env,
      invokeSkillEnvelope(maxFeedbackInvocationBody({ count: 2 })),
      "codex-two",
    );
    expectMaxFeedbackPointer(visibleStop(env, "codex-two").output.reason, {
      count: 2,
    });
  });

  it("carries the pointer into the next prompt's silent recovery", async () => {
    const env = testEnv();
    await invoke(
      env,
      invokeSkillEnvelope(maxFeedbackInvocationBody()),
      "codex-silent",
    );
    const context = await silentRecoveryContext(
      env,
      "codex-silent",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expectMaxFeedbackPointer(context);
  });

  it("keeps the recovery pointer and the required fetch under context pressure", async () => {
    const env = testEnv();
    await invoke(
      env,
      invokeSkillEnvelope(maxFeedbackInvocationBody()),
      "codex-pressure",
    );
    const context = await silentRecoveryContext(
      env,
      "codex-pressure",
      queryFetch(boundaryQueryBody()),
    );
    expect(context).toContain("[Additional completion context omitted.]");
    expectMaxFeedbackPointer(context);
    expectRequiredSettingsFetch(context);
  });

  it.each([
    ["one key", ["workflow.test_timing"], "; preference workflow.test_timing"],
    ["two keys", ["depth", "tone"], "; preferences depth, tone"],
    [
      "a key past the limit",
      ["workflow.test_timing", "explanation_depth"],
      "; preferences workflow.test_timing +1",
    ],
  ])(
    "names exact offered keys in the pointer when they fit: %s",
    async (_case, keys, named) => {
      const env = testEnv();
      const settings = keys.map((key) => ({
        ...MAX_FEEDBACK_SETTINGS[0],
        key,
        value: "on",
        label: "Test timing",
        behavior: "Run tests before a commit.",
      }));
      const ids = { queryId: "rinv_fits", resultId: "qres_fits" };
      await invoke(
        env,
        invokeSkillEnvelope(
          invokeSkillBody({
            ...ids,
            versionId: "skv_fits",
            slug: "release-checks",
            settings,
          }),
        ),
        "codex-keys",
      );
      const pointer = `${named}${OFFER_POINTER_TAIL}`;
      expectOfferPointer(
        visibleStop(env, "codex-keys").output.reason,
        feedbackObligationLine({ slug: "release-checks", ...ids, pointer }),
        pointer,
      );
    },
  );

  it("renders a maximum query-time offer as an exact compact reference", async () => {
    const context = await promptContext({
      query_id: FEEDBACK_QUERY_ID,
      skills: [
        {
          slug: FEEDBACK_SKILL_SLUG,
          result_id: FEEDBACK_RESULT_ID,
          description: "Rotate release credentials.",
          match_tier: "possible",
          preference_compatibility_feedback: {
            available: true,
            query_id: FEEDBACK_QUERY_ID,
            result_id: FEEDBACK_RESULT_ID,
            skill_version_id: FEEDBACK_VERSION_ID,
            preferences: [
              {
                preference_fingerprint: FEEDBACK_FINGERPRINTS[0],
                setting: MAX_FEEDBACK_SETTINGS[0],
              },
            ],
          },
        },
      ],
      resources: [],
    });
    expectMaxFeedbackHint(context);
  });

  it("keeps a query-time offer that fits the hint in full, without a fetch step", async () => {
    const setting = {
      ...MAX_FEEDBACK_SETTINGS[0],
      key: "workflow.test_timing",
      value: "before_commit",
      label: "Test timing",
      behavior: "Run tests before a commit.",
    };
    const context = await promptContext({
      query_id: "rq_fits",
      skills: [
        {
          slug: "release-checks",
          result_id: "qres_fits",
          description: "Release checks.",
          match_tier: "possible",
          preference_compatibility_feedback: {
            available: true,
            query_id: "rq_fits",
            result_id: "qres_fits",
            skill_version_id: "skv_fits",
            preferences: [
              { preference_fingerprint: FEEDBACK_FINGERPRINTS[0], setting },
            ],
          },
        },
      ],
      resources: [],
    });
    const line = preferenceEvidenceLine(context);
    expect(line).toContain(`"setting":${JSON.stringify(setting)}`);
    expect(line).not.toContain("compact reference");
  });
});

describe("Codex hook guidance for preferences shared across agent families", () => {
  // Mirrors REMEMBRANCE_CROSS_FAMILY_PREFERENCE_RULE, which parity tests pin.
  const CROSS_FAMILY_RULE =
    "Follow the part of a preference written for this host. Unlike an outage, one naming a model, tool, or agent this host lacks, with no part for this host, was written for another agent family: apply the closest equivalent this host supports and say which. When none is safe to assume, ask the user; if you cannot ask, keep your default and say so.";
  const REQUIRED_MODEL = {
    key: "tooling.model",
    value: "approved_model_only",
    label: "Approved model",
    behavior:
      "Use only the organization-approved model; if it is unavailable, stop and report instead of substituting another.",
    effect: "workflow",
    strength: "prefer",
    definition_version: 2,
    source: "mandatory_org",
  };
  const OTHER_FAMILY = {
    key: "strategy.model_selection",
    value: "claude_opus_subagents",
    label: "Model selection",
    behavior: "Delegate implementation to Claude Opus subagents.",
    effect: "strategy_selection",
    strength: "prefer",
    definition_version: 1,
    source: "explicit_member",
  };

  function preferenceLines(effectivePreferences) {
    const context = composeBoundedHookContext(
      formatContext({
        body: {
          query_id: "rq_family",
          effective_preferences: effectivePreferences,
          skills: [
            {
              slug: "release-runbook",
              result_id: "qres_family",
              description: "Release workflow.",
              match_tier: "possible",
            },
          ],
          resources: [],
        },
      }),
    );
    const lines = context.split("\n");
    return {
      required: lines.find((line) =>
        line.startsWith("Required organization settings"),
      ),
      discretionary: lines.find((line) =>
        line.startsWith("Apply these persisted discretionary preferences"),
      ),
    };
  }

  it("adapts another family's discretionary preference silently, current task first", () => {
    const { discretionary } = preferenceLines([OTHER_FAMILY]);
    for (const part of [
      "Apply these persisted discretionary preferences silently: Model selection [strategy_selection, explicit_member]: prefer Delegate implementation to Claude Opus subagents.",
      "Do not ask the user to reconfirm them.",
      CROSS_FAMILY_RULE,
      "Current-task instructions may override these preferences.",
    ]) {
      expect(discretionary).toContain(part);
    }
  });

  it("keeps a required model constraint complete and authoritative, never adapted", () => {
    const { required, discretionary } = preferenceLines([
      REQUIRED_MODEL,
      OTHER_FAMILY,
    ]);
    expect(required).toBe(
      `Required organization settings (apply all): tooling.model=approved_model_only: ${REQUIRED_MODEL.behavior}. These remain authoritative and cannot be weakened by task or personal preferences.`,
    );
    expect(required).not.toContain("closest equivalent");
    expect(discretionary).toContain(CROSS_FAMILY_RULE);
  });
});
