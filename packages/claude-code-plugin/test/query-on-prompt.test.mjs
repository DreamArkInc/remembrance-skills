import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildQueryPayload,
  handleHookInput,
  redactPrompt,
  shouldQueryPrompt,
} from "../scripts/query-on-prompt.mjs";
import {
  agentLedgerIdFor,
  observeSuccessfulCompletionTool,
} from "../scripts/hook-core.mjs";
import { KEYWORDS_ONLY } from "../../codex-plugin/test/fixtures/task-shape.mjs";
import {
  HOST_NOTIFICATION_SHAPES,
  ORDINARY_HUMAN_PROMPTS,
} from "../../codex-plugin/test/fixtures/host-notification-corpus.mjs";
import {
  noResultResponse,
  summaryEchoProposal,
  templateProposal,
} from "../../codex-plugin/test/fixtures/skill-idea-proposals.mjs";

const root = resolve(import.meta.dirname, "..");
const repoRoot = resolve(root, "../..");
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-plugin-test-"));
const expectedMcpTools = [
  "query_skills",
  "get_skill",
  "get_resource",
  "bootstrap_agent_identity",
  "capture_learning",
  "inspect_private_learning_outbox",
  "queue_private_skill_import",
  "submit_feedback",
  "submit_query_feedback",
  "submit_private_lesson_candidate",
  "submit_private_skill_candidate",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
  "request_attestation_challenge",
  "register_agent_key",
];
let cacheCounter = 0;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv(env = {}) {
  cacheCounter += 1;
  const testRoot = resolve(tempRoot, `state-${cacheCounter}`);
  return {
    XDG_CONFIG_HOME: resolve(testRoot, "config"),
    XDG_STATE_HOME: resolve(testRoot, "state"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: resolve(testRoot, "alerts"),
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(
      tempRoot,
      `cache-${cacheCounter}.json`,
    ),
    REMEMBRANCE_USAGE_DIR: resolve(tempRoot, `usage-${cacheCounter}`),
    REMEMBRANCE_AGENT_KEY_PATH: resolve(testRoot, "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: resolve(testRoot, "sessions"),
    ...env,
  };
}

function queryCallCount(fetchImpl) {
  return fetchImpl.mock.calls.filter(([url]) =>
    String(url).endsWith("/api/v1/agent/query"),
  ).length;
}

function frame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readFrames(buffer) {
  const responses = [];
  let remaining = buffer;
  while (remaining.byteLength > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      break;
    }
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const length = Number.parseInt(
      header.match(/content-length:\s*(\d+)/i)?.[1] ?? "",
      10,
    );
    if (!Number.isFinite(length)) {
      throw new Error(`Invalid MCP frame header: ${header}`);
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.byteLength < bodyEnd) {
      break;
    }
    responses.push(
      JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString("utf8")),
    );
    remaining = remaining.subarray(bodyEnd);
  }
  return responses;
}

