// Maximum-size preference fixtures shared by every hook host's boundary tests,
// with the assertions each host applies to its own rendered output. Sizes are
// the core contract limits: eight required settings; 96-character keys,
// values and labels; 320-character behaviors; 160-character feedback IDs and
// skill slug. Each required behavior ends with the clause a cut would lose.
import { expect, vi } from "vitest";

export const TRIGGER_PROMPT =
  "Fix this Vercel Next.js build error in GitHub Actions.";
export const QUERY_ID = "rq_preference_boundary";
const MAX_CONTEXT_CHARS = 4000;

// An identifier of exactly `length` characters in the preference key grammar.
function identifier(prefix, length) {
  let text = prefix;
  for (let index = 0; text.length < length; index += 1) text += index % 10;
  return text;
}

// Text of exactly `length` characters that keeps `ending` whole at the end.
function sentence(start, length, ending) {
  const filler = " keep this organization rule in force for every task";
  let text = start;
  while (text.length + filler.length + ending.length + 1 <= length) {
    text += filler;
  }
  return `${text}${".".repeat(length - text.length - ending.length - 1)} ${ending}`;
}

export const MAX_REQUIRED_SETTINGS = Array.from({ length: 8 }, (_, index) => ({
  key: identifier(`org.required_${index}.k`, 96),
  value: identifier(`value_${index}.v`, 96),
  label: sentence(`Required setting ${index}`, 96, `L${index}.`),
  behavior: sentence(
    `R${index}-rule:`,
    320,
    `CRUCIAL-${index}: never deploy without written approval.`,
  ),
  effect: "workflow",
  strength: "prefer",
  definition_version: 1_000_000,
  source: "mandatory_org",
}));

// Eight required settings short enough to be shown complete.
export const FITTING_REQUIRED_SETTINGS = Array.from(
  { length: 8 },
  (_, index) => ({
    key: `org.rule_${index}`,
    value: "on",
    label: `Rule ${index}`,
    behavior: `R${index}-rule: keep release checks; CRUCIAL-${index}: never deploy without written approval.`,
    effect: "workflow",
    strength: "prefer",
    definition_version: 3,
    source: "mandatory_org",
  }),
);

export const MAX_DISCRETIONARY_SETTINGS = Array.from(
  { length: 32 },
  (_, index) => ({
    key: identifier(`strategy.pref_${index}.k`, 96),
    value: identifier(`choice_${index}.v`, 96),
    label: sentence(`Discretionary setting ${index}`, 96, `D${index}.`),
    behavior: sentence(`D${index}-rule:`, 320, `END-${index}.`),
    effect: "strategy_selection",
    strength: "prefer",
    definition_version: 1,
    source: "explicit_installation",
  }),
);

// explicit_member_runtime is the longest statement source (23 characters). On
// maximum discretionary settings it is the preference line's worst case: the
// first setting must still show whole, at 1,196 of the line's 1,200 characters.
export const LONGEST_SOURCE_DISCRETIONARY_SETTINGS =
  MAX_DISCRETIONARY_SETTINGS.map((setting) => ({
    ...setting,
    source: "explicit_member_runtime",
  }));

const STATEMENT_SCOPES = {
  mandatory_org: "organization",
  explicit_member_runtime: "member_runtime",
};

// A statement as the REST query route states it: the setting plus its scope,
// source, confidence and profile revision.
function statement(setting) {
  return {
    ...setting,
    scope: STATEMENT_SCOPES[setting.source] ?? "installation",
    confidence: 1,
    profile_revision: 4,
  };
}

