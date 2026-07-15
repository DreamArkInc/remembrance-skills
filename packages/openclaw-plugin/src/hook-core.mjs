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
// path, so we cannot count registry consumption by scanning a transcript.
// Instead the prompt adapter records completed queries and eligible reusable
// tasks separately. The Stop adapter compares those counters with a
// last-prompted sentinel — the same count-sentinel pattern the Claude hook uses,
// but driven by markers instead of transcript scans.

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_DIRECTIVE_EVENT_TIMEOUT_MS = 750;
const DIRECTIVE_MARKER_TTL_MS = 30 * 60 * 1000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_FIELD_CHARS = 280;
const MAX_DIRECTIVE_CHARS = 900;
const VALUE_EPISODE_MARKER_LIMIT = 20;
const VALUE_EPISODE_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

// Short action prompts often depend entirely on earlier conversation. The hook
// cannot safely reconstruct that context in every runtime, but it can make the
// agent (which does have the thread) perform the missing full-context query.
// Keep these anchored and action-oriented so ordinary prose does not become a
// noisy auto-query trigger.
const CONTEXTUAL_CONTINUATION_PATTERNS = [
  /^\s*(?:continue|proceed|go ahead|do it|try again|one more pass)\s*[.!?]*\s*$/i,
  /^\s*(?:fix|address|resolve|implement|apply|tackle|clean up)\s+(?:all\s+)?(?:these|those|the|your)\s+(?:issues|findings|comments|changes|fixes|recommendations|items)\b/i,
  /^\s*(?:review|check|inspect|look at|take a look at)\s+(?:the\s+)?(?:latest|last|new|recent|remaining)\s+(?:changes?|commits?|updates?|failure|issues?)\b/i,
  /^\s*(?:how(?:'s| is) it looking|does this look|what about now)\b/i,
  /^\s*(?:run|rerun)\s+(?:it|that|the tests?|the checks?)\b/i,
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

export function isContextualContinuationPrompt(prompt) {
  const normalized = String(prompt ?? "").trim();
  if (
    !normalized ||
    SKIP_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return false;
  }
  return CONTEXTUAL_CONTINUATION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
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
  clientContext = null,
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
    ...(clientContext ? { client_context: clientContext } : {}),
    economics_context: buildEconomicsContext(summary, env, identity),
    limit: limitFromEnv(env),
  };
}

export function buildEconomicsContext(summary, env, identity) {
  const observedModel = stringOrNull(
    env.REMEMBRANCE_OBSERVED_MODEL_REVISION ?? env.REMEMBRANCE_MODEL_REVISION,
  );
  const requestedModel = stringOrNull(
    env.REMEMBRANCE_REQUESTED_MODEL ?? identity?.model,
  );
  return {
    runtime: runtimeFromIdentity(identity),
    ...(stringOrNull(env.REMEMBRANCE_RUNTIME_VERSION)
      ? { runtime_version: safeText(env.REMEMBRANCE_RUNTIME_VERSION, 120) }
      : {}),
    ...(requestedModel ? { requested_model: safeText(requestedModel, 160) } : {}),
    ...(observedModel
      ? { observed_model_revision: safeText(observedModel, 160) }
      : {}),
    reasoning_effort: normalizeReasoningEffort(
      env.REMEMBRANCE_REASONING_EFFORT,
    ),
    task_stage: inferTaskStage(summary),
    complexity: inferTaskComplexity(summary),
    scope: {},
    measurement_capabilities: ["latency"],
  };
}

function inferTaskStage(summary) {
  if (/\b(review|audit|inspect)\b/i.test(summary)) return "review";
  if (/\b(test|verify|e2e|qa)\b/i.test(summary)) return "testing";
  if (/\b(deploy|release|publish|rollout)\b/i.test(summary)) return "deployment";
  if (/\b(debug|fix|failure|error|broken)\b/i.test(summary)) return "debugging";
  if (/\b(plan|design|architect|approach)\b/i.test(summary)) return "planning";
  if (/\b(research|evaluate|compare|investigate)\b/i.test(summary)) return "research";
  if (/\b(build|implement|add|create|update|change)\b/i.test(summary)) {
    return "implementation";
  }
  return "unknown";
}

function inferTaskComplexity(summary) {
  const text = String(summary ?? "");
  if (/\b(full|complete|end[- ]to[- ]end|architecture|migration|security)\b/i.test(text)) {
    return "high";
  }
  if (text.length > 400 || inferConstraints(text).length >= 2) return "medium";
  return "unknown";
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
  if (
    /\b(payment|stripe|checkout|billing|invoice|commerce|receipt)\b/i.test(
      prompt,
    )
  ) {
    return "agent-commerce";
  }
  if (
    /\b(web ?ui|ux|usability|accessibility|a11y|responsive|playwright|frontend|front-end|dashboard|admin (page|panel|surface)|layout|nav(igation| bar| panel)?|sidebar|css|tailwind|styling|component|modal|tooltip|popover|button|form design|redesign|declutter|design system)\b/i.test(
      prompt,
    )
  ) {
    return "web-ui-qa";
  }
  if (
    /\b(vercel|heroku|deploy|deployment|ci\/cd|github actions?|pipeline|rollback)\b/i.test(
      prompt,
    )
  ) {
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
  const timeout = setTimeout(
    () => controller.abort(),
    autoQueryTimeoutMs(env),
  );
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

export async function createContinuationDirective(options = {}) {
  const directive = {
    directive_id: `dir_${randomBytes(16).toString("hex")}`,
    runtime: normalizeRuntime(options.runtime),
    trigger_reason: safeText(
      options.triggerReason ?? "contextual_continuation",
      160,
    ),
    shown_at: new Date().toISOString(),
  };
  await reportDirectiveEvent(
    {
      event: "shown",
      directive_id: directive.directive_id,
      surface: "plugin_hook",
      runtime: directive.runtime,
      trigger_reason: directive.trigger_reason,
    },
    options,
  );
  return directive;
}

// Directive telemetry is deliberately fail-open and analytics-only. Hooks wait
// briefly for the shown event so a fast subsequent MCP query cannot overtake
// its denominator record, but an unavailable registry never blocks the prompt.
export async function reportDirectiveEvent(event, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    directiveEventTimeoutMs(env),
  );
  try {
    const headers = {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    };
    const apiKey = resolveApiKey(env);
    if (apiKey) headers["x-remembrance-api-key"] = apiKey;
    const response = await fetchImpl(
      `${apiUrl(env)}/api/v1/agent/directive-events`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      },
    );
    if (!response?.ok) {
      debugLog(
        env,
        "directive_event_http_error",
        { status: response?.status ?? "unavailable" },
        options,
      );
      return false;
    }
    return true;
  } catch (error) {
    debugLog(
      env,
      "directive_event_error",
      { error: errorName(error) },
      options,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function runtimeFromIdentity(identity) {
  return normalizeRuntime(identity?.provider ?? "codex");
}

function normalizeRuntime(value) {
  if (value === "claude") return "claude_code";
  if (["codex", "claude_code", "cursor", "openclaw", "other"].includes(value)) {
    return value;
  }
  return "unknown";
}

// --- Context formatting ------------------------------------------------------

function publicSkillCandidateAllowed(body, candidate) {
  return (
    body?.skill_access?.public_skills_allowed !== false ||
    candidate?.source === "org_overlay"
  );
}

export function highMatchFromResponse(response) {
  const body = response?.body ?? response;
  const queryId = body?.query_feedback?.query_id ?? body?.query_id ?? null;
  const candidates = [
    ...(Array.isArray(body?.skills)
      ? body.skills
          .filter((item) => publicSkillCandidateAllowed(body, item))
          .map((item) => ({ ...item, target_type: "skill" }))
      : []),
    ...(Array.isArray(body?.resources)
      ? body.resources.map((item) => ({ ...item, target_type: "resource" }))
      : []),
  ];
  const candidate = candidates.find((item) => item?.match_tier === "high");
  if (!candidate?.slug) return null;
  return {
    query_id: queryId ? safeText(queryId, 80) : null,
    result_id: candidate.result_id ? safeText(candidate.result_id, 80) : null,
    target_type: candidate.target_type,
    slug: safeText(candidate.slug, 120),
    match_reason: safeText(
      candidate.match_reason ?? "Strong task coverage",
      160,
    ),
    estimated_tokens: Number.isFinite(candidate.estimated_tokens)
      ? Math.max(0, Math.round(candidate.estimated_tokens))
      : null,
    verified_uses: numberValue(candidate.verified_uses),
    risk_level: safeText(candidate.risk_level ?? "unknown", 24),
    value_estimate_id: candidate.value_estimate_id
      ? safeText(candidate.value_estimate_id, 80)
      : null,
    potential_savings: sanitizePotentialSavings(candidate.potential_savings),
  };
}

// Format the query response into the plain context string Codex injects via
// additionalContext. Returns null when there is nothing useful to inject.
export function formatContext(
  response,
  reason = "trigger_match",
  limit = DEFAULT_LIMIT,
) {
  const body = response?.body ?? response;
  const itemLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 10);
  const skills = Array.isArray(body?.skills)
    ? body.skills
        .filter((item) => publicSkillCandidateAllowed(body, item))
        .slice(0, itemLimit)
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
  if (body?.skill_access?.policy === "org_only") {
    lines.push(
      "Organization policy: use organization skills only. Do not use public skills or bundled public skill references, including as an offline fallback.",
    );
  }
  const queryId = body?.query_feedback?.query_id ?? body?.query_id;
  const highMatch = highMatchFromResponse(body);
  if (queryId) {
    lines.push(
      `Query receipt: ${safeText(queryId, 80)}. Use this query_id with the result IDs below when calling submit_query_feedback.`,
    );
  }
  if (highMatch) {
    const tool =
      highMatch.target_type === "resource" ? "get_resource" : "get_skill";
    const args = {
      slug: highMatch.slug,
      ...(highMatch.query_id ? { query_id: highMatch.query_id } : {}),
      ...(highMatch.result_id ? { result_id: highMatch.result_id } : {}),
    };
    lines.push(
      `HIGH MATCH — required next step: call ${tool} with ${JSON.stringify(args)} before proceeding. ${highMatch.match_reason}; ${matchEvidenceLabel(highMatch)}. If it does not actually fit, do not force its use: submit query feedback with fit poor and a concrete reason.`,
    );
  }
  if (skills.length > 0) {
    lines.push("Skills:");
    for (const skill of skills) {
      const resultId = skill.result_id
        ? `, result ${safeText(skill.result_id, 80)}`
        : "";
      lines.push(
        `- [${matchTierLabel(skill.match_tier)}] ${safeText(skill.slug, 80)} (${candidateEvidenceLabel(skill)}${resultId}): ${safeText(skill.description, MAX_CONTEXT_FIELD_CHARS)}`,
      );
    }
  }
  if (resources.length > 0) {
    lines.push("Resources:");
    for (const resource of resources) {
      const resultId = resource.result_id
        ? `, result ${safeText(resource.result_id, 80)}`
        : "";
      lines.push(
        `- [${matchTierLabel(resource.match_tier)}] ${safeText(resource.slug, 80)} [${safeText(resource.kind, 40)}, ${candidateEvidenceLabel(resource)}${resultId}]: ${safeText(resource.description, MAX_CONTEXT_FIELD_CHARS)}`,
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
  const contributionDirective =
    body?.contribution_directive?.message ?? body?.fallback_instruction;
  if (contributionDirective) {
    lines.push(
      `After using Remembrance: ${safeText(contributionDirective, MAX_DIRECTIVE_CHARS)}`,
    );
  }
  if (skills.length > 0 || resources.length > 0) {
    lines.push(
      "Delegating this task? Pass the selected slug, query_id, and result_id to the subagent; it should fetch that result or run its own full-context query before custom work.",
    );
  }
  return safeText(lines.join("\n"), MAX_CONTEXT_CHARS);
}

function matchTierLabel(value) {
  if (value === "high") return "HIGH MATCH";
  if (value === "possible") return "POSSIBLE MATCH";
  return "EXPLORATORY";
}

function candidateEvidenceLabel(candidate) {
  const tokens = Number.isFinite(candidate?.estimated_tokens)
    ? `~${Math.max(0, Math.round(candidate.estimated_tokens))} tokens`
    : "size unknown";
  const verified = numberValue(candidate?.verified_uses);
  const savings = potentialSavingsLabel(candidate?.potential_savings);
  return `${tokens}, ${verified} verified ${verified === 1 ? "use" : "uses"}, risk ${safeText(candidate?.risk_level ?? "unknown", 24)}${savings ? `, ${savings}` : ""}`;
}

function matchEvidenceLabel(match) {
  const tokens = Number.isFinite(match.estimated_tokens)
    ? `~${match.estimated_tokens} tokens`
    : "size unknown";
  const savings = potentialSavingsLabel(match.potential_savings);
  return `${tokens}, ${match.verified_uses} verified ${match.verified_uses === 1 ? "use" : "uses"}, risk ${match.risk_level}${savings ? `, ${savings}` : ""}`;
}

export function continuationQueryContext(directive = null) {
  const clientContext = directive
    ? ` Use client_context ${JSON.stringify({
        runtime: directive.runtime,
        trigger_reason: directive.trigger_reason,
        directive_id: directive.directive_id,
      })} so Remembrance can measure whether this instruction was followed.`
    : "";
  return [
    "Remembrance task-continuation reminder:",
    `This prompt depends on earlier conversation. Infer the concrete task, domain, and constraints from the full thread, then call the Remembrance MCP tool query_skills before acting; do not wait for the current prompt to repeat service, framework, workflow, or UI keywords.${clientContext}`,
    "If MCP is unavailable, use POST /api/v1/agent/query. Do not send raw prior conversation: submit a redacted task summary and constraints.",
    "Before finishing, use submit_query_feedback once with one complete set of explicit good/partial/poor query matches, submit_feedback and submit_remembrance when a returned skill was actually used, or submit a failure_report / skill idea only when a reusable lesson or genuinely missing workflow was found.",
  ].join("\n");
}

export function unavailableQueryContext(env = process.env) {
  const organizationFallback = resolveApiKey(env)
    ? "An organization API key is configured, but the organization skill policy could not be confirmed. Fail closed: do not use bundled public skill references while the query is unavailable."
    : "No organization API key is configured; bundled public references remain an optional offline fallback.";
  return [
    "Remembrance query-unavailable context:",
    "This task qualified for Remembrance, but the automatic query did not complete. Continue without blocking, and call query_skills directly when the MCP tool is visible.",
    organizationFallback,
    "Before finishing, submit a failure_report only if the outage or workaround produced a reusable lesson. Redact secrets, private URLs, credentials, and proprietary content.",
  ].join("\n");
}

export function emptyQueryContext(reason = "trigger_match") {
  return [
    "Remembrance auto-query context:",
    `Trigger: ${reason}. The query completed but returned no matching skill or resource.`,
    "Use the full conversation before deciding whether the workflow is genuinely missing. Propose a skill idea only when you built a reusable workflow that the registry does not already cover.",
    "Before finishing, submit a failure_report when the task exposed a reusable failure lesson.",
  ].join("\n");
}

// --- High-level query orchestration ------------------------------------------

// Full prompt-hook result. `eligible` means this turn should be recovered at
// completion even if no registry result was consumed. `consumed` means a real
// query completed (including a legitimate no-result response).
export async function runPromptHook(prompt, options = {}) {
  const env = options.env ?? process.env;
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  const redacted = redactPrompt(String(prompt ?? ""));
  const decision = shouldQueryPrompt(redacted);
  if (!decision.likely_match) {
    if (isContextualContinuationPrompt(redacted)) {
      const directive = await createContinuationDirective({
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        runtime: runtimeFromIdentity(options.identity),
        stderr: options.stderr,
        userAgent: options.userAgent,
      });
      return {
        consumed: false,
        context: continuationQueryContext(directive),
        directive,
        eligible: true,
        reason: "contextual_continuation",
      };
    }
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }
  const payload = buildQueryPayload(redacted, env, options.identity, {
    surface: "plugin_hook",
    runtime: runtimeFromIdentity(options.identity),
    trigger_reason: decision.reason,
  });
  const response = await queryRemembrance(payload, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
    userAgent: options.userAgent,
  });
  if (!response) {
    return {
      consumed: false,
      context: unavailableQueryContext(env),
      eligible: true,
      reason: "query_unavailable",
    };
  }
  return {
    consumed: true,
    context:
      formatContext(response, decision.reason, limitFromEnv(env)) ??
      emptyQueryContext(decision.reason),
    eligible: true,
    highMatch: highMatchFromResponse(response),
    valueEpisode: valueEpisodeFromResponse(response),
    reason: decision.reason,
  };
}

// Backward-compatible string-only wrapper used by callers that do not need the
// eligibility/consumption distinction.
export async function runQuery(prompt, options = {}) {
  return (await runPromptHook(prompt, options))?.context ?? null;
}

// --- Contribution decision (stop hook) ---------------------------------------

// Count only CONSUMPTION of the registry (queries / explicit skill retrieval) —
// not the agent's own submissions. Kept for parity with the Claude hook and for
// any transcript-shaped input a caller wants to scan; Codex's own Stop payload
// has no transcript, so the marker mechanism below is what actually drives the
// Codex stop decision.
const CONSUMPTION_MARKERS =
  /Remembrance auto-query context|mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource)|\/api\/v1\/agent\/query(?!-feedback)\b/gi;

const TASK_ELIGIBILITY_MARKERS =
  /Remembrance task-continuation reminder|Remembrance query-unavailable context/gi;

const CONTRIBUTION_SUBMITTED_PATTERNS = [
  /\brpub_[a-f0-9]{16,}\b/i,
  /\bsubmitted (?:it|this|the lesson|the failure|the remembrance) (?:to|as) Remembrance\b/i,
  /\bsubmit_remembrance\b/i,
  /\bREMEMBRANCE_SUBMISSION_PAYLOAD\b/,
];

const HIGH_VALUE_LESSON_PATTERNS = [
  {
    pattern:
      /\b(?:missed|missing|forgot(?:ten)?)\b.{0,80}\b(?:version bump|package version|plugin version|mcp package version)\b/i,
    reason: "release versioning miss",
  },
  {
    pattern:
      /\b(?:publish-impacting|check:mcp-package-version|sync:versions|refresh:generated)\b/i,
    reason: "publish or generated-artifact release lesson",
  },
  {
    pattern:
      /\b(?:regression|circleci failed|ci failed|deployment failed|deploy failed)\b/i,
    reason: "failure or regression",
  },
  {
    pattern:
      /\bI (?:missed|forgot|overlooked|failed to|should have|should've|did not|didn't)\b/i,
    reason: "self-correction or missed step",
  },
  {
    pattern: /\b(?:you|the user) (?:caught|pointed out|had to ask)\b/i,
    reason: "user-caught agent miss",
  },
];

export function countRegistryConsumption(transcript) {
  const matches = String(transcript ?? "").match(CONSUMPTION_MARKERS);
  return matches ? matches.length : 0;
}

export function countTaskEligibility(transcript) {
  const matches = String(transcript ?? "").match(TASK_ELIGIBILITY_MARKERS);
  return matches ? matches.length : 0;
}

export function contributionReason(signal = null, highMatch = null) {
  const signalLine = signal
    ? `High-value lesson detected: ${signal}. Capture it unless you already submitted the lesson.`
    : null;
  const highMatchLine = highMatch
    ? highMatchClosureInstruction(highMatch)
    : null;
  return [
    "Before you finish: you used Remembrance this session.",
    signalLine,
    highMatchLine,
    "If you learned something reusable — a lesson, a gotcha, a fix, a skill that helped, or a skill that was missing — contribute it now so the next agent inherits it instead of rediscovering it:",
    "• submit_query_feedback — send one complete good / partial / poor verdict set using query_id and returned result_id values; leave uncertain results unrated. A poor query match is not the same as a globally bad skill.",
    "• submit_feedback — a quick useful / not-useful signal plus a one-line lesson.",
    "• submit_remembrance — post the ready next_step.submit_remembrance_payload returned by submit_feedback when the lesson is reusable, adding redacted evidence when available.",
    "• propose_skill_idea — only if no existing skill fit and you built a reusable workflow.",
    "Use the Remembrance MCP tools directly when they are visible. If this runtime has no MCP tools exposed, use the REST endpoints from the query response; if the API is unavailable, emit REMEMBRANCE_SUBMISSION_PAYLOAD with the redacted JSON you would submit.",
    "Redact secrets, private URLs, and proprietary content; submit redacted summaries and hashes, not raw traces.",
    "Attach evidence: reproduction detail in outcome.failure_modes, artifact hashes of redacted logs/diffs, or an attestation. Evidence-less public reports wait in unverified intake until corroborated; evidence-backed ones verify faster and rank higher.",
    "If nothing is genuinely worth capturing, just say so in one line — you will not be asked again this session.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function taskClosureReason(signal = null) {
  const signalLine = signal
    ? `High-value lesson detected: ${signal}. Capture it unless you already submitted the lesson.`
    : null;
  return [
    "Before you finish: this session involved a reusable service, API, tool, workflow, UI, review, or engineering task, but no completed Remembrance query/use was recorded.",
    signalLine,
    "Infer the concrete task from the full conversation and call query_skills now when the MCP tool is visible. If MCP is unavailable, use POST /api/v1/agent/query with a redacted summary.",
    "Evaluate returned result IDs explicitly: call submit_query_feedback once with the complete good/partial/poor verdict set, then use submit_feedback only after actually using a skill. If nothing fits, report overall_fit none and propose a skill idea only when you actually built a reusable workflow.",
    "Submit a failure_report for a reusable self-correction, user-caught mistake, CI/deploy failure, security issue, or release/versioning miss even when no skill was used.",
    "Redact secrets, private URLs, credentials, raw logs, and proprietary content; attach bounded reproduction detail or artifact hashes when available.",
    "If the task was truly trivial and produced no reusable lesson, say so in one line; you will not be asked again for this task.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function detectHighValueLessonSignal(input) {
  return detectHighValueLessonSignalInText(
    input?.last_assistant_message ??
      input?.lastAssistantMessage ??
      input?.assistant_message ??
      input?.message ??
      "",
  );
}

export function detectHighValueLessonSignalInText(text) {
  const value = String(text ?? "");
  if (!value.trim()) {
    return null;
  }
  if (CONTRIBUTION_SUBMITTED_PATTERNS.some((pattern) => pattern.test(value))) {
    return null;
  }
  for (const { pattern, reason } of HIGH_VALUE_LESSON_PATTERNS) {
    if (pattern.test(value)) {
      return reason;
    }
  }
  return null;
}

// Pure decision function (unit-tested): compare completed registry use and task
// eligibility with the last-prompted count. A completed use prompts for a
// contribution; eligible work with no completed query prompts for full-context
// recovery. `useCount`/`promptedCount` are injectable so tests never touch the
// filesystem.
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
  const readEligible = options.readEligibilityCount ?? readTaskEligibilityCount;
  const eligibilityCount = readEligible(sessionId, env);
  const engagementCount = Math.max(useCount, eligibilityCount);
  const hasUnclosedEligibility = eligibilityCount > useCount;
  const readPrompted = options.readPromptedCount ?? readPromptedCount;
  const promptedCount = readPrompted(sessionId, env);
  const readHighMatch = options.readHighMatch ?? readHighMatchSurface;
  const highMatch = readHighMatch(sessionId, env);
  const highValueSignal = detectHighValueLessonSignal(input);
  if (engagementCount === 0 && !highValueSignal) {
    return { allow: true, why: "registry_not_used" };
  }
  if (engagementCount <= promptedCount && !highValueSignal) {
    return { allow: true, why: "no_new_usage" };
  }
  if (
    highValueSignal &&
    promptedCount > 0 &&
    engagementCount <= promptedCount
  ) {
    return { allow: true, why: "high_value_lesson_already_prompted" };
  }
  return {
    allow: false,
    why: highValueSignal
      ? "prompt_high_value_lesson_contribution"
      : hasUnclosedEligibility
        ? "prompt_task_closure"
        : "prompt_contribution",
    reason: hasUnclosedEligibility
      ? taskClosureReason(highValueSignal)
      : contributionReason(highValueSignal, highMatch),
    useCount: highValueSignal
      ? Math.max(engagementCount, promptedCount + 1, 1)
      : engagementCount,
  };
}

function highMatchClosureInstruction(match) {
  const tool = match.target_type === "resource" ? "get_resource" : "get_skill";
  const args = {
    slug: safeText(match.slug, 120),
    ...(match.query_id ? { query_id: safeText(match.query_id, 80) } : {}),
    ...(match.result_id ? { result_id: safeText(match.result_id, 80) } : {}),
  };
  return `High-confidence result surfaced: ${safeText(match.slug, 120)} (${matchEvidenceLabel(match)}). If you have not opened it, call ${tool} with ${JSON.stringify(args)} now. If it is not a fit, skip it and submit query feedback with fit poor plus the reason; after use, pass the same query_id/result_id to submit_feedback.`;
}

// --- Marker mechanism (Codex has no transcript path) -------------------------
//
// Three per-session counters and one bounded high-match marker live under
// os.tmpdir()/remembrance-usage/<hash>:
//   <hash>.use     — incremented every time the query adapter completes a query.
//   <hash>.eligible — records that a reusable task should be closed out even if
//                     no query result was consumed.
//   <hash>.prompt  — the use count at which the stop adapter last prompted.
//   <hash>.high-match.json — latest high result until its exact detail opens.
// The stop adapter compares max(.use, .eligible) with .prompt, then records the
// new engagement count. This reproduces the Claude hook's sentinel behavior
// without retaining a transcript.

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

function eligibilityPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.eligible`);
}

function highMatchPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.high-match.json`);
}

function valueEpisodePath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.value-episodes.json`);
}

function directivePath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.directive.json`);
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

// Increment (and return) the per-session registry-use counter. Called only when
// the query adapter completed a registry query, including a legitimate empty
// response. Fail-open: on any filesystem error it returns the best count it can
// and never throws.
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

// Increment task eligibility for each qualifying prompt. The prompted-count
// sentinel makes each task recoverable once without re-blocking the Stop retry.
export function recordTaskEligibility(sessionId, env = process.env) {
  const path = eligibilityPath(sessionId, env);
  const next = readCountFile(path) + 1;
  writeCountFile(path, next);
  return next;
}

export function readTaskEligibilityCount(sessionId, env = process.env) {
  return readCountFile(eligibilityPath(sessionId, env));
}

export function recordDirectiveSurface(
  sessionId,
  directive,
  env = process.env,
) {
  const path = directivePath(sessionId, env);
  try {
    if (!directive) {
      rmSync(path, { force: true });
      return true;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        directive_id: safeText(directive.directive_id, 96),
        runtime: normalizeRuntime(directive.runtime),
        trigger_reason: safeText(
          directive.trigger_reason ?? "contextual_continuation",
          160,
        ),
        shown_at: safeText(directive.shown_at ?? new Date().toISOString(), 40),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readDirectiveSurface(sessionId, env = process.env) {
  try {
    const path = directivePath(sessionId, env);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const shownAt = Date.parse(String(parsed?.shown_at ?? ""));
    if (
      !parsed?.directive_id ||
      !Number.isFinite(shownAt) ||
      shownAt + DIRECTIVE_MARKER_TTL_MS < Date.now()
    ) {
      rmSync(path, { force: true });
      return null;
    }
    return {
      directive_id: safeText(parsed.directive_id, 96),
      runtime: normalizeRuntime(parsed.runtime),
      trigger_reason: safeText(
        parsed.trigger_reason ?? "contextual_continuation",
        160,
      ),
      shown_at: new Date(shownAt).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function recordDirectiveFollowThroughForTool(
  sessionId,
  toolName,
  rawResponse,
  options = {},
) {
  const normalizedTool = String(toolName ?? "")
    .trim()
    .toLowerCase();
  if (
    !normalizedTool.endsWith("query_skills") ||
    (normalizedTool !== "query_skills" &&
      !normalizedTool.includes("remembrance"))
  ) {
    return false;
  }
  const env = options.env ?? process.env;
  const directive = readDirectiveSurface(sessionId, env);
  if (!directive) return false;
  // A completed query consumes this task directive even if its response shape
  // prevents correlation; never let a later unrelated query claim it.
  recordDirectiveSurface(sessionId, null, env);
  const queryId = queryIdFromToolResponse(rawResponse);
  if (!queryId) return false;
  return reportDirectiveEvent(
    {
      event: "followed",
      directive_id: directive.directive_id,
      query_id: queryId,
    },
    options,
  );
}

function queryIdFromToolResponse(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return queryIdFromToolResponse(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const queryId = queryIdFromToolResponse(item, depth + 1);
      if (queryId) return queryId;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.query_id === "string" && value.query_id.trim()) {
    return safeText(value.query_id, 80);
  }
  if (value.type === "text" && typeof value.text === "string") {
    const queryId = queryIdFromToolResponse(value.text, depth + 1);
    if (queryId) return queryId;
  }
  for (const key of [
    "body",
    "result",
    "output",
    "response",
    "tool_response",
    "toolResponse",
    "content",
  ]) {
    const queryId = queryIdFromToolResponse(value[key], depth + 1);
    if (queryId) return queryId;
  }
  return null;
}

// Store only bounded public result metadata. A later completed query replaces
// or clears the marker, so Stop never repeats a stale high-match instruction.
export function recordHighMatchSurface(sessionId, match, env = process.env) {
  const path = highMatchPath(sessionId, env);
  try {
    if (!match) {
      rmSync(path, { force: true });
      return true;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        query_id: match.query_id ? safeText(match.query_id, 80) : null,
        result_id: match.result_id ? safeText(match.result_id, 80) : null,
        target_type: match.target_type === "resource" ? "resource" : "skill",
        slug: safeText(match.slug, 120),
        match_reason: safeText(
          match.match_reason ?? "Strong task coverage",
          160,
        ),
        estimated_tokens: Number.isFinite(match.estimated_tokens)
          ? Math.max(0, Math.round(match.estimated_tokens))
          : null,
        verified_uses: numberValue(match.verified_uses),
        risk_level: safeText(match.risk_level ?? "unknown", 24),
        value_estimate_id: match.value_estimate_id
          ? safeText(match.value_estimate_id, 80)
          : null,
        potential_savings: sanitizePotentialSavings(match.potential_savings),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readHighMatchSurface(sessionId, env = process.env) {
  try {
    const parsed = JSON.parse(
      readFileSync(highMatchPath(sessionId, env), "utf8"),
    );
    if (!parsed || typeof parsed.slug !== "string" || !parsed.slug.trim()) {
      return null;
    }
    return {
      query_id:
        typeof parsed.query_id === "string"
          ? safeText(parsed.query_id, 80)
          : null,
      result_id:
        typeof parsed.result_id === "string"
          ? safeText(parsed.result_id, 80)
          : null,
      target_type: parsed.target_type === "resource" ? "resource" : "skill",
      slug: safeText(parsed.slug, 120),
      match_reason: safeText(
        parsed.match_reason ?? "Strong task coverage",
        160,
      ),
      estimated_tokens: Number.isFinite(parsed.estimated_tokens)
        ? Math.max(0, Math.round(parsed.estimated_tokens))
        : null,
      verified_uses: numberValue(parsed.verified_uses),
      risk_level: safeText(parsed.risk_level ?? "unknown", 24),
      value_estimate_id:
        typeof parsed.value_estimate_id === "string"
          ? safeText(parsed.value_estimate_id, 80)
          : null,
      potential_savings: sanitizePotentialSavings(parsed.potential_savings),
    };
  } catch {
    return null;
  }
}

export function clearHighMatchSurfaceIfOpened(
  sessionId,
  toolName,
  rawArguments,
  env = process.env,
) {
  const normalizedTool = String(toolName ?? "")
    .trim()
    .toLowerCase();
  const targetType = normalizedTool.endsWith("get_resource")
    ? "resource"
    : normalizedTool.endsWith("get_skill")
      ? "skill"
      : null;
  if (
    !targetType ||
    (normalizedTool !== `get_${targetType}` &&
      !normalizedTool.includes("remembrance"))
  ) {
    return false;
  }
  const args =
    rawArguments && typeof rawArguments === "object" ? rawArguments : {};
  const match = readHighMatchSurface(sessionId, env);
  if (!match || match.target_type !== targetType) return false;
  if (String(args.slug ?? "") !== match.slug) return false;
  if (match.query_id && String(args.query_id ?? "") !== match.query_id) {
    return false;
  }
  if (match.result_id && String(args.result_id ?? "") !== match.result_id) {
    return false;
  }
  markValueEpisodeSelection(
    sessionId,
    String(args.query_id ?? match.query_id ?? ""),
    String(args.result_id ?? match.result_id ?? ""),
    env,
  );
  return recordHighMatchSurface(sessionId, null, env);
}

export function valueEpisodeFromResponse(response) {
  const body = response?.body ?? response;
  const queryId = body?.query_id ?? body?.query_feedback?.query_id;
  if (!queryId || body?.task_outcome?.available !== true) return null;
  const eligibleResultIds = new Set(
    Array.isArray(body?.task_outcome?.eligible_result_ids)
      ? body.task_outcome.eligible_result_ids.map((id) => String(id))
      : [],
  );
  if (eligibleResultIds.size === 0) return null;
  const candidates = [
    ...(Array.isArray(body?.skills) ? body.skills : []),
    ...(Array.isArray(body?.resources) ? body.resources : []),
  ]
    .filter(
      (item) =>
        item?.task_outcome_eligible === true &&
        item?.result_id &&
        eligibleResultIds.has(String(item.result_id)),
    )
    .slice(0, 40)
    .map((item) => ({
      result_id: safeText(item.result_id, 80),
      value_estimate_id: item.value_estimate_id
        ? safeText(item.value_estimate_id, 80)
        : null,
    }));
  const bundles = (Array.isArray(body?.skill_bundles)
    ? body.skill_bundles
    : []
  )
    .filter((bundle) => {
      const resultIds = Array.isArray(bundle?.result_ids)
        ? bundle.result_ids.map((id) => String(id))
        : [];
      return (
        bundle?.task_outcome_eligible === true &&
        bundle?.bundle_id &&
        resultIds.length > 0 &&
        resultIds.length <= 3 &&
        resultIds.every((resultId) => eligibleResultIds.has(resultId))
      );
    })
    .slice(0, 20)
    .map((bundle) => ({
      bundle_id: safeText(bundle.bundle_id, 80),
      result_ids: bundle.result_ids
        .slice(0, 3)
        .map((id) => safeText(id, 80)),
      value_estimate_id: bundle.value_estimate_id
        ? safeText(bundle.value_estimate_id, 80)
        : null,
    }));
  return {
    query_id: safeText(queryId, 80),
    candidates,
    bundles,
    selected_result_ids: [],
    created_at: new Date().toISOString(),
    reported_at: null,
  };
}

export function recordValueEpisodeSurface(
  sessionId,
  episode,
  env = process.env,
) {
  if (!episode?.query_id) return false;
  const records = readValueEpisodeSurfaces(sessionId, env).filter(
    (item) => item.query_id !== episode.query_id,
  );
  records.push(episode);
  return writeValueEpisodeSurfaces(
    sessionId,
    records.slice(-VALUE_EPISODE_MARKER_LIMIT),
    env,
  );
}

export function readValueEpisodeSurfaces(sessionId, env = process.env) {
  try {
    const parsed = JSON.parse(
      readFileSync(valueEpisodePath(sessionId, env), "utf8"),
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => {
        const createdAt = Date.parse(String(item?.created_at ?? ""));
        return (
          item &&
          typeof item.query_id === "string" &&
          Number.isFinite(createdAt) &&
          createdAt + VALUE_EPISODE_MARKER_TTL_MS > Date.now()
        );
      })
      .slice(-VALUE_EPISODE_MARKER_LIMIT)
      .map((item) => ({
        query_id: safeText(item.query_id, 80),
        candidates: Array.isArray(item.candidates)
          ? item.candidates.slice(0, 40).map((candidate) => ({
              result_id: safeText(candidate?.result_id, 80),
              value_estimate_id: candidate?.value_estimate_id
                ? safeText(candidate.value_estimate_id, 80)
                : null,
            }))
          : [],
        bundles: Array.isArray(item.bundles)
          ? item.bundles.slice(0, 20).map((bundle) => ({
              bundle_id: safeText(bundle?.bundle_id, 80),
              result_ids: Array.isArray(bundle?.result_ids)
                ? bundle.result_ids
                    .slice(0, 3)
                    .map((id) => safeText(id, 80))
                : [],
              value_estimate_id: bundle?.value_estimate_id
                ? safeText(bundle.value_estimate_id, 80)
                : null,
            }))
          : [],
        selected_result_ids: Array.isArray(item.selected_result_ids)
          ? item.selected_result_ids.slice(0, 3).map((id) => safeText(id, 80))
          : [],
        created_at: safeText(item.created_at ?? "", 40),
        reported_at: item.reported_at
          ? safeText(item.reported_at, 40)
          : null,
      }));
  } catch {
    return [];
  }
}

export function markValueEpisodeSelection(
  sessionId,
  queryId,
  resultId,
  env = process.env,
) {
  if (!queryId || !resultId) return false;
  const records = readValueEpisodeSurfaces(sessionId, env);
  const record = records.find((item) => item.query_id === queryId);
  if (!record || !record.candidates.some((item) => item.result_id === resultId)) {
    return false;
  }
  record.selected_result_ids = [
    ...new Set([...record.selected_result_ids, resultId]),
  ].slice(0, 3);
  return writeValueEpisodeSurfaces(sessionId, records, env);
}

export async function reportTaskOutcomesOnStop(
  sessionId,
  input,
  options = {},
) {
  const env = options.env ?? process.env;
  const records = readValueEpisodeSurfaces(sessionId, env);
  const pending = records.filter((item) => !item.reported_at).slice(0, 5);
  if (pending.length === 0) return 0;
  const tokenUsage = tokenUsageFromRuntime(input);
  const modelRevision = stringOrNull(
    input?.observed_model_revision ??
      input?.model_revision ??
      input?.model ??
      env.REMEMBRANCE_OBSERVED_MODEL_REVISION,
  );
  const reasoningEffort = normalizeReasoningEffort(
    input?.reasoning_effort ?? env.REMEMBRANCE_REASONING_EFFORT,
  );
  let recorded = 0;
  for (const episode of pending) {
    const selected = episode.selected_result_ids.slice(0, 3);
    const selectedKey = [...selected].sort().join("\u0000");
    const selectedBundle = episode.bundles.find(
      (bundle) =>
        [...bundle.result_ids].sort().join("\u0000") === selectedKey,
    );
    const estimateId = selectedBundle?.value_estimate_id
      ? selectedBundle.value_estimate_id
      : selected.length === 1
        ? episode.candidates.find(
            (item) => item.result_id === selected[0],
          )?.value_estimate_id
        : null;
    const response = await postTaskOutcome(
      {
        query_id: episode.query_id,
        result_ids: selected,
        estimate_id: estimateId ?? null,
        bundle_id: selectedBundle?.bundle_id ?? null,
        status: "completed",
        success: null,
        latency_ms: null,
        token_usage: tokenUsage,
        observed_model_revision: modelRevision,
        reasoning_effort: reasoningEffort,
        provider_response_ids: [],
        measurement_source: "plugin_observed",
        idempotency_key: `hook_${sessionHash(sessionId)}_${safeText(episode.query_id, 64)}`,
      },
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: options.userAgent,
      },
    );
    if (response) {
      episode.reported_at = new Date().toISOString();
      recorded += 1;
    }
  }
  writeValueEpisodeSurfaces(sessionId, records, env);
  return recorded;
}

async function postTaskOutcome(payload, options = {}) {
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    autoQueryTimeoutMs(env),
  );
  try {
    const headers = {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    };
    const apiKey = resolveApiKey(env);
    if (apiKey) headers["x-remembrance-api-key"] = apiKey;
    const response = await (options.fetchImpl ?? fetch)(
      `${apiUrl(env)}/api/v1/agent/task-outcomes`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function writeValueEpisodeSurfaces(sessionId, records, env) {
  try {
    const path = valueEpisodePath(sessionId, env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(records.slice(-VALUE_EPISODE_MARKER_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

function tokenUsageFromRuntime(input) {
  const usage =
    input?.token_usage ?? input?.tokenUsage ?? input?.usage ?? input?.model_usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = finiteNonNegative(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens,
  );
  const outputTokens = finiteNonNegative(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens,
  );
  if (inputTokens === null || outputTokens === null) return null;
  const cacheRead =
    finiteNonNegative(usage.cache_read_tokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWrite =
    finiteNonNegative(usage.cache_write_tokens ?? usage.cacheWriteTokens) ?? 0;
  const reasoning =
    finiteNonNegative(usage.reasoning_tokens ?? usage.reasoningTokens) ?? 0;
  return {
    uncached_input_tokens: Math.max(0, inputTokens - cacheRead - cacheWrite),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    visible_output_tokens: Math.max(0, outputTokens - reasoning),
    reasoning_tokens: reasoning,
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "max"].includes(
    normalized,
  )
    ? normalized
    : "unknown";
}

function sanitizePotentialSavings(value) {
  if (!value || typeof value !== "object") return null;
  const estimated = value.estimated_saved;
  if (!estimated || typeof estimated !== "object") return null;
  const low = finiteNonNegative(estimated.low);
  const medianValue = finiteNonNegative(estimated.median);
  const high = finiteNonNegative(estimated.high);
  if (low === null || medianValue === null || high === null) return null;
  return {
    unit: "tokens",
    context_tokens: finiteNonNegative(value.context_tokens) ?? 0,
    estimated_saved: { low, median: medianValue, high },
    proof_grade: value.proof_grade === "A" ? "A" : "B",
    measured_episodes: finiteNonNegative(value.measured_episodes) ?? 0,
    proof_url: safeText(value.proof_url ?? "", 300),
    caveat: "Estimate, not a guarantee.",
  };
}

function potentialSavingsLabel(value) {
  const savings = sanitizePotentialSavings(value);
  if (!savings) return null;
  return `${formatCompactNumber(savings.estimated_saved.low)}-${formatCompactNumber(savings.estimated_saved.high)} potential tokens saved (grade ${savings.proof_grade} signed proof)`;
}

function formatCompactNumber(value) {
  if (value >= 1000) {
    const rounded = Math.round((value / 1000) * 10) / 10;
    return `${rounded}k`;
  }
  return String(value);
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
// pass) environment variables to hook commands. The OpenClaw package keeps this
// at the fixed user-home path rather than honoring environment-controlled config
// roots: the hook sends network requests, so ClawHub security scans treat
// dynamic env-driven credential paths as a higher-risk exfiltration pattern.
// Fail-open: any read/parse error yields an empty config so a missing/garbled
// file never breaks the hook.
export function remembranceConfigPath() {
  return join(homedir(), ".config", "remembrance", "config.json");
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

// Codex hosted MCP registration is separate from the hook runtime config. Point
// the hooks at a non-default registry (dev testing, self-host) while MCP still
// points at another URL, and the two surfaces silently diverge — hooks query one
// registry, MCP tools another. Claude Code and OpenClaw register the LOCAL
// bundled server, which resolves the same env as the hooks, so only the Codex
// adapters surface this notice.
export function hostedMcpSplitNotice(env = process.env) {
  const hookBase = normalizeRegistryBaseUrl(apiUrl(env));
  if (hookBase === normalizeRegistryBaseUrl(DEFAULT_API_URL)) {
    return null;
  }
  const hostedMcp = resolveHostedMcpRegistry(env);
  if (hostedMcp.apiBase === hookBase) {
    return null;
  }
  return (
    `Note: Remembrance prompt hooks are querying ${hookBase}, but Codex ` +
    `hosted MCP tools are configured for ${hostedMcp.apiBase} ` +
    `(${hostedMcp.source}). Update REMEMBRANCE_API_URL or the Codex MCP ` +
    `configuration so both surfaces use the same registry.`
  );
}

export function resolveHostedMcpRegistry(env = process.env) {
  const codexMcpUrl = stringOrNull(env.REMEMBRANCE_CODEX_MCP_URL);
  if (codexMcpUrl) {
    return {
      apiBase: normalizeRegistryBaseUrl(codexMcpUrl),
      mcpUrl: codexMcpUrl,
      source: "REMEMBRANCE_CODEX_MCP_URL",
    };
  }
  const genericMcpUrl = stringOrNull(env.REMEMBRANCE_MCP_URL);
  if (genericMcpUrl) {
    return {
      apiBase: normalizeRegistryBaseUrl(genericMcpUrl),
      mcpUrl: genericMcpUrl,
      source: "REMEMBRANCE_MCP_URL",
    };
  }

  const config = readCodexMcpConfig(env);
  if (config?.url) {
    return {
      apiBase: normalizeRegistryBaseUrl(config.url),
      mcpUrl: config.url,
      source: config.path,
    };
  }

  const packagedUrl = readPackagedCodexMcpUrl() ?? `${DEFAULT_API_URL}/api/mcp`;
  return {
    apiBase: normalizeRegistryBaseUrl(packagedUrl),
    mcpUrl: packagedUrl,
    source: "packaged Codex MCP manifest",
  };
}

export function normalizeRegistryBaseUrl(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "/api/mcp") {
      pathname = "";
    } else if (pathname.endsWith("/api/mcp")) {
      pathname = pathname.slice(0, -"/api/mcp".length);
    }
    const normalized = `${url.origin}${pathname}`.replace(/\/+$/, "");
    return normalized || url.origin;
  } catch {
    return raw.replace(/\/api\/mcp$/, "").replace(/\/+$/, "");
  }
}

export function readCodexMcpConfig(env = process.env) {
  for (const path of codexConfigPaths(env)) {
    try {
      if (!existsSync(path)) {
        continue;
      }
      const url = parseCodexMcpUrl(readFileSync(path, "utf8"));
      if (url) {
        return { path, url };
      }
    } catch {
      // Fail open: a malformed/unreadable Codex config should not break hooks.
    }
  }
  return null;
}

export function parseCodexMcpUrl(toml) {
  let inRemembranceServer = false;
  for (const rawLine of String(toml ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inRemembranceServer =
        section[1].trim().replace(/["']/g, "") === "mcp_servers.remembrance";
      continue;
    }
    if (!inRemembranceServer) {
      continue;
    }
    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url) {
      return parseTomlString(url[1]);
    }
  }
  return null;
}

function codexConfigPaths(env) {
  const explicit = stringOrNull(env.REMEMBRANCE_CODEX_CONFIG_PATH);
  if (explicit) {
    return [explicit];
  }
  const codexHome = stringOrNull(env.CODEX_HOME) ?? join(homedir(), ".codex");
  return [
    join(process.cwd(), ".codex", "config.toml"),
    join(codexHome, "config.toml"),
  ];
}

function readPackagedCodexMcpUrl() {
  for (const relativePath of ["../.mcp.codex.json", "../.mcp.json"]) {
    try {
      const parsed = JSON.parse(
        readFileSync(new URL(relativePath, import.meta.url), "utf8"),
      );
      const url = stringOrNull(parsed?.mcpServers?.remembrance?.url);
      if (url) {
        return url;
      }
    } catch {
      // Hook-core is copied into multiple plugin packages; not every copy has a
      // hosted Codex MCP manifest next to it.
    }
  }
  return null;
}

function parseTomlString(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : null;
  }
  const unquoted = trimmed.split("#")[0]?.trim();
  return unquoted || null;
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
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

export function autoQueryTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(
    String(env.REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 30_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function directiveEventTimeoutMs(env) {
  const parsed = Number.parseInt(
    String(env.REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 2_000
    ? parsed
    : DEFAULT_DIRECTIVE_EVENT_TIMEOUT_MS;
}

export function debugLog(env, event, fields = {}, options = {}) {
  if (!debugEnabled(env?.REMEMBRANCE_DEBUG)) {
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
