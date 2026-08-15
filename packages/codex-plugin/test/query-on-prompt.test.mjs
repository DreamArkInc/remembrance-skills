import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  codexHostedMcpCredentialSplitNotice,
  handleQuery,
} from "../scripts/query-on-prompt.mjs";

const root = resolve(import.meta.dirname, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-codex-query-"));
let counter = 0;

function testEnv(extra = {}) {
  counter += 1;
  const testId = counter;
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(tempRoot, `usage-${testId}`),
    XDG_CONFIG_HOME: join(tempRoot, `config-${testId}`),
    REMEMBRANCE_CODEX_CONFIG_PATH: join(
      tempRoot,
      `missing-codex-${testId}.toml`,
    ),
    ...extra,
  };
}

function sharedConfigCodexEnv(
  extra = {},
  mcpToml = [
    "[mcp_servers.remembrance]",
    'url = "https://remembrance.dev/api/mcp"',
    'bearer_token_env_var = "REMEMBRANCE_API_KEY"',
  ].join("\n"),
) {
  const env = testEnv(extra);
  mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true });
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "remembrance", "config.json"),
    JSON.stringify({ apiKey: "rmb_shared_query_key" }),
    { mode: 0o600 },
  );
  const configPath = join(env.XDG_CONFIG_HOME, "codex.toml");
  writeFileSync(configPath, mcpToml);
  return { ...env, REMEMBRANCE_CODEX_CONFIG_PATH: configPath };
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Codex query-on-prompt adapter", () => {
  it("injects additionalContext for a relevant prompt and records a use marker", async () => {
    const calls = [];
    const recorded = [];
    const eligible = [];
    const highMatches = [];
    const output = await handleQuery(
      {
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
        turn_id: "t1",
      },
      {
        env: testEnv({ REMEMBRANCE_AUTO_QUERY_LIMIT: "2" }),
        recordUse: (id) => {
          recorded.push(id);
        },
        recordEligibility: (id) => eligible.push(id),
        recordHighMatch: (id, match) => highMatches.push({ id, match }),
        fetchImpl: vi.fn(async (url, init) => {
          if (String(url).endsWith("/api/v1/agent/query")) {
            calls.push({ url, body: JSON.parse(String(init.body)) });
          }
          return Response.json({
            query_id: "rq_test",
            skills: [
              {
                slug: "vercel-build-debug",
                description: "Debug Vercel build failures.",
                trust_tier: "tofu_verified",
                verified_uses: 7,
                total_uses: 9,
                result_id: "qres_test",
                match_tier: "high",
                match_reason: "Strong task and constraint coverage",
                estimated_tokens: 360,
                risk_level: "low",
              },
            ],
            resources: [],
            contribution_directive: {
              query_id: "rq_test",
              message:
                "After use, call submit_feedback and then submit_remembrance when the lesson is reusable.",
            },
          });
        }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://remembrance.dev/api/v1/agent/query");
    expect(calls[0].body).toMatchObject({
      task: {
        domain: "deployment",
        constraints: expect.arrayContaining(["ci", "deployment"]),
      },
      limit: 2,
      client_context: {
        surface: "plugin_hook",
        runtime: "codex",
        trigger_reason: "external_service",
      },
    });
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Remembrance auto-query context",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "vercel-build-debug",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "After using Remembrance",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "submit_feedback",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "submit_remembrance",
    );
    // A real injection must record the per-session use marker.
    expect(recorded).toEqual(["t1"]);
    expect(eligible).toEqual(["t1"]);
    expect(highMatches).toEqual([
      {
        id: "t1",
        match: expect.objectContaining({
          query_id: "rq_test",
          result_id: "qres_test",
          slug: "vercel-build-debug",
        }),
      },
    ]);
  });

  it("turns a context-dependent follow-up into a full-thread query instruction", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toContain("/api/v1/agent/directive-events");
      return Response.json({ recorded: true }, { status: 201 });
    });
    const recorded = [];
    const eligible = [];
    const directives = [];
    const output = await handleQuery(
      { prompt: "fix these issues", turn_id: "t-followup" },
      {
        env: testEnv(),
        fetchImpl,
        recordUse: (id) => recorded.push(id),
        recordEligibility: (id) => eligible.push(id),
        recordDirective: (id, directive) => directives.push({ id, directive }),
      },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(recorded).toEqual([]);
    expect(eligible).toEqual(["t-followup"]);
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
      "contextual_continuation",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "directive_id",
    );
    expect(directives).toEqual([
      {
        id: "t-followup",
        directive: expect.objectContaining({
          directive_id: expect.stringMatching(/^dir_/),
          runtime: "codex",
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
    await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-marker" },
      { env, fetchImpl },
    );
    const { readRegistryUseCount } = await import("../scripts/hook-core.mjs");
    expect(readRegistryUseCount("t-marker", env)).toBe(1);
  });

  it("keeps empty results eligible without counting them as registry use", async () => {
    const recorded = [];
    const eligible = [];
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-empty" },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () =>
          Response.json({ skills: [], resources: [] }),
        ),
        recordUse: (id) => recorded.push(id),
        recordEligibility: (id) => eligible.push(id),
      },
    );

    expect(output.hookSpecificOutput.additionalContext).toContain(
      "returned no matching skill",
    );
    expect(recorded).toEqual([]);
    expect(eligible).toEqual(["t-empty"]);
  });

  it("does not query anonymously when a shared config file is malformed", async () => {
    const env = testEnv();
    mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true });
    writeFileSync(
      join(env.XDG_CONFIG_HOME, "remembrance", "config.json"),
      '{"apiKey":"unfinished"',
    );
    const fetchImpl = vi.fn();

    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-bad-config" },
      { env, fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "shared config file exists but is unreadable",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "falling back to anonymous scope",
    );
  });

  it("prefixes a registry-split notice when the hook URL is overridden", async () => {
    const hit = () =>
      Response.json({
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

    // Default registry: no notice.
    const aligned = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-split-default" },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () => hit()),
        recordUse: () => {},
      },
    );
    expect(aligned.hookSpecificOutput.additionalContext).not.toContain(
      "hosted MCP tools",
    );

    const splitConfigPath = join(tempRoot, "split-codex-config.toml");
    writeFileSync(
      splitConfigPath,
      [
        "[mcp_servers.remembrance]",
        'url = "https://remembrance.dev/api/mcp"',
      ].join("\n"),
    );
    // A manual hosted override that stays on production while hooks use dev is
    // diagnosed. The packaged local MCP would share the hook registry.
    const overridden = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-split-override" },
      {
        env: testEnv({
          REMEMBRANCE_API_URL: "https://dev.remembrance.example",
          REMEMBRANCE_CODEX_CONFIG_PATH: splitConfigPath,
        }),
        fetchImpl: vi.fn(async (url) => {
          expect(String(url)).toContain("https://dev.remembrance.example");
          return hit();
        }),
        recordUse: () => {},
      },
    );
    expect(overridden.hookSpecificOutput.additionalContext).toMatch(
      /^Note: Remembrance prompt hooks are querying https:\/\/dev\.remembrance\.example/,
    );
    expect(overridden.hookSpecificOutput.additionalContext).toContain(
      "hosted MCP tools are configured for https://remembrance.dev",
    );
    expect(overridden.hookSpecificOutput.additionalContext).toContain(
      "so both surfaces use the same registry",
    );

    const configPath = join(tempRoot, "aligned-codex-config.toml");
    writeFileSync(
      configPath,
      [
        "[mcp_servers.remembrance]",
        'url = "https://dev.remembrance.example/api/mcp"',
      ].join("\n"),
    );
    const alignedOverride = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-split-aligned" },
      {
        env: testEnv({
          REMEMBRANCE_API_URL: "https://dev.remembrance.example",
          REMEMBRANCE_CODEX_CONFIG_PATH: configPath,
        }),
        fetchImpl: vi.fn(async () => hit()),
        recordUse: () => {},
      },
    );
    expect(alignedOverride.hookSpecificOutput.additionalContext).not.toContain(
      "hosted MCP tools are configured",
    );
  });

  it("replaces the generic shared-config note with an actionable Codex health warning", async () => {
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-credential-split" },
      {
        env: sharedConfigCodexEnv(),
        fetchImpl: vi.fn(async () =>
          Response.json({
            skills: [{ slug: "vercel-build-debug", description: "Debug it." }],
            resources: [],
          }),
        ),
        recordUse: () => {},
      },
    );

    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toMatch(/^Remembrance connection health warning:/);
    expect(context).toContain(
      "requires REMEMBRANCE_API_KEY, but that variable is missing",
    );
    expect(context).toContain("native hosted MCP tools are unavailable");
    expect(context).toContain("fully quit and reopen Codex");
    expect(context).toContain("not a Remembrance rejection");
    expect(context).not.toContain("Remembrance credential source:");
    expect(context).not.toContain("rmb_shared_query_key");
    expect(context).not.toContain(tempRoot);
  });

  it("uses shared config without a hosted credential warning for bundled local MCP", () => {
    expect(
      codexHostedMcpCredentialSplitNotice(
        sharedConfigCodexEnv(
          {},
          ["[mcp_servers.remembrance]", 'command = "node"'].join("\n"),
        ),
      ),
    ).toBeNull();
  });

  it("detects a different hosted credential without disclosing either key", () => {
    const notice = codexHostedMcpCredentialSplitNotice(
      sharedConfigCodexEnv(
        { HOSTED_ORG_KEY: "rmb_other_query_key" },
        [
          "[mcp_servers.remembrance]",
          'url = "https://remembrance.dev/api/mcp"',
          'env_http_headers = { "X-Remembrance-API-Key" = "HOSTED_ORG_KEY" }',
        ].join("\n"),
      ),
    );

    expect(notice).toContain("uses a different credential from HOSTED_ORG_KEY");
    expect(notice).not.toContain("rmb_shared_query_key");
    expect(notice).not.toContain("rmb_other_query_key");
  });

  it("stays silent when hosted MCP receives the same credential", () => {
    expect(
      codexHostedMcpCredentialSplitNotice(
        sharedConfigCodexEnv(
          { HOSTED_ORG_KEY: "rmb_shared_query_key" },
          [
            "[mcp_servers.remembrance]",
            'url = "https://remembrance.dev/api/mcp"',
            'env_http_headers = { "X-Remembrance-API-Key" = "HOSTED_ORG_KEY" }',
          ].join("\n"),
        ),
      ),
    ).toBeNull();

    expect(
      codexHostedMcpCredentialSplitNotice(
        sharedConfigCodexEnv({
          REMEMBRANCE_API_KEY: "rmb_shared_query_key",
        }),
      ),
    ).toBeNull();
  });

  it("does not query or record for one-off fact prompts", async () => {
    const fetchImpl = vi.fn();
    const recorded = [];
    const output = await handleQuery(
      { prompt: "What is the capital of France?", turn_id: "t2" },
      { env: testEnv(), fetchImpl, recordUse: (id) => recorded.push(id) },
    );
    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("sends the x-remembrance-api-key header from REMEMBRANCE_API_KEY when set", async () => {
    const headers = [];
    await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-key-env" },
      {
        env: testEnv({ REMEMBRANCE_API_KEY: "env-key-123" }),
        recordUse: () => {},
        fetchImpl: vi.fn(async (url, init) => {
          if (String(url).endsWith("/api/v1/agent/query")) {
            headers.push(init.headers);
          }
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]["x-remembrance-api-key"]).toBe("env-key-123");
  });

  it("falls back to the config-file apiKey when the env key is empty", async () => {
    // env key unset/empty, but XDG_CONFIG_HOME points at a dir with a
    // remembrance/config.json that carries the org apiKey.
    const configHome = join(tempRoot, `xdg-${(counter += 1)}`);
    mkdirSync(join(configHome, "remembrance"), { recursive: true });
    writeFileSync(
      join(configHome, "remembrance", "config.json"),
      JSON.stringify({ apiKey: "file-key-456" }),
      { mode: 0o600 },
    );
    const headers = [];
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-key-file" },
      {
        env: testEnv({ REMEMBRANCE_API_KEY: "", XDG_CONFIG_HOME: configHome }),
        recordUse: () => {},
        fetchImpl: vi.fn(async (url, init) => {
          if (String(url).endsWith("/api/v1/agent/query")) {
            headers.push(init.headers);
          }
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]["x-remembrance-api-key"]).toBe("file-key-456");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Remembrance credential source",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "file-key-456",
    );
  });

  it("retains the actionable split diagnostic when the query fails open", async () => {
    const configHome = join(tempRoot, `xdg-failure-${(counter += 1)}`);
    mkdirSync(join(configHome, "remembrance"), { recursive: true });
    writeFileSync(
      join(configHome, "remembrance", "config.json"),
      JSON.stringify({ apiKey: "file-key-failure" }),
      { mode: 0o600 },
    );
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-key-file-failure" },
      {
        env: testEnv({ REMEMBRANCE_API_KEY: "", XDG_CONFIG_HOME: configHome }),
        recordUse: () => {},
        fetchImpl: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      },
    );

    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Remembrance credential source",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "query-unavailable context",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "file-key-failure",
    );
  });

  it("omits the x-remembrance-api-key header when neither env nor config sets it", async () => {
    // XDG_CONFIG_HOME points at an empty dir (no config.json), env key unset.
    const configHome = join(tempRoot, `xdg-empty-${(counter += 1)}`);
    mkdirSync(configHome, { recursive: true });
    const headers = [];
    await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t-key-none" },
      {
        env: testEnv({ XDG_CONFIG_HOME: configHome }),
        recordUse: () => {},
        fetchImpl: vi.fn(async (url, init) => {
          if (String(url).endsWith("/api/v1/agent/query")) {
            headers.push(init.headers);
          }
          return Response.json({ skills: [], resources: [] });
        }),
      },
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]["x-remembrance-api-key"]).toBeUndefined();
  });

  it("redacts a fake secret before sending the query text", async () => {
    const bodies = [];
    await handleQuery(
      {
        prompt:
          "Fix this Vercel deploy using sk_live_1234567890123456 and http://svc.internal/private.",
        turn_id: "t3",
      },
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
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment.", turn_id: "t4" },
      { env: testEnv({ REMEMBRANCE_AUTO_QUERY: "0" }), fetchImpl },
    );
    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("disables preference capture and every network path when auto-query is disabled", async () => {
    const fetchImpl = vi.fn();
    const output = await handleQuery(
      {
        prompt: "My default should always use the least disruptive valid rollout.",
        turn_id: "preference-only",
      },
      { env: testEnv({ REMEMBRANCE_AUTO_QUERY: "0" }), fetchImpl },
    );
    expect(output).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open on bad input, timeouts, server errors, and malformed responses", async () => {
    // Missing prompt → no match → null, no throw.
    expect(await handleQuery({}, { env: testEnv() })).toBeNull();
    expect(await handleQuery(null, { env: testEnv() })).toBeNull();

    const timeout = await handleQuery(
      { prompt: "Set up Vercel deployment." },
      {
        env: testEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "100" }),
        fetchImpl: vi.fn(
          async (_url, init) =>
            new Promise((_res, reject) => {
              init.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        ),
      },
    );
    const serverError = await handleQuery(
      { prompt: "Set up Stripe payment integration." },
      {
        env: testEnv(),
        fetchImpl: vi.fn(async () => new Response("no", { status: 500 })),
      },
    );
    const malformed = await handleQuery(
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

  it("fails closed on public fallbacks when an organization key is configured", async () => {
    const output = await handleQuery(
      { prompt: "Set up Vercel deployment." },
      {
        env: testEnv({ REMEMBRANCE_API_KEY: "org_test_key" }),
        fetchImpl: vi.fn(async () => new Response("no", { status: 503 })),
      },
    );

    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toContain(
      "organization skill policy could not be confirmed",
    );
    expect(context).toContain("Fail closed");
    expect(context).toContain("do not use bundled public skill references");
    expect(context).not.toContain(
      "bundled public references remain an optional offline fallback",
    );
  });

  it("ships the expected manifests and bundled artifacts", () => {
    const plugin = JSON.parse(
      readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const hooks = JSON.parse(
      readFileSync(resolve(root, "hooks/hooks.json"), "utf8"),
    );
    const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    const marketplace = JSON.parse(
      readFileSync(
        resolve(root, "../../.agents/plugins/marketplace.json"),
        "utf8",
      ),
    );

    expect(plugin).toMatchObject({
      name: "remembrance",
      skills: "./skills",
      mcpServers: "./.mcp.json",
      interface: { displayName: "Remembrance" },
    });
    expect(plugin.hooks).toBeUndefined();
    expect(pkg.name).toBe("@remembrance/codex-plugin");
    expect(pkg.version).toBe(plugin.version);
    // Codex/Claude hook schema: each event maps to an array of GROUPS, each group
    // carrying its own nested `hooks` array of {type, command} entries.
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "query-on-prompt.mjs",
    );
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "${PLUGIN_ROOT}",
    );
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain(
      "contribute-on-stop.mjs",
    );
    expect(hooks.hooks.PostToolUse[0].matcher).toContain("get_skill");
    expect(hooks.hooks.PostToolUse[0].matcher).toContain("get_resource");
    expect(hooks.hooks.PostToolUse[0].matcher).toContain("query_skills");
    const postToolMatcher = new RegExp(hooks.hooks.PostToolUse[0].matcher);
    for (const toolName of [
      "mcp__remembrance__run_connection_doctor",
      "mcp__remembrancerun_connection_doctor",
      "mcp__remembrancequery_skills",
      "mcp__plugin_remembrance_remembrance__get_connection_status",
      "mcp__plugin_remembrance_remembranceget_connection_status",
      "remembrance.list_skills",
      "report_task_outcome",
    ]) {
      expect(postToolMatcher.test(toolName), toolName).toBe(true);
    }
    expect(postToolMatcher.test("mcp__other__run_connection_doctor")).toBe(
      false,
    );
    expect(postToolMatcher.test("mcp__remembranceevil_tool")).toBe(false);
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain(
      "record-detail-open.mjs",
    );
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      "${PLUGIN_ROOT}",
    );
    expect(JSON.stringify(hooks)).not.toContain("CODEX_PLUGIN_ROOT");
    // Hooks and bundled MCP both run from the installed plugin package. The MCP
    // process resolves the same shared config as the native lifecycle hooks.
    expect(mcp.mcpServers.remembrance).toMatchObject({
      command: "node",
      args: ["./servers/remembrance-mcp.mjs"],
      cwd: ".",
      env: { REMEMBRANCE_PLUGIN_HOST: "codex" },
    });
    expect(JSON.stringify(mcp)).not.toContain("REMEMBRANCE_API_KEY");
    expect(marketplace.plugins[0]).toMatchObject({
      name: "remembrance",
      source: { source: "local", path: "./packages/codex-plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    });
  });
});