// Each REST candidate repeats the statements beside the preference
// application core builds for it, as the query route sends them.
function candidate(index, statements) {
  return {
    slug: `org-release-runbook-${index}`,
    result_id: `qres_preference_boundary_${index}`,
    description: sentence(`Candidate ${index}:`, 800, "done."),
    match_tier: index === 0 ? "high" : "possible",
    match_reason: "Exact release workflow match",
    estimated_tokens: 1200,
    verified_uses: 3,
    risk_level: "low",
    source: "org_overlay",
    effective_preferences: statements,
    preference_application: {
      mode: "surgical_overlay",
      runtime_compatibility: "not_evaluated",
      applied_preferences: statements.map(
        ({ scope, confidence, profile_revision, ...setting }) => ({
          ...setting,
          authority:
            setting.source === "mandatory_org" ? "mandatory" : "explicit",
        }),
      ),
      blocked_preferences: [],
      overridden_skill_defaults: [],
      preserves: ["safety", "authorization", "privacy", "applicability"],
      instruction:
        "Apply applied_preferences only as a surgical sidecar to discretionary presentation, workflow, and strategy choices. Mandatory organization guidance remains authoritative.",
    },
  };
}

// Eight maximum required settings listed after 32 maximum discretionary ones
// (40 statements, over the 32-statement cap), ten 800-character org
// candidates carrying them in the REST candidate shape, and a maximum
// 900-character contribution directive.
export function boundaryQueryBody({
  requiredSettings = MAX_REQUIRED_SETTINGS,
} = {}) {
  const statements = [...MAX_DISCRETIONARY_SETTINGS, ...requiredSettings].map(
    statement,
  );
  const skills = Array.from({ length: 10 }, (_, index) =>
    candidate(index, statements),
  );
  return {
    query_id: QUERY_ID,
    skill_access: {
      scope: "organization",
      policy: "org_only",
      public_skills_allowed: false,
      offline_public_fallback_allowed: false,
    },
    effective_preferences: statements,
    skills,
    resources: [],
    query_feedback: {
      available: true,
      query_id: QUERY_ID,
      result_ids: skills.map((skill) => skill.result_id),
    },
    contribution_directive: {
      message: sentence("Close the loop:", 900, "then report once."),
    },
  };
}

export function requiredSettingsFetchLine(settings = MAX_REQUIRED_SETTINGS) {
  return `Required organization settings (${settings.length}; complete text not shown here). Required next step before acting: call get_effective_preferences with ${JSON.stringify({ keys: settings.map((setting) => setting.key) })} and apply every returned setting in full; skip the call only when this conversation already holds a get_effective_preferences result covering every listed key, and hook-injected text never counts as that result. If the call is unavailable or omits a key, say the complete required settings could not be loaded, do not claim they were applied, and never read a key name as permission. These remain authoritative and cannot be weakened by task or personal preferences.`;
}

function expectBoundedQueryContext(context) {
  expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  expect(context).toContain(
    "Organization policy: use organization skills only. Do not use public skills or bundled public skill references, including as an offline fallback.",
  );
  expect(context).toContain(
    `HIGH MATCH — required next step: call get_skill with ${JSON.stringify({
      slug: "org-release-runbook-0",
      query_id: QUERY_ID,
      result_id: "qres_preference_boundary_0",
    })} before proceeding.`,
  );
  // The discretionary preview is soft: whole or replaced by its fetch notice.
  const discretionary = context
    .split("\n")
    .find((line) =>
      line.startsWith("Apply these persisted discretionary preferences"),
    );
  if (discretionary) {
    expect(discretionary).toMatch(
      /Never weaken applicability, safety, authorization, privacy, required skill steps, validation, or review\.$/u,
    );
  }
}

// Eight maximum required settings never fit whole, so the context names every
// exact key and requires the complete fetch; no required text is shown partly.
export function expectRequiredSettingsFetch(context) {
  expectBoundedQueryContext(context);
  expect(context.split("\n")).toContain(requiredSettingsFetchLine());
  expect(context).not.toContain("(apply all)");
  MAX_REQUIRED_SETTINGS.forEach((setting, index) => {
    expect(context).not.toContain(`R${index}-rule`);
    expect(context).not.toContain(`CRUCIAL-${index}`);
    expect(context).not.toContain(`${setting.key}=`);
  });
}