describe("Remembrance Claude Code prompt hook", () => {
  it("collects hook sections and invokes the final allocator exactly once", () => {
    const source = readFileSync(
      resolve(root, "scripts/query-on-prompt.mjs"),
      "utf8",
    );
    expect(source.match(/composeBoundedHookContext\(/gu)).toHaveLength(1);
    expect(source).not.toContain("withAdditionalContext(");
    expect(source).not.toContain("withCredentialContext(");
  });

  it("queries Remembrance for external service and workflow prompts", async () => {
    const calls = [];
    const recordHealth = vi.fn();
    const output = await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
      },
      {
        env: {
          ...testEnv(),
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_AUTO_QUERY_LIMIT: "2",
        },
        fetchImpl: vi.fn(async (url, init) => {
          if (String(url).endsWith("/api/v1/agent/query")) {
            calls.push({ url, init, body: JSON.parse(String(init.body)) });
          }
          return Response.json({
            skills: [
              {
                slug: "vercel-build-debug",
                description: "Debug Vercel build failures.",
                trust_tier: "tofu_verified",
                verified_uses: 7,
                total_uses: 9,
              },
            ],
            resources: [],
          });
        }),
        recordHealth,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers).toMatchObject({
      "user-agent": expect.stringMatching(
        /^@remembrance\/claude-code-plugin\/\d+\.\d+\.\d+$/,
      ),
    });
    expect(calls[0].url).toBe("https://remembrance.dev/api/v1/agent/query");
    expect(calls[0].body).toMatchObject({
      task: {
        domain: "deployment",
        constraints: expect.arrayContaining(["ci", "deployment"]),
      },
      limit: 2,
      client_context: {
        surface: "plugin_hook",
        runtime: "claude_code",
        trigger_reason: "external_service",
      },
    });
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "vercel-build-debug",
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "claude_code",
        component: "prompt_hook",
      }),
      expect.any(Object),
    );
  });

  it("uses the shared bounded timeout override", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await handleHookInput(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "Fix this Vercel deployment timeout.",
        },
        {
          env: testEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "30000" }),
          fetchImpl: vi.fn(async () =>
            Response.json({ skills: [], resources: [] }),
          ),
        },
      );

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not query for generic one-off fact prompts", async () => {
    const fetchImpl = vi.fn();
    const output = await handleHookInput(
      { prompt: "What is the capital of France?" },
      { env: testEnv(), fetchImpl },
    );

    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores host notification envelopes before correction capture or network work", async () => {
    const fetchImpl = vi.fn();
    const recordEligibility = vi.fn();
    const output = await handleHookInput(
      {
        prompt:
          '<task_notification task_id="task_123" path="/private/project">You missed the requirement.</task_notification>',
        session_id: "claude-notification",
      },
      { env: testEnv(), fetchImpl, recordEligibility },
    );

    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it.each(
    HOST_NOTIFICATION_SHAPES.filter((item) => item.host === "claude_code").map(
      (item) => [item.label, item],
    ),
  )("keeps Claude Code's %s out of the prompt hook", async (_label, item) => {
    const fetchImpl = vi.fn();
    const recordEligibility = vi.fn();
    const output = await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: item.prompt,
        session_id: "claude-host-text",
      },
      {
        env: { ...testEnv(), REMEMBRANCE_API_URL: "https://remembrance.dev" },
        fetchImpl,
        recordEligibility,
      },
    );

    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it.each(ORDINARY_HUMAN_PROMPTS)(
    "queries an ordinary Claude Code prompt as written: %s",
    async (prompt) => {
      const summaries = [];
      const fetchImpl = vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/v1/agent/query")) {
          summaries.push(JSON.parse(String(init.body)).task.summary);
        }
        return Response.json({ skills: [], resources: [] });
      });
      await handleHookInput(
        {
          hook_event_name: "UserPromptSubmit",
          prompt,
          session_id: "claude-human",
        },
        {
          env: {
            ...testEnv(),
            REMEMBRANCE_API_URL: "https://remembrance.dev",
          },
          fetchImpl,
        },
      );

      expect(summaries).toEqual([prompt]);
    },
  );

  it.each([
    [
      "an older server's proposal made from the prompt",
      summaryEchoProposal,
      false,
    ],
    [
      "the server's template proposal",
      () => templateProposal("rq_proposal"),
      true,
    ],
  ])(
    "offers a skill idea only when it is not the prompt: %s",
    async (_label, proposalFor, offered) => {
      const prompt = ORDINARY_HUMAN_PROMPTS[0];
      const fetchImpl = vi.fn(async (url, init) => {
        if (!String(url).endsWith("/api/v1/agent/query")) {
          return Response.json({});
        }
        const { summary } = JSON.parse(String(init.body)).task;
        return Response.json(
          noResultResponse("rq_proposal", proposalFor(summary)),
        );
      });
      const output = await handleHookInput(
        {
          hook_event_name: "UserPromptSubmit",
          prompt,
          session_id: "claude-proposal",
        },
        {
          env: {
            ...testEnv(),
            REMEMBRANCE_API_URL: "https://remembrance.dev",
          },
          fetchImpl,
        },
      );
      const context = output.hookSpecificOutput.additionalContext;
      expect(context).toContain("No matching skill/resource.");
      expect(context.includes("Proposed skill idea payload")).toBe(offered);
      expect(context.includes(prompt)).toBe(false);
    },
  );

  it("captures a user correction in the same turn without requiring a query", async () => {
    const fetchImpl = vi.fn();
    const recordEligibility = vi.fn();
    const output = await handleHookInput(
      {
        prompt: "That approach is overkill; keep the existing abstraction.",
        session_id: "claude-correction",
      },
      { env: testEnv(KEYWORDS_ONLY), fetchImpl, recordEligibility },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordEligibility).toHaveBeenCalledWith(
      "claude-correction",
      expect.any(Object),
    );
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "Remembrance user-correction capture",
    );
  });

  it("injects a full-thread query reminder for contextual follow-ups", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toContain("/api/v1/agent/directive-events");
      return Response.json({ recorded: true }, { status: 201 });
    });
    const directives = [];
    const output = await handleHookInput(
      { prompt: "fix these issues", session_id: "claude-followup" },
      {
        env: testEnv(),
        fetchImpl,
        recordDirective: (id, directive) => directives.push({ id, directive }),
      },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "task-continuation reminder",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "full thread",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "query_skills",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "directive_id",
    );
    expect(directives).toEqual([
      {
        id: "claude-followup",
        directive: expect.objectContaining({
          directive_id: expect.stringMatching(/^dir_/),
          runtime: "claude_code",
        }),
      },
    ]);
  });

  it("redacts secrets and private URLs before sending query text", async () => {
    const calls = [];
    await handleHookInput(
      {
        prompt:
          "Fix this Vercel deploy using Bearer abcdefghijklmnopqrstuvwxyz, sk_live_1234567890123456, rk_live_1234567890123456, github_pat_123456789012345678901234, gho_12345678901234567890, xoxb-12345678901234567890, AKIA1234567890ABCDEF, ASIA1234567890ABCDEF, eyJabc.eyJdef.signature, and http://svc.internal/private.",
      },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async (_url, init) => {
          calls.push(JSON.parse(String(init.body)));
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );

    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).not.toContain("rk_live_");
    expect(serialized).not.toContain("github_pat_");
    expect(serialized).not.toContain("gho_");
    expect(serialized).not.toContain("xoxb-");
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain("ASIA");
    expect(serialized).not.toContain("eyJabc");
    expect(serialized).not.toContain("svc.internal");
    expect(serialized).toContain("[redacted-token]");
    expect(serialized).toContain("[redacted-private-url]");
  });

  it("caches repeated matching prompts without storing or resending raw text", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        skills: [
          {
            slug: "vercel-cache-debug",
            description: "Debug cached Vercel failures.",
            trust_tier: "registered_provider",
            verified_uses: 12,
            total_uses: 14,
          },
        ],
        resources: [],
      }),
    );
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    const prompt =
      "Fix this Vercel Next.js build error with sk_live_1234567890123456.";

    const first = await handleHookInput({ prompt }, { env, fetchImpl });
    const second = await handleHookInput({ prompt }, { env, fetchImpl });

    expect(queryCallCount(fetchImpl)).toBe(1);
    expect(second).toEqual(first);
    const cache = readFileSync(env.REMEMBRANCE_HOOK_CACHE_PATH, "utf8");
    expect(cache).not.toContain("Vercel Next.js");
    expect(cache).not.toContain("sk_live_");
    expect(cache).toContain("vercel-cache-debug");
  });

  it("records the exact query-feedback obligation on network and cache delivery", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        query_id: "rq_claude_feedback",
        skills: [
          {
            slug: "vercel-feedback-debug",
            description: "Debug Vercel feedback failures.",
            result_id: "qres_claude_feedback",
          },
        ],
        resources: [],
        query_feedback: {
          available: true,
          query_id: "rq_claude_feedback",
          result_ids: ["qres_claude_feedback"],
        },
      }),
    );
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    const input = {
      prompt: "Review this Vercel deployment workflow.",
      session_id: "claude-query-feedback",
    };
    const recordQueryFeedbackObligation = vi.fn();

    await handleHookInput(input, {
      env,
      fetchImpl,
      recordQueryFeedbackObligation,
    });
    await handleHookInput(input, {
      env,
      fetchImpl,
      recordQueryFeedbackObligation,
    });

    expect(queryCallCount(fetchImpl)).toBe(1);
    expect(recordQueryFeedbackObligation).toHaveBeenCalledTimes(2);
    expect(recordQueryFeedbackObligation).toHaveBeenNthCalledWith(
      1,
      "claude-query-feedback",
      { available: true, query_id: "rq_claude_feedback" },
      env,
    );
    expect(recordQueryFeedbackObligation).toHaveBeenNthCalledWith(
      2,
      "claude-query-feedback",
      { available: true, query_id: "rq_claude_feedback" },
      env,
    );
  });

  it("caches empty responses without counting them as registry consumption", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ skills: [], resources: [] }),
    );
    const recordUse = vi.fn();
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    const input = {
      prompt: "Review this Vercel deployment workflow.",
      session_id: "claude-empty",
    };

    const first = await handleHookInput(input, { env, fetchImpl, recordUse });
    const second = await handleHookInput(input, { env, fetchImpl, recordUse });

    expect(queryCallCount(fetchImpl)).toBe(1);
    expect(recordUse).not.toHaveBeenCalled();
    expect(first?.hookSpecificOutput.additionalContext).toContain(
      "returned no matching skill",
    );
    expect(second).toEqual(first);
  });

  it("rewrites existing cache files atomically into valid JSON", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    writeFileSync(
      env.REMEMBRANCE_HOOK_CACHE_PATH,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: "old",
            output: null,
            touched_at: 1,
            expires_at: 1,
          },
        ],
      }),
    );

    await handleHookInput(
      { prompt: "Fix this Vercel Next.js build error." },
      {
        env,
        fetchImpl: vi.fn(async () =>
          Response.json({
            skills: [
              {
                slug: "atomic-cache-skill",
                description: "Debug atomic cache writes.",
              },
            ],
            resources: [],
          }),
        ),
      },
    );

    const parsed = JSON.parse(
      readFileSync(env.REMEMBRANCE_HOOK_CACHE_PATH, "utf8"),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(JSON.stringify(parsed)).toContain("atomic-cache-skill");
    expect(JSON.stringify(parsed)).not.toContain("Vercel Next.js");
    expect(
      readdirSync(dirname(env.REMEMBRANCE_HOOK_CACHE_PATH)).some((name) =>
        name.includes(".tmp-"),
      ),
    ).toBe(false);
    expect(existsSync(env.REMEMBRANCE_HOOK_CACHE_PATH)).toBe(true);
  });

  it("emits sanitized debug logs when REMEMBRANCE_DEBUG is enabled", async () => {
    let stderr = "";
    const env = testEnv({
      REMEMBRANCE_DEBUG: "1",
      REMEMBRANCE_API_KEY: "sk_live_1234567890123456",
    });
    const output = await handleHookInput(
      {
        prompt:
          "Set up Stripe payment integration with sk_live_1234567890123456.",
      },
      {
        env,
        stderr: {
          write(chunk) {
            stderr += String(chunk);
          },
        },
        fetchImpl: vi.fn(async () => new Response("nope", { status: 401 })),
      },
    );

    expect(output.hookSpecificOutput.additionalContext).toContain(
      "query-unavailable context",
    );
    expect(stderr).toContain("cache_miss");
    expect(stderr).toContain("http_error");
    expect(stderr).not.toContain("sk_live_");
    expect(stderr).not.toContain("payment integration");
  });

  it("fails open with recovery context on query failures", async () => {
    const timeout = await handleHookInput(
      { prompt: "Set up Vercel deployment." },
      {
        env: testEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" }),
        fetchImpl: vi.fn(
          async (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        ),
      },
    );
    const serverError = await handleHookInput(
      { prompt: "Set up Stripe payment integration." },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () => new Response("nope", { status: 500 })),
      },
    );
    const malformed = await handleHookInput(
      { prompt: "Set up Vercel deployment." },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw new Error("bad json");
          },
        })),
      },
    );

    for (const output of [timeout, serverError, malformed]) {
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "query-unavailable context",
      );
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "query_skills",
      );
    }
  });

  it("surfaces shared-config authentication on success, failure, and cache replay", async () => {
    const configHome = join(tempRoot, `claude-config-${(cacheCounter += 1)}`);
    mkdirSync(join(configHome, "remembrance"), { recursive: true });
    writeFileSync(
      join(configHome, "remembrance", "config.json"),
      JSON.stringify({ apiKey: "rk_claude_shared" }),
      { mode: 0o600 },
    );
    const env = testEnv({
      XDG_CONFIG_HOME: configHome,
      REMEMBRANCE_API_KEY: "",
    });
    const successFetch = vi.fn(async () =>
      Response.json({
        skills: [{ slug: "claude-shared", description: "Shared guidance" }],
        resources: [],
      }),
    );

    const first = await handleHookInput(
      { prompt: "Set up a Vercel deployment.", session_id: "claude-shared-1" },
      { env, fetchImpl: successFetch },
    );
    const cached = await handleHookInput(
      { prompt: "Set up a Vercel deployment.", session_id: "claude-shared-2" },
      { env, fetchImpl: successFetch },
    );
    for (const output of [first, cached]) {
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "Remembrance credential source",
      );
      expect(output.hookSpecificOutput.additionalContext).toContain(
        "run_connection_doctor",
      );
      expect(output.hookSpecificOutput.additionalContext).not.toContain(
        "rk_claude_shared",
      );
    }
    expect(queryCallCount(successFetch)).toBe(1);

    const failed = await handleHookInput(
      { prompt: "Debug a Stripe API failure.", session_id: "claude-shared-3" },
      {
        env: testEnv({
          XDG_CONFIG_HOME: configHome,
          REMEMBRANCE_API_KEY: "",
        }),
        fetchImpl: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      },
    );
    expect(failed.hookSpecificOutput.additionalContext).toContain(
      "Remembrance credential source",
    );
    expect(failed.hookSpecificOutput.additionalContext).toContain(
      "query-unavailable context",
    );
    expect(failed.hookSpecificOutput.additionalContext).not.toContain(
      "rk_claude_shared",
    );
  });

  it("validates plugin, hook, mcp, and marketplace manifests", () => {
    const plugin = JSON.parse(
      readFileSync(resolve(root, ".claude-plugin/plugin.json"), "utf8"),
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    const hooks = JSON.parse(
      readFileSync(resolve(root, "hooks/hooks.json"), "utf8"),
    );
    const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    const skill = readFileSync(
      resolve(root, "skills/remembrancer/SKILL.md"),
      "utf8",
    );
    const attestationReference = readFileSync(
      resolve(root, "skills/remembrancer/references/attestation-rest.md"),
      "utf8",
    );
    const canonicalAttestationReference = readFileSync(
      resolve(repoRoot, "skills/remembrancer/references/attestation-rest.md"),
      "utf8",
    );
    const canonicalSkill = readFileSync(
      resolve(repoRoot, "skills/remembrancer/SKILL.md"),
      "utf8",
    );
    const marketplace = JSON.parse(
      readFileSync(
        resolve(repoRoot, ".claude-plugin/marketplace.json"),
        "utf8",
      ),
    );

    expect(plugin).toMatchObject({
      name: "remembrance",
      mcpServers: "./.mcp.json",
      skills: "./skills",
    });
    // The manifest must NOT reference the standard hooks/hooks.json — Claude Code
    // auto-loads that path, and a manifest `hooks` pointing at it makes the
    // plugin fail to load with a "Duplicate hooks file detected" error.
    expect(plugin.hooks).toBeUndefined();
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "query-on-prompt.mjs",
    );
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain(
      "contribute-on-stop.mjs",
    );
    // A subagent is asked for its own pending actions by the same script,
    // which also moves the debts of one an API error ended.
    expect(hooks.hooks.SubagentStop).toEqual(hooks.hooks.Stop);
    expect(hooks.hooks.StopFailure).toEqual(hooks.hooks.Stop);
    const localMemoryHook = hooks.hooks.PostToolUse.find((entry) =>
      entry.hooks[0].command.includes("route-local-memory.mjs"),
    );
    const remembranceToolHook = hooks.hooks.PostToolUse.find((entry) =>
      entry.hooks[0].command.includes("record-detail-open.mjs"),
    );
    expect(localMemoryHook?.matcher).toBe("^(?:Write|Edit|Memory|AutoMemory)$");
    expect(remembranceToolHook?.hooks[0].command).toContain(
      "record-detail-open.mjs",
    );
    expect(remembranceToolHook?.matcher).toContain("query_skills");
    expect(remembranceToolHook?.matcher).toContain(
      "submit_private_lesson_candidate",
    );
    expect(remembranceToolHook?.matcher).toContain(
      "retry_private_lesson_candidate",
    );
    expect(
      new RegExp(remembranceToolHook?.matcher).test(
        "mcp__plugin_remembrance_remembrance__decline_pending_action",
      ),
    ).toBe(true);
    for (const event of ["PostToolUseFailure", "PermissionDenied"]) {
      expect(hooks.hooks[event][0].hooks[0].command).toContain(
        "report-host-policy-denial.mjs",
      );
      expect(hooks.hooks[event][0].matcher).toContain("propose_private_skill");
      expect(hooks.hooks[event][0].matcher).toContain("decline_pending_action");
      expect(hooks.hooks[event][0].matcher).toContain(
        "submit_private_lesson_candidate",
      );
    }
    // Every hook and the bundled MCP server start through the launcher, which
    // finds Node.js when the host's PATH does not include it. The MCP entry
    // names it directly so native Windows resolves node-launcher.cmd.
    const hookCommands = Object.values(hooks.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    );
    expect(hookCommands).toHaveLength(9);
    for (const command of hookCommands) {
      const script = command.match(
        /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/node-launcher" "\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[a-z-]+\.mjs)"$/,
      )?.[1];
      expect(script, command).toBeTruthy();
      expect(existsSync(resolve(root, script)), script).toBe(true);
    }
    expect(existsSync(resolve(root, "scripts/node-launcher"))).toBe(true);
    expect(existsSync(resolve(root, "scripts/node-launcher.cmd"))).toBe(true);
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(mcp.mcpServers.remembrance).toMatchObject({
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/node-launcher",
      args: ["${CLAUDE_PLUGIN_ROOT}/servers/remembrance-mcp.mjs"],
    });
    expect(mcp.mcpServers.remembrance.env).toMatchObject({
      // Empty default (not a baked remembrance.dev): lets the bundled MCP
      // server fall through to a config-file apiUrl before its own default, so
      // the hooks and the server can't target different registries.
      REMEMBRANCE_API_URL: "${REMEMBRANCE_API_URL:-}",
      REMEMBRANCE_API_KEY: "${REMEMBRANCE_API_KEY:-}",
      REMEMBRANCE_AGENT_KEY_PATH: "${REMEMBRANCE_AGENT_KEY_PATH:-}",
    });
    expect(JSON.stringify(mcp)).not.toContain("${REMEMBRANCE_API_KEY}");
    expect(JSON.stringify(mcp)).not.toContain("${REMEMBRANCE_AGENT_KEY_PATH}");
    expect(marketplace.plugins[0]).toMatchObject({
      name: "remembrance",
      source: "./packages/claude-code-plugin",
    });
    expect(packageJson.version).toBe(plugin.version);
    expect(marketplace.metadata.version).toBe(plugin.version);
    expect(skill).toBe(canonicalSkill);
    expect(attestationReference).toBe(canonicalAttestationReference);
    expect(
      existsSync(
        resolve(root, "skills/remembrancer/scripts/validate-remembrance.mjs"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          root,
          "skills/remembrancer/scripts/queue-private-skill-import.mjs",
        ),
      ),
    ).toBe(true);
    expect(skill).toContain("Query Remembrance first");
    expect(skill).not.toContain("description: Call query_skills");
    expect(skill).toContain("`query_skills`");
    expect(skill).toContain("`bootstrap_agent_identity`");
    expect(skill).toContain("`local_signing_identity`");
    expect(skill).toContain("initializes automatically");
    expect(skill).toContain("with no arguments");
    expect(skill).toContain("POST https://remembrance.dev/api/v1/agent/query");
    expect(skill).toContain(
      "POST https://remembrance.dev/api/v1/agent/feedback",
    );
    expect(skill).toContain(
      "POST https://remembrance.dev/api/v1/agent/remembrances",
    );
    expect(skill).toContain(
      "POST https://remembrance.dev/api/v1/agent/skill-ideas",
    );
    expect(skill).toContain(
      "POST https://remembrance.dev/api/v1/agent/private-skill-ideas",
    );
    expect(skill).toContain("queue_private_skill_import");
    expect(skill).toContain("POST https://remembrance.dev/api/v1/resources");
    expect(skill).toContain(
      "POST https://remembrance.dev/api/v1/resources/reviews",
    );
    expect(skill).toContain("Idempotency-Key");
    expect(skill).toContain("no_results.propose_skill_idea_payload");
    expect(skill).toContain("references/attestation-rest.md");
    expect(skill).toContain("https://remembrance.dev/llms.txt");
    expect(skill).toContain("https://remembrance.dev/docs/api");
  });

  it("exposes expected tools through the bundled plugin MCP server", async () => {
    const profileRoot = resolve(tempRoot, "bundled-mcp-profile");
    const child = spawn(
      process.execPath,
      [resolve(root, "servers/remembrance-mcp.mjs")],
      {
        env: {
          HOME: resolve(profileRoot, "home"),
          XDG_CONFIG_HOME: resolve(profileRoot, "config"),
          XDG_STATE_HOME: resolve(profileRoot, "state"),
          XDG_CACHE_HOME: resolve(profileRoot, "cache"),
          XDG_DATA_HOME: resolve(profileRoot, "data"),
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_API_KEY: "rk_test_synthetic_bundled_mcp",
          REMEMBRANCE_API_KEY_ORIGIN: "https://remembrance.dev",
          REMEMBRANCE_PLUGIN_HOST: "claude_code",
          REMEMBRANCE_HOST_SURFACE: "cli",
          REMEMBRANCE_ENABLE_LEGACY_BROAD_WRITES: "0",
          REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
          REMEMBRANCE_AGENT_KEY_PATH: resolve(
            profileRoot,
            "config",
            "agent-key.json",
          ),
          REMEMBRANCE_PRINCIPAL_SESSION_DIR: resolve(
            profileRoot,
            "state",
            "principal-sessions",
          ),
        },
      },
    );
    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      child.stdin.write(
        frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      );
      child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

      const startedAt = Date.now();
      while (Date.now() - startedAt < 5_000) {
        const responses = readFrames(stdout);
        const initialize = responses.find((response) => response.id === 1);
        const list = responses.find((response) => response.id === 2);
        if (initialize && list) {
          expect(initialize.result.serverInfo.name).toBe(
            "@remembrance-ai/mcp-server",
          );
          const names = list.result.tools.map((tool) => tool.name);
          expect(names).toEqual(expect.arrayContaining(expectedMcpTools));
          // Claude Code keeps only this tool's schema out of tool search.
          expect(
            list.result.tools
              .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
              .map((tool) => tool.name),
          ).toEqual(["query_skills"]);
          const privateSkillAction = list.result.tools.find(
            (tool) => tool.name === "submit_private_skill_candidate",
          );
          const localHandoff = list.result.tools.find(
            (tool) => tool.name === "queue_private_skill_import",
          );
          expect(privateSkillAction.annotations).toMatchObject({
            readOnlyHint: false,
            openWorldHint: false,
            destructiveHint: false,
            idempotentHint: true,
          });
          expect(names).not.toEqual(
            expect.arrayContaining([
              "submit_remembrance",
              "propose_skill_idea",
              "propose_private_skill",
            ]),
          );
          expect(localHandoff.annotations).toMatchObject({
            readOnlyHint: false,
            openWorldHint: false,
            destructiveHint: false,
            idempotentHint: true,
          });
          return;
        }
        await delay(50);
      }
      throw new Error(
        stderr || "Bundled plugin MCP server did not return tools/list.",
      );
    } finally {
      child.kill("SIGTERM");
    }
  }, 10_000);

  it("keeps trigger and redaction helpers deterministic", () => {
    expect(shouldQueryPrompt("Deploy a Next.js app on Vercel")).toMatchObject({
      likely_match: true,
    });
    expect(
      shouldQueryPrompt("Redesign the dashboard and declutter the review card"),
    ).toMatchObject({
      likely_match: true,
      reason: "ui_or_dashboard_work",
    });
    expect(shouldQueryPrompt("Search the web for current news")).toMatchObject({
      likely_match: false,
    });
    expect(
      shouldQueryPrompt("Review the latest notes from Claude and Codex", KEYWORDS_ONLY),
    ).toEqual({ likely_match: false, reason: "no_trigger_match" });
    // The task-shape default (owner decision 34C) searches it as a task.
    expect(
      shouldQueryPrompt("Review the latest notes from Claude and Codex", {}),
    ).toEqual({ likely_match: true, reason: "task_shape" });
    expect(
      shouldQueryPrompt("Integrate the Anthropic API with its SDK"),
    ).toEqual({ likely_match: true, reason: "external_service" });
    expect(redactPrompt("api_key=secret123 for Vercel")).toContain(
      "[redacted-secret]",
    );
    expect(redactPrompt("github_pat_123456789012345678901234")).toBe(
      "[redacted-secret]",
    );
    expect(redactPrompt("https://payments.internal/path")).toBe(
      "[redacted-private-url]",
    );
    expect(
      buildQueryPayload("Run Playwright QA", {
        REMEMBRANCE_AUTO_QUERY_LIMIT: "99",
      }).limit,
    ).toBe(3);
  });

  it("infers the right seeded domain from the task, not a generic fallback", () => {
    const domainFor = (prompt) => buildQueryPayload(prompt, {}).task.domain;
    // The bug this guards: frontend/dashboard work said none of the old narrow
    // web-ui keywords, so it fell through to a non-seeded catch-all and surfaced
    // the wrong skills. These must resolve to real seeded domains.
    expect(
      domainFor("Redesign the dashboard and declutter the review card"),
    ).toBe("web-ui-qa");
    expect(
      domainFor("Add a left nav side panel and fix the settings layout"),
    ).toBe("web-ui-qa");
    expect(domainFor("Build a Tailwind modal component with a tooltip")).toBe(
      "web-ui-qa",
    );
    // Framework name alone in a build/deploy context is NOT web-ui.
    expect(
      domainFor("Fix the Vercel Next.js build error in GitHub Actions"),
    ).toBe("deployment");
    expect(domainFor("Submit a skill idea and review the queue")).toBe(
      "agent-skills",
    );
    expect(domainFor("Find an MPP endpoint for x402 payments")).toBe("mpp");
    // Unknown work falls back to a real seeded domain, not a made-up one.
    expect(domainFor("Help me think through an unrelated idea")).toBe(
      "agent-skills",
    );
  });

  it("acknowledges both user-decision notices on their first delivery in a context over its budget", async () => {
    const env = testEnv({
      REMEMBRANCE_API_KEY: "rk_synthetic_prompt_notices",
      REMEMBRANCE_API_URL: "http://127.0.0.1:9",
      REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
    });
    const state = join(env.XDG_STATE_HOME, "remembrance");
    const outbox = join(state, "private-lessons");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    chmodSync(outbox, 0o700);
    const envelope = (draftId, envelopeState = "ready", status = "not_required") =>
      writeFileSync(
        join(outbox, `${draftId}.lesson.json`),
        JSON.stringify({
          version: "private-lesson-outbox-envelope-v1",
          draft_id: draftId,
          state: envelopeState,
          hold_telemetry_status: status,
          last_error_code: null,
          next_retry_at: null,
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
    const input = {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-notices",
      prompt: "Review the deploy runbook.",
    };
    // One draft of this session's own, one no session holds and one a
    // safety hold left with nothing to send.
    const own = "pld_ownbudget001";
    envelope(own);
    observeSuccessfulCompletionTool(
      agentLedgerIdFor(input),
      "mcp__plugin_remembrance_remembrance__capture_learning",
      {},
      {
        capture_route: "private_lesson",
        draft_id: own,
        state: "ready",
        next_action: { tool: "submit_private_lesson_candidate", arguments: { draft_id: own } },
      },
      env,
    );
    envelope("pld_noonesbudget");
    envelope("pld_heldbudget01", "held_safety", "submitted");
    // Four long skill cards fill most of the 4,000-character budget.
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/api/v1/agent/query")
        ? Response.json({
            query_id: "rq_overbudget",
            skills: Array.from({ length: 4 }, (_, index) => ({
              slug: `deploy-runbook-review-${index + 1}`,
              result_id: `qres_overbudget_${index + 1}`,
              description: `Review deploy runbook step ${index + 1}: ${"check rollback, health checks and staged rollout order. ".repeat(5)}`,
              match_reason: "Deploy runbook review workflow",
              trust_tier: "tofu_verified",
              verified_uses: 7,
              total_uses: 9,
            })),
            resources: [],
          })
        : Promise.reject(new TypeError("network disabled in tests")),
    );
    const context = async () =>
      (await handleHookInput(input, { env, fetchImpl })).hookSpecificOutput
        .additionalContext;
    const first = await context();
    // Cut to fit, with each notice kept whole on one line.
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first).toContain("[Additional completion context omitted.]");
    const lines = first.split("\n");
    expect(
      lines.filter(
        (line) =>
          line.startsWith("- Retained private drafts awaiting a user decision: 1 lesson") &&
          line.endsWith("leave them in the outbox."),
      ),
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line.startsWith("- 1 retained private lesson draft was held") &&
          line.endsWith("leave the outbox as it is."),
      ),
    ).toHaveLength(1);
    const lifecycle = join(state, "private-learning-lifecycle");
    expect(existsSync(join(lifecycle, "orphan-notice.json"))).toBe(true);
    expect(existsSync(join(lifecycle, "pld_heldbudget01.held-notice.json"))).toBe(true);
    const second = await context();
    expect(second).toContain(`call submit_private_lesson_candidate with draft_id ${own}`);
    expect(second).not.toContain("awaiting a user decision");
    expect(second).not.toContain("held by the local safety check");
  });
});
