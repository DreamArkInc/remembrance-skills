import {
  existsSync,
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

const root = resolve(import.meta.dirname, "..");
const repoRoot = resolve(root, "../..");
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-plugin-test-"));
const expectedMcpTools = [
  "query_skills",
  "get_skill",
  "get_resource",
  "bootstrap_agent_identity",
  "submit_feedback",
  "submit_remembrance",
  "propose_skill_idea",
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
  return {
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(tempRoot, `cache-${cacheCounter}.json`),
    ...env,
  };
}

function frame(payload) {
  return `${JSON.stringify(payload)}\n`;
}

function readFrames(buffer) {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Remembrance Claude Code prompt hook", () => {
  it("queries Remembrance for external service and workflow prompts", async () => {
    const calls = [];
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
          calls.push({ url, body: JSON.parse(String(init.body)) });
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
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://remembrance.dev/api/v1/agent/query",
    );
    expect(calls[0].body).toMatchObject({
      task: {
        domain: "deployment",
        constraints: expect.arrayContaining(["ci", "deployment"]),
      },
      limit: 2,
    });
    expect(
      output?.hookSpecificOutput.additionalContext,
    ).toContain("vercel-build-debug");
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

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    const cache = readFileSync(env.REMEMBRANCE_HOOK_CACHE_PATH, "utf8");
    expect(cache).not.toContain("Vercel Next.js");
    expect(cache).not.toContain("sk_live_");
    expect(cache).toContain("vercel-cache-debug");
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

    const parsed = JSON.parse(readFileSync(env.REMEMBRANCE_HOOK_CACHE_PATH, "utf8"));
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

    expect(output).toBeNull();
    expect(stderr).toContain("cache_miss");
    expect(stderr).toContain("http_error");
    expect(stderr).not.toContain("sk_live_");
    expect(stderr).not.toContain("payment integration");
  });

  it("fails open on timeouts, server errors, and malformed responses", async () => {
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

    expect(timeout).toBeNull();
    expect(serverError).toBeNull();
    expect(malformed).toBeNull();
  });

  it("validates plugin, hook, mcp, and marketplace manifests", () => {
    const plugin = JSON.parse(
      readFileSync(resolve(root, ".claude-plugin/plugin.json"), "utf8"),
    );
    const codexPlugin = JSON.parse(
      readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"),
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    const hooks = JSON.parse(
      readFileSync(resolve(root, "hooks/hooks.json"), "utf8"),
    );
    const codexHooks = JSON.parse(
      readFileSync(resolve(root, "hooks/codex-hooks.json"), "utf8"),
    );
    const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    const codexMcp = JSON.parse(
      readFileSync(resolve(root, ".mcp.codex.json"), "utf8"),
    );
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
      readFileSync(resolve(repoRoot, ".claude-plugin/marketplace.json"), "utf8"),
    );

    expect(plugin).toMatchObject({
      name: "remembrance",
      mcpServers: "./.mcp.json",
      skills: "./skills",
    });
    expect(codexPlugin).toMatchObject({
      name: "remembrance",
      hooks: "./hooks/codex-hooks.json",
      mcpServers: "./.mcp.codex.json",
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
    expect(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      'node "${PLUGIN_ROOT}/scripts/codex-query-on-prompt.mjs"',
    );
    expect(codexHooks.hooks.Stop[0].hooks[0].command).toBe(
      'node "${PLUGIN_ROOT}/scripts/codex-contribute-on-stop.mjs"',
    );
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(mcp.mcpServers.remembrance).toMatchObject({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/servers/remembrance-mcp.mjs"],
    });
    expect(codexMcp.mcp_servers.remembrance).toMatchObject({
      command: "node",
      args: ["${PLUGIN_ROOT}/servers/remembrance-mcp.mjs"],
    });
    expect(mcp.mcpServers.remembrance.env).toMatchObject({
      // Empty default (not a baked remembrance.dev): lets the bundled MCP
      // server fall through to a config-file apiUrl before its own default, so
      // the hooks and the server can't target different registries.
      REMEMBRANCE_API_URL: "${REMEMBRANCE_API_URL:-}",
      REMEMBRANCE_API_KEY: "${REMEMBRANCE_API_KEY:-}",
      REMEMBRANCE_AGENT_KEY_PATH: "${REMEMBRANCE_AGENT_KEY_PATH:-}",
    });
    expect(codexMcp.mcp_servers.remembrance.env).toMatchObject({
      REMEMBRANCE_API_URL: "${REMEMBRANCE_API_URL:-}",
      REMEMBRANCE_API_KEY: "${REMEMBRANCE_API_KEY:-}",
      REMEMBRANCE_AGENT_KEY_PATH: "${REMEMBRANCE_AGENT_KEY_PATH:-}",
    });
    expect(JSON.stringify(mcp)).not.toContain("${REMEMBRANCE_API_KEY}");
    expect(JSON.stringify(mcp)).not.toContain("${REMEMBRANCE_AGENT_KEY_PATH}");
    expect(JSON.stringify(codexMcp)).not.toContain("${REMEMBRANCE_API_KEY}");
    expect(JSON.stringify(codexMcp)).not.toContain(
      "${REMEMBRANCE_AGENT_KEY_PATH}",
    );
    expect(marketplace.plugins[0]).toMatchObject({
      name: "remembrance",
      source: "./packages/claude-code-plugin",
    });
    expect(packageJson.version).toBe(plugin.version);
    expect(packageJson.version).toBe(codexPlugin.version);
    expect(marketplace.metadata.version).toBe(plugin.version);
    expect(
      existsSync(resolve(root, "scripts/codex-query-on-prompt.mjs")),
    ).toBe(true);
    expect(
      existsSync(resolve(root, "scripts/codex-contribute-on-stop.mjs")),
    ).toBe(true);
    expect(skill).toBe(canonicalSkill);
    expect(attestationReference).toBe(canonicalAttestationReference);
    expect(
      existsSync(
        resolve(root, "skills/remembrancer/scripts/validate-remembrance.mjs"),
      ),
    ).toBe(true);
    expect(skill).toContain("Query Remembrance first");
    expect(skill).not.toContain("description: Call query_skills");
    expect(skill).toContain("`query_skills`");
    expect(skill).toContain("`bootstrap_agent_identity`");
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
    const child = spawn(process.execPath, [
      resolve(root, "servers/remembrance-mcp.mjs"),
    ]);
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
      child.stdin.write(
        frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      );

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
    expect(domainFor("Redesign the dashboard and declutter the review card")).toBe(
      "web-ui-qa",
    );
    expect(domainFor("Add a left nav side panel and fix the settings layout")).toBe(
      "web-ui-qa",
    );
    expect(domainFor("Build a Tailwind modal component with a tooltip")).toBe(
      "web-ui-qa",
    );
    // Framework name alone in a build/deploy context is NOT web-ui.
    expect(domainFor("Fix the Vercel Next.js build error in GitHub Actions")).toBe(
      "deployment",
    );
    expect(domainFor("Submit a skill idea and review the queue")).toBe(
      "agent-skills",
    );
    expect(domainFor("Find an MPP endpoint for x402 payments")).toBe("mpp");
    // Unknown work falls back to a real seeded domain, not a made-up one.
    expect(domainFor("Help me think through an unrelated idea")).toBe(
      "agent-skills",
    );
  });
});
