#!/usr/bin/env node
// Runtime-agnostic Remembrance hook core.
//
// This module holds the shared logic that both Codex adapters
// (query-on-prompt.mjs, contribute-on-stop.mjs) build on, so those adapters are
// thin: they only read the runtime's stdin JSON, call into here, and print the
// runtime's expected stdout shape. Everything here is Node-builtins-only and
// fail-open by design.
//
// Ported from packages/claude-code-plugin/scripts/{query-on-prompt,contribute-on-stop}.mjs.
// Key difference from the Claude plugin: Codex's Stop payload has NO transcript
// path, so we cannot count registry consumption by scanning a transcript. Instead
// the query adapter records a per-session usage marker whenever it actually
// injects skills (recordRegistryUse), and the stop adapter reads that count
// (readRegistryUseCount) and compares it to a last-prompted sentinel — the same
// count-sentinel pattern the Claude hook uses, but driven by markers instead of
// transcript scans.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_FIELD_CHARS = 280;

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
  /\b(?:mongodb(?:\+srv)?|redis(?:s)?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)[^\s)"']*/gi,
  /\bhttps?:\/\/[^/\s)"']*(?:\.internal|\.local|\.corp|\.onion)(?::\d+)?[^\s)"']*/gi,
];

// --- Trigger heuristic -------------------------------------------------------

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

// --- Redaction ---------------------------------------------------------------

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

// --- Query payload -----------------------------------------------------------

// Canonical (Codex) agent identity. "codex" must be a value the server's
// agentProviderSchema accepts — a non-enum provider (the old "openai") makes the
// /api/v1/agent/query request fail validation, so the fail-open hook silently
// injects nothing. Other runtimes override via runQuery's identity/userAgent
// options; the Claude adapter builds its own payload with its own identity.
export const DEFAULT_AGENT_IDENTITY = { provider: "codex", model: "codex" };
export const DEFAULT_USER_AGENT = "@remembrance/codex-plugin";

export function buildQueryPayload(
  prompt,
  env = process.env,
  identity = DEFAULT_AGENT_IDENTITY,
) {
  const redacted = redactPrompt(prompt).trim();
  const summary =
    redacted.length <= MAX_SUMMARY_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_SUMMARY_CHARS - 3).trim()}...`;
  return {
    agent: {
      provider: identity.provider,
      model: identity.model,
    },
    task: {
      domain: inferDomain(summary),
      summary,
      constraints: inferConstraints(summary),
    },
    limit: limitFromEnv(env),
  };
}

// Map a prompt to a seeded registry domain so the auto-query is filtered to the
// right area instead of falling back to a generic catch-all (which surfaces the
// entry skills regardless of task). Seeded domains: agent-skills, web-ui-qa,
// resource-discovery, agent-commerce, mcp, mpp. Order matters — most specific
// first. The web-ui vocabulary is intentionally broad (frontend / dashboard /
// design work rarely says the words "web ui" or "accessibility").
export function inferDomain(prompt) {
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

export function inferConstraints(prompt) {
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

// --- Query (fetch + timeout, fail-open) --------------------------------------

// Query Remembrance. Returns { body } on success, null on any failure (HTTP
// error, timeout, malformed JSON, thrown error). Never throws.
export async function queryRemembrance(payload, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMsFromEnv(env));
  try {
    const headers = {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    };
    const apiKey = resolveApiKey(env);
    if (apiKey) {
      headers["x-remembrance-api-key"] = apiKey;
    }
    const response = await fetchImpl(`${apiUrl(env)}/api/v1/agent/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      debugLog(env, "http_error", { status: response.status, api_url: apiUrl(env) }, options);
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

// --- Context formatting ------------------------------------------------------

// Format the query response into the plain context string Codex injects via
// additionalContext. Returns null when there is nothing useful to inject.
export function formatContext(response, reason = "trigger_match", limit = DEFAULT_LIMIT) {
  const body = response?.body ?? response;
  const itemLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 10);
  const skills = Array.isArray(body?.skills) ? body.skills.slice(0, itemLimit) : [];
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
    lines.push(`No matching skill/resource. Proposed skill idea payload: ${payload}`);
  }
  return safeText(lines.join("\n"), MAX_CONTEXT_CHARS);
}

// --- High-level query orchestration ------------------------------------------

