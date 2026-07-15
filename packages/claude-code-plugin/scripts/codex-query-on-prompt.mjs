#!/usr/bin/env node
// Codex UserPromptSubmit adapter.
//
// Codex triggers this before the prompt is sent, with stdin JSON {prompt, turn_id}.
// We inject context by printing the wrapped hook output on stdout:
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
// (the same shape Claude Code requires). All decision/query/format logic lives in
// hook-core.mjs — this file only reads the runtime's stdin, calls the core,
// records task eligibility and completed-query markers, and prints Codex's
// expected shape. Query failures remain fail-open but inject a bounded recovery
// instruction; malformed hook input and true no-matches print nothing.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  debugLog,
  hostedMcpSplitNotice,
  recordHighMatchSurface,
  recordDirectiveSurface,
  recordRegistryUse,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  runPromptHook,
  sessionIdFor,
} from "./hook-core.mjs";

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// Given parsed Codex input, return the object to print on stdout (or null).
// `env`/`fetchImpl` are injectable so tests need no network.
export async function handleQuery(input, options = {}) {
  const env = options.env ?? process.env;
  const prompt = String(input?.prompt ?? "");
  const result = await runPromptHook(prompt, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
  });
  if (!result) {
    return null;
  }
  const sessionId = sessionIdFor(input);
  if (result.eligible) {
    const recordEligibility =
      options.recordEligibility ?? recordTaskEligibility;
    recordEligibility(sessionId, env);
  }
  const recordDirective = options.recordDirective ?? recordDirectiveSurface;
  recordDirective(sessionId, result.directive ?? null, env);
  if (result.consumed) {
    // Only a completed query is registry consumption. Continuation/unavailable
    // reminders remain eligible for Stop recovery without inflating use counts.
    const record = options.recordUse ?? recordRegistryUse;
    record(sessionId, env);
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(sessionId, result.highMatch ?? null, env);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, result.valueEpisode ?? null, env);
  }
  // Codex's hosted MCP endpoint is configured separately from this hook. When
  // the resolved MCP URL differs from the hook API URL, tell the agent so it
  // doesn't mix results from one registry with tool calls against another.
  const splitNotice = hostedMcpSplitNotice(env);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: splitNotice
        ? `${splitNotice}\n\n${result.context}`
        : result.context,
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    debugLog(process.env, "hook_input_parse_error", {
      error: errorName(error),
    });
    return;
  }
  const output = await handleQuery(input);
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    debugLog(process.env, "hook_error", { error: errorName(error) });
    process.exitCode = 0;
  });
}
