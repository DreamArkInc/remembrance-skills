#!/usr/bin/env node
// Claude Code UserPromptSubmit adapter.
//
// Claude Code invokes this before the prompt is sent, with stdin JSON
// {hook_event_name, prompt, session_id, ...}. We inject context by printing JSON
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
// on stdout. All runtime-agnostic decision/query/format logic lives in the shared
// hook-core.mjs (byte-identical across the Codex / OpenClaw / Claude plugins;
// re-synced by `npm run sync:hook-core`). This file keeps only the Claude glue:
//   • the per-prompt disk cache (Claude fires this hook synchronously on every
//     prompt, so repeated matching prompts are served from cache without a
//     re-query — Codex/OpenClaw have no such cache);
//   • the `provider: "claude"` payload agent identity;
//   • a Claude-branded query wrapper (its own user-agent) that layers the shared
//     apiUrl / resolveApiKey / timeout logic;
//   • Claude's stdin/stdout shape.
// Fail-open: true no-matches and disabled hooks print nothing. Query failures
// inject a bounded direct-query recovery instruction and still exit 0.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  agentLedgerIdFor,
  buildQueryPayload as buildSharedQueryPayload,
  capturePrivateSkillNativeUserPrompt,
  claimSubagentStart,
  composeBoundedHookContext,
  createContinuationDirective,
  debugLog,
  disabled,
  emptyQueryContext,
  emptyTaskShapeContext,
  formatContext,
  highMatchFromResponse,
  isHostNotificationPrompt,
  isContextualContinuationPrompt,
  readRemembranceConfig,
  redactPrompt,
  recordPluginLifecycleHealth,
  recordQueryFeedbackObligation,
  recordRegistryUse,
  recordDirectiveSurface,
  recordExplicitPreferenceObservations,
  recordHighMatchSurface,
  recordTaskEligibility,
  recordUserPrompt,
  recordValueEpisodeSurface,
  queryResponseHasMatches,
  pendingCompletionRecovery,
  acknowledgePrivateAuthorizationReminders,
  queryFeedbackTrackingFromResponse,
  queryRemembrance as querySharedRemembrance,
  resolveApiKey,
  resolveApiCredential,
  sessionIdFor,
  sharedConfigCredentialNotice,
  shouldQueryPrompt,
  stoppedSearchGovernance,
  continuationQueryContext,
  unavailableQueryContext,
  userCorrectionCaptureDirective,
  valueEpisodeFromResponse,
  withoutPrivateKeySearch,
} from "./hook-core.mjs";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 64;
const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;

// Small env-scoped helpers. These mirror the (non-exported) internals of the
// shared hook-core verbatim; they live here so the adapter can layer its cache
// and Claude-branded query wrapper without the core exposing internals. Kept in
// sync by inspection — they are pure and trivially auditable.
function apiUrl(env) {
  const fromFile = readRemembranceConfig(env).apiUrl;
  return String(env.REMEMBRANCE_API_URL || fromFile || DEFAULT_API_URL).replace(
    /\/$/,
    "",
  );
}

