import { readFileSync } from "node:fs";
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
    });
    expect(JSON.stringify(mcp)).not.toMatch(/\$\{[^}]+:-/);
    expect(mcp.mcpServers.remembrance.args[0]).toContain(
      "${CLAUDE_PLUGIN_ROOT}",
    );
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
    expect(JSON.stringify(mcp)).toContain(
      "${CLAUDE_PLUGIN_ROOT}/packages/vscode-plugin/servers/remembrance-mcp.mjs",
    );
    expect(mcp.mcpServers.remembrance.env).toEqual({
      REMEMBRANCE_PLUGIN_HOST: "vs_code",
    });
    expect(JSON.stringify(mcp)).not.toMatch(/\$\{[^}]+:-/);
  });
});
