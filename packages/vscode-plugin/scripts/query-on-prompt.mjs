#!/usr/bin/env node
// VS Code UserPromptSubmit adapter.
//
// VS Code invokes this before the prompt is sent, with stdin JSON
// {hook_event_name, prompt, session_id, ...}. We inject context by printing JSON
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
// on stdout. All runtime-agnostic decision/query/format logic lives in the shared
// hook-core.mjs (byte-identical across the Codex / OpenClaw / Claude plugins;
// re-synced by `npm run sync:hook-core`). This file keeps only the Claude glue:
//   • the per-prompt disk cache (Claude fires this hook synchronously on every
//     prompt, so repeated matching prompts are served from cache without a
//     re-query — Codex/OpenClaw have no such cache). It holds no preference
//     snapshot: every prompt reads that once, from its search response, its
//     hygiene read or one read with the project key only;
//   • the `provider: "vscode"` payload agent identity;
//   • a Claude-branded query wrapper (its own user-agent) that layers the shared
//     apiUrl / resolveApiKey / timeout logic;
//   • Claude's stdin/stdout shape.
// Fail-open: disabled hooks print nothing, and a prompt with nothing else to
// say prints only the organization's preference snapshot (nothing without an
// organization key). Query failures inject a bounded direct-query recovery
// instruction and still exit 0.

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
  declareSubagentIdentityUnavailable,
  disabled,
  emptyQueryContext,
  emptyTaskShapeContext,
  formatContext,
  HOOK_CONTEXT_BUDGETS,
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
  preferenceSnapshotAddition,
  preferenceSnapshotModel,
  projectKeyForHook,
  projectPreferenceSnapshot,
  queryFeedbackTrackingFromResponse,
  queryRemembrance as querySharedRemembrance,
  resolveApiKey,
  resolveApiCredential,
  responseBodyFromToolResponse,
  sessionIdFor,
  sharedConfigCredentialNotice,
  shouldQueryPrompt,
  stoppedSearchGovernance,
  continuationQueryContext,
  unavailableQueryContext,
  unsavedProjectPreferenceNotice,
  userCorrectionCaptureDirective,
  valueEpisodeFromResponse,
  withoutPrivateKeySearch,
} from "./hook-core.mjs";

// VS Code 1.133 names a subagent only in SubagentStart and SubagentStop.
declareSubagentIdentityUnavailable();

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
// VS Code adapter reports itself as the VS Code runtime instead. Everything
// else (redaction, summary truncation, domain/constraint inference, limit) comes
// straight from the shared core. Exported because the plugin test and any
// importer expect this module's payload to carry the Claude identity.
// `projectPath` names the host's project, so the project key is the one the
// session-start read sends.
export function buildQueryPayload(
  prompt,
  env = process.env,
  triggerReason = "trigger_match",
  projectPath = null,
) {
  const payload = buildSharedQueryPayload(
    prompt,
    env,
    { provider: "vscode", model: "vs-code-agent" },
    {
      surface: "plugin_hook",
      runtime: "vs_code",
      trigger_reason: triggerReason,
    },
    projectPath,
  );
  payload.agent = { provider: "vscode", model: "vs-code-agent" };
  return payload;
}