export function requiredSettingsCompleteLine(
  settings = FITTING_REQUIRED_SETTINGS,
) {
  return `Required organization settings (apply all): ${settings
    .map((setting) => `${setting.key}=${setting.value}: ${setting.behavior}`)
    .join(
      "; ",
    )}. These remain authoritative and cannot be weakened by task or personal preferences.`;
}

// Required settings that fit are shown complete, crucial end clauses included.
export function expectRequiredSettingsComplete(
  context,
  settings = FITTING_REQUIRED_SETTINGS,
) {
  expectBoundedQueryContext(context);
  expect(context.split("\n")).toContain(requiredSettingsCompleteLine(settings));
  expect(context).not.toContain("complete text not shown here");
}

// Six typed notices of distinct required kinds: beside them the eight-key
// required line and the HIGH MATCH action no longer both fit.
export const PRESSURE_NOTICES = [
  "consent",
  "retention",
  "credential",
  "correction",
  "completion",
  "query_identity",
].map((kind, index) => ({
  id: `boundary_notice_${index}`,
  kind,
  text: sentence(
    `Remembrance ${kind} notice: do not skip it.`,
    600,
    `N${index}.`,
  ),
}));

export const REQUIRED_SETTINGS_KEYLESS_FETCH =
  "Required organization settings did not fit this context. Required next step before acting: call get_effective_preferences and apply every returned required organization setting in full. If the call is unavailable, say the complete required settings could not be loaded and do not claim they were applied.";

// Under that pressure the query action stays and the required settings become
// the keyless fetch, never a keyed line that evicts the action.
export function expectKeylessFetchKeepsQueryAction(context) {
  expectBoundedQueryContext(context);
  expect(context.split("\n")).toContain(REQUIRED_SETTINGS_KEYLESS_FETCH);
  expect(context).not.toContain("complete text not shown here");
  expect(context).not.toContain("(apply all)");
  MAX_REQUIRED_SETTINGS.forEach((setting, index) => {
    expect(context).not.toContain(`R${index}-rule`);
    expect(context).not.toContain(setting.key);
  });
}

// The worst-case discretionary settings beside one candidate, leaving the
// context room for the discretionary line.
export function discretionaryQueryBody() {
  const statements = LONGEST_SOURCE_DISCRETIONARY_SETTINGS.map(statement);
  return {
    query_id: QUERY_ID,
    effective_preferences: statements,
    skills: [candidate(0, statements)],
    resources: [],
  };
}

export function expectLongestSourceDiscretionaryLine(context) {
  const [first] = LONGEST_SOURCE_DISCRETIONARY_SETTINGS;
  const line = context
    .split("\n")
    .find((entry) =>
      entry.startsWith("Apply these persisted discretionary preferences"),
    );
  expect(line).toContain(
    `${first.label} [${first.effect}, ${first.source}]: prefer ${first.behavior}; +31 discretionary preferences omitted.`,
  );
  expect(line.length).toBeLessThanOrEqual(1200);
}

// --- Result sets whose every candidate the hooks filter out ----------------

// The trigger the hooks derive from TRIGGER_PROMPT.
const TRIGGER_REASON = "external_service";
const FILTERED_QUERY_ID = "rq_filtered_governance";
// In every filtered candidate's slug, result ID and description: its absence
// from a host's output proves no filtered candidate reached the agent.
const FILTERED_MARKER = "filtered-out";
const ORG_ONLY_SKILL_ACCESS = {
  scope: "organization",
  policy: "org_only",
  public_skills_allowed: false,
  offline_public_fallback_allowed: false,
};
export const ORG_ONLY_POLICY_LINE =
  "Organization policy: use organization skills only. Do not use public skills or bundled public skill references, including as an offline fallback.";
const FILTERED_DIRECTIVE = `Close the loop once you have evaluated these results. Reference query_id "${FILTERED_QUERY_ID}".`;

