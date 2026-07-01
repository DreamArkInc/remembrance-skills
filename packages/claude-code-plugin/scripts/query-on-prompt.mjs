#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_FIELD_CHARS = 280;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 64;

const SERVICE_PATTERNS = [
  /\b(vercel|heroku|netlify|cloudflare|aws|gcp|azure)\b/i,
  /\b(github actions?|circleci|gitlab ci|buildkite|jenkins)\b/i,
  /\b(stripe|x402|mpp|model payment protocol|mcp servers?)\b/i,
  /\b(openai|anthropic|claude|cursor|codex|voyage|mongodb atlas)\b/i,
];

const TOOL_PATTERNS = [
  /\b(next\.?js|turbopack|webpack|vite|react|prisma|drizzle)\b/i,
  /\b(esbuild|playwright|vitest|jest|typescript|node\.?js|npm)\b/i,
  /\b(mongodb|redis|bullmq|atlas vector search)\b/i,
];

const WORKFLOW_PATTERNS = [
  /\b(deploy|deployment|migrate|migration|ci\/cd|ci|pipeline)\b/i,
  /\b(payment integration|schema upgrade|observability|monitoring)\b/i,
  /\b(build error|release|rollback|provision|backfill)\b/i,
];

const UI_PATTERNS = [
  /\b(web ?ui|ux|usability|accessibility|a11y|responsive|frontend|front-end)\b/i,
  /\b(dashboard|admin (page|panel|surface)|review card|settings layout)\b/i,
  /\b(layout|nav(igation| bar| panel)?|sidebar|modal|tooltip|popover)\b/i,
  /\b(tailwind|styling|component|button|form design|redesign|declutter|design system)\b/i,
];

const SKIP_PATTERNS = [
  /\b(general web search|search the web|google this|look up current facts?)\b/i,
  /^\s*(what|who|when|where)\s+(is|are|was|were)\b/i,
  /\b(one[- ]off fact|private scratch memory|brainstorm)\b/i,
];

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:aws_secret_access_key|aws_secret_key|secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{32,}["']?/gi,
  /\b(password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+/gi,
  /\b(?:mongodb(?:\+srv)?|redis(?:s)?|postgres(?:ql)?:)\/\/[^\s"'<>]+/gi,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)[^\s)"']*/gi,
  /\bhttps?:\/\/[^/\s)"']*(?:\.internal|\.local|\.corp|\.onion)(?::\d+)?[^\s)"']*/gi,
];

export function shouldQueryPrompt(prompt) {
  const normalized = String(prompt ?? "").trim();
  if (!normalized || normalized.length < 8) {
    return { likely_match: false, reason: "empty_or_too_short" };
  }
  if (SKIP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { likely_match: false, reason: "skip_pattern" };
  }
  const matches = [
    ...SERVICE_PATTERNS.map((pattern) => [pattern, "external_service"]),
    ...TOOL_PATTERNS.map((pattern) => [pattern, "tool_or_framework"]),
    ...WORKFLOW_PATTERNS.map((pattern) => [pattern, "workflow_shape"]),
    ...UI_PATTERNS.map((pattern) => [pattern, "ui_or_dashboard_work"]),
  ];
  for (const [pattern, reason] of matches) {
    if (pattern.test(normalized)) {
      return { likely_match: true, reason };
    }
  }
  if (/\b(integrate|integration|configure|setup|set up)\b/i.test(normalized)) {
    return { likely_match: true, reason: "third_party_integration" };
  }
  return { likely_match: false, reason: "no_trigger_match" };
}

export function redactPrompt(prompt) {
  let redacted = String(prompt ?? "");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && /^Bearer\s+/i.test(prefix)) {
        return `${prefix}[redacted-token]`;
      }
      if (/^https?:\/\//i.test(match)) {
        return "[redacted-private-url]";
      }
      return "[redacted-secret]";
    });
  }
  return redacted;
}

