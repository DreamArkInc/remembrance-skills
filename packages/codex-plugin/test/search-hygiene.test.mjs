import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
// Namespace import: before the export exists, each case fails on its own.
import * as hookCore from "../scripts/hook-core.mjs";
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
} from "./fixtures/search-hygiene.mjs";
import { KEYWORDS_ONLY } from "./fixtures/task-shape.mjs";

const searchHygieneReason = (prompt) => hookCore.searchHygieneReason(prompt);
// What a hook query stores as its summary: the redacted prompt cut to 1,200
// characters. Hygiene must decide a stored summary as the whole prompt does,
// or err toward stopping the search (never toward searching host text).
const storedSummary = (prompt) =>
  hookCore.buildQueryPayload(prompt, {}).task.summary;

const filler = (label, count) =>
  Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join(
    "\n",
  );

// Synthetic prompts shaped like each host's own text. None is user text.
const COMMIT_PROMPT = [
  "Using the supplied git context below, generate a git commit message.",
  "Write the result into the structured response field message.",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "+export const deployToVercel = true;",
].join("\n");
const PULL_REQUEST_PROMPT = [
  "You are a helpful assistant. Generate a pull request title and body.",
  "Write the result into the structured response fields title and body.",
  "",
  "Commits: add the vercel deployment workflow",
].join("\n");
const COMMIT_AND_PULL_REQUEST_PROMPT = [
  "Using the supplied commit and pull request contexts below, generate one git commit message plus one pull request title and body.",
  "Write the result into the structured response fields message, title, and body.",
  "",
  "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
].join("\n");
const HANDBACK = [
  '<agent-message from="worker-7">',
  "[Subagent hand-back]",
  "Deployed the Next.js preview to Vercel; the MongoDB migration ran clean.",
  "</agent-message>",
].join("\n");
const BOARD_NOTIFICATION = [
  "<agent_message_board_notification>A teammate posted: the vercel deploy finished.</agent_message_board_notification>",
  "[Use read_post for the rest.]",
].join("\n");
const PERSISTED_OUTPUT = [
  "<persisted-output>",
  "Output too large (49.4KB). Full output saved to: /tmp/tool-results/abc.txt",
  "",
  "Preview (first 2KB):",
  "npm ERR! vercel build failed",
  "</persisted-output>",
].join("\n");
const GIT_STATUS = [
  "On branch main",
  "Your branch is up to date with 'origin/main'.",
  "",
  "Changes not staged for commit:",
  '  (use "git add <file>..." to update what will be committed)',
  "\tmodified:   vercel.json",
  "",
  'no changes added to commit (use "git add" and/or "git commit -a")',
].join("\n");
const COMPARTMENT_BLOCK = [
  "<compartment_examples_from_other_projects>",
  "<compartment>An earlier project configured a Vercel deployment.</compartment>",
  "</compartment_examples_from_other_projects>",
].join("\n");

