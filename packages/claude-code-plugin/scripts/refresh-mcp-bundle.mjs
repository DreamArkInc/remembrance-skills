#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(pluginRoot, "../..");
const mcpBundle = resolve(pluginRoot, "../mcp-server/dist/server.js");
const bundledServer = resolve(pluginRoot, "servers/remembrance-mcp.mjs");
const canonicalSkill = resolve(repoRoot, "skills/remembrancer/SKILL.md");
const canonicalSkillReferences = resolve(
  repoRoot,
  "skills/remembrancer/references",
);
const canonicalSkillScripts = resolve(repoRoot, "skills/remembrancer/scripts");
const bundledSkill = resolve(pluginRoot, "skills/remembrancer/SKILL.md");
const bundledSkillReferences = resolve(
  pluginRoot,
  "skills/remembrancer/references",
);
const bundledSkillScripts = resolve(pluginRoot, "skills/remembrancer/scripts");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(
  npmCommand,
  ["run", "build", "-w", "@remembrance-ai/mcp-server"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

await stat(mcpBundle);
await stat(canonicalSkill);
await stat(canonicalSkillReferences);
await stat(canonicalSkillScripts);
await mkdir(dirname(bundledServer), { recursive: true });
await copyFile(mcpBundle, bundledServer);
await chmod(bundledServer, 0o755);
await mkdir(dirname(bundledSkill), { recursive: true });
await copyFile(canonicalSkill, bundledSkill);
await rm(bundledSkillReferences, { recursive: true, force: true });
await rm(bundledSkillScripts, { recursive: true, force: true });
await cp(canonicalSkillReferences, bundledSkillReferences, { recursive: true });
await cp(canonicalSkillScripts, bundledSkillScripts, { recursive: true });

console.log(`Refreshed ${bundledServer}`);
console.log(`Refreshed ${bundledSkill}`);
console.log(`Refreshed ${bundledSkillReferences}`);
console.log(`Refreshed ${bundledSkillScripts}`);