function filteredCandidate(name, fields) {
  return {
    slug: `${FILTERED_MARKER}-${name}`,
    result_id: `qres_${FILTERED_MARKER}-${name}`,
    description: `A ${FILTERED_MARKER} ${name} candidate.`,
    estimated_tokens: 900,
    verified_uses: 2,
    risk_level: "low",
    source: "org_overlay",
    ...fields,
  };
}

// The REST shapes the hooks keep out of auto-query context: the server's tier
// for an unlikely fit, an exploratory match, a public skill under an org_only
// policy, and an exploratory resource. The unlikely one also carries a
// preference-feedback offer.
const FILTERED_SKILLS = [
  filteredCandidate("unlikely", {
    match_tier: "exploratory",
    match_reason:
      "Topic match, but stated applicability does not fit this task",
    why_matched: {
      matched_terms: ["vercel", "build"],
      matched_capabilities: [],
      domain_match: true,
      satisfied_constraints: [],
      missed_constraints: [],
      lexical_signal: "strong",
      semantic_signal: "strong",
    },
    applicability: {
      fit: "unlikely",
      scope: "corner_case",
      reason: "No stated use condition matches this task",
      use_when: ["Edge runtime cold-start failure"],
      avoid_when: ["Routine build errors"],
    },
    preference_compatibility_feedback: {
      available: true,
      query_id: FILTERED_QUERY_ID,
      result_id: `qres_${FILTERED_MARKER}-unlikely`,
      skill_version_id: `skv_${FILTERED_MARKER}-unlikely`,
      preferences: [
        {
          preference_fingerprint: `sha256:${"a".repeat(64)}`,
          setting: {
            key: "workflow.test_timing",
            value: "before_commit",
            label: "Test timing",
            behavior: "Run tests before a commit.",
            effect: "workflow",
            strength: "prefer",
            definition_version: 1,
          },
        },
      ],
    },
  }),
  filteredCandidate("exploratory", {
    match_tier: "exploratory",
    applicability: {
      fit: "conditional",
      scope: "general",
      reason: "Some task constraints are not covered",
    },
  }),
  filteredCandidate("public", {
    match_tier: "high",
    match_reason: "Strong task and constraint coverage",
    source: "public",
    applicability: {
      fit: "likely",
      scope: "general",
      reason: "Stated use conditions match this task",
    },
  }),
];
// A possible match on weak signals: 0.1.x hooks filtered it out, while 0.2.0
// hooks show every possible skill the server returns, because the server's
// tier floor now decides (plan 15.4, P1 step 6).
export const WEAK_POSSIBLE_SKILL = filteredCandidate("weak", {
  match_tier: "possible",
  why_matched: {
    matched_terms: ["build"],
    matched_capabilities: [],
    domain_match: true,
    satisfied_constraints: [],
    missed_constraints: [],
    lexical_signal: "weak",
    semantic_signal: "moderate",
  },
  applicability: { fit: "unknown" },
});
const FILTERED_RESOURCE = filteredCandidate("resource", {
  kind: "documentation",
  match_tier: "exploratory",
});

export const FILTERED_CANDIDATE_CASES = [
  ["an unlikely corner case", { skills: [FILTERED_SKILLS[0]] }],
  ["an exploratory match", { skills: [FILTERED_SKILLS[1]] }],
  ["a public skill under an org_only policy", { skills: [FILTERED_SKILLS[2]] }],
  ["an exploratory resource", { resources: [FILTERED_RESOURCE] }],
  [
    "all of them together",
    { skills: FILTERED_SKILLS, resources: [FILTERED_RESOURCE] },
  ],
];
// Without an org_only policy the public skill is a real match.
export const FILTERED_UNDER_ANY_POLICY = {
  skills: FILTERED_SKILLS.filter((skill) => skill.source !== "public"),
  resources: [FILTERED_RESOURCE],
};