describe("searchHygieneReason", () => {
  it.each([
    ["a Codex commit-message generation prompt", COMMIT_PROMPT],
    ["a Codex pull-request generation prompt", PULL_REQUEST_PROMPT],
    [
      "a Codex commit and pull-request generation prompt",
      COMMIT_AND_PULL_REQUEST_PROMPT,
    ],
    [
      "a generation prompt with Windows line endings",
      COMMIT_PROMPT.replace(/\n/gu, "\r\n"),
    ],
  ])("names %s host_generation_prompt", (_label, prompt) => {
    expect(searchHygieneReason(prompt)).toBe("host_generation_prompt");
  });

  it("names a subagent hand-back subagent_handback, closed or cut", () => {
    expect(searchHygieneReason(HANDBACK)).toBe("subagent_handback");
    expect(searchHygieneReason(HANDBACK.replace("</agent-message>", ""))).toBe(
      "subagent_handback",
    );
  });

  it("names a message-board notification host_notification_relay", () => {
    expect(searchHygieneReason(BOARD_NOTIFICATION)).toBe(
      "host_notification_relay",
    );
    expect(
      searchHygieneReason(
        BOARD_NOTIFICATION.replace("\n[Use read_post for the rest.]", ""),
      ),
    ).toBe("host_notification_relay");
  });

  it("names a persisted tool output tool_output_echo", () => {
    expect(searchHygieneReason(PERSISTED_OUTPUT)).toBe("tool_output_echo");
  });

  it("names pasted git status output status_output", () => {
    expect(searchHygieneReason(GIT_STATUS)).toBe("status_output");
    expect(
      searchHygieneReason(
        [
          "HEAD detached at 1a2b3c4",
          "Untracked files:",
          '  (use "git add <file>..." to include in what will be committed)',
          "\tnext.config.ts",
          "",
          'nothing added to commit but untracked files present (use "git add" to track)',
        ].join("\n"),
      ),
    ).toBe("status_output");
  });

  it.each([
    [
      "a Codex skill mention link",
      "[$vercel-deploy](/home/dev/.codex/skills/vercel-deploy/SKILL.md) ship the preview build",
    ],
    ["a namespaced slash command", "/deploy-kit:ship-preview to vercel now"],
    ["a dashed slash command", "/security-review the stripe webhook handler"],
    ["a bare dashed slash command", "/code-review"],
  ])("names %s local_skill_reference", (_label, prompt) => {
    expect(searchHygieneReason(prompt)).toBe("local_skill_reference");
  });

  it("sees a marker after leading host envelopes the hook strips", () => {
    expect(
      searchHygieneReason(
        `<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>\n${COMMIT_PROMPT}`,
      ),
    ).toBe("host_generation_prompt");
  });

  it.each([
    [
      "user text after a hand-back",
      `${HANDBACK}\nNow deploy the Next.js app to Vercel.`,
    ],
    [
      "user text after a board notification",
      `${BOARD_NOTIFICATION}\nNow deploy the Next.js app to Vercel.`,
    ],
    [
      "user text after a persisted output",
      `${PERSISTED_OUTPUT}\nWhy does the vercel build fail?`,
    ],
    [
      "a question after git status output",
      `${GIT_STATUS}\n\nWhy does the vercel deploy fail with these changes?`,
    ],
    ["a lone branch line", "On branch main"],
    [
      "a generation instruction the user typed mid-prompt",
      `Please fix the build.\n${COMMIT_PROMPT}`,
    ],
    [
      "a first generation line without the host's second line",
      "Using the supplied git context below, generate a git commit message.\nKeep it short.",
    ],
    [
      "a hand-back phrase outside its envelope",
      "[Subagent hand-back] deploy the Next.js app to Vercel",
    ],
    [
      "an agent message that is not a hand-back",
      '<agent-message from="lead">\nPlease migrate the MongoDB schema.</agent-message>',
    ],
    ["a MongoDB stage", "$lookup is slow on my MongoDB collection"],
    ["a Svelte rune", "$state does not update my Svelte component"],
    ["a JSON Schema keyword", "$ref resolution fails in the OpenAPI build"],
    [
      "a Codex app connector link",
      "[$github](app://connector_123) open the failing CI run",
    ],
    ["an absolute path", "/usr/local/bin/node crashes when npm installs"],
    ["a single-word slash", "/deploy the Next.js app to Vercel"],
    [
      "a skill mention later in the prompt",
      "Deploy it with [$vercel-deploy](/home/dev/.codex/skills/vercel-deploy/SKILL.md)",
    ],
    ["an ordinary task", "Set up the Stripe webhook integration on Vercel"],
    ["an empty prompt", ""],
  ])("returns null for %s", (_label, prompt) => {
    expect(searchHygieneReason(prompt)).toBeNull();
  });

  it("never stops the search for an injected context block", () => {
    expect(
      searchHygieneReason(
        `${COMPARTMENT_BLOCK}\nFix the Vercel deployment of the Next.js app.`,
      ),
    ).toBeNull();
    expect(searchHygieneReason(COMPARTMENT_BLOCK)).toBeNull();
    expect(
      searchHygieneReason(
        COMPARTMENT_BLOCK.replace(
          "</compartment_examples_from_other_projects>",
          "",
        ),
      ),
    ).toBeNull();
  });

  it("leaves a host notification to the host-notification rule", () => {
    const notification =
      "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>";
    expect(hookCore.isHostNotificationPrompt(notification)).toBe(true);
    expect(searchHygieneReason(notification)).toBeNull();
  });

  it("decides a stored 1,200-character summary as the whole prompt", () => {
    const long = (prompt, closing = null) =>
      closing
        ? prompt.replace(closing, `${filler("body", 120)}\n${closing}`)
        : `${prompt}\n${filler("body", 120)}`;
    const cases = [
      [long(COMMIT_PROMPT), "host_generation_prompt"],
      [long(HANDBACK, "</agent-message>"), "subagent_handback"],
      [
        long(BOARD_NOTIFICATION, "</agent_message_board_notification>"),
        "host_notification_relay",
      ],
      [long(PERSISTED_OUTPUT, "</persisted-output>"), "tool_output_echo"],
      [
        GIT_STATUS.replace(
          "\tmodified:   vercel.json",
          Array.from(
            { length: 80 },
            (_, index) => `\tmodified:   src/file-${index}.ts`,
          ).join("\n"),
        ),
        "status_output",
      ],
      [
        `/security-review ${filler("scope", 120)}`,
        "local_skill_reference",
      ],
      [`Set up the Vercel deploy.\n${filler("note", 120)}`, null],
      [`${COMPARTMENT_BLOCK}\n${filler("note", 120)}`, null],
    ];
    for (const [prompt, reason] of cases) {
      expect(prompt.length).toBeGreaterThan(1_200);
      const summary = storedSummary(prompt);
      expect(summary.length).toBeLessThanOrEqual(1_200);
      expect([searchHygieneReason(prompt), searchHygieneReason(summary)]).toEqual(
        [reason, reason],
      );
    }
  });

  it("errs toward stopping when a cut hides the user's text after host text", () => {
    // The stored summary ends inside the envelope, so it cannot show the
    // user's line after it; the replay then over-counts stops, never misses one.
    const prompt = `${HANDBACK.replace(
      "</agent-message>",
      `${filler("report", 120)}\n</agent-message>`,
    )}\nNow deploy the Next.js app to Vercel.`;
    expect(searchHygieneReason(prompt)).toBeNull();
    expect(searchHygieneReason(storedSummary(prompt))).toBe("subagent_handback");
  });
});