function limitFromEnv(env) {
  const parsed = Number.parseInt(
    String(env.REMEMBRANCE_AUTO_QUERY_LIMIT ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10
    ? parsed
    : DEFAULT_LIMIT;
}

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// Re-export the pure helpers the plugin test imports from this module.
export { redactPrompt, shouldQueryPrompt };
// Kept as a named export for compatibility with the shared core / any importer.
export const formatAdditionalContext = formatContext;

// The shared buildQueryPayload stamps the canonical (Codex) agent identity; the
// Claude adapter reports itself as the Claude Code runtime instead. Everything
// else (redaction, summary truncation, domain/constraint inference, limit) comes
// straight from the shared core. Exported because the plugin test and any
// importer expect this module's payload to carry the Claude identity.
export function buildQueryPayload(
  prompt,
  env = process.env,
  triggerReason = "trigger_match",
) {
  const payload = buildSharedQueryPayload(
    prompt,
    env,
    { provider: "claude", model: "claude-code" },
    {
      surface: "plugin_hook",
      runtime: "claude_code",
      trigger_reason: triggerReason,
    },
  );
  payload.agent = { provider: "claude", model: "claude-code" };
  return payload;
}

export async function handleHookInput(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFor(input);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "claude_code",
      component: "prompt_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  // A subagent's task can arrive here like a user's prompt; it is neither
  // the user's nor its parent's, so nothing here applies to it.
  if (claimSubagentStart(input, env)) {
    debugLog(env, "skip", { reason: "subagent_prompt" }, options);
    return null;
  }
  const prompt = String(input?.prompt ?? "");
  if (isHostNotificationPrompt(prompt)) {
    debugLog(env, "skip", { reason: "host_notification" }, options);
    return null;
  }
  const recordPrompt = options.recordUserPrompt ?? recordUserPrompt;
  recordPrompt(agentLedgerIdFor(input), env);
  await capturePrivateSkillNativeUserPrompt(prompt, {
    env,
    nativeContextBridge: options.nativeContextBridge,
    nativeSessionId: input?.session_id,
  });
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  const redacted = redactPrompt(prompt);
  if (isHostNotificationPrompt(redacted)) {
    debugLog(env, "skip", { reason: "host_notification" }, options);
    return null;
  }
  const correctionCapture = userCorrectionCaptureDirective(redacted, env);
  const recovery = pendingCompletionRecovery(agentLedgerIdFor(input), env);
  // Typed like the shared prompt hook's recovery, so the allocator keeps it as
  // one completion section: a re-supplied payload line stays under its
  // instruction whatever words the payload contains. withAllContext renders
  // it for the prompt's context.
  const recoveryInstruction = recovery
    ? { id: "private_learning_recovery", kind: "completion", render: recovery }
    : null;
  void recordExplicitPreferenceObservations(redacted, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: "claude_code",
    userAgent: "@remembrance/claude-code-plugin",
  }).catch(() => 0);
  let decision = withoutPrivateKeySearch(
    shouldQueryPrompt(redacted, env),
    prompt,
  );
  if (decision.hygiene) {
    // Only the skill search stops: the governance a search would have carried
    // and this prompt's capture and recovery lines are still delivered.
    debugLog(
      env,
      "search_hygiene",
      { reason: decision.reason, trigger: decision.trigger },
      options,
    );
    const stopped = await stoppedSearchGovernance(
      buildQueryPayload(redacted, env, decision.reason),
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        stderr: options.stderr,
        userAgent: "@remembrance/claude-code-plugin",
      },
    );
    if (!stopped.search) {
      if (correctionCapture || recoveryInstruction) {
        recordEligibility(input, env, options);
        recordDirective(input, null, env, options);
      } else if (!stopped.governs) {
        return null;
      }
      return withAllContext(
        outputForContext(stopped.context),
        env,
        recoveryInstruction,
        correctionCapture,
      );
    }
    // The read failed: run the search the rule stopped, as without the rule.
    debugLog(
      env,
      "search_hygiene_fallback",
      { reason: decision.reason },
      options,
    );
    decision = { likely_match: true, reason: decision.trigger };
  }
  if (!decision.likely_match) {
    if (isContextualContinuationPrompt(redacted)) {
      const directive = await createContinuationDirective({
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        runtime: "claude_code",
        stderr: options.stderr,
        userAgent: "@remembrance/claude-code-plugin",
      });
      recordEligibility(input, env, options);
      recordDirective(input, directive, env, options);
      return withAllContext(
        outputForContext(continuationQueryContext(directive, env)),
        env,
        recoveryInstruction,
        correctionCapture,
      );
    }
    if (correctionCapture || recoveryInstruction) {
      recordEligibility(input, env, options);
      recordDirective(input, null, env, options);
      return withAllContext(
        outputForContext("Remembrance capture routing:"),
        env,
        recoveryInstruction,
        correctionCapture,
      );
    }
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }
  // Owner decision 34C: an empty task-shape search makes the turn eligible
  // for completion recovery only through its correction or recovery line, so
  // a task-shape search records eligibility once its result is known.
  const taskShape = decision.reason === "task_shape";
  if (!taskShape) recordEligibility(input, env, options);
  recordDirective(input, null, env, options);
  // An empty task-shape search shows no no-match block and records no
  // query-feedback obligation; its governance (`output`, null for none) and
  // this prompt's capture and recovery lines arrive as for any search.
  const emptyTaskShapeOutput = (output) => {
    if (correctionCapture || recoveryInstruction) {
      recordEligibility(input, env, options);
    } else if (!output) {
      debugLog(env, "task_shape_no_result", {}, options);
      return null;
    }
    return withAllContext(
      output ?? outputForContext(emptyTaskShapeContext(null).context),
      env,
      recoveryInstruction,
      correctionCapture,
    );
  };

  const cacheKey = cacheKeyForPrompt(redacted, env);
  const cached = await readCachedOutput(cacheKey, env, options);
  if (cached.hit) {
    debugLog(
      env,
      "cache_hit",
      {
        key: shortCacheKey(cacheKey),
        output: cached.output ? "context" : "none",
      },
      options,
    );
    if (taskShape && !cached.matched) {
      return emptyTaskShapeOutput(cached.output);
    }
    if (taskShape) recordEligibility(input, env, options);
    const output =
      cached.output ??
      outputForContext(emptyQueryContext(decision.reason, env));
    if (cached.matched) {
      recordUse(input, env, options, cached.highMatch ?? null);
    }
    recordQueryFeedback(input, cached.queryFeedback, env, options);
    return withAllContext(output, env, recoveryInstruction, correctionCapture);
  }
  debugLog(env, "cache_miss", { key: shortCacheKey(cacheKey) }, options);

  const payload = buildQueryPayload(redacted, env, decision.reason);
  const response = await queryRemembrance(payload, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
  });
  if (!response) {
    if (taskShape) recordEligibility(input, env, options);
    return withAllContext(
      outputForContext(unavailableQueryContext(env)),
      env,
      recoveryInstruction,
      correctionCapture,
    );
  }
  const matched = queryResponseHasMatches(response);
  if (taskShape && !matched) {
    const empty = emptyTaskShapeContext(response);
    const output = empty.governs ? outputForContext(empty.context) : null;
    await writeCachedOutput(cacheKey, output, null, false, null, env, options);
    return emptyTaskShapeOutput(output);
  }
  if (taskShape) recordEligibility(input, env, options);
  const context =
    formatContext(response, decision.reason, limitFromEnv(env), {
      maxChars: 32_000,
      querySummary: payload.task.summary,
    }) ?? emptyQueryContext(decision.reason, env);
  const output = outputForContext(context);
  const highMatch = highMatchFromResponse(response);
  const queryFeedback = queryFeedbackTrackingFromResponse(response);
  await writeCachedOutput(
    cacheKey,
    output,
    highMatch,
    matched,
    queryFeedback,
    env,
    options,
  );
  if (matched) {
    recordUse(input, env, options, highMatch, response);
  }
  recordQueryFeedback(input, queryFeedback, env, options);
  return withAllContext(output, env, recoveryInstruction, correctionCapture);
}

