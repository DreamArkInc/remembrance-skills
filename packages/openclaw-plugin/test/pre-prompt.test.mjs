import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  handlePrePrompt,
  promptFromEvent,
  sessionIdFromEvent,
} from "../src/index.mjs";
import { remembranceConfigPath } from "../src/hook-core.mjs";

const root = resolve(import.meta.dirname, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-openclaw-pre-"));
let counter = 0;

function testEnv(extra = {}) {
  counter += 1;
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(tempRoot, `usage-${counter}`),
    ...extra,
  };
}

// A fake OpenClaw before_prompt_build event.
function event(prompt, ctx = {}) {
  return { prompt, context: { sessionId: "s1", runId: "r1", ...ctx } };
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("OpenClaw pre-prompt hook (before_prompt_build)", () => {
  it("injects appendSystemContext for a relevant prompt and records a use marker", async () => {
    const calls = [];
    const recorded = [];
    const eligible = [];
    const highMatches = [];
    const result = await handlePrePrompt(
      event("Fix this Vercel Next.js build error in GitHub Actions."),
      {
        env: testEnv({ REMEMBRANCE_AUTO_QUERY_LIMIT: "2" }),
        recordUse: (id) => recorded.push(id),
        recordEligibility: (id) => eligible.push(id),
        recordHighMatch: (id, match) => highMatches.push({ id, match }),
        fetchImpl: vi.fn(async (url, init) => {
          calls.push({
            url,
            body: JSON.parse(String(init.body)),
            headers: init.headers,
          });
          return Response.json({
            query_id: "rq_openclaw",
            skills: [
              {
                slug: "vercel-build-debug",
                description: "Debug Vercel build failures.",
                trust_tier: "tofu_verified",
                verified_uses: 7,
                total_uses: 9,
                result_id: "qres_openclaw",
                match_tier: "high",
                match_reason: "Strong task coverage",
                estimated_tokens: 360,
                risk_level: "low",
              },
            ],
            resources: [],
          });
        }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://remembrance.dev/api/v1/agent/query");
    expect(calls[0].body).toMatchObject({
      // Reports as OpenClaw (an accepted agentProviderSchema value), not the
      // shared-core Codex default — otherwise the query would fail validation.
      agent: { provider: "openclaw", model: "openclaw" },
      task: {
        domain: "deployment",
        constraints: expect.arrayContaining(["ci", "deployment"]),
      },
      limit: 2,
      client_context: {
        surface: "plugin_hook",
        runtime: "openclaw",
        trigger_reason: "external_service",
      },
    });
    expect(calls[0].headers["user-agent"]).toBe("@remembrance/openclaw-plugin");
    expect(result.appendSystemContext).toContain(
      "Remembrance auto-query context",
    );
    expect(result.appendSystemContext).toContain("vercel-build-debug");
    // A real injection must record the per-session use marker (from ctx.runId).
    expect(recorded).toEqual(["r1"]);
    expect(eligible).toEqual(["r1"]);
    expect(highMatches).toEqual([
      {
        id: "r1",
        match: expect.objectContaining({
          query_id: "rq_openclaw",
          slug: "vercel-build-debug",
        }),
      },
    ]);
  });

  it("injects a full-conversation reminder for contextual follow-ups", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toContain("/api/v1/agent/directive-events");
      return Response.json({ recorded: true }, { status: 201 });
    });
    const recorded = [];
    const eligible = [];
    const directives = [];
    const result = await handlePrePrompt(event("fix these issues"), {
      env: testEnv(),
      fetchImpl,
      recordUse: (id) => recorded.push(id),
      recordEligibility: (id) => eligible.push(id),
      recordDirective: (id, directive) => directives.push({ id, directive }),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(recorded).toEqual([]);
    expect(eligible).toEqual(["r1"]);
    expect(result.appendSystemContext).toContain("task-continuation reminder");
    expect(result.appendSystemContext).toContain("full thread");
    expect(result.appendSystemContext).toContain("query_skills");
    expect(result.appendSystemContext).toContain("directive_id");
    expect(directives).toEqual([
      {
        id: "r1",
        directive: expect.objectContaining({
          directive_id: expect.stringMatching(/^dir_/),
          runtime: "openclaw",
        }),
      },
    ]);
  });

  it("really increments the on-disk use marker on a hit", async () => {
    const env = testEnv();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        skills: [{ slug: "s", description: "d" }],
        resources: [],
      }),
    );
    await handlePrePrompt(
      event("Set up Vercel deployment.", { runId: "r-marker" }),
      {
        env,
        fetchImpl,
      },
    );
    const { readRegistryUseCount } = await import("../src/hook-core.mjs");
    expect(readRegistryUseCount("r-marker", env)).toBe(1);
  });

  it("no-ops (undefined) for one-off fact prompts and never queries or records", async () => {
    const fetchImpl = vi.fn();
    const recorded = [];
    const result = await handlePrePrompt(
      event("What is the capital of France?"),
      {
        env: testEnv(),
        fetchImpl,
        recordUse: (id) => recorded.push(id),
      },
    );
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("sends the x-remembrance-api-key header from REMEMBRANCE_API_KEY when set", async () => {
    const headers = [];
    await handlePrePrompt(
      event("Set up Vercel deployment.", { runId: "r-key-env" }),
      {
        env: testEnv({ REMEMBRANCE_API_KEY: "env-key-123" }),
        recordUse: () => {},
        fetchImpl: vi.fn(async (_url, init) => {
          headers.push(init.headers);
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]["x-remembrance-api-key"]).toBe("env-key-123");
  });

  it("uses the fixed user-home config path instead of env-controlled HOME", () => {
    const injectedHome = join(tempRoot, `home-${(counter += 1)}`);
    const path = remembranceConfigPath({
      HOME: injectedHome,
      XDG_CONFIG_HOME: join(injectedHome, "xdg"),
    });

    expect(path).toBe(join(homedir(), ".config", "remembrance", "config.json"));
    expect(path).not.toContain(injectedHome);
  });

  it("redacts a fake secret before sending the query text", async () => {
    const bodies = [];
    await handlePrePrompt(
      event(
        "Fix this Vercel deploy using sk_live_1234567890123456 and http://svc.internal/private.",
      ),
      {
        env: testEnv(),
        recordUse: () => {},
        fetchImpl: vi.fn(async (_url, init) => {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).not.toContain("svc.internal");
    expect(serialized).toContain("[redacted-secret]");
    expect(serialized).toContain("[redacted-private-url]");
  });

  it("REMEMBRANCE_AUTO_QUERY=0 disables the network query", async () => {
    const fetchImpl = vi.fn();
    const result = await handlePrePrompt(event("Set up Vercel deployment."), {
      env: testEnv({ REMEMBRANCE_AUTO_QUERY: "0" }),
      fetchImpl,
    });
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open on bad input and injects recovery context for query failures", async () => {
    expect(await handlePrePrompt({}, { env: testEnv() })).toBeUndefined();
    expect(await handlePrePrompt(null, { env: testEnv() })).toBeUndefined();

    const timeout = await handlePrePrompt(event("Set up Vercel deployment."), {
      env: testEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" }),
      fetchImpl: vi.fn(
        async (_url, init) =>
          new Promise((_res, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    });
    const serverError = await handlePrePrompt(
      event("Set up Stripe payment integration."),
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () => new Response("no", { status: 500 })),
      },
    );
    const malformed = await handlePrePrompt(
      event("Set up Vercel deployment."),
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
    for (const result of [timeout, serverError, malformed]) {
      expect(result.appendSystemContext).toContain("query-unavailable context");
      expect(result.appendSystemContext).toContain("query_skills");
    }
  });

  it("promptFromEvent reads prompt, userPrompt, input.prompt, and messages shapes", () => {
    expect(promptFromEvent({ prompt: "a" })).toBe("a");
    expect(promptFromEvent({ userPrompt: "b" })).toBe("b");
    expect(promptFromEvent({ input: { prompt: "c" } })).toBe("c");
    expect(
      promptFromEvent({
        messages: [
          { role: "assistant", content: "x" },
          { role: "user", content: "d" },
        ],
      }),
    ).toBe("d");
    expect(
      promptFromEvent({
        messages: [{ role: "user", content: [{ text: "e1" }, { text: "e2" }] }],
      }),
    ).toBe("e1\ne2");
    expect(promptFromEvent(null)).toBe("");
    expect(promptFromEvent({})).toBe("");
  });

  it("sessionIdFromEvent prefers runId then sessionId, and normalizes missing to unknown", () => {
    expect(
      sessionIdFromEvent({ context: { runId: "R", sessionId: "S" } }),
    ).toBe("R");
    expect(sessionIdFromEvent({ context: { sessionId: "S" } })).toBe("S");
    expect(sessionIdFromEvent({})).toBe("unknown");
  });

  it("ships the expected manifests and bundled artifacts", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "openclaw.plugin.json"), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const mcp = JSON.parse(
      readFileSync(resolve(root, "openclaw.mcp.json"), "utf8"),
    );

    // Version is not pinned to a literal here — the monorepo-wide version sync
    // is enforced by `check:versions`, and line below cross-checks pkg⇄manifest.
    expect(manifest).toMatchObject({ id: "remembrance" });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      properties: {},
    });
    expect(pkg.name).toBe("@remembrance/openclaw-plugin");
    expect(pkg.version).toBe(manifest.version);
    // package.json declares the native entrypoint under openclaw.extensions.
    expect(pkg.openclaw.extensions).toContain("./src/index.mjs");
    // OpenClaw configures MCP servers under mcp.servers (not mcp_servers/mcpServers).
    // OpenClaw does NOT define an ${OPENCLAW_PLUGIN_ROOT} variable, so the
    // fragment ships an illustrative absolute path (to be replaced by the user)
    // rather than a non-expanding var, and carries a _comment marker saying so.
    expect(mcp._comment).toMatch(/absolute path/i);
    expect(mcp.mcp.servers.remembrance).toMatchObject({
      command: "node",
      args: ["/abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs"],
    });
    expect(mcp.mcp.servers.remembrance.args[0]).not.toContain(
      "OPENCLAW_PLUGIN_ROOT",
    );
    expect(mcp.mcp.servers.remembrance.env).toMatchObject({
      // Empty default (not a baked remembrance.dev): lets the bundled MCP
      // server fall through to a config-file apiUrl before its own default, so
      // the hooks and the server can't target different registries.
      REMEMBRANCE_API_URL: "${REMEMBRANCE_API_URL:-}",
    });
  });
});
