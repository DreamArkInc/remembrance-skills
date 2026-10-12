import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The VS Code plugin is a COPY of the Claude Code plugin's hook scripts (VS Code
// auto-detects the Claude plugin format), differing only in host identity. Copies
// rot silently: a fix lands in the Claude script and this one never gets it, with
// no test failing anywhere. These assertions make that drift loud.
//
// If a real behavioral divergence is ever intended, add it to the allowlist below
// with a comment saying why — don't delete the test.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const claudeRoot = resolve(root, "../claude-code-plugin");
const read = (base, rel) => readFileSync(resolve(base, rel), "utf8");

// VS Code 1.133 sends no agent_id with a subagent's tool hooks, so its debts
// are recorded as possibly a subagent's; Claude Code sends one and keeps them
// per agent.
const SUBAGENT_IDENTITY_DECLARATION = [
  "  declareSubagentIdentityUnavailable,\n",
  "\n// VS Code 1.133 names a subagent only in SubagentStart and SubagentStop.\ndeclareSubagentIdentityUnavailable();\n",
];

// Every intentional host delta, as a normalization applied to the VS Code copy to
// turn it back into the Claude original.
function normalizeToClaude(source) {
  return SUBAGENT_IDENTITY_DECLARATION.reduce(
    (text, line) => text.replaceAll(line, ""),
    source,
  )
    .replaceAll(
      "VS Code UserPromptSubmit adapter.",
      "Claude Code UserPromptSubmit adapter.",
    )
    .replaceAll(
      "VS Code invokes this before",
      "Claude Code invokes this before",
    )
    .replaceAll('provider: "vscode"', 'provider: "claude"')
    .replaceAll('model: "vs-code-agent"', 'model: "claude-code"')
    .replaceAll(
      "VS Code adapter reports itself as the VS Code runtime",
      "Claude adapter reports itself as the Claude Code runtime",
    )
    .replaceAll('surface: "vs_code"', 'surface: "claude_code"')
    .replaceAll('runtime: "vs_code"', 'runtime: "claude_code"')
    .replaceAll('hostSurface: "extension"', 'hostSurface: "cli"')
    .replaceAll("@remembrance/vscode-plugin", "@remembrance/claude-code-plugin")
    .replaceAll("vscode-hook-cache.json", "claude-code-hook-cache.json")
    .replaceAll("input?.vscode_version", "input?.claude_version")
    .replaceAll("VS Code SessionStart", "Claude Code SessionStart")
    .replaceAll("VS Code Stop adapter", "Claude Code Stop adapter")
    .replaceAll("Loop-safe: VS Code sets", "Loop-safe: Claude Code sets")
    .replaceAll("and reload VS Code.", "and restart Claude Code.")
    .replaceAll("before reloading VS Code.", "before restarting Claude Code.");
}

describe("VS Code adapter parity with the Claude Code originals", () => {
  // These three are pure host-token swaps, so they must round-trip EXACTLY.
  // Any other change to either side breaks this and has to be made deliberately.
  for (const script of [
    "scripts/session-start.mjs",
    "scripts/contribute-on-stop.mjs",
    "scripts/record-detail-open.mjs",
  ]) {
    it(`${script} differs from the Claude original only in host identity`, () => {
      expect(normalizeToClaude(read(root, script))).toBe(
        read(claudeRoot, script),
      );
    });
  }

  it("query-on-prompt.mjs differs only in normalized host identity", () => {
    expect(normalizeToClaude(read(root, "scripts/query-on-prompt.mjs"))).toBe(
      read(claudeRoot, "scripts/query-on-prompt.mjs"),
    );
  });

  it("keeps the shared hook-core byte-identical to the synced source", () => {
    // hook-core.mjs is machine-synced (scripts/sync-hook-core.mjs). If this ever
    // fails, run `npm run sync:hook-core` rather than hand-editing the copy.
    expect(read(root, "scripts/hook-core.mjs")).toBe(
      read(claudeRoot, "scripts/hook-core.mjs"),
    );
  });

  it("never reports itself as Claude Code anywhere in its own scripts", () => {
    for (const script of [
      "scripts/session-start.mjs",
      "scripts/query-on-prompt.mjs",
      "scripts/contribute-on-stop.mjs",
      "scripts/record-detail-open.mjs",
    ]) {
      const source = read(root, script);
      expect(
        source.includes('surface: "claude_code"'),
        `${script} still reports the claude_code surface`,
      ).toBe(false);
      expect(
        source.includes("@remembrance/claude-code-plugin"),
        `${script} still sends the Claude Code user agent`,
      ).toBe(false);
    }
  });
});
