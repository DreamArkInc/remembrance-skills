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
// Fail-open: any no-match, disabled flag, or error prints nothing and exits 0.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildQueryPayload as buildSharedQueryPayload,
  debugLog,
  disabled,
  formatContext,
  readRemembranceConfig,
  redactPrompt,
  resolveApiKey,
  shouldQueryPrompt,
} from "./hook-core.mjs";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 64;
const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 2000;

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
  const parsed = Number.parseInt(String(env.REMEMBRANCE_AUTO_QUERY_LIMIT ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10
    ? parsed
    : DEFAULT_LIMIT;
}

function timeoutMsFromEnv(env) {
  const parsed = Number.parseInt(
    String(env.REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 10_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
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
export function buildQueryPayload(prompt, env = process.env) {
  const payload = buildSharedQueryPayload(prompt, env);
  payload.agent = { provider: "claude", model: "claude-code" };
  return payload;
}

export async function handleHookInput(input, options = {}) {
  const env = options.env ?? process.env;
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  const prompt = String(input?.prompt ?? "");
  const redacted = redactPrompt(prompt);
  const decision = shouldQueryPrompt(redacted);
  if (!decision.likely_match) {
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }

  const cacheKey = cacheKeyForPrompt(redacted, env);
  const cached = await readCachedOutput(cacheKey, env, options);
  if (cached.hit) {
    debugLog(
      env,
      "cache_hit",
      { key: shortCacheKey(cacheKey), output: cached.output ? "context" : "none" },
      options,
    );
    return cached.output;
  }
  debugLog(env, "cache_miss", { key: shortCacheKey(cacheKey) }, options);

  const response = await queryRemembrance(buildQueryPayload(redacted, env), {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
  });
  if (!response) {
    return null;
  }
  const context = formatContext(response, decision.reason, limitFromEnv(env));
  if (!context) {
    await writeCachedOutput(cacheKey, null, env, options);
    return null;
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
  await writeCachedOutput(cacheKey, output, env, options);
  return output;
}

async function queryRemembrance(payload, options) {
  const env = options.env;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMsFromEnv(env));
  try {
    const headers = {
      "content-type": "application/json",
      "user-agent": "@remembrance/claude-code-plugin",
    };
    const apiKey = resolveApiKey(env);
    if (apiKey) {
      headers["x-remembrance-api-key"] = apiKey;
    }
    const response = await options.fetchImpl(
      `${apiUrl(env)}/api/v1/agent/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      debugLog(
        env,
        "http_error",
        { status: response.status, api_url: apiUrl(env) },
        options,
      );
      return null;
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      debugLog(env, "malformed_response", { error: errorName(error) }, options);
      return null;
    }
    return { body };
  } catch (error) {
    debugLog(
      env,
      errorName(error) === "AbortError" ? "timeout" : "request_error",
      { error: errorName(error) },
      options,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
      return { hit: false, output: null };
    }
    entry.touched_at = now;
    await writeCacheFile({ entries: freshEntries }, env);
    return { hit: true, output: entry.output };
  } catch (error) {
    debugLog(env, "cache_read_error", { error: errorName(error) }, options);
    return { hit: false, output: null };
  }
}

async function writeCachedOutput(cacheKey, output, env, options = {}) {
  try {
    const cache = await readCacheFile(env);
    const now = nowMs(options);
    const entries = cache.entries
      .filter((entry) => entry.expires_at > now && entry.key !== cacheKey)
      .sort((a, b) => b.touched_at - a.touched_at);
    entries.unshift({
      key: cacheKey,
      output,
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
  return String(prompt ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
    debugLog(process.env, "hook_input_parse_error", { error: errorName(error) });
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
