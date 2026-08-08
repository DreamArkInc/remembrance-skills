#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  recordPluginLifecycleHealth,
  resolveApiCredential,
  sessionIdFor,
} from "./hook-core.mjs";

function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

export function handleSessionStart(input, options = {}) {
  const env = options.env ?? process.env;
  const credential = resolveApiCredential(env);
  const version = options.pluginVersion ?? pluginVersion();
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  if (String(input?.source ?? "").trim().toLowerCase() !== "compact") {
    recordHealth(
      {
        surface: "claude_code",
        component: "session_start",
        pluginVersion: version,
        hostVersion: String(input?.claude_version ?? input?.version ?? ""),
        credentialSource: credential.source,
        sessionId: sessionIdFor(input),
      },
      env,
    );
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `Remembrance plugin health: Claude Code SessionStart hook is active for plugin ${version}; ` +
        "the bundled local MCP server resolves the same environment/shared config credential. " +
        "Run run_connection_doctor if setup seems incomplete. It verifies the active connection and gives one exact next step. If that tool is absent, report partial activation, update or reinstall the plugin, and restart Claude Code.",
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  process.stdout.write(`${JSON.stringify(handleSessionStart(input))}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {});
}