// --- The hook's decision and what a stopped search still delivers -----------

const hygieneRoot = mkdtempSync(join(tmpdir(), "remembrance-hygiene-"));
let hygieneCounter = 0;

beforeAll(() => {
  for (const [key, name] of [
    ["HOME", "home"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
    ["TMPDIR", "tmp"],
  ]) {
    mkdirSync(join(hygieneRoot, name), { recursive: true });
    vi.stubEnv(key, join(hygieneRoot, name));
  }
});

function hookEnv(extra = {}) {
  hygieneCounter += 1;
  const root = join(hygieneRoot, `run-${hygieneCounter}`);
  return {
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    REMEMBRANCE_AGENT_KEY_PATH: join(root, "config", "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(root, "sessions"),
    REMEMBRANCE_HEALTH_REPORTING: "0",
    ...extra,
  };
}

const orgEnv = (extra = {}) =>
  hookEnv({
    REMEMBRANCE_API_KEY: "rk_hygiene_org_key",
    REMEMBRANCE_PROJECT_KEY: "prj_hygieneproject0000001",
    ...extra,
  });


describe("shouldQueryPrompt with search hygiene", () => {
  it("stops a triggered search on host text and names both reasons", () => {
    expect(hookCore.shouldQueryPrompt(STOPPED_PROMPT, {})).toEqual({
      likely_match: false,
      reason: "hygiene_host_generation_prompt",
      hygiene: "host_generation_prompt",
      trigger: "external_service",
    });
    expect(
      hookCore.shouldQueryPrompt(
        "/security-review the Stripe webhook deploy on Vercel",
        {},
      ),
    ).toEqual({
      likely_match: false,
      reason: "hygiene_local_skill_reference",
      hygiene: "local_skill_reference",
      trigger: "external_service",
    });
  });

  it.each(["0", "false", "no"])(
    "searches again when REMEMBRANCE_AUTO_QUERY_HYGIENE=%s",
    (value) => {
      expect(
        hookCore.shouldQueryPrompt(STOPPED_PROMPT, {
          REMEMBRANCE_AUTO_QUERY_HYGIENE: value,
        }),
      ).toEqual({ likely_match: true, reason: "external_service" });
    },
  );

  it("leaves a prompt no trigger matched as it was", () => {
    const neutralStatus = GIT_STATUS.replace("vercel.json", "notes.txt");
    expect(hookCore.searchHygieneReason(neutralStatus)).toBe("status_output");
    expect(hookCore.shouldQueryPrompt(neutralStatus, KEYWORDS_ONLY)).toEqual({
      likely_match: false,
      reason: "no_trigger_match",
    });
    // The task-shape default (owner decision 34C) would search it as a task;
    // hygiene stops that search as it stops a keyword-triggered one.
    expect(hookCore.shouldQueryPrompt(neutralStatus, {})).toEqual({
      likely_match: false,
      reason: "hygiene_status_output",
      hygiene: "status_output",
      trigger: "task_shape",
    });
  });

  it("leaves an ordinary triggered prompt searching", () => {
    expect(
      hookCore.shouldQueryPrompt(
        `${GIT_STATUS}\n\nWhy does the vercel deploy fail with these changes?`,
        {},
      ),
    ).toEqual({ likely_match: true, reason: "external_service" });
  });
});

describe("runPromptHook on a stopped search", () => {
  it("delivers the organization policy and preferences a search would have, without searching", async () => {
    const searched = registry({
      query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING, DISCRETIONARY_SETTING]),
    });
    const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      fetchImpl: searched.fetchImpl,
    });
    const stopped = registry({
      effective: effectiveBody(ORG_ONLY_ACCESS, [
        REQUIRED_SETTING,
        DISCRETIONARY_SETTING,
      ]),
    });
    const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: orgEnv(),
      fetchImpl: stopped.fetchImpl,
    });

    expect(searched.queries()).toHaveLength(1);
    expect(search.context).toContain("HIGH MATCH");
    expect(stopped.queries()).toEqual([]);
    expect(stopped.effectives()).toHaveLength(1);
    const [request] = stopped.effectives();
    const [searchRequest] = searched.queries();
    expect(request.body).toEqual({
      keys: [],
      domains: [searchRequest.body.task.domain],
      project_key: searchRequest.body.client_context.project_key,
    });
    expect(request.body.project_key).toBe("prj_hygieneproject0000001");
    expect(request.headers["x-remembrance-api-key"]).toBe("rk_hygiene_org_key");

    expect(skipped).toMatchObject({
      consumed: false,
      eligible: false,
      reason: "hygiene_host_generation_prompt",
    });
    expect(skipped.context).toBe(withoutResults(search.context));
    const lines = skipped.context.split("\n");
    expect(lines[0]).toBe("Remembrance auto-query context:");
    expect(lines[1]).toMatch(/^Organization policy: use organization skills only\./u);
    expect(lines[2]).toMatch(/^Required organization settings \(apply all\): workflow\.release_approval=written/u);
    expect(lines[3]).toMatch(/^Apply these persisted discretionary preferences silently: Explanation depth/u);
    expect(lines).toHaveLength(4);
  });

  it("delivers nothing and asks nothing for an anonymous caller, as a search's results are all it would add", async () => {
    const searched = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: hookEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      fetchImpl: searched.fetchImpl,
    });
    const stopped = registry({});
    const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: hookEnv(),
      fetchImpl: stopped.fetchImpl,
    });
    expect(search.context).toContain("HIGH MATCH");
    expect(withoutResults(search.context)).toBeNull();
    expect(skipped).toBeNull();
    expect(stopped.fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers nothing for an organization whose search would govern nothing", async () => {
    const access = ORG_ALLOW_ACCESS;
    const searched = registry({ query: searchBody(access, []) });
    const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      fetchImpl: searched.fetchImpl,
    });
    const stopped = registry({ effective: effectiveBody(access, []) });
    expect(
      await hookCore.runPromptHook(STOPPED_PROMPT, {
        env: orgEnv(),
        fetchImpl: stopped.fetchImpl,
      }),
    ).toBeNull();
    expect(withoutResults(search.context)).toBeNull();
    expect(stopped.effectives()).toHaveLength(1);
    expect(stopped.queries()).toEqual([]);
  });

  // A failed read never costs a delivery: the hook runs the search the rule
  // stopped, exactly as it runs with the rule off, and only when that search
  // fails too does the fail-closed line apply.
  const EFFECTIVE_FAILURES = [
    ["an unavailable status", { effectiveStatus: 503 }],
    ["a server error", { effectiveStatus: 500 }],
    ["a network failure", { effectiveThrows: new TypeError("fetch failed") }],
    ["a timeout", { effectiveHangs: true }],
    [
      "a response without the policy",
      { effective: { definition_version: "agent-preferences-v4", effective_preferences: [REQUIRED_SETTING] } },
    ],
  ];
  const QUERY = { query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]) };

  it.each(EFFECTIVE_FAILURES)(
    "runs the stopped search as it runs without the rule after %s",
    async (_label, failure) => {
      const timeout = { REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" };
      const searched = registry(QUERY);
      const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
        env: orgEnv({ ...timeout, REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
        fetchImpl: searched.fetchImpl,
      });
      const stopped = registry({ ...QUERY, ...failure });
      const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
        env: orgEnv(timeout),
        fetchImpl: stopped.fetchImpl,
      });

      expect(stopped.effectives()).toHaveLength(1);
      expect(stopped.queries()).toHaveLength(1);
      expect(stopped.queries()[0].body).toEqual(searched.queries()[0].body);
      expect(search.context).toContain("Required organization settings");
      expect(skipped).toEqual(search);
    },
  );

  it.each(EFFECTIVE_FAILURES)(
    "fails closed as an unavailable query does when the search fails too after %s",
    async (_label, failure) => {
      const timeout = { REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" };
      const searched = registry({ queryStatus: 503 });
      const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
        env: orgEnv({ ...timeout, REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
        fetchImpl: searched.fetchImpl,
      });
      const stopped = registry({ queryStatus: 503, ...failure });
      const env = orgEnv(timeout);
      const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
        env,
        fetchImpl: stopped.fetchImpl,
      });

      const failClosed = hookCore.unavailableQueryContext(env).split("\n")[2];
      expect(failClosed).toMatch(/^An organization API key is configured, but the organization skill policy could not be confirmed\. Fail closed/u);
      expect(stopped.queries()).toHaveLength(1);
      expect(skipped.context.split("\n")).toContain(failClosed);
      expect(skipped).toEqual(search);
    },
  );

  it("fails closed without a request when the shared config is unusable, as a search does", async () => {
    const unusable = () => {
      const env = hookEnv();
      mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true });
      writeFileSync(join(env.XDG_CONFIG_HOME, "remembrance", "config.json"), "{not json");
      return env;
    };
    const searched = registry(QUERY);
    const searchEnv = unusable();
    searchEnv.REMEMBRANCE_AUTO_QUERY_HYGIENE = "0";
    const search = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: searchEnv,
      fetchImpl: searched.fetchImpl,
    });
    const stopped = registry(QUERY);
    const env = unusable();
    const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env,
      fetchImpl: stopped.fetchImpl,
    });
    expect(stopped.fetchImpl).not.toHaveBeenCalled();
    const unavailable = hookCore.unavailableQueryContext(env).split("\n");
    expect(skipped.context).toContain(unavailable[2]);
    expect(skipped.context).toContain(hookCore.sharedConfigCredentialNotice(env));
    expect(skipped).toEqual(search);
  });

  // Whatever a stopped search delivers opens with the header a search's
  // context opens with, so a consumer reads both paths the same way.
  it.each([
    ["an organization whose search would govern nothing", () => orgEnv(), ORG_ALLOW_ACCESS],
    ["an anonymous caller", () => hookEnv(), ANONYMOUS_ACCESS],
  ])(
    "gives a correction the search context's header for %s",
    async (_label, makeEnv, access) => {
      const prompt =
        "/security-review You broke the build: the Stripe webhook deploy on Vercel fails again.";
      const searched = registry({ query: searchBody(access, []) });
      const search = await hookCore.runPromptHook(prompt, {
        env: { ...makeEnv(), REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" },
        fetchImpl: searched.fetchImpl,
      });
      const stopped = registry({ effective: effectiveBody(access, []) });
      const skipped = await hookCore.runPromptHook(prompt, {
        env: makeEnv(),
        fetchImpl: stopped.fetchImpl,
      });
      expect(stopped.queries()).toEqual([]);
      expect(skipped.context.split("\n")[0]).toBe("Remembrance auto-query context:");
      expect(skipped.context).not.toContain("Remembrance capture routing:");
      expect(skipped.context).toBe(withoutResults(search.context));
      expect(skipped).toMatchObject({ consumed: false, eligible: true });
    },
  );

  it("keeps every other delivery the prompt carries", async () => {
    const prompt =
      "/security-review You broke the build: the Stripe webhook deploy on Vercel fails again.";
    const searched = registry({
      query: searchBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]),
    });
    const notice = { id: "client_update", kind: "notice", text: "Remembrance plugin update available." };
    const search = await hookCore.runPromptHook(prompt, {
      env: orgEnv({ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }),
      fetchImpl: searched.fetchImpl,
      contextAdditions: [notice],
    });
    const stopped = registry({
      effective: effectiveBody(ORG_ONLY_ACCESS, [REQUIRED_SETTING]),
    });
    const skipped = await hookCore.runPromptHook(prompt, {
      env: orgEnv(),
      fetchImpl: stopped.fetchImpl,
      contextAdditions: [notice],
    });
    expect(hookCore.promptContainsUserCorrection(prompt)).toBe(true);
    expect(stopped.queries()).toEqual([]);
    expect(skipped.context).toBe(withoutResults(search.context));
    expect(skipped.context).toContain(notice.text);
    expect(skipped.context).toContain(
      hookCore.userCorrectionCaptureDirective(prompt, orgEnv()).split("\n")[0],
    );
    expect(skipped.deliveredContextAdditionIds).toEqual(
      expect.arrayContaining(["client_update", "correction_capture"]),
    );
    // A correction still makes the turn eligible for completion recovery.
    expect(skipped).toMatchObject({ consumed: false, eligible: true });
  });

  it("delivers a caller's notices for an anonymous caller", async () => {
    const stopped = registry({});
    const skipped = await hookCore.runPromptHook(STOPPED_PROMPT, {
      env: hookEnv(),
      fetchImpl: stopped.fetchImpl,
      contextAdditions: [
        { id: "client_update", kind: "notice", text: "Remembrance plugin update available." },
      ],
    });
    expect(stopped.fetchImpl).not.toHaveBeenCalled();
    expect(skipped.context.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(skipped.context).toContain("Remembrance plugin update available.");
    expect(skipped).toMatchObject({ consumed: false, eligible: false });
  });
});

