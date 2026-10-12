import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handleHookInput } from "../scripts/query-on-prompt.mjs";
import {
  sharedConfigCredentialNotice,
  unavailableQueryContext,
  userCorrectionCaptureDirective,
} from "../scripts/hook-core.mjs";
import {
  ANONYMOUS_ACCESS,
  DISCRETIONARY_SETTING,
  ORG_ALLOW_ACCESS,
  ORG_ONLY_ACCESS,
  REQUIRED_SETTING,
  STOPPED_PROMPT,
  effectiveBody,
  registry,
  searchBody,
  withoutResults,
} from "../../codex-plugin/test/fixtures/search-hygiene.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-claude-code-hygiene-"));
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
    REMEMBRANCE_API_KEY: "rk_hygiene_org_key",
    REMEMBRANCE_PROJECT_KEY: "prj_hygieneproject0000001",
    ...extra,
  });

async function run(prompt, env, fetchImpl, extra = {}) {
  counter += 1;
  const output = await handleHookInput(
    {
      hook_event_name: "UserPromptSubmit",
      prompt,
      session_id: `hygiene-session-${counter}`,
    },
    { env, fetchImpl, recordHealth: vi.fn(), ...extra },
  );
  return output?.hookSpecificOutput?.additionalContext ?? null;
}

