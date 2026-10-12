import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Namespace import: before the behaviour exists, each case fails on its own.
import * as hookCore from "../scripts/hook-core.mjs";
import { handleQuery } from "../scripts/query-on-prompt.mjs";
import {
  ANONYMOUS_ACCESS,
  DISCRETIONARY_SETTING,
  ORG_ALLOW_ACCESS,
  ORG_ONLY_ACCESS,
  REQUIRED_SETTING,
  registry,
  searchBody,
} from "./fixtures/search-hygiene.mjs";
import {
  EMPTY_QUERY_ID,
  KEYWORDS_ONLY,
  KEYWORD_CORRECTION,
  KEYWORD_PROMPT,
  TASK_SHAPE_CORRECTION,
  TASK_SHAPE_PROMPT,
  emptyBody,
  withoutNoMatchBlock,
} from "./fixtures/task-shape.mjs";

// Owner decision 34C (2026-09-29): a prompt no stop rule, keyword trigger or
// reuse rule decided is searched from 40 characters with trigger reason
// task_shape. An empty task-shape search differs from an empty keyword search
// in exactly three ways: no no-match block, no completion eligibility, no
// query-feedback obligation.

const { shouldQueryPrompt } = hookCore;
const TASK_SHAPE_DECISION = Object.freeze({ likely_match: true, reason: "task_shape" });
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/trigger-gap-benchmark.json", import.meta.url),
    "utf8",
  ),
);
const queries = fixture.queries;
const gold = queries.filter((query) => query.gold);

// The ten benchmark queries master missed that the closed keyword fixes
// search (trigger-gap.test.mjs), with the reason each keeps.
const CLOSED_FIX_REASONS = {
  "para-azure-validate-1": "workflow_shape",
  "para-azure-deploy-4": "workflow_shape",
  "legacy-remotion-video": "ui_or_dashboard_work",
  "distractor-mpp-1": "external_service",
  "para-find-skills-1": "reuse_request",
  "para-find-skills-3": "reuse_request",
  "para-find-skills-4": "reuse_request",
  "para-remembrancer-1": "reuse_request",
  "para-remembrancer-3": "reuse_request",
  "legacy-skills-discovery": "reuse_request",
};

describe("the task-shape default on the synthetic benchmark", () => {
  it("keeps every decision master made and searches each of master's 55 misses", () => {
    const newlySearched = {};
    for (const query of queries) {
      const decision = shouldQueryPrompt(query.summary, {});
      if (query.master_reason !== "no_trigger_match") {
        expect(decision.reason, query.id).toBe(query.master_reason);
      } else {
        expect(decision.likely_match, query.id).toBe(true);
        newlySearched[query.id] = decision.reason;
      }
    }
    const byReason = Object.entries(newlySearched);
    expect(byReason).toHaveLength(55);
    expect(byReason.filter(([, reason]) => reason === "task_shape")).toHaveLength(45);
    expect(
      Object.fromEntries(byReason.filter(([, reason]) => reason !== "task_shape")),
    ).toEqual(CLOSED_FIX_REASONS);
  });

  it("searches all 122 gold queries where the keyword triggers alone search 82", () => {
    const searched = (env) =>
      gold.filter((query) => shouldQueryPrompt(query.summary, env).likely_match)
        .length;
    expect(gold).toHaveLength(122);
    expect(searched({})).toBe(122);
    expect(searched(KEYWORDS_ONLY)).toBe(82);
    const misses = gold.filter((query) => query.master_reason === "no_trigger_match");
    expect(misses).toHaveLength(50);
    expect(
      misses.filter(
        (query) => shouldQueryPrompt(query.summary, {}).reason === "task_shape",
      ),
    ).toHaveLength(40);
  });

  it("also searches the five no-answer queries, as task_shape", () => {
    const noAnswer = queries.filter((query) => query.kind === "no_answer");
    expect(noAnswer).toHaveLength(5);
    for (const query of noAnswer) {
      expect(shouldQueryPrompt(query.summary, {}), query.id).toEqual({
        likely_match: true,
        reason: "task_shape",
      });
    }
  });
});