// The full query flow used by the query adapter: decide, query, format. Returns
// the context string to inject, or null when nothing should be injected (skip,
// disabled, no results, or any failure). Never throws. `fetchImpl`/`env` are
// injectable for tests.
export async function runQuery(prompt, options = {}) {
  const env = options.env ?? process.env;
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  const redacted = redactPrompt(String(prompt ?? ""));
  const decision = shouldQueryPrompt(redacted);
  if (!decision.likely_match) {
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }
  const response = await queryRemembrance(
    buildQueryPayload(redacted, env, options.identity),
    {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      stderr: options.stderr,
      userAgent: options.userAgent,
    },
  );
  if (!response) {
    return null;
  }
  return formatContext(response, decision.reason, limitFromEnv(env));
}

// --- Contribution decision (stop hook) ---------------------------------------

// Count only CONSUMPTION of the registry (queries / explicit skill retrieval) —
// not the agent's own submissions. Kept for parity with the Claude hook and for
// any transcript-shaped input a caller wants to scan; Codex's own Stop payload
// has no transcript, so the marker mechanism below is what actually drives the
// Codex stop decision.
const CONSUMPTION_MARKERS =
  /Remembrance auto-query context|mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource)|\/api\/v1\/agent\/query\b/gi;

export function countRegistryConsumption(transcript) {
  const matches = String(transcript ?? "").match(CONSUMPTION_MARKERS);
  return matches ? matches.length : 0;
}

export function contributionReason() {
  return [
    "Before you finish: you used Remembrance this session.",
    "If you learned something reusable — a lesson, a gotcha, a fix, a skill that helped, or a skill that was missing — contribute it now so the next agent inherits it instead of rediscovering it:",
    "• submit_remembrance — a redacted, evidence-backed lesson tied to the skill/resource you used (the fastest path: a prior submit_feedback response includes a ready next_step.submit_remembrance_payload you can post as-is).",
    "• submit_feedback — a quick useful / not-useful signal plus a one-line lesson.",
    "• propose_skill_idea — only if no existing skill fit and you built a reusable workflow.",
    "Redact secrets, private URLs, and proprietary content; submit redacted summaries and hashes, not raw traces.",
    "Attach evidence: reproduction detail in outcome.failure_modes, artifact hashes of redacted logs/diffs, or an attestation. Evidence-less public reports wait in unverified intake until corroborated; evidence-backed ones verify faster and rank higher.",
    "If nothing is genuinely worth capturing, just say so in one line — you will not be asked again this session.",
  ].join("\n");
}

// Pure decision function (unit-tested): given the current registry-use count and
// the last-prompted count, decide whether to prompt for a contribution. Prompts
// when use has INCREASED since the last prompt — so it fires on the first use
// and again on each later distinct use, but never nags when nothing new was
// used. `useCount`/`promptedCount` are injectable so tests never touch the FS.
export function decideStop(input, options = {}) {
  const env = options.env ?? process.env;
  if (contributeDisabled(env.REMEMBRANCE_AUTO_CONTRIBUTE)) {
    return { allow: true, why: "disabled" };
  }
  if (input?.stop_hook_active) {
    return { allow: true, why: "stop_hook_active" };
  }
  const sessionId = sessionIdFor(input);
  const readUse = options.readUseCount ?? readRegistryUseCount;
  const useCount = readUse(sessionId, env);
  if (useCount === 0) {
    return { allow: true, why: "registry_not_used" };
  }
  const readPrompted = options.readPromptedCount ?? readPromptedCount;
  if (useCount <= readPrompted(sessionId, env)) {
    return { allow: true, why: "no_new_usage" };
  }
  return {
    allow: false,
    why: "prompt_contribution",
    reason: contributionReason(),
    useCount,
  };
}

// --- Marker mechanism (Codex has no transcript path) -------------------------
//
// Two per-session counters live under os.tmpdir()/remembrance-usage/<hash>:
//   <hash>.use     — incremented every time the query adapter injects skills.
//   <hash>.prompt  — the use count at which the stop adapter last prompted.
// The stop adapter prompts when .use > .prompt, then records the new .prompt.
// This reproduces the Claude hook's count-sentinel behavior without a transcript.

const USAGE_DIR = "remembrance-usage";

