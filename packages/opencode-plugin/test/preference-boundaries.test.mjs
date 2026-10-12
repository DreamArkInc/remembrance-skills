import { describe, expect, it, vi } from "vitest";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";
import {
  FILTERED_CANDIDATE_CASES,
  WEAK_POSSIBLE_SKILL,
  ORG_ONLY_POLICY_LINE,
  requiredSettingsCompleteLine,
  FILTERED_UNDER_ANY_POLICY,
  FITTING_REQUIRED_SETTINGS,
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
import { readDirectSelectionSurfaces } from "../scripts/hook-core.mjs";
import { Remembrance } from "../src/index.mjs";

const { fetch } = useIsolatedHookEnvironment();

// The OpenCode adapter reads process.env, as the host configures it.
function configure(extra = {}) {
  vi.stubEnv("REMEMBRANCE_API_URL", "https://remembrance.dev");
  vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
}

function loggingClient() {
  const messages = [];
  return {
    messages,
    client: { app: { log: async ({ body }) => messages.push(body) } },
  };
}

// The system entries OpenCode sends with the model turn after the prompt.
async function promptSystem(
  body,
  sessionID,
  { env = {}, answer = body, hooks = null } = {},
) {
  configure(env);
  fetch.mockImplementation(registryStub({ "/api/v1/agent/query": answer }));
  try {
    const plugin = hooks ?? (await Remembrance(loggingClient()));
    const messageID = `msg-${sessionID}`;
    await plugin["chat.message"](
      { messageID, sessionID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [{ type: "text", messageID, sessionID, text: TRIGGER_PROMPT }],
      },
    );
    const output = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID }, output);
    return output.system;
  } finally {
    fetch.mockReset();
    fetch.mockRejectedValue(new TypeError("network disabled in tests"));
  }
}

async function promptContext(body, sessionID) {
  return (await promptSystem(body, sessionID)).join("\n");
}

describe("OpenCode hooks at the preference size boundaries", () => {
  it("requires the complete fetch of eight maximum required settings by exact key", async () => {
    expectRequiredSettingsFetch(
      await promptContext(boundaryQueryBody(), "opencode-max"),
    );
  });

  it("keeps eight required settings complete when they fit", async () => {
    expectRequiredSettingsComplete(
      await promptContext(
        boundaryQueryBody({ requiredSettings: FITTING_REQUIRED_SETTINGS }),
        "opencode-fits",
      ),
    );
  });

  it("shows a maximum discretionary setting whole with the longest source", async () => {
    expectLongestSourceDiscretionaryLine(
      await promptContext(discretionaryQueryBody(), "opencode-discretionary"),
    );
  });

  // OpenCode hands the hook an MCP tool's text output: the API envelope JSON.
  it("points to a maximum offer instead of repeating it in the idle prompt", async () => {
    configure({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
    fetch.mockImplementation(async () =>
      Response.json({ recorded: true }, { status: 201 }),
    );
    try {
      const sessionID = "opencode-feedback";
      const { client, messages } = loggingClient();
      const hooks = await Remembrance({ client });
      await hooks["tool.execute.after"](
        { tool: "remembrance_invoke_skill", sessionID, args: {} },
        {
          title: "remembrance_invoke_skill",
          output: JSON.stringify(
            invokeSkillEnvelope(maxFeedbackInvocationBody()),
          ),
          metadata: {},
        },
      );
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID } },
      });
      expect(messages).toHaveLength(1);
      const message = String(messages[0].message);
      expectMaxFeedbackPointer(message);
    } finally {
      fetch.mockReset();
      fetch.mockRejectedValue(new TypeError("network disabled in tests"));
    }
  });
});