describe("the task-shape rule", () => {
  const SHORT = "Please tidy up these notes for me today";
  const LONG = `${SHORT}.`;
  const NOT_SEARCHED = { likely_match: false, reason: "no_trigger_match" };
  const TASK_SHAPE = { likely_match: true, reason: "task_shape" };

  it("searches from 40 characters of the user's own text", () => {
    expect(SHORT).toHaveLength(39);
    expect(LONG).toHaveLength(40);
    expect(shouldQueryPrompt(SHORT, {})).toEqual(NOT_SEARCHED);
    expect(shouldQueryPrompt(LONG, {})).toEqual(TASK_SHAPE);
    // Surrounding whitespace and a host envelope the hook strips do not count.
    expect(shouldQueryPrompt(`   ${SHORT}\n\n  `, {})).toEqual(NOT_SEARCHED);
    const envelope =
      "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>\n";
    expect(shouldQueryPrompt(`${envelope}${SHORT}`, {})).toEqual(NOT_SEARCHED);
    expect(shouldQueryPrompt(`${envelope}${LONG}`, {})).toEqual(TASK_SHAPE);
  });

  it.each(["0", "false", "no", "FALSE", "No"])(
    "REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=%s restores keyword-only searching",
    (value) => {
      const env = { REMEMBRANCE_AUTO_QUERY_TASK_SHAPE: value };
      expect(shouldQueryPrompt(LONG, env)).toEqual(NOT_SEARCHED);
      expect(shouldQueryPrompt(KEYWORD_PROMPT, env)).toEqual({
        likely_match: true,
        reason: "ui_or_dashboard_work",
      });
    },
  );

  it.each([undefined, "", "1", "true", "yes", "on"])(
    "keeps the default on for REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=%s",
    (value) => {
      expect(
        shouldQueryPrompt(LONG, { REMEMBRANCE_AUTO_QUERY_TASK_SHAPE: value }),
      ).toEqual(TASK_SHAPE);
    },
  );

  it("reads the switch from the process environment when no env is passed", () => {
    const before = process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE;
    try {
      process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE = "0";
      expect(shouldQueryPrompt(LONG)).toEqual(NOT_SEARCHED);
      delete process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE;
      expect(shouldQueryPrompt(LONG)).toEqual(TASK_SHAPE);
    } finally {
      if (before === undefined) delete process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE;
      else process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE = before;
    }
  });

  it("leaves every stop rule and keyword trigger in charge at 40 characters and more", () => {
    const cases = [
      ["What is the difference between these two approaches to the notes?", "skip_pattern", false],
      ["The remembrance-production-workspace session is now authenticated.", "status_acknowledgment", false],
      ["Use the Remembrance skill named release-checklist for this change please.", "explicit_skill_reference", false],
      ["<task-notification>Please tidy up these notes for me today and tomorrow.</task-notification>", "host_notification", false],
      [KEYWORD_PROMPT, "ui_or_dashboard_work", true],
      [KEYWORD_CORRECTION, "external_service", true],
    ];
    for (const [prompt, reason, likely] of cases) {
      expect(prompt.length).toBeGreaterThanOrEqual(40);
      const decision = { likely_match: likely, reason };
      expect(shouldQueryPrompt(prompt, {}), prompt).toEqual(decision);
      expect(shouldQueryPrompt(prompt, KEYWORDS_ONLY), prompt).toEqual(decision);
    }
  });

  it("keeps a contextual continuation on its full-conversation directive at 40 characters and more", () => {
    for (const prompt of [
      "Fix all these issues you found in the review, one by one please",
      "Review the latest changes on this branch and tell me what you think",
      "Run the tests again and summarize whatever is still failing for me",
    ]) {
      expect(prompt.length).toBeGreaterThanOrEqual(40);
      expect(hookCore.isContextualContinuationPrompt(prompt), prompt).toBe(true);
      expect(shouldQueryPrompt(prompt, {}), prompt).toEqual(NOT_SEARCHED);
    }
    // A continuation a keyword trigger matches is searched, as before.
    const keyword =
      "Fix these issues in the Vercel deployment before the next release";
    expect(hookCore.isContextualContinuationPrompt(keyword)).toBe(true);
    expect(shouldQueryPrompt(keyword, {})).toEqual({
      likely_match: true,
      reason: "external_service",
    });
  });

  it("leaves hygiene in charge of host text the default would search", () => {
    const handback = [
      '<agent-message from="worker-3">',
      "[Subagent hand-back]",
      "Summarized the open questions from the notes for the team.",
      "</agent-message>",
    ].join("\n");
    expect(shouldQueryPrompt(handback, {})).toEqual({
      likely_match: false,
      reason: "hygiene_subagent_handback",
      hygiene: "subagent_handback",
      trigger: "task_shape",
    });
    expect(
      shouldQueryPrompt(handback, { REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
    ).toEqual(TASK_SHAPE);
    expect(shouldQueryPrompt(handback, KEYWORDS_ONLY)).toEqual(NOT_SEARCHED);
    for (const query of queries) {
      expect(hookCore.searchHygieneReason(query.summary), query.id).toBeNull();
    }
  });
});

// --- What the hook delivers ---------------------------------------------------

const hookRoot = mkdtempSync(join(tmpdir(), "remembrance-task-shape-"));
let hookCounter = 0;

beforeAll(() => {
  for (const [key, name] of [
    ["HOME", "home"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
    ["TMPDIR", "tmp"],
  ]) {
    mkdirSync(join(hookRoot, name), { recursive: true });
    vi.stubEnv(key, join(hookRoot, name));
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(hookRoot, { recursive: true, force: true });
});

function hookEnv(extra = {}) {
  hookCounter += 1;
  const root = join(hookRoot, `run-${hookCounter}`);
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    REMEMBRANCE_AGENT_KEY_PATH: join(root, "config", "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(root, "sessions"),
    REMEMBRANCE_CODEX_CONFIG_PATH: join(root, "missing-codex.toml"),
    REMEMBRANCE_HEALTH_REPORTING: "0",
    ...extra,
  };
}

const orgEnv = (extra = {}) =>
  hookEnv({
    REMEMBRANCE_API_KEY: "rk_task_shape_org_key",
    REMEMBRANCE_PROJECT_KEY: "prj_taskshapeproject00001",
    ...extra,
  });

// Each empty registry answer, for each kind of caller.
const EMPTY_CASES = [
  ["an anonymous caller", hookEnv, ANONYMOUS_ACCESS, [], {}],
  [
    "an organization with a policy and preferences",
    orgEnv,
    ORG_ONLY_ACCESS,
    [REQUIRED_SETTING, DISCRETIONARY_SETTING],
    {},
  ],
  [
    "an organization with a discretionary preference only",
    orgEnv,
    ORG_ALLOW_ACCESS,
    [DISCRETIONARY_SETTING],
    {},
  ],
  ["an organization whose answer governs nothing", orgEnv, ORG_ALLOW_ACCESS, [], {}],
  [
    "an organization with a policy and preferences, every candidate dropped",
    orgEnv,
    ORG_ONLY_ACCESS,
    [REQUIRED_SETTING, DISCRETIONARY_SETTING],
    { filtered: true },
  ],
  [
    "an organization with a discretionary preference only, every candidate dropped",
    orgEnv,
    ORG_ALLOW_ACCESS,
    [DISCRETIONARY_SETTING],
    { filtered: true },
  ],
  [
    "an anonymous caller, every candidate dropped",
    hookEnv,
    ANONYMOUS_ACCESS,
    [],
    { filtered: true },
  ],
];

const adviceLines = (env) =>
  hookCore.emptyQueryContext("task_shape", env).split("\n").slice(2);

describe("runPromptHook with the task-shape default", () => {
  it("searches with trigger reason task_shape, the redacted text and the preview cap", async () => {
    const secret = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
    const prompt = `${TASK_SHAPE_PROMPT} The shared token is ${secret}. ${"Keep every heading short. ".repeat(60)}`;
    const searched = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    const env = hookEnv();
    const result = await hookCore.runPromptHook(prompt, {
      env,
      fetchImpl: searched.fetchImpl,
    });
    expect(searched.queries()).toHaveLength(1);
    const [request] = searched.queries();
    expect(request.body.client_context).toMatchObject({
      surface: "plugin_hook",
      trigger_reason: "task_shape",
    });
    expect(request.body.task.summary).not.toContain(secret);
    expect(request.body.task.summary.length).toBeLessThanOrEqual(1200);
    expect(request.body.task.summary).toBe(
      hookCore.buildQueryPayload(prompt, env).task.summary,
    );
    expect(result).toMatchObject({
      consumed: true,
      matched: true,
      eligible: true,
      reason: "task_shape",
    });
  });

  it("sends nothing with the switch off", async () => {
    const searched = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    expect(
      await hookCore.runPromptHook(TASK_SHAPE_PROMPT, {
        env: hookEnv(KEYWORDS_ONLY),
        fetchImpl: searched.fetchImpl,
      }),
    ).toBeNull();
    expect(searched.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["an anonymous caller", hookEnv, ANONYMOUS_ACCESS, []],
    ["an organization", orgEnv, ORG_ONLY_ACCESS, [REQUIRED_SETTING, DISCRETIONARY_SETTING]],
  ])(
    "delivers a task-shape search with results exactly as a keyword-triggered one for %s",
    async (_label, makeEnv, access, preferences) => {
      const keyword = registry({ query: searchBody(access, preferences) });
      const shaped = registry({ query: searchBody(access, preferences) });
      const byKeyword = await hookCore.runPromptHook(KEYWORD_PROMPT, {
        env: makeEnv(),
        fetchImpl: keyword.fetchImpl,
      });
      const byShape = await hookCore.runPromptHook(TASK_SHAPE_PROMPT, {
        env: makeEnv(),
        fetchImpl: shaped.fetchImpl,
      });
      expect(byKeyword.context).toContain("Trigger: ui_or_dashboard_work.");
      expect(byShape).toEqual({
        ...byKeyword,
        reason: "task_shape",
        context: byKeyword.context.replace(
          "Trigger: ui_or_dashboard_work.",
          "Trigger: task_shape.",
        ),
      });
      expect(byShape).toMatchObject({
        consumed: true,
        matched: true,
        eligible: true,
        queryFeedback: { available: true, query_id: "rq_hygiene" },
      });
    },
  );

  it.each(EMPTY_CASES)(
    "differs from an empty keyword search only by the no-match block, eligibility and the feedback obligation for %s",
    async (_label, makeEnv, access, preferences, options) => {
      const body = emptyBody(access, preferences, options);
      const keyword = registry({ query: body });
      const shaped = registry({ query: body });
      const env = makeEnv();
      const byKeyword = await hookCore.runPromptHook(KEYWORD_PROMPT, {
        env,
        fetchImpl: keyword.fetchImpl,
      });
      const byShape = await hookCore.runPromptHook(TASK_SHAPE_PROMPT, {
        env: makeEnv(),
        fetchImpl: shaped.fetchImpl,
      });
      // Both searched once, the same way apart from the prompt's own text.
      expect(keyword.queries()).toHaveLength(1);
      expect(shaped.queries()).toHaveLength(1);
      expect(shaped.queries()[0].body.client_context).toEqual({
        ...keyword.queries()[0].body.client_context,
        trigger_reason: "task_shape",
      });
      expect(byKeyword.context).toMatch(/^Trigger: ui_or_dashboard_work\./mu);
      expect(byKeyword).toMatchObject({
        consumed: true,
        matched: false,
        eligible: true,
        queryFeedback: { available: true, query_id: EMPTY_QUERY_ID },
      });
      expect(byShape.context).toBe(
        withoutNoMatchBlock(byKeyword.context, adviceLines(env)) ?? "",
      );
      expect(byShape).toMatchObject({
        consumed: true,
        matched: false,
        eligible: false,
        reason: "task_shape",
      });
      expect(byShape.queryFeedback ?? null).toBeNull();
      expect(byShape.deliveredContextAdditionIds).toEqual(
        byKeyword.deliveredContextAdditionIds,
      );
    },
  );

  it.each(EMPTY_CASES)(
    "keeps a correction's capture, its eligibility and every addition for %s",
    async (_label, makeEnv, access, preferences, options) => {
      const body = emptyBody(access, preferences, options);
      const notice = {
        id: "client_update",
        kind: "notice",
        text: "Remembrance plugin update available.",
      };
      const keyword = registry({ query: body });
      const shaped = registry({ query: body });
      const env = makeEnv();
      const byKeyword = await hookCore.runPromptHook(KEYWORD_CORRECTION, {
        env,
        fetchImpl: keyword.fetchImpl,
        contextAdditions: [notice],
      });
      const byShape = await hookCore.runPromptHook(TASK_SHAPE_CORRECTION, {
        env: makeEnv(),
        fetchImpl: shaped.fetchImpl,
        contextAdditions: [notice],
      });
      expect(hookCore.promptContainsUserCorrection(KEYWORD_CORRECTION)).toBe(true);
      expect(hookCore.promptContainsUserCorrection(TASK_SHAPE_CORRECTION)).toBe(true);
      expect(shaped.queries()).toHaveLength(1);
      expect(byShape.context).toBe(
        withoutNoMatchBlock(byKeyword.context, adviceLines(env)),
      );
      expect(byShape.context.split("\n")[0]).toBe("Remembrance auto-query context:");
      expect(byShape.context).toContain(notice.text);
      expect(byShape.context).toContain(
        hookCore.userCorrectionCaptureDirective(TASK_SHAPE_CORRECTION, env).split("\n")[0],
      );
      expect(byShape.deliveredContextAdditionIds).toEqual(
        byKeyword.deliveredContextAdditionIds,
      );
      expect(byShape.deliveredContextAdditionIds).toEqual(
        expect.arrayContaining(["client_update", "correction_capture"]),
      );
      // A correction keeps its own eligibility; the obligation stays absent.
      expect(byShape).toMatchObject({ consumed: true, matched: false, eligible: true });
      expect(byShape.queryFeedback ?? null).toBeNull();
      expect(byKeyword.queryFeedback).toEqual({
        available: true,
        query_id: EMPTY_QUERY_ID,
      });
    },
  );

  it("keeps a durable-preference capture on an empty task-shape search", async () => {
    const prompt =
      "Always answer me in short bullet points from now on, for every reply please.";
    const env = hookEnv();
    expect(shouldQueryPrompt(prompt, env)).toEqual(TASK_SHAPE_DECISION);
    const shaped = registry({ query: emptyBody(ANONYMOUS_ACCESS, []) });
    const result = await hookCore.runPromptHook(prompt, {
      env,
      fetchImpl: shaped.fetchImpl,
    });
    expect(shaped.queries()).toHaveLength(1);
    expect(result.context.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(result.context).toContain(
      hookCore.genericPreferenceCaptureDirective(prompt, { env }).split("\n")[0],
    );
    expect(result.context).not.toMatch(/^Trigger: |No matching skill\/resource|^Query receipt: /mu);
    expect(result.deliveredContextAdditionIds).toEqual(["preference_capture"]);
    expect(result).toMatchObject({ consumed: true, matched: false, eligible: false });
  });

  it("keeps a continuation's directive at 40 characters and more", async () => {
    const prompt = "Fix all these issues you found in the review, one by one please";
    const searched = registry({});
    const result = await hookCore.runPromptHook(prompt, {
      env: hookEnv(),
      fetchImpl: searched.fetchImpl,
      reportDirectiveShown: false,
    });
    expect(searched.queries()).toEqual([]);
    expect(result).toMatchObject({
      consumed: false,
      eligible: true,
      reason: "contextual_continuation",
      directive: { trigger_reason: "contextual_continuation" },
    });
    expect(result.context.split("\n")).toContain(
      "Remembrance task-continuation reminder:",
    );
  });
});


describe("the Codex adapter on an empty task-shape search", () => {
  it("prints nothing and records no eligibility or feedback obligation, and still ends an earlier directive", async () => {
    const env = hookEnv();
    const directives = [];
    const recordDirective = (_sessionId, directive) => directives.push(directive);
    const keywordOutput = await handleQuery(
      { prompt: KEYWORD_PROMPT, turn_id: "t-keyword-empty" },
      {
        env,
        fetchImpl: registry({ query: emptyBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
        recordDirective,
      },
    );
    const shapeOutput = await handleQuery(
      { prompt: TASK_SHAPE_PROMPT, turn_id: "t-shape-empty" },
      {
        env,
        fetchImpl: registry({ query: emptyBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
        recordDirective,
      },
    );
    expect(keywordOutput.hookSpecificOutput.additionalContext).toContain(
      "No matching skill/resource.",
    );
    expect(shapeOutput).toBeNull();
    expect(hookCore.readTaskEligibilityCount("t-keyword-empty", env)).toBe(1);
    expect(hookCore.readTaskEligibilityCount("t-shape-empty", env)).toBe(0);
    expect(
      hookCore.readCompletionObligations("t-keyword-empty", env).map((item) => item.kind),
    ).toEqual(["query_feedback"]);
    expect(hookCore.readCompletionObligations("t-shape-empty", env)).toEqual([]);
    expect(hookCore.readRegistryUseCount("t-shape-empty", env)).toBe(0);
    // Both completed searches end an earlier continuation directive.
    expect(directives).toEqual([null, null]);
  });

  it("records a correction's eligibility and prints only its capture", async () => {
    const env = hookEnv();
    const output = await handleQuery(
      { prompt: TASK_SHAPE_CORRECTION, turn_id: "t-shape-correction" },
      {
        env,
        fetchImpl: registry({ query: emptyBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
      },
    );
    const context = output.hookSpecificOutput.additionalContext;
    expect(context.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(context).toContain(
      hookCore.userCorrectionCaptureDirective(TASK_SHAPE_CORRECTION, env).split("\n")[0],
    );
    expect(context).not.toMatch(/^Trigger: |No matching skill\/resource|^Query receipt: /mu);
    expect(hookCore.readTaskEligibilityCount("t-shape-correction", env)).toBe(1);
    expect(hookCore.readCompletionObligations("t-shape-correction", env)).toEqual([]);
  });

  it("keeps a task-shape search with results eligible, counted and owed feedback", async () => {
    const env = hookEnv();
    const output = await handleQuery(
      { prompt: TASK_SHAPE_PROMPT, turn_id: "t-shape-hit" },
      {
        env,
        fetchImpl: registry({ query: searchBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Trigger: task_shape.",
    );
    expect(hookCore.readTaskEligibilityCount("t-shape-hit", env)).toBe(1);
    expect(hookCore.readRegistryUseCount("t-shape-hit", env)).toBe(1);
    expect(
      hookCore.readCompletionObligations("t-shape-hit", env).map((item) => item.kind),
    ).toContain("query_feedback");
  });
});
