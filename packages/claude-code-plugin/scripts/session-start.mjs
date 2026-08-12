#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  checkForClientUpdate,
  recordPluginLifecycleHealth,
  resolveApiCredential,
  sessionIdFor,
  warmPrincipalSession,
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

export async function handleSessionStart(input, options = {}) {
  const env = options.env ?? process.env;
  const credential = resolveApiCredential(env);
  const version = options.pluginVersion ?? pluginVersion();
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  const isCompaction =
    String(input?.source ?? "")
      .trim()
      .toLowerCase() === "compact";
  if (!isCompaction) {
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
  const baseContext =
    `Remembrance plugin health: Claude Code SessionStart hook is active for plugin ${version}; ` +
    "the bundled local MCP server resolves the same environment/shared config credential. " +
    "Run run_connection_doctor if setup seems incomplete. It verifies the active connection and gives one exact next step. If that tool is absent, report partial activation, update or reinstall the plugin, and restart Claude Code.";
  const hostVersion = String(input?.claude_version ?? input?.version ?? "");
  const [, clientUpdate] = isCompaction
    ? [null, null]
    : await Promise.all([
        (options.warmSession ?? warmPrincipalSession)(
          {
            runtime: "claude_code",
            hostSurface: "cli",
            clientVersion: version,
            hostVersion,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
        (options.checkUpdate ?? checkForClientUpdate)(
          {
            surface: "claude_code",
            currentVersion: version,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
      ]);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: clientUpdate?.notice
        ? `${baseContext}\n\n${clientUpdate.notice}`
        : baseContext,
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
  process.stdout.write(`${JSON.stringify(await handleSessionStart(input))}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {});
}
