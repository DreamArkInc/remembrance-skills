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
  SESSION_SKILLS_DIRECTIVE_HEADER,
  boundaryQueryBody,
  discretionaryQueryBody,
  expectLongestSourceDiscretionaryLine,
  expectMaxFeedbackPointer,
  expectNoFilteredCandidate,
  expectRequiredSettingsComplete,
  expectRequiredSettingsFetch,
  filteredGovernanceContext,
  filteredQueryBody,
  invokeSkillToolResult,
  maxFeedbackInvocationBody,
  rawEmptyGovernanceContext,
  registryStub,
  requiredSettingsFetchLine,
  sessionInvokeSkillBody,
  sessionSkillsListing,
} from "../../codex-plugin/test/fixtures/preference-boundaries.mjs";
import { handleStop } from "../scripts/contribute-on-stop.mjs";
import {
  composeBoundedHookContext,
  formatContext,
} from "../scripts/hook-core.mjs";
import { handleMcpUse } from "../scripts/record-mcp-use.mjs";
import {
  CURSOR_REMEMBRANCE_CONTEXT,
  handleSessionStart,
} from "../scripts/session-start.mjs";

useIsolatedHookEnvironment();

function testEnv(extra = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR, "cursor-boundary-"));
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    ...extra,
  };
}

// Cursor has no prompt-context hook; its shipped hook-core copy still renders
// query context for the shared allocator, so the boundary is checked there.
function renderedContext(body, env) {
  return composeBoundedHookContext(
    formatContext({ body }, "external_service", undefined, { env }),
  );
}

describe("Cursor hooks at the preference size boundaries", () => {
  it("requires the complete fetch of eight maximum required settings by exact key", () => {
    expectRequiredSettingsFetch(renderedContext(boundaryQueryBody()));
  });

  it("keeps eight required settings complete when they fit", () => {
    expectRequiredSettingsComplete(
      renderedContext(
        boundaryQueryBody({ requiredSettings: FITTING_REQUIRED_SETTINGS }),
      ),
    );
  });

  it("shows a maximum discretionary setting whole with the longest source", () => {
    expectLongestSourceDiscretionaryLine(
      renderedContext(discretionaryQueryBody()),
    );
  });

  it.each(INVOKE_SKILL_DELIVERIES)(
    "points to a maximum offer delivered as an %s instead of repeating it in the follow-up",
    async (_delivery, deliver) => {
      const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
      expect(
        await handleMcpUse(
          {
            tool_name: "MCP:invoke_skill",
            conversation_id: "cursor-feedback",
            result: deliver(maxFeedbackInvocationBody()),
          },
          { env, recordHealth: () => undefined },
        ),
      ).toMatchObject({ recorded: true, kind: "direct_selection" });
      const stop = handleStop(
        { conversation_id: "cursor-feedback", loop_count: 0 },
        { env },
      );
      expect(stop).toMatchObject({ allow: false });
      expectMaxFeedbackPointer(stop.output.followup_message);
    },
  );
});

// Cursor cannot inject prompt context, so no Cursor hook emits this context or
// the unavailable-query context; its shipped hook-core copy is checked here.
describe("Cursor hook-core when every returned candidate is filtered out", () => {
  it.each(FILTERED_CANDIDATE_CASES)(
    "keeps the organization policy and required settings beside %s",
    (_case, candidates) => {
      const context = renderedContext(filteredQueryBody({ candidates }));
      expect(context).toBe(filteredGovernanceContext());
      expectNoFilteredCandidate(context);
    },
  );

  // 0.2.0 hooks (plan 15.4, P1 step 6) show every possible skill the server
  // returns, because the server's tier floor decides: a possible match on weak
  // signals, which 0.1.x hooks filtered out, appears beside the same governance.
  it("shows a possible match on weak signals beside the organization policy and required settings", () => {
    const body = filteredQueryBody({
      candidates: { skills: [WEAK_POSSIBLE_SKILL] },
    });
    const context = renderedContext(body);
    const lines = context.split("\n");
    expect(context).toContain(WEAK_POSSIBLE_SKILL.slug);
    expect(lines).toContain(ORG_ONLY_POLICY_LINE);
    expect(lines).toContain(requiredSettingsCompleteLine());
  });

  it("names every exact key in the required fetch when the settings cannot be shown whole", () => {
    expect(
      renderedContext(
        filteredQueryBody({ requiredSettings: MAX_REQUIRED_SETTINGS }),
      ),
    ).toBe(
      filteredGovernanceContext({ requiredLine: requiredSettingsFetchLine() }),
    );
  });

  it("renders exactly the governance lines the response carries", () => {
    expect(
      renderedContext(
        filteredQueryBody({
          candidates: FILTERED_UNDER_ANY_POLICY,
          skillAccess: null,
        }),
      ),
    ).toBe(filteredGovernanceContext({ policy: false }));
    expect(renderedContext(filteredQueryBody({ requiredSettings: [] }))).toBe(
      filteredGovernanceContext({ requiredLine: null }),
    );
    // Without governance there is still nothing useful to inject.
    expect(
      formatContext(
        {
          body: filteredQueryBody({
            candidates: FILTERED_UNDER_ANY_POLICY,
            skillAccess: null,
            requiredSettings: [],
          }),
        },
        "external_service",
      ),
    ).toBeNull();
  });

  it("keeps the raw-empty no_results context", () => {
    expect(
      renderedContext(
        filteredQueryBody({ candidates: {}, noResults: RAW_EMPTY_NO_RESULTS }),
      ),
    ).toBe(rawEmptyGovernanceContext());
  });

  it("keeps the governance beside a session skill loaded at session start", async () => {
    const env = testEnv({ REMEMBRANCE_API_KEY: ORG_API_KEY });
    const conversation = "cursor-session-governance";
    const started = await handleSessionStart(
      {
        hook_event_name: "sessionStart",
        conversation_id: conversation,
        session_id: conversation,
      },
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
    expect(
      started.additional_context.startsWith(CURSOR_REMEMBRANCE_CONTEXT),
    ).toBe(true);
    expect(started.additional_context).toContain(
      `${SESSION_SKILLS_DIRECTIVE_HEADER}\n- {"slug":"${SESSION_SKILL.slug}","version_id":"${SESSION_SKILL.version_id}","scope":"session",`,
    );
    expect(
      await handleMcpUse(
        {
          tool_name: "MCP:invoke_skill",
          conversation_id: conversation,
          result: invokeSkillToolResult(sessionInvokeSkillBody()),
        },
        { env, recordHealth: () => undefined },
      ),
    ).toMatchObject({ recorded: true, kind: "direct_selection", count: 0 });
    const context = renderedContext(filteredQueryBody(), env);
    expect(context).toBe(filteredGovernanceContext({ capture: "private" }));
    expect(context).not.toContain(SESSION_SKILL.slug);
  });
});
