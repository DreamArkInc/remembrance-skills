import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  unavailableQueryText,
} from "../../codex-plugin/test/fixtures/preference-boundaries.mjs";
import {
  handleAfterToolCall,
  handleCompletion,
  handlePrePrompt,
} from "../src/index.mjs";

useIsolatedHookEnvironment();

function testEnv(extra = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, "openclaw-boundary-"));
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_AGENT_KEY_PATH: join(root, "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(root, "sessions"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    ...extra,
  };
}

// The before_prompt_build result OpenClaw applies.
async function promptResult(
  body,
  {
    env = testEnv(),
    fetchImpl = registryStub({ "/api/v1/agent/query": body }),
    context = { sessionId: "openclaw-boundary", runId: "run-boundary" },
  } = {},
) {
  return handlePrePrompt(
    { prompt: TRIGGER_PROMPT, context },
    { env, fetchImpl, recordHealth: () => undefined },
  );
}

async function promptContext(body) {
  return (await promptResult(body)).appendSystemContext;
}

describe("OpenClaw hooks at the preference size boundaries", () => {
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
    "points to a maximum offer delivered as an %s instead of repeating it in the revision prompt",
    async (delivery, deliver) => {
      const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
      const run = delivery.replaceAll(" ", "-");
      const context = { sessionId: `openclaw-${run}`, runId: `run-${run}` };
      expect(
        await handleAfterToolCall(
          {
            toolName: "remembrance__invoke_skill",
            result: deliver(maxFeedbackInvocationBody()),
            context,
          },
          { env, recordHealth: () => undefined },
        ),
      ).toMatchObject({ recorded: true, why: "direct_skill_invoked" });
      const completion = handleCompletion(
        { context, last_assistant_message: "Done." },
        { env },
      );
      expect(completion).toMatchObject({ action: "revise" });
      expectMaxFeedbackPointer(completion.reason);
    },
  );
});

describe("OpenClaw prompt hook when every returned candidate is filtered out", () => {
  it.each(FILTERED_CANDIDATE_CASES)(
    "keeps the organization policy and required settings beside %s",
    async (_case, candidates) => {
      const result = await promptResult(filteredQueryBody({ candidates }));
      expect(result).toEqual({
        appendSystemContext: filteredGovernanceContext(),
      });
      expectNoFilteredCandidate(JSON.stringify(result));
    },
  );

  // 0.2.0 hooks (plan 15.4, P1 step 6) show every possible skill the server
  // returns, because the server's tier floor decides: a possible match on weak
  // signals, which 0.1.x hooks filtered out, appears beside the same governance.
  it("shows a possible match on weak signals beside the organization policy and required settings", async () => {
    const body = filteredQueryBody({
      candidates: { skills: [WEAK_POSSIBLE_SKILL] },
    });
    const context = (await promptResult(body)).appendSystemContext;
    const lines = context.split("\n");
    expect(context).toContain(WEAK_POSSIBLE_SKILL.slug);
    expect(lines).toContain(ORG_ONLY_POLICY_LINE);
    expect(lines).toContain(requiredSettingsCompleteLine());
  });

  it("names every exact key in the required fetch when the settings cannot be shown whole", async () => {
    expect(
      await promptResult(
        filteredQueryBody({ requiredSettings: MAX_REQUIRED_SETTINGS }),
      ),
    ).toEqual({
      appendSystemContext: filteredGovernanceContext({
        requiredLine: requiredSettingsFetchLine(),
      }),
    });
  });

  it("renders exactly the governance lines the response carries", async () => {
    expect(
      await promptResult(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
        }),
      ),
    ).toEqual({
      appendSystemContext: filteredGovernanceContext({ policy: false }),
    });
    expect(
      await promptResult(filteredQueryBody({ requiredSettings: [] })),
    ).toEqual({
      appendSystemContext: filteredGovernanceContext({ requiredLine: null }),
    });
    expect(
      await promptResult(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
          requiredSettings: [],
        }),
      ),
    ).toEqual({
      appendSystemContext: filteredGovernanceContext({
        policy: false,
        requiredLine: null,
      }),
    });
  });

  it("keeps the raw-empty no_results context", async () => {
    expect(
      await promptResult(
        filteredQueryBody({ candidates: {}, noResults: RAW_EMPTY_NO_RESULTS }),
      ),
    ).toEqual({ appendSystemContext: rawEmptyGovernanceContext() });
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
        await promptResult(null, {
          env: testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY }),
          fetchImpl: registryStub({ "/api/v1/agent/query": answer }),
        }),
      ).toEqual({ appendSystemContext: unavailableQueryText() });
    },
  );

  it("keeps the governance quiet beside a session skill the agent loaded", async () => {
    const env = testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY });
    const context = { sessionId: "openclaw-session", runId: "run-session" };
    expect(
      await handleAfterToolCall(
        {
          toolName: "remembrance__invoke_skill",
          result: invokeSkillEnvelope(sessionInvokeSkillBody()),
          context,
        },
        { env, recordHealth: () => undefined },
      ),
    ).toMatchObject({ recorded: true, count: 0 });
    const result = await promptResult(filteredQueryBody(), { env, context });
    expect(result).toEqual({
      appendSystemContext: filteredGovernanceContext({ capture: "private" }),
    });
    expect(JSON.stringify(result)).not.toContain(SESSION_SKILL.slug);
  });
});
