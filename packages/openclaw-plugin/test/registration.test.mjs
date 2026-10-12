import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.mjs";
import {
  configureOpenClawRemembrance,
  handlePrivateLessonSubmitApproval,
} from "../src/index.mjs";
import {
  readCompletionObligations,
  readPluginLifecycleHealth,
} from "../src/hook-core.mjs";
import { EXPECTED_OPENCLAW_RUNTIME_HOOKS } from "../../../scripts/openclaw-plugin-install-smoke.mjs";
import {
  OFFLINE_FETCH_IMPORT,
  useIsolatedHookEnvironment,
} from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

// Registered before the suite's own hooks, which unstub after each test.
useIsolatedHookEnvironment();

describe("OpenClaw plugin registration health", () => {
  const dirs = [];

  beforeEach(() => {
    // Isolate credential resolution from the ambient environment so
    // credential_source assertions are deterministic regardless of a developer
    // (or CI) exporting REMEMBRANCE_API_KEY or having ~/.config/remembrance.
    // os.homedir() reads $HOME on POSIX, so an empty temp HOME hides any real
    // shared-config file.
    const home = mkdtempSync(join(tmpdir(), "remembrance-openclaw-home-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("REMEMBRANCE_API_KEY", "");
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.REMEMBRANCE_PLUGIN_HEALTH_DIR;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares startup activation for native lifecycle registration", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "remembrance",
      activation: { onStartup: true },
    });
    expect(packageJson.openclaw).toMatchObject({
      compat: {
        pluginApi: ">=2026.7.1-2",
        minGatewayVersion: "2026.7.1-2",
      },
      build: {
        openclawVersion: "2026.7.1-2",
        pluginSdkVersion: "2026.7.1-2",
      },
    });
  });

  it("registers every lifecycle hook and records startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "remembrance-openclaw-health-"));
    dirs.push(dir);
    process.env.REMEMBRANCE_PLUGIN_HEALTH_DIR = dir;
    const on = vi.fn();
    const info = vi.fn();
    const registerCli = vi.fn();

    plugin.register({ on, logger: { info }, registerCli, version: "1.2.3" });

    expect(on.mock.calls.map(([name]) => name)).toEqual(
      EXPECTED_OPENCLAW_RUNTIME_HOOKS,
    );
    // Registered last, so the order of the earlier hooks stays stable.
    expect(on.mock.calls.at(-1)).toEqual([
      "subagent_ended",
      expect.any(Function),
      { priority: 50 },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("lifecycle hooks registered"),
    );
    expect(registerCli).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        descriptors: [
          expect.objectContaining({
            name: "remembrance",
            hasSubcommands: true,
          }),
        ],
      }),
    );
    expect(readPluginLifecycleHealth("openclaw", process.env)).toMatchObject({
      surface: "openclaw",
      host_version: "1.2.3",
      credential_source: "none",
      components: { session_start: expect.any(String) },
    });
  });

  it("keys lifecycle state by the run OpenClaw passes as the hook context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remembrance-openclaw-health-"));
    dirs.push(dir);
    process.env.REMEMBRANCE_PLUGIN_HEALTH_DIR = dir;
    vi.stubEnv("REMEMBRANCE_AUTO_QUERY", "0");
    vi.stubEnv("REMEMBRANCE_AUTO_CONTRIBUTE", "0");
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    const hook = (name) =>
      on.mock.calls.find(([hookName]) => hookName === name)[1];
    const components = (runId) =>
      Object.keys(
        readPluginLifecycleHealth("openclaw", process.env, runId)?.components ??
          {},
      ).sort();

    // OpenClaw 2026.7.1-2 calls a typed hook as handler(event, ctx) and keeps
    // the run's identity in ctx; before_prompt_build's event has none.
    for (const runId of ["run-first", "run-second"]) {
      const ctx = { runId, sessionId: `session-${runId}`, agentId: "main" };
      await hook("before_prompt_build")(
        { prompt: "Check the Remembrance connection.", messages: [] },
        ctx,
      );
      await hook("after_tool_call")(
        { toolName: "session_status", params: {}, runId, result: {} },
        ctx,
      );
      await expect(
        hook("before_agent_finalize")(
          { runId, sessionId: ctx.sessionId, stopHookActive: false },
          ctx,
        ),
      ).resolves.toMatchObject({ action: "finalize" });
      expect(components(runId)).toEqual([
        "completion_hook",
        "prompt_hook",
        "session_start",
        "tool_observer",
      ]);
    }
    expect(components(null)).toEqual(["session_start"]);
  });

  // OpenClaw starts a new run for every turn of a session. A debt one run
  // leaves (silent finalize) is offered at the next prompt of the same
  // session, closed there, and never offered in another session.
  it("keeps a debt in its OpenClaw session across runs and out of other sessions", async () => {
    const usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-usage-"));
    dirs.push(usage);
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    const hook = (name) =>
      on.mock.calls.find(([hookName]) => hookName === name)[1];
    const queryId = "rq_openclawsessionledger";
    const ctx = (runId, sessionId) => ({ runId, sessionId, agentId: "main" });
    const prompt = (context) =>
      hook("before_prompt_build")(
        { prompt: "What is the capital of France?", messages: [] },
        context,
      );
    const toolResult = (body) => ({
      content: [{ type: "text", text: JSON.stringify(body) }],
    });
    const owed = `call submit_query_feedback for query_id ${queryId}`;

    const first = ctx("run-1", "session-a");
    await expect(prompt(first)).resolves.toBeUndefined();
    await hook("after_tool_call")(
      {
        toolName: "remembrance__query_skills",
        params: { query: "deploy" },
        runId: "run-1",
        result: toolResult({
          query_id: queryId,
          skills: [],
          resources: [],
          query_feedback: { available: true, query_id: queryId },
        }),
      },
      first,
    );
    await expect(
      hook("before_agent_finalize")(
        { runId: "run-1", sessionId: "session-a", stopHookActive: false },
        first,
      ),
    ).resolves.toEqual({ action: "finalize", why: "silent_prompt_recovery" });
    expect(readCompletionObligations("session-a", process.env)).toEqual([
      expect.objectContaining({ kind: "query_feedback", query_id: queryId }),
    ]);
    expect(readCompletionObligations("run-1", process.env)).toEqual([]);

    await expect(prompt(ctx("run-2", "session-b"))).resolves.toBeUndefined();

    const next = ctx("run-3", "session-a");
    const recovery = await prompt(next);
    expect(recovery?.appendSystemContext).toContain(owed);
    await hook("after_tool_call")(
      {
        toolName: "remembrance__submit_query_feedback",
        params: { query_id: queryId, overall_fit: "none" },
        runId: "run-3",
        result: toolResult({ ok: true, status: 201, body: { accepted: true } }),
      },
      next,
    );
    expect(readCompletionObligations("session-a", process.env)).toEqual([]);
    await expect(prompt(ctx("run-4", "session-a"))).resolves.toBeUndefined();
  });

  // Visible recovery mode asks at finalize. A run that never finalized
  // (stopped, say) leaves its debt to the next run of its session.
  it("asks the next run of the session, not another session, for a debt in visible recovery mode", async () => {
    const usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-usage-"));
    dirs.push(usage);
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "1");
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    const hook = (name) =>
      on.mock.calls.find(([hookName]) => hookName === name)[1];
    const queryId = "rq_openclawvisibleledger";
    const finalize = (runId, sessionId) =>
      hook("before_agent_finalize")(
        { runId, sessionId, stopHookActive: false },
        { runId, sessionId },
      );
    await hook("after_tool_call")(
      {
        toolName: "remembrance__query_skills",
        params: { query: "deploy" },
        runId: "run-1",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query_id: queryId,
                skills: [],
                resources: [],
                query_feedback: { available: true, query_id: queryId },
              }),
            },
          ],
        },
      },
      { runId: "run-1", sessionId: "session-a" },
    );

    await expect(finalize("run-2", "session-b")).resolves.toMatchObject({
      action: "finalize",
    });
    const asked = await finalize("run-3", "session-a");
    expect(asked).toMatchObject({
      action: "revise",
      why: "prompt_pending_obligations",
    });
    expect(asked.reason).toContain(
      `call submit_query_feedback for query_id ${queryId}`,
    );
    await expect(finalize("run-4", "session-a")).resolves.toMatchObject({
      action: "finalize",
    });
  });

  it("requests and persists approvals by semantic egress lane", async () => {
    const onAllowAlways = vi.fn();
    expect(
      handlePrivateLessonSubmitApproval(
        { toolName: "remembrance_submit_private_lesson_candidate" },
        { onAllowAlways },
      ),
    ).toMatchObject({
      requireApproval: {
        title: "Submit private Remembrance lesson",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    const approval = handlePrivateLessonSubmitApproval(
      { tool_name: "submit_private_lesson_candidate" },
      { onAllowAlways },
    );
    approval.requireApproval.onResolution("allow-once");
    expect(onAllowAlways).not.toHaveBeenCalled();
    approval.requireApproval.onResolution("allow-always");
    expect(onAllowAlways).toHaveBeenCalledOnce();
    expect(
      handlePrivateLessonSubmitApproval(
        { toolName: "submit_private_lesson_candidate" },
        { approved: true },
      ),
    ).toMatchObject({ requireApproval: expect.any(Object) });
    expect(
      handlePrivateLessonSubmitApproval({ toolName: "submit_remembrance" }),
    ).toMatchObject({
      requireApproval: { title: "Submit broad Remembrance content" },
    });
    expect(
      handlePrivateLessonSubmitApproval({ toolName: "submit_query_feedback" }),
    ).toBeUndefined();

    const on = vi.fn();
    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      const draft = { plugins: { entries: { remembrance: { config: {} } } } };
      mutate(draft);
      expect(draft.plugins.entries.remembrance.config).toEqual({
        privateLearningEgressApprovals: { private_lesson: true },
      });
    });
    plugin.register({
      on,
      logger: { info: vi.fn(), warn: vi.fn() },
      registerCli: vi.fn(),
      pluginConfig: {},
      runtime: { config: { mutateConfigFile } },
    });
    const beforeToolCall = on.mock.calls.find(
      ([name]) => name === "before_tool_call",
    )[1];
    const registeredApproval = await beforeToolCall({
      toolName: "submit_private_lesson_candidate",
    });
    registeredApproval.requireApproval.onResolution("allow-always");
    await vi.waitFor(() => expect(mutateConfigFile).toHaveBeenCalledOnce());
    await expect(
      beforeToolCall({ toolName: "retry_private_lesson_candidate" }),
    ).resolves.toBeUndefined();
  });

  it("delivers an available update to the agent once per session", async () => {
    const on = vi.fn();
    const clientUpdateCheck = vi.fn(async () => ({
      current_version: "0.1.54",
      latest_version: "0.1.55",
      notice:
        "Remembrance update available. Ask permission, update OpenClaw, restart the Gateway, and begin a new session.",
    }));
    plugin.register({
      on,
      logger: { info: vi.fn() },
      registerCli: vi.fn(),
      clientUpdateCheck,
    });
    const prePrompt = on.mock.calls.find(
      ([name]) => name === "before_prompt_build",
    )[1];
    const event = { prompt: "", context: { sessionId: "update-session" } };
    await expect(prePrompt(event)).resolves.toMatchObject({
      appendSystemContext: expect.stringContaining("restart the Gateway"),
    });
    await expect(prePrompt(event)).resolves.toBeUndefined();
    expect(clientUpdateCheck).toHaveBeenCalledOnce();
  });

  it("delivers the update notice once per OpenClaw session, not once per run", async () => {
    const on = vi.fn();
    plugin.register({
      on,
      logger: { info: vi.fn() },
      registerCli: vi.fn(),
      clientUpdateCheck: vi.fn(async () => ({
        current_version: "0.1.54",
        latest_version: "0.1.55",
        notice:
          "Remembrance update available. Ask permission, update OpenClaw, restart the Gateway, and begin a new session.",
      })),
    });
    const prePrompt = on.mock.calls.find(
      ([name]) => name === "before_prompt_build",
    )[1];
    // OpenClaw gives each run of a session its own runId (handler(event, ctx)).
    const turn = (runId, sessionId) =>
      prePrompt({ prompt: "", messages: [] }, { runId, sessionId });
    const notice = {
      appendSystemContext: expect.stringContaining("restart the Gateway"),
    };
    await expect(turn("run-1", "session-a")).resolves.toMatchObject(notice);
    await expect(turn("run-2", "session-a")).resolves.toBeUndefined();
    await expect(turn("run-3", "session-b")).resolves.toMatchObject(notice);
  });

  it("preserves host config while enabling hooks and the installed MCP path", () => {
    const pluginRoot = new URL("..", import.meta.url).pathname;
    const draft = {
      plugins: {
        allow: ["remembrance"],
        entries: {
          other: { enabled: true },
          remembrance: {
            config: { retained: true },
            hooks: { retained: true },
          },
        },
      },
      mcp: {
        servers: {
          other: { command: "other" },
          remembrance: {
            include: ["query_skills"],
            env: { REMEMBRANCE_API_URL: "https://example.test" },
          },
        },
      },
    };

    const result = configureOpenClawRemembrance(draft, pluginRoot);

    expect(draft).toMatchObject({
      plugins: {
        allow: ["remembrance"],
        entries: {
          other: { enabled: true },
          remembrance: {
            enabled: true,
            config: { retained: true },
            hooks: { retained: true, allowConversationAccess: true },
          },
        },
      },
      mcp: {
        servers: {
          other: { command: "other" },
          remembrance: {
            command: process.execPath,
            args: [result.serverPath],
            include: ["query_skills"],
            env: {
              REMEMBRANCE_API_URL: "https://example.test",
              REMEMBRANCE_PLUGIN_HOST: "openclaw",
            },
          },
        },
      },
    });
    expect(result.serverPath).toMatch(/servers\/remembrance-mcp\.mjs$/);
  });

  it("registers an MCP command that starts without node on the gateway's PATH", async () => {
    const draft = {};
    configureOpenClawRemembrance(draft, new URL("..", import.meta.url).pathname);
    const { command, args, env } = draft.mcp.servers.remembrance;
    const home = mkdtempSync(join(tmpdir(), "remembrance-openclaw-gateway-"));
    dirs.push(home);
    const emptyPath = join(home, "empty-bin");
    mkdirSync(emptyPath);
    const child = spawn(command, args, {
      env: {
        ...env,
        HOME: home,
        PATH: emptyPath,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
        NODE_OPTIONS: `--import=${OFFLINE_FETCH_IMPORT}`,
      },
    });
    const exited = new Promise((done) => child.on("close", done));
    child.on("error", () => {});
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const response = new Promise((done) =>
      child.stdout.on("data", () => {
        const line = stdout.split("\n").find((text) => text.includes('"id":1'));
        if (line) done(JSON.parse(line));
      }),
    );
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "openclaw-registration-test", version: "1" },
          },
        })}\n`,
      );
      await expect(
        Promise.race([response, exited.then(() => "exited")]),
      ).resolves.toMatchObject({
        id: 1,
        result: { serverInfo: { name: "@remembrance-ai/mcp-server" } },
      });
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });
});
