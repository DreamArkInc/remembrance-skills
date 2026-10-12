import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handleHookInput } from "../scripts/query-on-prompt.mjs";
import * as hookCore from "../scripts/hook-core.mjs";
import {
  ANONYMOUS_ACCESS,
  DISCRETIONARY_SETTING,
  ORG_ALLOW_ACCESS,
  ORG_ONLY_ACCESS,
  REQUIRED_SETTING,
  registry,
  searchBody,
} from "../../codex-plugin/test/fixtures/search-hygiene.mjs";
import {
  KEYWORDS_ONLY,
  KEYWORD_CORRECTION,
  KEYWORD_PROMPT,
  TASK_SHAPE_CORRECTION,
  TASK_SHAPE_PROMPT,
  emptyBody,
  withoutNoMatchBlock,
} from "../../codex-plugin/test/fixtures/task-shape.mjs";

// Owner decision 34C: an empty task-shape search differs from an empty
// keyword search only by its missing no-match block, completion eligibility
// and query-feedback obligation.

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-claude-code-task-shape-"));
let counter = 0;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv(extra = {}) {
  counter += 1;
  const root = resolve(tempRoot, `run-${counter}`);
  return {
    XDG_CONFIG_HOME: resolve(root, "config"),
    XDG_STATE_HOME: resolve(root, "state"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: resolve(root, "alerts"),
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(root, "cache.json"),
    REMEMBRANCE_USAGE_DIR: resolve(root, "usage"),
    REMEMBRANCE_AGENT_KEY_PATH: resolve(root, "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: resolve(root, "sessions"),
    REMEMBRANCE_HEALTH_REPORTING: "0",
    ...extra,
  };
}

const orgEnv = (extra = {}) =>
  testEnv({
    REMEMBRANCE_API_KEY: "rk_task_shape_org_key",
    REMEMBRANCE_PROJECT_KEY: "prj_taskshapeproject00001",
    ...extra,
  });

// One prompt through the hook with its own recorders: what it printed (null
// for nothing) and what it left in the prompt's ledger.
async function run(prompt, env, fetchImpl) {
  counter += 1;
  const input = {
    hook_event_name: "UserPromptSubmit",
    prompt,
    session_id: `task-shape-session-${counter}`,
  };
  const output = await handleHookInput(input, {
    env,
    fetchImpl,
    recordHealth: vi.fn(),
  });
  const ledgerId = hookCore.agentLedgerIdFor(input);
  return {
    context: output?.hookSpecificOutput?.additionalContext ?? null,
    eligibility: hookCore.readTaskEligibilityCount(ledgerId, env),
    obligations: hookCore
      .readCompletionObligations(ledgerId, env)
      .map((item) => item.kind),
    uses: hookCore.readRegistryUseCount(ledgerId, env),
  };
}

const EMPTY_CASES = [
  ["an anonymous caller", testEnv, ANONYMOUS_ACCESS, [], {}],
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
    "an anonymous caller, every candidate dropped",
    testEnv,
    ANONYMOUS_ACCESS,
    [],
    { filtered: true },
  ],
];

// The empty-result advice lines of a keyword search. This adapter renders a
// filtered-out answer with the process environment's variant.
const adviceLines = (env) => [
  ...hookCore.emptyQueryContext("task_shape", env).split("\n").slice(2),
  ...hookCore.emptyQueryContext("task_shape").split("\n").slice(2),
];

describe("Claude Code prompt hook with the task-shape default", () => {
  it("searches a task-shaped prompt with trigger reason task_shape, and not with the switch off", async () => {
    const searched = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    const shaped = await run(TASK_SHAPE_PROMPT, testEnv(), searched.fetchImpl);
    expect(searched.queries()).toHaveLength(1);
    const [request] = searched.queries();
    expect(request.body.client_context).toMatchObject({
      surface: "plugin_hook",
      trigger_reason: "task_shape",
    });
    expect(request.headers["user-agent"]).toMatch(/^@remembrance\/claude-code-plugin(?:\/|$)/u);
    expect(shaped.context).toContain("Trigger: task_shape.");
    expect(shaped).toMatchObject({ eligibility: 1, uses: 1 });
    expect(shaped.obligations).toContain("query_feedback");

    const off = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    expect(
      await run(TASK_SHAPE_PROMPT, testEnv(KEYWORDS_ONLY), off.fetchImpl),
    ).toEqual({ context: null, eligibility: 0, obligations: [], uses: 0 });
    expect(off.queries()).toEqual([]);
  });

  it.each(EMPTY_CASES)(
    "differs from an empty keyword search only by the no-match block, eligibility and the feedback obligation for %s",
    async (_label, makeEnv, access, preferences, options) => {
      const body = emptyBody(access, preferences, options);
      const keyword = registry({ query: body });
      const shaped = registry({ query: body });
      const env = makeEnv();
      const byKeyword = await run(KEYWORD_PROMPT, env, keyword.fetchImpl);
      const byShape = await run(TASK_SHAPE_PROMPT, makeEnv(), shaped.fetchImpl);
      expect(keyword.queries()).toHaveLength(1);
      expect(shaped.queries()).toHaveLength(1);
      expect(shaped.queries()[0].body.client_context).toEqual({
        ...keyword.queries()[0].body.client_context,
        trigger_reason: "task_shape",
      });
      expect(byKeyword.context).toMatch(/^Trigger: ui_or_dashboard_work\./mu);
      expect(byKeyword).toMatchObject({
        eligibility: 1,
        obligations: ["query_feedback"],
        uses: 0,
      });
      expect(byShape).toEqual({
        context: withoutNoMatchBlock(byKeyword.context, adviceLines(env)),
        eligibility: 0,
        obligations: [],
        uses: 0,
      });
    },
  );

  it.each(EMPTY_CASES)(
    "keeps a correction's capture and its eligibility for %s",
    async (_label, makeEnv, access, preferences, options) => {
      const body = emptyBody(access, preferences, options);
      const keyword = registry({ query: body });
      const shaped = registry({ query: body });
      const env = makeEnv();
      const byKeyword = await run(KEYWORD_CORRECTION, env, keyword.fetchImpl);
      const byShape = await run(TASK_SHAPE_CORRECTION, makeEnv(), shaped.fetchImpl);
      expect(shaped.queries()).toHaveLength(1);
      expect(byShape.context).toBe(
        withoutNoMatchBlock(byKeyword.context, adviceLines(env)),
      );
      expect(byShape.context.split("\n")[0]).toBe("Remembrance auto-query context:");
      expect(byShape.context).toContain(
        hookCore.userCorrectionCaptureDirective(TASK_SHAPE_CORRECTION, env).split("\n")[0],
      );
      expect(byShape).toMatchObject({ eligibility: 1, obligations: [], uses: 0 });
      expect(byKeyword).toMatchObject({
        eligibility: 1,
        obligations: ["query_feedback"],
      });
    },
  );

  it("serves a repeated empty task-shape prompt from the cache the same way", async () => {
    const env = orgEnv();
    const shaped = registry({
      query: emptyBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING, DISCRETIONARY_SETTING]),
    });
    const first = await run(TASK_SHAPE_PROMPT, env, shaped.fetchImpl);
    const second = await run(TASK_SHAPE_PROMPT, env, shaped.fetchImpl);
    expect(shaped.queries()).toHaveLength(1);
    expect(first.context).toContain("Required organization settings");
    expect(second).toEqual(first);
    expect(second).toMatchObject({ eligibility: 0, obligations: [] });

    const anonymous = testEnv();
    const empty = registry({ query: emptyBody(ANONYMOUS_ACCESS, []) });
    expect(await run(TASK_SHAPE_PROMPT, anonymous, empty.fetchImpl)).toEqual({
      context: null,
      eligibility: 0,
      obligations: [],
      uses: 0,
    });
    const corrected = await run(TASK_SHAPE_CORRECTION, anonymous, empty.fetchImpl);
    const repeated = await run(TASK_SHAPE_CORRECTION, anonymous, empty.fetchImpl);
    expect(empty.queries()).toHaveLength(2);
    expect(repeated).toEqual(corrected);
    expect(repeated).toMatchObject({ eligibility: 1, obligations: [] });
    expect(await run(TASK_SHAPE_PROMPT, anonymous, empty.fetchImpl)).toMatchObject({
      context: null,
      eligibility: 0,
    });
    expect(empty.queries()).toHaveLength(2);
  });

  it("treats an unavailable task-shape query as any unavailable query", async () => {
    const keyword = await run(
      KEYWORD_PROMPT,
      testEnv(),
      registry({ queryStatus: 503 }).fetchImpl,
    );
    const shaped = await run(
      TASK_SHAPE_PROMPT,
      testEnv(),
      registry({ queryStatus: 503 }).fetchImpl,
    );
    expect(shaped.context).toBe(keyword.context);
    expect(shaped.context).toContain(
      hookCore.unavailableQueryContext(testEnv()).split("\n")[1],
    );
    expect(shaped).toMatchObject({ eligibility: 1, obligations: [] });
    expect(keyword).toMatchObject({ eligibility: 1, obligations: [] });
  });

  it("keeps a task-shape search with results as any search", async () => {
    const keyword = await run(
      KEYWORD_PROMPT,
      testEnv(),
      registry({ query: searchBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
    );
    const shaped = await run(
      TASK_SHAPE_PROMPT,
      testEnv(),
      registry({ query: searchBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
    );
    expect(shaped.context).toBe(
      keyword.context.replace("Trigger: ui_or_dashboard_work.", "Trigger: task_shape."),
    );
    expect(shaped).toEqual({ ...keyword, context: shaped.context });
    expect(shaped).toMatchObject({ eligibility: 1, uses: 1 });
    expect(shaped.obligations).toContain("query_feedback");
  });
});
