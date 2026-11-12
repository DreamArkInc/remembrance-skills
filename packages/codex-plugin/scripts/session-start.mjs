#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { inspectCodexHookTrust } from "./codex-hook-trust.mjs";
import {
  checkForClientUpdate,
  estimatePreferenceSnapshotTokens,
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
  const hostVersion = String(
    input?.codex_version ?? input?.app_version ?? input?.version ?? "",
  ).trim();
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  const isCompaction =
    String(input?.source ?? "")
      .trim()
      .toLowerCase() === "compact";
  const auth =
    credential.source === "none"
      ? "public anonymous registry access"
      : `${credential.source.replace("_", " ")} organization credential`;
  const baseContext =
    `Remembrance plugin health: Codex SessionStart hook is active for plugin ${version}; ` +
    `the bundled local MCP server uses the same ${auth}. ` +
    "Run run_connection_doctor if setup seems incomplete. It verifies the active connection and gives one exact next step. If that tool is absent, report partial activation, update or reinstall the plugin, and fully restart Codex.";
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
      runtime: "codex",
      hostSurface:
        input?.host_surface === "desktop" || input?.host_surface === "cli"
          ? input.host_surface
          : input?.app_version || input?.codex_desktop_version
            ? "desktop"
            : "unknown",
      clientVersion: version,
      hostVersion,
      fetchImpl: options.fetchImpl ?? fetch,
    },
    env,
  ).catch(() => null);
  const [hookTrust, , clientUpdate] = isCompaction
    ? [null, await warmup, null]
    : await Promise.all([
        (options.inspectHookTrust ?? inspectCodexHookTrust)({
          env,
          cwd: options.cwd,
        }).catch(() => null),
        warmup,
        (options.checkUpdate ?? checkForClientUpdate)(
          {
            surface: "codex",
            currentVersion: version,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
      ]);
  const snapshot = await projectPreferenceSnapshot({
    runtime: "codex",
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    projectPath: input?.cwd ?? null,
  });
  if (!isCompaction) {
    recordHealth(
      {
        surface: "codex",
        component: "session_start",
        pluginVersion: version,
        hostVersion,
        credentialSource: credential.source,
        sessionId: sessionIdFor(input),
        hookTrust,
      },
      env,
    );
  }
  const trustNotice =
    hookTrust?.status === "review_required"
      ? `Remembrance hook trust review is required for ${hookTrust.review_events.join(", ")}. Querying, opening skills, bounded feedback, and private submissions remain available; until those hooks are approved, only what they add is paused (SubagentStart: each subagent's preference snapshot; UserPromptSubmit: each prompt's search and preference snapshot; the others: automatic skill-use or completion tracking). Run run_connection_doctor and follow its exact Codex review steps before claiming full activation.`
      : null;
  const notices = [
    trustNotice,
    clientUpdate?.notice,
    await sessionSkills,
  ].filter(Boolean);
  const context = [baseContext, ...notices].join("\n\n");
  // The snapshot fits exactly into what remains of the Codex budget: whole,
  // or page 1 with its opening line.
  const budget = HOOK_CONTEXT_BUDGETS.codex;
  const preferences =
    snapshot &&
    preferenceSnapshotText(snapshot, {
      maxChars: budget.maxChars - context.length - 2,
      maxEstimatedTokens:
        budget.maxEstimatedTokens -
        estimatePreferenceSnapshotTokens(`${context}\n\n`),
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

export async function main() {
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
  main().catch(() => {
    // Health context is advisory and must never block startup.
  });
}