// A REST query response whose candidates the hooks all filter out, with the
// organization's policy and required settings; like the server, it has no
// no_results because its arrays are not empty.
export function filteredQueryBody({
  candidates = FILTERED_CANDIDATE_CASES.at(-1)[1],
  requiredSettings = FITTING_REQUIRED_SETTINGS,
  skillAccess = ORG_ONLY_SKILL_ACCESS,
  noResults = null,
} = {}) {
  const statements = requiredSettings.map(statement);
  const skills = (candidates.skills ?? []).map((skill) => ({
    ...skill,
    effective_preferences: statements,
  }));
  const resources = candidates.resources ?? [];
  return {
    query_id: FILTERED_QUERY_ID,
    ...(skillAccess ? { skill_access: skillAccess } : {}),
    effective_preferences: statements,
    skills,
    resources,
    query_feedback: {
      available: true,
      query_id: FILTERED_QUERY_ID,
      result_ids: [...skills, ...resources].map((item) => item.result_id),
    },
    contribution_directive: { message: FILTERED_DIRECTIVE },
    no_results: noResults,
  };
}

// The server's no_results for a raw-empty organization query.
export const RAW_EMPTY_NO_RESULTS = {
  reason: "no_matching_skills_or_resources",
  capture_learning_tool: "capture_learning",
  capture_route: "private_skill",
  contract_version: "private-learning-capture-v1",
  instruction:
    "If this task produced a complete reusable workflow, call capture_learning with private_skill and complete instructions, then invoke only its exact next_action.",
  missing_skill_request: null,
};

// The empty-result guidance, which depends on the local credential alone.
const EMPTY_RESULT_GUIDANCE = {
  public: [
    "Use the full conversation before deciding whether the workflow is genuinely missing. Propose a skill idea only when you built a reusable workflow that the registry does not already cover.",
    "Before finishing, submit a failure_report when the task exposed a reusable failure lesson.",
  ],
  private: [
    "Use the full conversation before deciding whether the workflow is genuinely missing. A complete reusable workflow belongs in capture_learning.private_skill; a compact generalized lesson belongs in capture_learning.lesson.",
    "If you build a reusable workflow or discover a reusable lesson, capture each new item once with private_skill or lesson. Follow its exact next_action or bounded agent_recovery instructions.",
  ],
};

// The exact context a host delivers for a filtered response: the empty-result
// context plus the organization policy and required settings. The shared
// allocator emits authority lines, which take in the unclassified empty-result
// guidance, then required settings, then completion lines, so only the public
// lane's "Before finishing" line follows the settings.
export function filteredGovernanceContext({
  requiredLine = requiredSettingsCompleteLine(),
  policy = true,
  capture = "public",
} = {}) {
  const [consider, closing] = EMPTY_RESULT_GUIDANCE[capture];
  return [
    "Remembrance auto-query context:",
    `Trigger: ${TRIGGER_REASON}. The query completed but returned no matching skill or resource.`,
    ...(policy ? [ORG_ONLY_POLICY_LINE] : []),
    consider,
    ...(capture === "private" ? [closing] : []),
    ...(requiredLine ? [requiredLine] : []),
    ...(capture === "public" ? [closing] : []),
  ].join("\n");
}

// The exact context for a raw-empty response, which the server marks with
// no_results: this path never used the empty-result guidance.
export function rawEmptyGovernanceContext({
  requiredLine = requiredSettingsCompleteLine(),
} = {}) {
  return [
    "Remembrance auto-query context:",
    `Trigger: ${TRIGGER_REASON}. Use these results only if they fit the user's task constraints.`,
    ORG_ONLY_POLICY_LINE,
    requiredLine,
    `After using Remembrance: ${FILTERED_DIRECTIVE}`,
    `Query receipt: ${FILTERED_QUERY_ID}. Use this query_id with the result IDs below when calling submit_query_feedback.`,
    "No matching skill/resource.",
  ].join("\n");
}