function outputForContext(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

function withAllContext(output, env, ...contexts) {
  const notice = sharedConfigCredentialNotice(env);
  const compose = (text) =>
    composeBoundedHookContext(output.hookSpecificOutput.additionalContext, [
      ...contexts.map((context) =>
        context?.render ? { ...context, text } : context,
      ),
      notice,
    ]);
  const additionalContext = compose(
    contexts.find((context) => context?.render)?.render(compose),
  );
  acknowledgePrivateAuthorizationReminders(additionalContext, env);
  return {
    hookSpecificOutput: {
      ...output.hookSpecificOutput,
      additionalContext,
    },
  };
}

// Usage and debts belong to the agent that received the context (see
// agentLedgerIdFor); directives and task outcomes stay with the session.
function recordEligibility(input, env, options) {
  const record = options.recordEligibility ?? recordTaskEligibility;
  record(agentLedgerIdFor(input), env);
}

function recordDirective(input, directive, env, options) {
  const record = options.recordDirective ?? recordDirectiveSurface;
  record(sessionIdFor(input), directive, env);
}

function recordUse(input, env, options, highMatch = null, response = null) {
  const record = options.recordUse ?? recordRegistryUse;
  const ledgerId = agentLedgerIdFor(input);
  record(ledgerId, env);
  const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
  recordHighMatch(ledgerId, highMatch, env);
  if (response) {
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    const valueEpisode = valueEpisodeFromResponse(response);
    recordValueEpisode(sessionIdFor(input), valueEpisode, env);
  }
}

function recordQueryFeedback(input, tracking, env, options) {
  if (!tracking) return;
  const record =
    options.recordQueryFeedbackObligation ?? recordQueryFeedbackObligation;
  record(agentLedgerIdFor(input), tracking, env);
}

async function queryRemembrance(payload, options) {
  return querySharedRemembrance(payload, {
    ...options,
    userAgent: "@remembrance/claude-code-plugin",
  });
}

async function readCachedOutput(cacheKey, env, options = {}) {
  try {
    const cache = await readCacheFile(env);
    const now = nowMs(options);
    const freshEntries = cache.entries
      .filter((entry) => entry.expires_at > now)
      .sort((a, b) => b.touched_at - a.touched_at)
      .slice(0, CACHE_MAX_ENTRIES);
    const entry = freshEntries.find((item) => item.key === cacheKey);
    if (!entry) {
      if (freshEntries.length !== cache.entries.length) {
        await writeCacheFile({ entries: freshEntries }, env);
      }
      return { hit: false, output: null, highMatch: null, matched: false };
    }
    entry.touched_at = now;
    await writeCacheFile({ entries: freshEntries }, env);
    return {
      hit: true,
      output: entry.output,
      highMatch: entry.high_match ?? null,
      matched: entry.matched === true,
      queryFeedback: entry.query_feedback ?? null,
    };
  } catch (error) {
    debugLog(env, "cache_read_error", { error: errorName(error) }, options);
    return {
      hit: false,
      output: null,
      highMatch: null,
      matched: false,
      queryFeedback: null,
    };
  }
}

async function writeCachedOutput(
  cacheKey,
  output,
  highMatch,
  matched,
  queryFeedback,
  env,
  options = {},
) {
  try {
    const cache = await readCacheFile(env);
    const now = nowMs(options);
    const entries = cache.entries
      .filter((entry) => entry.expires_at > now && entry.key !== cacheKey)
      .sort((a, b) => b.touched_at - a.touched_at);
    entries.unshift({
      key: cacheKey,
      output,
      high_match: highMatch,
      matched,
      query_feedback: queryFeedback,
      touched_at: now,
      expires_at: now + CACHE_TTL_MS,
    });
    await writeCacheFile({ entries: entries.slice(0, CACHE_MAX_ENTRIES) }, env);
    debugLog(env, "cache_write", { key: shortCacheKey(cacheKey) }, options);
  } catch (error) {
    debugLog(env, "cache_write_error", { error: errorName(error) }, options);
  }
}

async function readCacheFile(env) {
  const path = cachePath(env);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter((entry) => typeof entry?.key === "string")
        : [],
    };
  } catch {
    return { entries: [] };
  }
}

