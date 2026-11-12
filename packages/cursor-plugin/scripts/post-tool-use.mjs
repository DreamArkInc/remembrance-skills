#!/usr/bin/env node
// Cursor postToolUse adapter: earlier pickup of the workspace's
// project-context preference snapshot, never pre-action delivery.
//
// Cursor does not wait for sessionStart and runs no sessionStart in cloud
// agents, and a compaction drops what it delivered. This hook reads the
// project context again at most every REMEMBRANCE_CURSOR_PREFERENCE_REFRESH_MS
// (default five minutes), and after a compaction. It adds the snapshot after
// the tool result when the conversation was compacted or when the read
// differs from the snapshot the conversation last received whole, then
// records that one as delivered, so nothing repeats. Otherwise it prints {}.

import process from "node:process";
import {
  disabled,
  HOOK_CONTEXT_BUDGETS,
  isEntryScript,
  preferenceSnapshotText,
  resolveApiCredential,
  warmPrincipalSession,
} from "./hook-core.mjs";
import {
  cursorSessionId,
  observePreferenceSnapshot,
  projectSnapshotRef,
  readCursorPreferenceState,
  readCursorProjectSnapshot,
  sameSnapshot,
  updateCursorPreferenceState,
} from "./record-mcp-use.mjs";

const DEFAULT_REFRESH_MS = 300_000;

function refreshMs(env) {
  const value = Number.parseInt(
    env.REMEMBRANCE_CURSOR_PREFERENCE_REFRESH_MS ?? "",
    10,
  );
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_REFRESH_MS;
}

export async function handlePostToolUse(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = cursorSessionId(input, env);
  // A Remembrance MCP result may already carry this context's snapshot.
  // afterMCPExecution records it too, but cloud agents do not run that hook.
  observePreferenceSnapshot(sessionId, input, env);
  const state = readCursorPreferenceState(sessionId, env);
  const now = Date.now();
  if (
    !state.compacted &&
    state.last_refresh_at !== null &&
    now - state.last_refresh_at < refreshMs(env)
  ) {
    return {};
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  // Without the hooks' principal session the server reads organization
  // settings only. sessionStart warms it, but a cached session can expire
  // during a conversation and cloud agents run no sessionStart, so a due
  // read warms first: a cached session returns at once, a warm-up waits at
  // most 1.2 s, and the 2.5 s read still fits Cursor's 5-second timeout.
  if (
    !disabled(env.REMEMBRANCE_AUTO_QUERY) &&
    resolveApiCredential(env).apiKey
  ) {
    await (options.warmSession ?? warmPrincipalSession)(
      { runtime: "cursor", hostSurface: "extension", fetchImpl },
      env,
    ).catch(() => null);
  }
  const snapshot = await readCursorProjectSnapshot(input, { env, fetchImpl });
  if (!snapshot) return {};
  // A failed read keeps the last read's reference and adds nothing, except
  // after a compaction, where its text names the recovery call. Only a live
  // read counts as delivered (DESIGN 4.6): after a failed one the compacted
  // conversation holds no snapshot, so the next successful refresh delivers.
  const read = projectSnapshotRef(snapshot);
  const latest = read ?? state.latest;
  const current = readCursorPreferenceState(sessionId, env);
  const text =
    (current.compacted ||
      (read !== null && !sameSnapshot(read, current.delivered))) &&
    preferenceSnapshotText(snapshot, HOOK_CONTEXT_BUDGETS.cursor);
  updateCursorPreferenceState(
    sessionId,
    text
      ? { latest, delivered: read, compacted: false, last_refresh_at: now }
      : { latest, last_refresh_at: now },
    env,
  );
  return text ? { additional_context: text } : {};
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let output = {};
  try {
    const raw = await readStdin();
    output = await handlePostToolUse(raw.trim() ? JSON.parse(raw) : {});
  } catch {
    // Fail open; a tool result never waits on preference pickup.
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (isEntryScript(import.meta.url)) {
  main().catch(() => {
    // Never fail a tool call because the pickup failed.
  });
}
