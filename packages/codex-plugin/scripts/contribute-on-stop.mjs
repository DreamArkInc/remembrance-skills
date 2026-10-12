#!/usr/bin/env node
// Codex Stop adapter — the contribution mirror of query-on-prompt.mjs.
//
// The query hook automates CONSUMPTION (it queries Remembrance on relevant
// prompts). Contribution had no trigger, so agents reliably query but rarely
// submit what they learned. This Stop hook closes that asymmetry: when a reusable
// task or actual Remembrance use is about to end, it blocks the stop ONCE. It
// asks the agent to recover a missed full-context query when needed, then
// contribute a redacted remembrance / feedback / skill idea when warranted.
//
// Codex Stop payload: stdin JSON {session_id, turn_id, stop_hook_active,
// last_assistant_message}; the main thread's debts are keyed by session_id.
// To continue instead of stopping, print JSON {"decision":"block","reason":"..."}
// (reason becomes the next prompt). SubagentStop runs this script too, with the
// subagent's agent_id; debts are kept per agent (agentLedgerIdFor), and a
// subagent is asked, once, for its own before it exits. Whatever it leaves
// unpaid then passes to its parent, marked second-hand
// (transferSubagentObligations).
//
// Safety:
// - Env-flagged: disable with REMEMBRANCE_AUTO_CONTRIBUTE in {0,false,no}.
// - Loop-safe: Codex sets stop_hook_active=true on the continuation a Stop-block
//   caused, so that turn is always allowed. A per-session prompted-count sentinel
//   is a second guard so the agent is prompted at most once per distinct use.
// - Non-nagging: only blocks when a per-session use or task-eligibility marker
//   advances beyond the prompted marker. The Stop retry itself cannot create a
//   second reminder for the same task.
// - Fail-open: any error allows the stop.
//
// All decision logic lives in hook-core.mjs; this file only reads Codex's stdin,
// calls decideStop, records the new prompted count on a block, and prints.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  agentLedgerIdFor,
  completionContinuationReason,
  decideStop,
  foldTurnLedgerIntoSession,
  recordPluginLifecycleHealth,
  reportTaskOutcomesOnStop,
  resolveApiCredential,
  sessionIdFor,
  transferSubagentObligations,
  writePromptedCount,
} from "./hook-core.mjs";

// Given parsed Codex input, decide and (on a block) record the new prompted
// count. Returns { allow, why, output? }. `env` and the count fns are injectable.
export function handleStop(input, options = {}) {
  const env = options.env ?? process.env;
  foldTurnLedgerIntoSession(input, env);
  const decision = decideStop(input, options);
  if (decision.allow) {
    transferSubagentObligations(input, env);
    return { allow: true, why: decision.why };
  }
  const writePrompted = options.writePromptedCount ?? writePromptedCount;
  writePrompted(agentLedgerIdFor(input), decision.useCount, env);
  return {
    allow: false,
    why: decision.why,
    output: {
      decision: "block",
      reason: completionContinuationReason(decision.reason, input, env, {
        subagent: input?.hook_event_name === "SubagentStop",
      }),
    },
  };
}

export async function handleStopHook(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFor(input);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "codex",
      component: "completion_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  // Task outcomes stay session-scoped; the parent's stop reports them.
  if (input?.hook_event_name !== "SubagentStop") {
    const report = options.reportTaskOutcomes ?? reportTaskOutcomesOnStop;
    await report(sessionId, input, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      userAgent: "@remembrance/codex-plugin",
    });
  }
  return handleStop(input, options);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // Malformed input → allow the stop.
    return;
  }
  let result;
  try {
    result = await handleStopHook(input);
  } catch {
    // Fail open.
    return;
  }
  if (result && result.allow === false && result.output) {
    process.stdout.write(JSON.stringify(result.output));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Never block a stop on an unexpected error.
  });
}
