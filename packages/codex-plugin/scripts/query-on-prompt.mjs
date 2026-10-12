#!/usr/bin/env node
// Codex UserPromptSubmit adapter.
//
// Codex triggers this before the prompt is sent, with stdin JSON that includes
// the stable session_id and the turn-scoped turn_id.
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
  agentLedgerIdFor,
  debugLog,
  foldTurnLedgerIntoSession,
  hostedMcpSplitNotice,
  recordHighMatchSurface,
  recordDirectiveSurface,
  recordPluginLifecycleHealth,
  recordQueryFeedbackObligation,
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
    `Hooks use the shared Remembrance config, but hosted MCP at ${hostedMcp.mcpUrl} (${registrationSource}) ${diagnosis}.`,
    "Result: hook queries can use organization skills while native hosted MCP tools are unavailable, anonymous, or scoped differently.",
    `Desktop fix: launchctl setenv ${remediationEnv} \"<same organization key>\". Terminal fix: export ${remediationEnv}=\"<same organization key>\" before launch.`,
    "Fully quit and reopen Codex, then run run_connection_doctor. A host-policy denial occurs before Remembrance and is not a Remembrance rejection.",
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
  // Usage and debts belong to the agent that received the context; health,
  // directives and task outcomes stay with the session.
  const ledgerId = agentLedgerIdFor(input);
  foldTurnLedgerIntoSession(input, env);
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
  // Include all adapter notices before the shared one-pass allocator runs.
  // No adapter may recompose its already-bounded output.
  const credentialSplitNotice = codexHostedMcpCredentialSplitNotice(env);
  const registrySplitNotice = hostedMcpSplitNotice(env);
  const sharedCredentialNotice = credentialSplitNotice
    ? null
    : sharedConfigCredentialNotice(env);
  const notices = [
    credentialSplitNotice
      ? {
          id: "codex_hosted_mcp_credential_split",
          kind: "credential",
          text: credentialSplitNotice,
        }
      : null,
    registrySplitNotice
      ? {
          id: "codex_hosted_mcp_split",
          kind: "credential",
          text: registrySplitNotice,
        }
      : null,
    sharedCredentialNotice
      ? {
          id: "codex_shared_config_credential",
          kind: "credential",
          text: sharedCredentialNotice,
        }
      : null,
  ].filter(Boolean);
  const result = await runPromptHook(prompt, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    includeSharedConfigCredentialNotice: false,
    contextAdditions: notices,
    projectPath: input?.cwd ?? null,
    sessionId: ledgerId,
    nativeSessionId: input?.session_id,
    nativeContextBridge: options.nativeContextBridge,
    stderr: options.stderr,
  });
  if (!result) {
    return null;
  }
  if (result.eligible) {
    const recordEligibility =
      options.recordEligibility ?? recordTaskEligibility;
    recordEligibility(ledgerId, env);
  }
  const recordDirective = options.recordDirective ?? recordDirectiveSurface;
  recordDirective(sessionId, result.directive ?? null, env);
  if (result.consumed && result.matched) {
    // Only a completed query with an authorized match is registry consumption.
    // Empty, continuation, and unavailable results remain eligible for Stop
    // recovery without inflating use counts.
    const record = options.recordUse ?? recordRegistryUse;
    record(ledgerId, env);
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(ledgerId, result.highMatch ?? null, env);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, result.valueEpisode ?? null, env);
  }
  if (result.queryFeedback) {
    const recordQueryFeedback =
      options.recordQueryFeedbackObligation ?? recordQueryFeedbackObligation;
    recordQueryFeedback(ledgerId, result.queryFeedback, env);
  }
  // An empty task-shape search with nothing to deliver (owner decision 34C).
  if (!result.context) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: result.context,
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