// The exact context when the query itself fails: no policy or required
// setting was received, so an organization key fails closed.
export function unavailableQueryText({ organization = true } = {}) {
  return [
    "Remembrance query-unavailable context:",
    "This task qualified for Remembrance, but the automatic query did not complete. Continue without blocking, and call query_skills directly when the MCP tool is visible.",
    organization
      ? "An organization API key is configured, but the organization skill policy could not be confirmed. Fail closed: do not use bundled public skill references while the query is unavailable."
      : "No organization API key is configured; bundled public references remain an optional offline fallback.",
    organization
      ? "If the outage or workaround produced a reusable lesson, complete workflow, or durable preference, call capture_learning once. Query-fit feedback is unavailable without a query receipt. Never switch destination or visibility when submission is unavailable."
      : "Before finishing, submit a failure_report only if the outage or workaround produced a reusable lesson. Redact secrets, private URLs, credentials, and proprietary content.",
  ].join("\n");
}

// A stubbed registry: a request whose path ends with a key of `routes` gets
// that JSON body, or that function's Response; any other request gets {}.
export function registryStub(routes = {}) {
  return vi.fn(async (url) => {
    const path = new URL(String(url)).pathname;
    const answer = Object.entries(routes).find(([suffix]) =>
      path.endsWith(suffix),
    )?.[1];
    if (typeof answer === "function") return answer();
    return Response.json(answer ?? {});
  });
}

// No filtered candidate, receipt, action or offer may reach the agent.
export function expectNoFilteredCandidate(text) {
  for (const hidden of [
    FILTERED_MARKER,
    "Query receipt",
    "HIGH MATCH",
    "Private preference evidence",
    "Skills:",
    "Resources:",
  ]) {
    expect(text).not.toContain(hidden);
  }
}

// --- Session-scoped skills beside a task query -----------------------------

export const ORG_API_KEY = "rk_filtered_governance_synthetic";
export const SESSION_SKILL = {
  slug: "pairing-mode",
  version_id: "sv_pairing_mode_1",
  pinned: false,
};

export function sessionSkillsListing() {
  return {
    contract_version: "session-skills-v1",
    available: true,
    reason_code: null,
    session_skills: [SESSION_SKILL],
    omitted_count: 0,
  };
}

// The first line of the session-start directive for SESSION_SKILL.
export const SESSION_SKILLS_DIRECTIVE_HEADER =
  "Remembrance organization session skills: before your first reply, call invoke_skill once per entry below with exactly these arguments, then follow each returned skill's instructions for the whole session.";

// invoke_skill's body when the agent loads SESSION_SKILL for the session.
export function sessionInvokeSkillBody() {
  return {
    ...invokeSkillBody({
      queryId: "rinv_pairing_mode_session",
      resultId: "qres_pairing_mode_session",
      versionId: SESSION_SKILL.version_id,
      slug: SESSION_SKILL.slug,
      settings: [],
    }),
    scope: "session",
  };
}

// --- Post-use preference evidence at the maximum valid sizes ---------------

export const FEEDBACK_QUERY_ID = identifier("rinv_", 160);
export const FEEDBACK_RESULT_ID = identifier("qres_", 160);
export const FEEDBACK_VERSION_ID = identifier("skv_", 160);
// The catalog slug grammar allows a leading digit; 160 characters exactly.
export const FEEDBACK_SKILL_SLUG = `${"1password-rotation-".repeat(9)}runbook-z`
  .slice(0, 158)
  .concat("zz");
export const FEEDBACK_FINGERPRINTS = [
  `sha256:${"e".repeat(64)}`,
  `sha256:${"f".repeat(64)}`,
];
export const MAX_FEEDBACK_SETTINGS = FEEDBACK_FINGERPRINTS.map((_, index) => ({
  key: identifier(`workflow.feedback_${index}.k`, 96),
  value: identifier(`choice_${index}.v`, 96),
  label: sentence(`Feedback setting ${index}`, 96, `F${index}.`),
  behavior: sentence(
    `F${index}-rule:`,
    320,
    `FINAL-${index}: keep the audit trail.`,
  ),
  effect: "workflow",
  strength: "prefer",
  definition_version: 1_000_000,
}));