// --- Off-by-default: search the text after an injected context block --------

describe("REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT", () => {
  const STRIP = { REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT: "1" };
  const REQUEST = "Fix the flaky Playwright test in the CI pipeline.";

  it("leaves the prompt whole unless switched on", () => {
    const prompt = `${COMPARTMENT_BLOCK}\n${REQUEST}`;
    expect(hookCore.searchTextForPrompt(prompt, {})).toBe(prompt);
    expect(
      hookCore.searchTextForPrompt(prompt, {
        REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT: "0",
      }),
    ).toBe(prompt);
  });

  it.each([
    ["the request after a leading block", `${COMPARTMENT_BLOCK}\n${REQUEST}`, REQUEST],
    ["nothing when only the block was sent", COMPARTMENT_BLOCK, ""],
    [
      "a prompt whose block is not closed",
      COMPARTMENT_BLOCK.replace("</compartment_examples_from_other_projects>", ""),
      null,
    ],
    ["a prompt whose block is not leading", `${REQUEST}\n${COMPARTMENT_BLOCK}`, null],
  ])("searches %s", (_label, prompt, expected) => {
    expect(hookCore.searchTextForPrompt(prompt, STRIP)).toBe(expected ?? prompt);
  });

  it("queries only the user's text after the block when switched on", async () => {
    const prompt = `${COMPARTMENT_BLOCK}\n${REQUEST}`;
    const summaries = async (env) => {
      const seen = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
      await hookCore.runPromptHook(prompt, { env, fetchImpl: seen.fetchImpl });
      return seen.queries().map((request) => request.body.task.summary);
    };
    expect(await summaries(hookEnv())).toEqual([prompt]);
    expect(await summaries(hookEnv(STRIP))).toEqual([REQUEST]);
  });

  it("does not search the block's own words when nothing follows it", async () => {
    const seen = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    expect(hookCore.shouldQueryPrompt(COMPARTMENT_BLOCK, {}).likely_match).toBe(true);
    await hookCore.runPromptHook(COMPARTMENT_BLOCK, {
      env: hookEnv(STRIP),
      fetchImpl: seen.fetchImpl,
    });
    expect(seen.queries()).toEqual([]);
  });
});