export function buildQueryPayload(prompt, env = process.env) {
  const redacted = redactPrompt(prompt).trim();
  const summary =
    redacted.length <= MAX_SUMMARY_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_SUMMARY_CHARS - 3).trim()}...`;
  return {
    agent: {
      provider: "claude",
      model: "claude-code",
    },
    task: {
      domain: inferDomain(summary),
      summary,
      constraints: inferConstraints(summary),
    },
    limit: limitFromEnv(env),
  };
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
  const context = formatAdditionalContext(
    response,
    decision.reason,
    limitFromEnv(env),
  );
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

export function formatAdditionalContext(
  response,
  reason = "trigger_match",
  limit = DEFAULT_LIMIT,
) {
  const body = response?.body ?? response;
  const itemLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 10);
  const skills = Array.isArray(body?.skills)
    ? body.skills.slice(0, itemLimit)
    : [];
  const resources = Array.isArray(body?.resources)
    ? body.resources.slice(0, itemLimit)
    : [];
  const noResults = body?.no_results ?? null;
  if (skills.length === 0 && resources.length === 0 && !noResults) {
    return null;
  }

  const lines = [
    "Remembrance auto-query context:",
    `Trigger: ${reason}. Use these results only if they fit the user's task constraints.`,
  ];
  if (skills.length > 0) {
    lines.push("Skills:");
    for (const skill of skills) {
      lines.push(
        `- ${safeText(skill.slug, 80)} (${safeText(skill.trust_tier ?? "unknown", 40)}, uses ${numberValue(skill.verified_uses)}/${numberValue(skill.total_uses)}): ${safeText(skill.description, MAX_CONTEXT_FIELD_CHARS)}`,
      );
    }
  }
  if (resources.length > 0) {
    lines.push("Resources:");
    for (const resource of resources) {
      lines.push(
        `- ${safeText(resource.slug, 80)} [${safeText(resource.kind, 40)}]: ${safeText(resource.description, MAX_CONTEXT_FIELD_CHARS)}`,
      );
    }
  }
  if (noResults) {
    const payload = safeText(
      JSON.stringify(noResults.propose_skill_idea_payload ?? noResults),
      1200,
    );
    lines.push(
      `No matching skill/resource. Proposed skill idea payload: ${payload}`,
    );
  }
  return safeText(lines.join("\n"), MAX_CONTEXT_CHARS);
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
    if (env.REMEMBRANCE_API_KEY) {
      headers["x-remembrance-api-key"] = env.REMEMBRANCE_API_KEY;
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

function debugLog(env, event, fields = {}, options = {}) {
  if (!debugEnabled(env.REMEMBRANCE_DEBUG)) {
    return;
  }
  const writer = options.stderr ?? process.stderr;
  const body = redactPrompt(JSON.stringify({ event, ...fields })).slice(
    0,
    1000,
  );
  writer.write(`[remembrance] ${body}\n`);
}

function debugEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ""));
}

function nowMs(options = {}) {
  return typeof options.nowMs === "number" ? options.nowMs : Date.now();
}

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// Map a prompt to a seeded registry domain so the auto-query is filtered to the
// right area instead of falling back to a generic catch-all (which surfaces the
// entry skills regardless of task). Seeded domains: agent-skills, web-ui-qa,
// resource-discovery, agent-commerce, mcp, mpp. Order matters — most specific
// first. The web-ui vocabulary is intentionally broad (frontend / dashboard /
// design work rarely says the words "web ui" or "accessibility").
function inferDomain(prompt) {
  if (/\b(mpp|x402)\b/i.test(prompt)) {
    return "mpp";
  }
  if (/\b(payment|stripe|checkout|billing|invoice|commerce|receipt)\b/i.test(prompt)) {
    return "agent-commerce";
  }
  if (
    /\b(web ?ui|ux|usability|accessibility|a11y|responsive|playwright|frontend|front-end|dashboard|admin (page|panel|surface)|layout|nav(igation| bar| panel)?|sidebar|css|tailwind|styling|component|modal|tooltip|popover|button|form design|redesign|declutter|design system)\b/i.test(
      prompt,
    )
  ) {
    return "web-ui-qa";
  }
  if (/\b(vercel|heroku|deploy|deployment|ci\/cd|github actions?|pipeline|rollback)\b/i.test(prompt)) {
    return "deployment";
  }
  if (/\b(mongodb|atlas|redis|database|postgres|sql)\b/i.test(prompt)) {
    return "database";
  }
  if (/\b(mcp|model context protocol|tool server)\b/i.test(prompt)) {
    return "mcp";
  }
  if (
    /\b(skill|registry|review queue|reviewer|verifier|remembranc\w*|agent memory|skill idea|suggestion)\b/i.test(
      prompt,
    )
  ) {
    return "agent-skills";
  }
  if (
    /\b(api|endpoint|rest|graphql|webhook|resource|integration|integrate|sdk|service|connector|provider|dataset|docs site)\b/i.test(
      prompt,
    )
  ) {
    return "resource-discovery";
  }
  // No seeded domain fits; agent-skills is the safest default (its entry skill
  // covers the query/submit workflow itself) rather than a non-existent domain.
  return "agent-skills";
}

function inferConstraints(prompt) {
  const constraints = [];
  for (const [pattern, value] of [
    [/\b(ci|github actions?|circleci)\b/i, "ci"],
    [/\b(deploy|deployment|vercel|heroku)\b/i, "deployment"],
    [/\b(payment|stripe|mpp|x402)\b/i, "payment"],
    [/\b(migration|migrate|schema)\b/i, "migration"],
    [/\b(playwright|browser|responsive|accessibility|a11y)\b/i, "qa"],
    [
      /\b(frontend|front-end|dashboard|ux|css|tailwind|react|next\.?js|component|layout|nav|redesign|declutter)\b/i,
      "frontend",
    ],
  ]) {
    if (pattern.test(prompt)) {
      constraints.push(value);
    }
  }
  return [...new Set(constraints)];
}

function apiUrl(env) {
  return String(env.REMEMBRANCE_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
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

function disabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? ""));
}

function stringValue(value) {
  const text = String(value ?? "").trim();
  return text || "unknown";
}

function safeText(value, maxLength) {
  const text = redactPrompt(stringValue(value)).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "0";
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
