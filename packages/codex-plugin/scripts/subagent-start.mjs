#!/usr/bin/env node
// Codex SubagentStart adapter.
//
// Codex runs this when it starts a subagent, with stdin JSON that includes
// the session's cwd. It gives the subagent the project-context preference
// snapshot by printing
// {"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": "..."}}
// within the Codex budget: the whole snapshot, or page 1 with its opening
// line. It writes no marker and records no lifecycle health, and prints
// nothing when no snapshot applies (no organization credential, or
// REMEMBRANCE_AUTO_QUERY=0).

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  debugLog,
  disabled,
  HOOK_CONTEXT_BUDGETS,
  preferenceSnapshotText,
  projectPreferenceSnapshot,
  resolveApiCredential,
  warmPrincipalSession,
} from "./hook-core.mjs";

// The plugin version the warm-up registers, as SessionStart does, so an
// exchange made here keeps the admin view's client version.
function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

export async function handleSubagentStart(input, options = {}) {
  const env = options.env ?? process.env;
  // Without a snapshot to deliver, a subagent start sends nothing.
  if (
    disabled(env.REMEMBRANCE_AUTO_QUERY) ||
    !resolveApiCredential(env).apiKey
  ) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  await (options.warmSession ?? warmPrincipalSession)(
    {
      runtime: "codex",
      clientVersion: options.pluginVersion ?? pluginVersion(),
      hostVersion: String(
        input?.codex_version ?? input?.app_version ?? input?.version ?? "",
      ).trim(),
      fetchImpl,
    },
    env,
  ).catch(() => null);
  const snapshot = await projectPreferenceSnapshot({
    runtime: "codex",
    env,
    fetchImpl,
    projectPath: input?.cwd ?? null,
  });
  const preferences =
    snapshot && preferenceSnapshotText(snapshot, HOOK_CONTEXT_BUDGETS.codex);
  return preferences
    ? {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: preferences,
        },
      }
    : null;
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
  const output = await handleSubagentStart(input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // Preference context is advisory and must never block a subagent.
    debugLog(process.env, "subagent_start_error", {
      error: error instanceof Error ? error.name : "Error",
    });
  });
}