describe("OpenCode prompt hook when every returned candidate is filtered out", () => {
  it.each(FILTERED_CANDIDATE_CASES)(
    "keeps the organization policy and required settings beside %s",
    async (name, candidates) => {
      // Each case is its own session: a delivered query leaves its feedback
      // obligation to the session's later turns.
      const system = await promptSystem(
        filteredQueryBody({ candidates }),
        `opencode-filtered-${name.replaceAll(" ", "-")}`,
      );
      expect(system).toEqual([filteredGovernanceContext()]);
      expectNoFilteredCandidate(system.join("\n"));
    },
  );

  // 0.2.0 hooks (plan 15.4, P1 step 6) show every possible skill the server
  // returns, because the server's tier floor decides: a possible match on weak
  // signals, which 0.1.x hooks filtered out, appears beside the same governance.
  it("shows a possible match on weak signals beside the organization policy and required settings", async () => {
    const body = filteredQueryBody({
      candidates: { skills: [WEAK_POSSIBLE_SKILL] },
    });
    const context = (await promptSystem(body, "opencode-weak-possible")).join("\n");
    const lines = context.split("\n");
    expect(context).toContain(WEAK_POSSIBLE_SKILL.slug);
    expect(lines).toContain(ORG_ONLY_POLICY_LINE);
    expect(lines).toContain(requiredSettingsCompleteLine());
  });

  it("names every exact key in the required fetch when the settings cannot be shown whole", async () => {
    expect(
      await promptSystem(
        filteredQueryBody({ requiredSettings: MAX_REQUIRED_SETTINGS }),
        "opencode-filtered-max",
      ),
    ).toEqual([
      filteredGovernanceContext({ requiredLine: requiredSettingsFetchLine() }),
    ]);
  });

  it("renders exactly the governance lines the response carries", async () => {
    expect(
      await promptSystem(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
        }),
        "opencode-filtered-required",
      ),
    ).toEqual([filteredGovernanceContext({ policy: false })]);
    expect(
      await promptSystem(
        filteredQueryBody({ requiredSettings: [] }),
        "opencode-filtered-policy",
      ),
    ).toEqual([filteredGovernanceContext({ requiredLine: null })]);
    expect(
      await promptSystem(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
          requiredSettings: [],
        }),
        "opencode-filtered-ungoverned",
      ),
    ).toEqual([
      filteredGovernanceContext({ policy: false, requiredLine: null }),
    ]);
  });

  it("keeps the raw-empty no_results context", async () => {
    expect(
      await promptSystem(
        filteredQueryBody({ candidates: {}, noResults: RAW_EMPTY_NO_RESULTS }),
        "opencode-raw-empty",
      ),
    ).toEqual([rawEmptyGovernanceContext()]);
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
    async (outcome, answer) => {
      expect(
        await promptSystem(null, `opencode-${outcome.replaceAll(" ", "-")}`, {
          env: { REMEMBRANCE_API_KEY: ORG_API_KEY },
          answer,
        }),
      ).toEqual([unavailableQueryText()]);
    },
  );

  // OpenCode hands the hook an MCP tool's text output: the API envelope JSON.
  it("keeps the governance quiet beside a session skill the agent loaded", async () => {
    configure({ REMEMBRANCE_API_KEY: ORG_API_KEY });
    const sessionID = "opencode-session";
    const hooks = await Remembrance(loggingClient());
    await hooks["tool.execute.after"](
      { tool: "remembrance_invoke_skill", sessionID, args: {} },
      {
        title: "remembrance_invoke_skill",
        output: JSON.stringify(invokeSkillEnvelope(sessionInvokeSkillBody())),
        metadata: {},
      },
    );
    expect(readDirectSelectionSurfaces(sessionID, process.env)).toEqual([
      expect.objectContaining({
        slug: SESSION_SKILL.slug,
        version_id: SESSION_SKILL.version_id,
        scope: "session",
      }),
    ]);
    const system = await promptSystem(filteredQueryBody(), sessionID, {
      env: { REMEMBRANCE_API_KEY: ORG_API_KEY },
      hooks,
    });
    expect(system).toEqual([filteredGovernanceContext({ capture: "private" })]);
    expect(system.join("\n")).not.toContain(SESSION_SKILL.slug);
  });
});