// An explicit invoke_skill body in the shape the invocation route builds
// (apps/web/lib/skill-invocations.ts): the full offer, never compacted. Only
// query_skills MCP results state preferences once by fingerprint.
export function invokeSkillBody({
  queryId = FEEDBACK_QUERY_ID,
  resultId = FEEDBACK_RESULT_ID,
  versionId = FEEDBACK_VERSION_ID,
  slug = FEEDBACK_SKILL_SLUG,
  settings = MAX_FEEDBACK_SETTINGS.slice(0, 1),
} = {}) {
  const statements = settings.map((setting) => ({
    ...setting,
    scope: "member",
    source: "explicit_member",
    confidence: 1,
    profile_revision: 4,
  }));
  return {
    invocation_id: queryId,
    query_id: queryId,
    result_id: resultId,
    selection_mode: "explicit",
    scope: "task",
    preference_definition_version: "agent-preferences-v4",
    effective_preferences: statements,
    preference_compatibility_feedback: {
      available: true,
      query_id: queryId,
      result_id: resultId,
      skill_version_id: versionId,
      preferences: settings.map((setting, index) => ({
        preference_fingerprint: FEEDBACK_FINGERPRINTS[index],
        setting,
      })),
    },
    preference_application: {
      mode: "surgical_overlay",
      runtime_compatibility: "not_evaluated",
      applied_preferences: statements.map(
        ({ scope, confidence, profile_revision, ...setting }) => ({
          ...setting,
          authority: "explicit",
        }),
      ),
      blocked_preferences: [],
      overridden_skill_defaults: [],
      preserves: ["safety", "authorization", "privacy", "applicability"],
      instruction:
        "Apply applied_preferences only as a surgical sidecar to discretionary presentation, workflow, and strategy choices.",
    },
    telemetry_available: true,
    skill: {
      name: "Release credential rotation",
      slug,
      description: "Rotate release credentials.",
      version: 7,
      visibility: "organization",
      source: "org_overlay",
      version_id: versionId,
      skill_md: "# Instructions",
      task_outcome_eligible: true,
    },
    query_feedback: {
      available: false,
      reason:
        "Explicit selections use post-use feedback, not query-fit feedback.",
    },
    feedback: {
      available: true,
      correlated: true,
      tool: "submit_feedback",
      submit_url: "https://remembrance.dev/api/v1/agent/feedback",
      query_id: queryId,
      result_id: resultId,
      payload_template: {
        skill_slug: slug,
        query_id: queryId,
        result_id: resultId,
        useful: true,
        lesson: "Replace with a concise post-use lesson.",
        evidence: { artifact_hashes: [] },
      },
      instruction:
        "After use, call submit_feedback once. Submit next_step evidence only for a reusable lesson.",
    },
    task_outcome: {
      available: true,
      eligible_result_ids: [resultId],
      tool: "report_task_outcome",
      submit_url: "https://remembrance.dev/api/v1/agent/task-outcomes",
      query_id: queryId,
      instruction:
        "On completion or abandonment, report these IDs plus bounded tokens and latency when available; never send task content.",
    },
    subagent_handoff: {
      slug,
      version: 7,
      version_id: versionId,
      query_id: queryId,
      result_id: resultId,
      instruction:
        "Pass these IDs; the parent reports the outcome unless the subagent invokes separately.",
    },
  };
}

export function maxFeedbackInvocationBody({ count = 1 } = {}) {
  return invokeSkillBody({ settings: MAX_FEEDBACK_SETTINGS.slice(0, count) });
}

// The API envelope a Remembrance MCP server returns for invoke_skill, and the
// MCP tools/call result carrying it as compact JSON text: the two ways a host
// hands an invoke_skill result to its post-tool hook.
export function invokeSkillEnvelope(body) {
  return {
    ok: true,
    status: 200,
    idempotency_status: "created",
    rate_limit_remaining: "119",
    retry_after: null,
    etag: null,
    body,
  };
}