export async function handleHookInput(input, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Every preference read and write of this prompt names the host's project,
  // as the session-start read does.
  const projectPath = input?.cwd ?? null;
  const sessionId = sessionIdFor(input);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "vs_code",
      component: "prompt_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  // The project-context snapshot: one read with the project key only (null
  // without an organization key or with REMEMBRANCE_AUTO_QUERY=0).
  const projectSnapshot = () =>
    projectPreferenceSnapshot({
      runtime: "vs_code",
      env,
      fetchImpl,
      projectPath,
      userAgent: "@remembrance/vscode-plugin",
      stderr: options.stderr,
    });
  // A subagent's task can arrive here like a user's prompt; it is neither
  // the user's nor its parent's, so only the project's preferences apply.
  if (claimSubagentStart(input, env)) {
    debugLog(env, "skip", { reason: "subagent_prompt" }, options);
    return withAllContext(null, env, await projectSnapshot());
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
  // "For this project" is never saved for every project: when the host
  // cannot name the project, the agent is told the preference was not saved.
  const unsavedProjectPreference = unsavedProjectPreferenceNotice(redacted, {
    env,
    projectPath,
  });
  // Every exit from here on delivers this prompt's lines and the preference
  // snapshot (null for none) beside its output (null when it has none).
  const respond = (output, snapshot) =>
    withAllContext(
      output,
      env,
      snapshot,
      recoveryInstruction,
      correctionCapture,
      unsavedProjectPreference && {
        id: "project_preference_unsaved",
        kind: "notice",
        text: unsavedProjectPreference,
      },
    );
  void recordExplicitPreferenceObservations(redacted, {
    env,
    fetchImpl,
    projectPath,
    runtime: "vs_code",
    userAgent: "@remembrance/vscode-plugin",
  }).catch(() => 0);
  // A search response or the hygiene read is the snapshot source when the
  // prompt makes one; it never uses or writes the cached copy, so a failed
  // read renders read_failed.
  const organization = Boolean(resolveApiCredential(env).apiKey);
  // Decided before any search, as the search payload's project key is: a
  // search's background warm-up can create the local identity, and with it a
  // project key that search never sent.
  const projectScopeUnread =
    organization && !projectKeyForHook(env, projectPath);
  const snapshotFrom = (read) => {
    if (!organization) return null;
    return read?.ok
      ? preferenceSnapshotModel(read.body, {
          projectScopeUnread,
          coldStart: read.coldStart === true,
        })
      : {
          entries: [],
          digest: null,
          total: null,
          reasons: [
            { code: "read_failed" },
            ...(projectScopeUnread ? [{ code: "project_scope_unread" }] : []),
          ],
          pageToken: null,
        };
  };
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
      buildQueryPayload(redacted, env, decision.reason, projectPath),
      {
        env,
        fetchImpl,
        stderr: options.stderr,
        userAgent: "@remembrance/vscode-plugin",
      },
    );
    if (!stopped.search) {
      const snapshot = snapshotFrom(stopped.read);
      if (correctionCapture || recoveryInstruction) {
        recordEligibility(input, env, options);
        recordDirective(input, null, env, options);
      } else if (!stopped.governs) {
        return respond(null, snapshot);
      }
      return respond(outputForContext(stopped.context), snapshot);
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
    // No search: one read with the project key only.
    const snapshot = projectSnapshot();
    if (isContextualContinuationPrompt(redacted)) {
      const directive = await createContinuationDirective({
        env,
        fetchImpl,
        runtime: "vs_code",
        stderr: options.stderr,
        userAgent: "@remembrance/vscode-plugin",
      });
      recordEligibility(input, env, options);
      recordDirective(input, directive, env, options);
      return respond(
        outputForContext(continuationQueryContext(directive, env)),
        await snapshot,
      );
    }
    if (correctionCapture || recoveryInstruction) {
      recordEligibility(input, env, options);
      recordDirective(input, null, env, options);
      return respond(
        outputForContext("Remembrance capture routing:"),
        await snapshot,
      );
    }
    debugLog(env, "skip", { reason: decision.reason }, options);
    return respond(null, await snapshot);
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
  const emptyTaskShapeOutput = (output, snapshot) => {
    if (correctionCapture || recoveryInstruction) {
      recordEligibility(input, env, options);
    } else if (!output) {
      debugLog(env, "task_shape_no_result", {}, options);
      return respond(null, snapshot);
    }
    return respond(
      output ?? outputForContext(emptyTaskShapeContext(null).context),
      snapshot,
    );
  };

  const cacheKey = cacheKeyForPrompt(redacted, env, projectPath);
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
    const snapshot = await projectSnapshot();
    if (taskShape && !cached.matched) {
      return emptyTaskShapeOutput(cached.output, snapshot);
    }
    if (taskShape) recordEligibility(input, env, options);
    const output =
      cached.output ??
      outputForContext(emptyQueryContext(decision.reason, env));
    if (cached.matched) {
      recordUse(input, env, options, cached.highMatch ?? null);
    }
    recordQueryFeedback(input, cached.queryFeedback, env, options);
    return respond(output, snapshot);
  }
  debugLog(env, "cache_miss", { key: shortCacheKey(cacheKey) }, options);

  const payload = buildQueryPayload(
    redacted,
    env,
    decision.reason,
    projectPath,
  );
  const response = await queryRemembrance(payload, {
    env,
    fetchImpl,
    stderr: options.stderr,
  });
  if (!response) {
    if (taskShape) recordEligibility(input, env, options);
    return respond(
      outputForContext(unavailableQueryContext(env)),
      snapshotFrom(null),
    );
  }
  // A search sent without a session read organization settings only; while
  // the warm-up it started can bring one, the snapshot names the recovery
  // call (DESIGN 4.3).
  const snapshot = snapshotFrom({
    ok: true,
    body: responseBodyFromToolResponse(response),
    coldStart: response.coldStart === true,
  });
  const matched = queryResponseHasMatches(response);
  if (taskShape && !matched) {
    const empty = emptyTaskShapeContext(response);
    const output = empty.governs ? outputForContext(empty.context) : null;
    await writeCachedOutput(cacheKey, output, null, false, null, env, options);
    return emptyTaskShapeOutput(output, snapshot);
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
  // The cache holds no preference text (DESIGN 4.3), so a context with a
  // candidate's skill notes is searched again instead of cached.
  if (!/^Skill notes for /mu.test(context)) {
    await writeCachedOutput(
      cacheKey,
      output,
      highMatch,
      matched,
      queryFeedback,
      env,
      options,
    );
  }
  if (matched) {
    recordUse(input, env, options, highMatch, response);
  }
  recordQueryFeedback(input, queryFeedback, env, options);
  return respond(output, snapshot);
}

function outputForContext(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

// The output (null for none) with the credential notice, `contexts` and the
// preference snapshot (null for none), composed within the Claude Code
// budget; null when nothing remains to say.
function withAllContext(output, env, snapshot, ...contexts) {
  const additions = [
    ...contexts,
    output ? sharedConfigCredentialNotice(env) : null,
    snapshot ? preferenceSnapshotAddition(snapshot) : null,
  ];
  const compose = (text) =>
    composeBoundedHookContext(
      output?.hookSpecificOutput.additionalContext ?? "",
      additions.map((context) =>
        context?.render ? { ...context, text } : context,
      ),
      HOOK_CONTEXT_BUDGETS.vscode,
    );
  const additionalContext = compose(
    contexts.find((context) => context?.render)?.render(compose),
  );
  if (!additionalContext) return null;
  acknowledgePrivateAuthorizationReminders(additionalContext, env);
  return outputForContext(additionalContext);
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
    userAgent: "@remembrance/vscode-plugin",
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

// Version 2 outputs hold no preference snapshot; a version 1 file, whose
// outputs carried preference lines, reads as empty.
const CACHE_VERSION = 2;

async function readCacheFile(env) {
  const path = cachePath(env);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      entries:
        parsed.version === CACHE_VERSION && Array.isArray(parsed.entries)
          ? parsed.entries.filter((entry) => typeof entry?.key === "string")
          : [],
    };
  } catch {
    return { entries: [] };
  }
}

async function writeCacheFile(cache, env) {
  const path = cachePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(
    tempPath,
    JSON.stringify({ version: CACHE_VERSION, entries: cache.entries }),
    { mode: 0o600 },
  );
  await rename(tempPath, path);
}

function cacheKeyForPrompt(prompt, env, projectPath) {
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
      // A search carries the context of its project, and its skill notes
      // follow that project's preferences.
      project_path: projectPath,
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
  return join(root, "remembrance", "vscode-hook-cache.json");
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
