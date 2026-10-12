import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "../..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

// VS Code agent plugins (Preview) auto-detect the Claude plugin format and
// resolve ${CLAUDE_PLUGIN_ROOT} for it. These assertions pin the parts of that
// contract we depend on, so a rename cannot quietly make the plugin undetectable.
describe("VS Code agent plugin manifest", () => {
  it("is discoverable through the Claude-format detection path", () => {
    const manifest = readJson(".claude-plugin/plugin.json");
    expect(manifest.name).toBe("remembrance");
    expect(manifest.skills).toBe("./skills");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(manifest.mcpServers).toBe("./.mcp.json");
  });

  it("declares only hook events VS Code supports, via the plugin-root token", () => {
    const hooks = readJson("hooks/hooks.json").hooks;
    // The documented VS Code agent-plugin event set.
    const supported = new Set([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
    const declared = Object.keys(hooks);
    expect(declared.length).toBeGreaterThan(0);
    for (const event of declared) {
      expect(supported.has(event), `${event} is not a VS Code hook event`).toBe(
        true,
      );
    }
    // Every command must go through the plugin-root token, otherwise the hook
    // resolves relative to the workspace and silently never runs.
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe("command");
          expect(hook.command).toContain("${CLAUDE_PLUGIN_ROOT}");
        }
      }
    }
  });

  it("reports its own plugin host so client-health does not merge it with Claude Code", () => {
    const mcp = readJson(".mcp.json");
    expect(mcp.mcpServers.remembrance.env).toEqual({
      REMEMBRANCE_PLUGIN_HOST: "vs_code",
      REMEMBRANCE_HOST_SURFACE: "extension",
    });
    expect(JSON.stringify(mcp)).not.toMatch(/\$\{[^}]+:-/);
    expect(mcp.mcpServers.remembrance.args[0]).toContain(
      "${CLAUDE_PLUGIN_ROOT}",
    );
  });

  it("starts every hook and the bundled MCP server through the POSIX launcher", () => {
    // The launcher finds Node.js when the host's PATH does not include it. On
    // Windows, VS Code runs each hook's `windows` form instead (through
    // PowerShell or cmd.exe): the plain node command, so no sh is needed.
    const cases = [
      {
        base: root,
        prefix: "${CLAUDE_PLUGIN_ROOT}/",
        hooks: readJson("hooks/hooks.json"),
        mcp: readJson(".mcp.json"),
      },
      {
        base: repoRoot,
        prefix: "${CLAUDE_PLUGIN_ROOT}/packages/vscode-plugin/",
        hooks: JSON.parse(
          readFileSync(
            resolve(repoRoot, ".claude-plugin/vscode-hooks.json"),
            "utf8",
          ),
        ),
        mcp: JSON.parse(
          readFileSync(
            resolve(repoRoot, ".claude-plugin/vscode-mcp.json"),
            "utf8",
          ),
        ),
      },
    ];
    for (const { base, prefix, hooks, mcp } of cases) {
      const launcher = `${prefix}scripts/node-launcher`;
      const handlers = Object.values(hooks.hooks).flatMap((entries) =>
        entries.flatMap((entry) => entry.hooks),
      );
      expect(handlers).toHaveLength(6);
      // A subagent is asked for its own pending actions by the same script,
      // which also marks its start so that its task prompt is not taken for
      // the user's.
      expect(hooks.hooks.SubagentStop).toEqual(hooks.hooks.Stop);
      expect(hooks.hooks.SubagentStart).toEqual(hooks.hooks.Stop);
      for (const { command, windows } of handlers) {
        const quoted = command.match(/^sh "([^"]+)" "([^"]+\.mjs)"$/);
        expect(quoted?.[1], command).toBe(launcher);
        expect(quoted?.[2].startsWith(`${prefix}scripts/`), command).toBe(true);
        expect(
          existsSync(
            resolve(base, quoted[2].replace("${CLAUDE_PLUGIN_ROOT}/", "")),
          ),
        ).toBe(true);
        expect(windows, command).toBe(`node "${quoted[2]}"`);
      }
      expect(mcp.mcpServers.remembrance.command).toBe("sh");
      expect(mcp.mcpServers.remembrance.args).toEqual([
        launcher,
        `${prefix}servers/remembrance-mcp.mjs`,
      ]);
      expect(
        existsSync(
          resolve(base, launcher.replace("${CLAUDE_PLUGIN_ROOT}/", "")),
        ),
      ).toBe(true);
    }
  });

  it("observes private-lesson submission and retry tools", () => {
    const hooks = readJson("hooks/hooks.json").hooks;
    const matcher = new RegExp(hooks.PostToolUse[0].matcher);
    expect(
      matcher.test("mcp__remembrance__submit_private_lesson_candidate"),
    ).toBe(true);
    expect(
      matcher.test(
        "mcp__plugin_remembrance_remembrance__retry_private_lesson_candidate",
      ),
    ).toBe(true);
  });

  it("keeps the manifest version in step with the package version", () => {
    expect(readJson(".claude-plugin/plugin.json").version).toBe(
      readJson("package.json").version,
    );
  });

  it("ships a public-mirror root manifest for direct source installation", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, ".claude-plugin/plugin.json"), "utf8"),
    );
    const hooks = JSON.parse(
      readFileSync(
        resolve(repoRoot, ".claude-plugin/vscode-hooks.json"),
        "utf8",
      ),
    );
    const mcp = JSON.parse(
      readFileSync(resolve(repoRoot, ".claude-plugin/vscode-mcp.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      name: "remembrance",
      skills: "./skills",
      hooks: "./.claude-plugin/vscode-hooks.json",
      mcpServers: "./.claude-plugin/vscode-mcp.json",
    });
    expect(JSON.stringify(hooks)).toContain(
      "${CLAUDE_PLUGIN_ROOT}/packages/vscode-plugin/scripts/session-start.mjs",
    );
    // A declined pending action closes only when the observer sees the call.
    expect(
      new RegExp(hooks.hooks.PostToolUse[0].matcher).test(
        "mcp__remembrance__decline_pending_action",
      ),
    ).toBe(true);
    expect(JSON.stringify(mcp)).toContain(
      "${CLAUDE_PLUGIN_ROOT}/packages/vscode-plugin/servers/remembrance-mcp.mjs",
    );
    expect(mcp.mcpServers.remembrance.env).toEqual({
      REMEMBRANCE_PLUGIN_HOST: "vs_code",
      REMEMBRANCE_HOST_SURFACE: "extension",
    });
    expect(JSON.stringify(mcp)).not.toMatch(/\$\{[^}]+:-/);
  });
});
