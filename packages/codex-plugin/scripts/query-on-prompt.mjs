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
  recordPluginLifecycleHealth,
  recordRegistryUse,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  resolveApiCredential,
  resolveCodexHostedMcpRegistration,
  resolveHostedMcpRegistry,
  runPromptHook,
  sessionIdFor,
  sharedConfigCredentialNotice,
} from "./hook-core.mjs";

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// A manually configured hosted Codex MCP process cannot read the shared
// Remembrance config file. The packaged plugin uses local stdio MCP and returns
// no split warning; this remains for users who intentionally override it with a
// hosted registration.
export function codexHostedMcpCredentialSplitNotice(env = process.env) {
  const localCredential = resolveApiCredential(env);
  if (localCredential.source !== "shared_config") {
    return null;
  }

  const registration = resolveCodexHostedMcpRegistration(env);
  if (registration.command) {
    return null;
  }
  const configuredValues = registration.credentialEnvVars
    .map((name) => stringOrNull(env[name]))
    .filter(Boolean);

  if (
    registration.hasStaticCredential ||
    configuredValues.some((value) => value === localCredential.apiKey)
  ) {
    return null;
  }

  const expectedEnv = registration.credentialEnvVars[0] ?? null;
  const diagnosis = expectedEnv
    ? configuredValues.length > 0
      ? `uses a different credential from ${expectedEnv}`
      : `requires ${expectedEnv}, but that variable is missing from this Codex process`
    : "does not declare an organization credential";
  const remediationEnv = expectedEnv ?? "REMEMBRANCE_API_KEY";
  const hostedMcp = resolveHostedMcpRegistry(env);
  const registrationSource = registration.source.includes("manifest")
    ? registration.source
    : "active Codex MCP config";

  return [
    "Remembrance connection health warning:",
    "The local Codex hooks authenticated from the shared Remembrance config (normally ~/.config/remembrance/config.json),",
    `but the hosted MCP registration at ${hostedMcp.mcpUrl} (${registrationSource}) ${diagnosis}.`,
    "Result: hook queries can use organization skills while native hosted MCP tools are unavailable, anonymous, or scoped differently.",
    `Fix for Codex Desktop on macOS: launchctl setenv ${remediationEnv} \"<same organization key>\", then fully quit and reopen Codex.`,
    `For a terminal launch: export ${remediationEnv}=\"<same organization key>\" before starting Codex.`,
    "Once the native tools are visible, run run_connection_doctor and follow its single remediation if attention is required.",
    "A Codex tenant/privacy-policy denial happens before any Remembrance request; it is not a Remembrance rejection.",
  ].join("\n");
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

// Given parsed Codex input, return the object to print on stdout (or null).
// `env`/`fetchImpl` are injectable so tests need no network.
export async function handleQuery(input, options = {}) {
  const env = options.env ?? process.env;
  const credential = resolveApiCredential(env);
  const sessionId = sessionIdFor(input);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "codex",
      component: "prompt_hook",
      credentialSource: credential.source,
      sessionId,
    },
    env,
  );
  const prompt = String(input?.prompt ?? "");
  const result = await runPromptHook(prompt, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    includeSharedConfigCredentialNotice: false,
    stderr: options.stderr,
  });
  if (!result) {
    return null;
  }
  if (result.eligible) {
    const recordEligibility =
      options.recordEligibility ?? recordTaskEligibility;
    recordEligibility(sessionId, env);
  }
  const recordDirective = options.recordDirective ?? recordDirectiveSurface;
  recordDirective(sessionId, result.directive ?? null, env);
  if (result.consumed && result.matched) {
    // Only a completed query with an authorized match is registry consumption.
    // Empty, continuation, and unavailable results remain eligible for Stop
    // recovery without inflating use counts.
    const record = options.recordUse ?? recordRegistryUse;
    record(sessionId, env);
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(sessionId, result.highMatch ?? null, env);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, result.valueEpisode ?? null, env);
  }
  // An intentional hosted-MCP override is configured separately from this
  // hook. When its URL differs from the hook API URL, tell the agent so it
  // doesn't mix results from one registry with tool calls against another.
  const credentialSplitNotice = codexHostedMcpCredentialSplitNotice(env);
  const notices = [
    credentialSplitNotice,
    hostedMcpSplitNotice(env),
    credentialSplitNotice ? null : sharedConfigCredentialNotice(env),
  ].filter(Boolean);
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        notices.length > 0
          ? `${notices.join("\n\n")}\n\n${result.context}`
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