export function invokeSkillToolResult(body) {
  return {
    content: [
      { type: "text", text: JSON.stringify(invokeSkillEnvelope(body)) },
    ],
  };
}

export const INVOKE_SKILL_DELIVERIES = [
  ["API envelope", invokeSkillEnvelope],
  ["MCP tool result", invokeSkillToolResult],
];

export function preferenceEvidenceLine(text) {
  return String(text ?? "")
    .split("\n")
    .find((line) => line.startsWith("Private preference evidence"));
}

// A maximum setting cannot repeat in full within the 520-character hint, so the
// first offer stays as an exact compact reference with a fetch instruction and
// any further offer is counted, never dropped silently or cut.
export function expectMaxFeedbackHint(text, { count = 1 } = {}) {
  const line = preferenceEvidenceLine(text);
  expect(line).toBeDefined();
  expect(line).toContain("call submit_preference_compatibility_feedback");
  expect(line).toContain(
    "An entry without label and behavior is a compact reference: before judging it, read that setting in full with get_effective_preferences and its key.",
  );
  const candidates = line.slice(line.indexOf("Candidates: ") + 12);
  const payload = candidates.slice(0, candidates.lastIndexOf("]") + 1);
  expect(JSON.parse(payload)).toEqual([
    {
      query_id: FEEDBACK_QUERY_ID,
      result_id: FEEDBACK_RESULT_ID,
      skill_slug: FEEDBACK_SKILL_SLUG,
      skill_version_id: FEEDBACK_VERSION_ID,
      preference_fingerprint: FEEDBACK_FINGERPRINTS[0],
      setting: {
        key: MAX_FEEDBACK_SETTINGS[0].key,
        value: MAX_FEEDBACK_SETTINGS[0].value,
      },
    },
  ]);
  expect(candidates.slice(payload.length)).toBe(
    count > 1
      ? ` (+${count - 1} more offered preference${count > 2 ? "s" : ""} omitted to fit this hint.)`
      : "",
  );
  expect(line).not.toContain(MAX_FEEDBACK_SETTINGS[0].behavior.slice(0, 40));
}

// The post-use feedback line an explicit selection's obligation prompts. Its
// preference offer is never repeated there: the line ends with a pointer of at
// most 100 characters that names the offered keys when they fit.
export const OFFER_POINTER_TAIL =
  ": see your invoke_skill result or get_effective_preferences";

// VS Code's tool hooks name no subagent, so its first such line says so.
export const SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED =
  " [subagent identity unavailable: this host does not say whether you or a subagent received this and every debt tagged so; decline one with not_observed_by_this_agent if you did not receive it]";

export function feedbackObligationLine({
  slug = FEEDBACK_SKILL_SLUG,
  queryId = FEEDBACK_QUERY_ID,
  resultId = FEEDBACK_RESULT_ID,
  pointer,
  from = "",
} = {}) {
  return `- Post-use feedback for ${slug}${from}: call submit_feedback with query_id ${queryId} and result_id ${resultId}${pointer}.`;
}

export function expectOfferPointer(text, line, pointer) {
  expect(pointer.length).toBeLessThanOrEqual(100);
  expect(String(text).split("\n")).toContain(line);
  expect(text).not.toContain("Private preference evidence");
  expect(text).not.toContain("submit_preference_compatibility_feedback");
}

// A 96-character key cannot fit the pointer, so it points to the offer by
// count alone; neither the setting nor its key is repeated.
export function expectMaxFeedbackPointer(text, { count = 1, from = "" } = {}) {
  const pointer = `; offered preference${count === 1 ? "" : "s"}${OFFER_POINTER_TAIL}`;
  expectOfferPointer(text, feedbackObligationLine({ pointer, from }), pointer);
  for (const setting of MAX_FEEDBACK_SETTINGS) {
    expect(text).not.toContain(setting.key);
    expect(text).not.toContain(setting.behavior.slice(0, 40));
  }
}