// Owner decision 40 = B: when Jev leaves candidates undecided, the server's
// relevance judge may take 2 s on the hook instead of 1 s, but only for a
// hook that says its search waits that long. The search waits 3 s by
// default and says so; the hook's other registry requests keep 2 s, so a
// stopped search whose preference read and search both hang now costs 5 s.
describe("the search's wait for the relevance judge", () => {
  const PROMPT = "Why does the vercel deploy fail with these changes?";
  const WAITS = "private-learning-capture-v1, relevance-judge-wait-v1";
  const capabilities = async (env) => {
    const seen = registry({ query: searchBody(ANONYMOUS_ACCESS, []) });
    await hookCore.runPromptHook(PROMPT, { env, fetchImpl: seen.fetchImpl });
    expect(seen.queries()).toHaveLength(1);
    return seen.queries()[0].headers["x-remembrance-client-capabilities"];
  };
  const hangs = () =>
    vi.fn(
      (_url, init = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

  it("tells the server that the search waits for the judge's longer hook deadline", async () => {
    expect(await capabilities(hookEnv())).toBe(WAITS);
    expect(await capabilities(orgEnv())).toBe(WAITS);
    expect(
      await capabilities(hookEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "3000" })),
    ).toBe(WAITS);
  });

  it("does not claim the wait when its search timeout is set shorter", async () => {
    expect(
      await capabilities(hookEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "2999" })),
    ).toBe("private-learning-capture-v1");
  });

  it("waits 3 s for the search by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = hangs();
      let settled = false;
      const pending = hookCore
        .queryRemembrance(hookCore.buildQueryPayload(PROMPT, {}), {
          env: hookEnv(),
          fetchImpl,
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps 2 s for a stopped search's preference read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopped = registry({ effectiveHangs: true });
      let settled = false;
      const pending = hookCore
        .stoppedSearchGovernance(hookCore.buildQueryPayload(PROMPT, {}), {
          env: orgEnv(),
          fetchImpl: stopped.fetchImpl,
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ search: true });
      expect(stopped.effectives()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
