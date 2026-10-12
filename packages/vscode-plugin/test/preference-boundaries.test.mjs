import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";
import {
  FILTERED_CANDIDATE_CASES,
  WEAK_POSSIBLE_SKILL,
  ORG_ONLY_POLICY_LINE,
  requiredSettingsCompleteLine,
  FILTERED_UNDER_ANY_POLICY,
  FITTING_REQUIRED_SETTINGS,
  INVOKE_SKILL_DELIVERIES,
  MAX_REQUIRED_SETTINGS,
  ORG_API_KEY,
  RAW_EMPTY_NO_RESULTS,
  SESSION_SKILL,
  SESSION_SKILLS_DIRECTIVE_HEADER,
  SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED,
  TRIGGER_PROMPT,
  boundaryQueryBody,
  discretionaryQueryBody,
  expectLongestSourceDiscretionaryLine,
  expectMaxFeedbackPointer,
  expectNoFilteredCandidate,
  expectRequiredSettingsComplete,
  expectRequiredSettingsFetch,
  filteredGovernanceContext,
  filteredQueryBody,
  invokeSkillEnvelope,
  maxFeedbackInvocationBody,
  rawEmptyGovernanceContext,
  registryStub,
  requiredSettingsFetchLine,
  sessionInvokeSkillBody,
  sessionSkillsListing,
  unavailableQueryText,
} from "../../codex-plugin/test/fixtures/preference-boundaries.mjs";
import { handleStopHook } from "../scripts/contribute-on-stop.mjs";
import { handleHookInput } from "../scripts/query-on-prompt.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";
import { handleSessionStart } from "../scripts/session-start.mjs";

useIsolatedHookEnvironment();

function testEnv(extra = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, "vscode-boundary-"));
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_HOOK_CACHE_PATH: join(root, "cache.json"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
    REMEMBRANCE_AGENT_KEY_PATH: join(root, "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(root, "sessions"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    ...extra,
  };
}

// The object the hook prints as its stdout JSON.
async function promptOutput(
  body,
  {
    env = testEnv(),
    fetchImpl = registryStub({ "/api/v1/agent/query": body }),
    sessionId = "vscode-boundary",
  } = {},
) {
  return handleHookInput(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: TRIGGER_PROMPT,
      session_id: sessionId,
    },
    { env, fetchImpl, recordHealth: () => undefined },
  );
}

async function promptContext(body) {
  return (await promptOutput(body)).hookSpecificOutput.additionalContext;
}

function promptSubmitOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

describe("VS Code hooks at the preference size boundaries", () => {
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

  it.each(INVOKE_SKILL_DELIVERIES)(
    "points to a maximum offer delivered as an %s instead of repeating it in the Stop prompt",
    async (_delivery, deliver) => {
      const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
      await handlePostToolUse(
        {
          session_id: "vscode-feedback",
          tool_name: "mcp__remembrance__invoke_skill",
          tool_response: deliver(maxFeedbackInvocationBody()),
        },
        { env, recordHealth: () => undefined },
      );
      const stop = await handleStopHook(
        { session_id: "vscode-feedback", last_assistant_message: "Done." },
        {
          env,
          recordHealth: () => undefined,
          fetchImpl: vi.fn(async () => Response.json({}, { status: 201 })),
        },
      );
      expect(stop).toMatchObject({ allow: false });
      expectMaxFeedbackPointer(stop.output.reason, {
        from: SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED,
      });
    },
  );
});

describe("VS Code prompt hook when every returned candidate is filtered out", () => {
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

  it("keeps the governance quiet beside a session skill loaded at session start", async () => {
    // VS Code runs each hook with its own process environment.
    vi.stubEnv("REMEMBRANCE_API_KEY", ORG_API_KEY);
    const env = testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY });
    const sessionId = "vscode-session-governance";
    const started = await handleSessionStart(
      { hook_event_name: "SessionStart", session_id: sessionId },
      {
        env,
        pluginVersion: "0.2.0",
        recordHealth: () => undefined,
        warmSession: async () => null,
        checkUpdate: async () => null,
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