function usageDir(env = process.env) {
  return env?.REMEMBRANCE_USAGE_DIR
    ? String(env.REMEMBRANCE_USAGE_DIR)
    : join(tmpdir(), USAGE_DIR);
}

function sessionHash(sessionId) {
  return createHash("sha256")
    .update(String(sessionId ?? "unknown"))
    .digest("hex")
    .slice(0, 16);
}

function usePath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.use`);
}

function promptPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.prompt`);
}

function readCountFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeCountFile(path, count) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(count));
    return true;
  } catch {
    // Non-fatal: fail-open, the stop_hook_active guard still prevents loops.
    return false;
  }
}

// Increment (and return) the per-session registry-use counter. Called by the
// query adapter whenever it actually injects skills. Fail-open: on any FS error
// it returns the best count it can and never throws.
export function recordRegistryUse(sessionId, env = process.env) {
  const path = usePath(sessionId, env);
  const next = readCountFile(path) + 1;
  writeCountFile(path, next);
  return next;
}

// Read the per-session registry-use counter (0 if never recorded).
export function readRegistryUseCount(sessionId, env = process.env) {
  return readCountFile(usePath(sessionId, env));
}

// Read the use count at which this session was last prompted to contribute.
export function readPromptedCount(sessionId, env = process.env) {
  return readCountFile(promptPath(sessionId, env));
}

// Record the use count at which we just prompted this session.
export function writePromptedCount(sessionId, count, env = process.env) {
  return writeCountFile(promptPath(sessionId, env), count);
}

// --- Shared helpers ----------------------------------------------------------

export function sessionIdFor(input) {
  return input?.turn_id ?? input?.session_id ?? "unknown";
}

export function disabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? ""));
}

export function contributeDisabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? "").trim());
}

// Well-known config file that carries the org API key (and, optionally, the API
// URL). It exists so a plugin user can authenticate ONCE — via one copy-paste
// command that writes this file — and have BOTH the prompt hooks and the MCP
// server pick the key up, regardless of how the runtime happens to pass (or not
// pass) environment variables to hook commands. Co-located with the agent
// attestation key under the XDG config dir. Fail-open: any read/parse error
// yields an empty config so a missing/garbled file never breaks the hook.
export function remembranceConfigPath(env = process.env) {
  return join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "remembrance",
    "config.json",
  );
}

export function readRemembranceConfig(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(remembranceConfigPath(env), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

// The org API key: an explicit env var wins, then the config file. Returns ""
// when neither is present (the request then goes out anonymously).
export function resolveApiKey(env = process.env) {
  if (env.REMEMBRANCE_API_KEY) {
    return String(env.REMEMBRANCE_API_KEY);
  }
  const fromFile = readRemembranceConfig(env).apiKey;
  return fromFile ? String(fromFile) : "";
}

function apiUrl(env) {
  const fromFile = readRemembranceConfig(env).apiUrl;
  return String(env.REMEMBRANCE_API_URL || fromFile || DEFAULT_API_URL).replace(
    /\/$/,
    "",
  );
}

// Codex registers the HOSTED MCP endpoint as a static URL in its persisted
// registry (no env expansion there), while these hooks resolve
// REMEMBRANCE_API_URL / config.json at runtime. Point the hooks at a
// non-default registry (dev testing, self-host) and the two surfaces silently
// diverge — hooks query one registry, MCP tools another. Claude Code and
// OpenClaw register the LOCAL bundled server, which resolves the same env as
// the hooks, so only the Codex adapters surface this notice.
export function hostedMcpSplitNotice(env = process.env) {
  const origin = apiUrl(env);
  if (origin === DEFAULT_API_URL) {
    return null;
  }
  return (
    `Note: Remembrance prompt hooks are querying ${origin} ` +
    `(REMEMBRANCE_API_URL/config.json override). Codex hosted MCP tools are ` +
    `registered separately and may still target ${DEFAULT_API_URL}; check ` +
    `~/.codex/config.toml if MCP tools should use the same registry.`
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

export function debugLog(env, event, fields = {}, options = {}) {
  if (!debugEnabled(env?.REMEMBRANCE_DEBUG)) {
    return;
  }
  const writer = options.stderr ?? process.stderr;
  const body = redactPrompt(JSON.stringify({ event, ...fields })).slice(0, 1000);
  writer.write(`[remembrance] ${body}\n`);
}

function debugEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ""));
}

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
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