describe("Claude Code prompt hook on a stopped search", () => {
  it("delivers what a search would have governed the task with, without searching", async () => {
    const searched = registry({
      query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING, DISCRETIONARY_SETTING]),
    });
    const search = await run(
      STOPPED_PROMPT,
      orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
    );
    const stopped = registry({
      effective: effectiveBody(ORG_ONLY_ACCESS, [
        REQUIRED_SETTING,
        DISCRETIONARY_SETTING,
      ]),
    });
    const recordEligibility = vi.fn();
    const skipped = await run(STOPPED_PROMPT, orgEnv(), stopped.fetchImpl, {
      recordEligibility,
    });

    expect(searched.queries()).toHaveLength(1);
    expect(search).toContain("HIGH MATCH");
    expect(stopped.queries()).toEqual([]);
    expect(stopped.effectives()).toHaveLength(1);
    const [request] = stopped.effectives();
    const [searchRequest] = searched.queries();
    expect(request.body).toEqual({
      keys: [],
      domains: [searchRequest.body.task.domain],
      project_key: searchRequest.body.client_context.project_key,
    });
    expect(request.headers["x-remembrance-api-key"]).toBe("rk_hygiene_org_key");
    expect(request.headers["user-agent"]).toMatch(/^@remembrance\/claude-code-plugin(?:\/|$)/u);
    expect(skipped).toBe(withoutResults(search));
    expect(skipped.split("\n")).toHaveLength(4);
    expect(skipped).toContain("Organization policy: use organization skills only.");
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it("delivers nothing and asks nothing for an anonymous caller", async () => {
    const searched = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    const search = await run(
      STOPPED_PROMPT,
      testEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
    );
    const stopped = registry({});
    expect(await run(STOPPED_PROMPT, testEnv(), stopped.fetchImpl)).toBeNull();
    expect(withoutResults(search)).toBeNull();
    expect(stopped.fetchImpl).not.toHaveBeenCalled();
  });

  // A failed read never costs a delivery: the hook runs the search the rule
  // stopped, exactly as it runs with the rule off; only when that search fails
  // too does the fail-closed line apply.
  const QUERY = { query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]) };
  it.each([
    ["an unavailable status", { effectiveStatus: 503 }],
    ["a network failure", { effectiveThrows: new TypeError("fetch failed") }],
    ["a timeout", { effectiveHangs: true }],
  ])("runs the stopped search as it runs without the rule after %s", async (_label, failure) => {
    const timeout = { REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" };
    const searched = registry(QUERY);
    const searchEligibility = vi.fn();
    const search = await run(
      STOPPED_PROMPT,
      orgEnv({ ...timeout, REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
      { recordEligibility: searchEligibility },
    );
    const stopped = registry({ ...QUERY, ...failure });
    const recordEligibility = vi.fn();
    const skipped = await run(STOPPED_PROMPT, orgEnv(timeout), stopped.fetchImpl, {
      recordEligibility,
    });
    expect(stopped.effectives()).toHaveLength(1);
    expect(stopped.queries()).toHaveLength(1);
    expect(stopped.queries()[0].body).toEqual(searched.queries()[0].body);
    expect(search).toContain("Required organization settings");
    expect(skipped).toBe(search);
    expect(recordEligibility).toHaveBeenCalledTimes(searchEligibility.mock.calls.length);
  });

  it("fails closed as an unavailable query does when the search fails too", async () => {
    const searched = registry({ queryStatus: 503 });
    const search = await run(
      STOPPED_PROMPT,
      orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
    );
    const env = orgEnv();
    const stopped = registry({ queryStatus: 503, effectiveStatus: 503 });
    const skipped = await run(STOPPED_PROMPT, env, stopped.fetchImpl);
    expect(stopped.queries()).toHaveLength(1);
    expect(skipped.split("\n")).toContain(
      unavailableQueryContext(env).split("\n")[2],
    );
    expect(skipped).toBe(search);
  });

  it("fails closed without a request when the shared config is unusable, as a search does", async () => {
    const unusable = (extra = {}) => {
      const env = testEnv(extra);
      mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true });
      writeFileSync(
        join(env.XDG_CONFIG_HOME, "remembrance", "config.json"),
        "{not json",
      );
      return env;
    };
    const searched = registry(QUERY);
    const search = await run(
      STOPPED_PROMPT,
      unusable({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
    );
    const env = unusable();
    const stopped = registry(QUERY);
    const skipped = await run(STOPPED_PROMPT, env, stopped.fetchImpl);
    expect(stopped.fetchImpl).not.toHaveBeenCalled();
    expect(skipped).toContain(unavailableQueryContext(env).split("\n")[2]);
    expect(skipped).toContain(sharedConfigCredentialNotice(env));
    expect(skipped).toBe(search);
  });

  // Whatever a stopped search delivers opens with the header a search's
  // context opens with, so a consumer reads both paths the same way.
  it.each([
    ["an organization whose search would govern nothing", () => orgEnv(), ORG_ALLOW_ACCESS],
    ["an anonymous caller", () => testEnv(), ANONYMOUS_ACCESS],
  ])("gives a correction the search context's header for %s", async (_label, makeEnv, access) => {
    const prompt =
      "/security-review You broke the build: the Stripe webhook deploy on Vercel fails again.";
    const searched = registry({ query: searchBody(access, []) });
    const search = await run(
      prompt,
      { ...makeEnv(), REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" },
      searched.fetchImpl,
    );
    const stopped = registry({ effective: effectiveBody(access, []) });
    const skipped = await run(prompt, makeEnv(), stopped.fetchImpl);
    expect(stopped.queries()).toEqual([]);
    expect(skipped.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(skipped).not.toContain("Remembrance capture routing:");
    expect(skipped).toBe(withoutResults(search));
  });

  it("keeps the correction capture and its eligibility", async () => {
    const prompt =
      "/security-review You broke the build: the Stripe webhook deploy on Vercel fails again.";
    const searched = registry({
      query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]),
    });
    const search = await run(
      prompt,
      orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      searched.fetchImpl,
    );
    const stopped = registry({
      effective: effectiveBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]),
    });
    const recordEligibility = vi.fn();
    const skipped = await run(prompt, orgEnv(), stopped.fetchImpl, {
      recordEligibility,
    });
    expect(stopped.queries()).toEqual([]);
    expect(skipped).toBe(withoutResults(search));
    expect(skipped).toContain(
      userCorrectionCaptureDirective(prompt, orgEnv()).split("\n")[0],
    );
    expect(recordEligibility).toHaveBeenCalledTimes(1);
  });
});
