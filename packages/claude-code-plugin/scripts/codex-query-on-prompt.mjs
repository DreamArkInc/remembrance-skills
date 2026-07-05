#!/usr/bin/env node
// Codex UserPromptSubmit adapter.
//
// Codex triggers this before the prompt is sent, with stdin JSON {prompt, turn_id}.
// We inject context by printing the wrapped hook output on stdout:
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
// (the same shape Claude Code requires). All decision/query/format logic lives in
// hook-core.mjs — this file only reads
// the runtime's stdin, calls the core, records a usage marker on a hit, and
// prints Codex's expected shape. Fail-open: any no-match or error prints nothing
// and exits 0.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { recordRegistryUse, runQuery, debugLog } from "./hook-core.mjs";

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// Given parsed Codex input, return the object to print on stdout (or null).
// `env`/`fetchImpl` are injectable so tests need no network.
export async function handleQuery(input, options = {}) {
  const env = options.env ?? process.env;
  const prompt = String(input?.prompt ?? "");
  const context = await runQuery(prompt, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
  });
  if (!context) {
    return null;
  }
  // A real injection happened — record it so the Stop adapter can detect that
  // this session consumed the registry (Codex's Stop payload has no transcript).
  const record = options.recordUse ?? recordRegistryUse;
  record(input?.turn_id ?? input?.session_id ?? "unknown", env);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
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
    debugLog(process.env, "hook_input_parse_error", { error: errorName(error) });
    return;
  }
  const output = await handleQuery(input);
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    debugLog(process.env, "hook_error", { error: errorName(error) });
    process.exitCode = 0;
  });
}
