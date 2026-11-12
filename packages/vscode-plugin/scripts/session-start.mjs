#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import {
  checkForClientUpdate,
  HOOK_CONTEXT_BUDGETS,
  isEntryScript,
  preferenceSnapshotText,
  projectPreferenceSnapshot,
  recordPluginLifecycleHealth,
  resolveApiCredential,
  sessionIdFor,
  sessionSkillsDirective,
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
        surface: "vs_code",
        component: "session_start",
        pluginVersion: version,
        hostVersion: String(input?.vscode_version ?? input?.version ?? ""),
        credentialSource: credential.source,
        sessionId: sessionIdFor(input),
      },
      env,
    );
  }
  const baseContext =
    `Remembrance plugin health: VS Code SessionStart hook is active for plugin ${version}; ` +
    "the bundled local MCP server resolves the same environment/shared config credential. " +
    "Run run_connection_doctor if setup seems incomplete. It verifies the active connection and gives one exact next step. If that tool is absent, report partial activation, update or reinstall the plugin, and reload VS Code.";
  const hostVersion = String(input?.vscode_version ?? input?.version ?? "");
  // Runs beside the requests below; on compaction it reads only its cache.
  const sessionSkills = sessionSkillsDirective(
    {
      source: input?.source,
      nativeSessionId: input?.session_id,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    env,
  ).catch(() => null);
  // Every source, compaction included, warms the session the preference read
  // below uses.
  const warmup = (options.warmSession ?? warmPrincipalSession)(
    {
      runtime: "vs_code",
      hostSurface: "extension",
      clientVersion: version,
      hostVersion,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    env,
  ).catch(() => null);
  const [, clientUpdate] = isCompaction
    ? [await warmup, null]
    : await Promise.all([
        warmup,
        (options.checkUpdate ?? checkForClientUpdate)(
          {
            surface: "vs_code",
            currentVersion: version,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
      ]);
  // The host's project, as the prompt hook reads it.
  const snapshot = await projectPreferenceSnapshot({
    runtime: "vs_code",
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    projectPath: input?.cwd ?? null,
    userAgent: "@remembrance/vscode-plugin",
  });
  const context = [baseContext, clientUpdate?.notice, await sessionSkills]
    .filter(Boolean)
    .join("\n\n");
  // The snapshot fits exactly into what remains of the budget: whole, or
  // page 1 with its opening line.
  const preferences =
    snapshot &&
    preferenceSnapshotText(snapshot, {
      maxChars: HOOK_CONTEXT_BUDGETS.vscode.maxChars - context.length - 2,
    });
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: preferences ? `${context}\n\n${preferences}` : context,
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

if (isEntryScript(import.meta.url)) {
  main().catch(() => {});
}