async function writeCacheFile(cache, env) {
  const path = cachePath(env);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(
    tempPath,
    JSON.stringify({ version: 1, entries: cache.entries }),
  );
  await rename(tempPath, path);
}

function cacheKeyForPrompt(prompt, env) {
  return hashText(
    JSON.stringify({
      prompt: normalizeForCache(prompt),
      api_url: apiUrl(env),
      limit: limitFromEnv(env),
      // Scope the cache to the resolved key: an org key can surface org-private
      // skills, so two same-machine sessions with different keys (or one keyed,
      // one anonymous) must not share a cached response. Hashed one-way here, so
      // the raw key is never written to the on-disk cache. null = anonymous.
      api_key: resolveApiKey(env) ?? null,
    }),
  );
}

function normalizeForCache(prompt) {
  return String(prompt ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cachePath(env) {
  if (env.REMEMBRANCE_HOOK_CACHE_PATH) {
    return String(env.REMEMBRANCE_HOOK_CACHE_PATH);
  }
  const root = env.XDG_CACHE_HOME
    ? String(env.XDG_CACHE_HOME)
    : join(homedir(), ".cache");
  return join(root, "remembrance", "claude-code-hook-cache.json");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortCacheKey(value) {
  return value.slice(0, 12);
}

function nowMs(options = {}) {
  return typeof options.nowMs === "number" ? options.nowMs : Date.now();
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
  const output = await handleHookInput(input);
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
