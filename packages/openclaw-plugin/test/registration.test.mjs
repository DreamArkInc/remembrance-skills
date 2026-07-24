import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.mjs";
import { configureOpenClawRemembrance } from "../src/index.mjs";
import { readPluginLifecycleHealth } from "../src/hook-core.mjs";

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

    expect(on.mock.calls.map(([name]) => name)).toEqual([
      "before_prompt_build",
      "after_tool_call",
      "before_agent_finalize",
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
            command: "node",
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
});
