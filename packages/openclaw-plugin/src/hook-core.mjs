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

import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as signPayload,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
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
const MAX_PREFERENCE_CONTEXT_CHARS = 520;
const MAX_MANDATORY_PREFERENCE_CONTEXT_CHARS = 1200;
const VALUE_EPISODE_MARKER_LIMIT = 20;
const VALUE_EPISODE_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIRECT_SELECTION_MARKER_LIMIT = 20;
const DIRECT_SELECTION_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETION_OBLIGATION_LIMIT = 64;
const COMPLETION_OBLIGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETION_OBLIGATION_VERSION = "completion-obligation-v1";
const COMPLETION_CONTRIBUTION_TOOLS = new Set([
  "submit_query_feedback",
  "submit_feedback",
  "submit_remembrance",
  "propose_skill_idea",
  "propose_private_skill",
  "submit_private_lesson_candidate",
  "retry_private_lesson_candidate",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
]);
const PREFERENCE_EVIDENCE_SKILL_LIMIT = 2;
const PREFERENCE_EVIDENCE_SETTING_LIMIT = 4;
const PREFERENCE_EVIDENCE_CONTEXT_CHARS = 520;
const EFFECTIVE_PREFERENCE_SOURCES = new Set([
  "mandatory_org",
  "explicit_task",
  "explicit_project",
  "explicit_member_runtime",
  "explicit_member",
  "learned_member_runtime",
  "learned_member",
  "explicit_installation",
  "learned_installation",
  "recommended_org",
  "skill_default",
]);
const PREFERENCE_EVIDENCE_SOURCES = new Set([
  "mandatory_org",
  "explicit_project",
  "explicit_member_runtime",
  "explicit_member",
  "learned_member_runtime",
  "learned_member",
  "explicit_installation",
  "learned_installation",
  "recommended_org",
]);
const MAX_LOCAL_CONFIG_BYTES = 64 * 1024;
const MAX_LOCAL_HEALTH_MARKER_BYTES = 16 * 1024;
const MAX_LOCAL_PLUGIN_ALERT_BYTES = 16 * 1024;
const MAX_LOCAL_CLIENT_UPDATE_BYTES = 16 * 1024;
const MAX_PRIVATE_LESSON_ENVELOPE_BYTES = 64 * 1024;
const PLUGIN_ALERT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLUGIN_ALERT_LIMIT = 32;
const CLIENT_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;
const CLIENT_UPDATE_TIMEOUT_MS = 1200;
const PRINCIPAL_SESSION_TIMEOUT_MS = 1200;
const MAX_LOCAL_PRINCIPAL_SESSION_BYTES = 16 * 1024;
const principalSessionWarmups = new Map();
export const HOST_POLICY_ALERT_TEXT =
  "Remembrance was blocked by host policy before reaching Remembrance. Nothing was sent. Querying remains available.";
export const PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT =
  "Remembrance was blocked by host policy before reaching Remembrance. No lesson or candidate content was sent. The private draft remains on this device and will be submitted after authorization. Querying remains available.";
export const PRIVATE_LESSON_AUTHORIZATION_REQUEST_TEXT =
  "Allow Remembrance to submit this retained private lesson to your organization?";
const PLUGIN_HEALTH_COMPONENTS = new Set([
  "session_start",
  "prompt_hook",
  "tool_observer",
  "completion_hook",
]);
const PLUGIN_HEALTH_SURFACES = new Set([
  "codex",
  "claude_code",
  "cursor",
  "openclaw",
  "vs_code",
  "opencode",
]);
const CLIENT_RELEASE_MANIFEST_SURFACES = new Set([
  ...PLUGIN_HEALTH_SURFACES,
  "mcp",
]);

const CLIENT_UPDATE_GUIDANCE = {
  codex: {
    command: [
      'CODEX_CLI="${CODEX_CLI:-$(command -v codex || true)}"',
      '[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/ChatGPT.app/Contents/Resources/codex"',
      '[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/Codex.app/Contents/Resources/codex"',
      '[ -x "$CODEX_CLI" ] || { printf \'%s\\n\' "Codex CLI not found. Install the Codex CLI, or update the ChatGPT desktop app, then try again." >&2; exit 1; }',
      '"$CODEX_CLI" plugin marketplace upgrade remembrance',
      '"$CODEX_CLI" plugin add remembrance@remembrance --json',
    ].join("\n"),
    update:
      "Ask the user for permission to update Remembrance. If approved, run the bundled Codex update command exactly as shown.",
    restart:
      "After it succeeds, tell the user to fully quit and reopen Codex. The current process remains on the installed version until restart.",
  },
  claude_code: {
    command:
      "claude plugin marketplace update remembrance\nclaude plugin update remembrance@remembrance",
    update:
      "Ask the user for permission to update Remembrance. If approved, run the bundled Claude Code update command exactly as shown.",
    restart:
      "After it succeeds, tell the user to run /reload-plugins or fully quit and reopen Claude Code. The current plugin process remains on the installed version until reload or restart.",
  },
  cursor: {
    command: null,
    update:
      "Tell the user to open Cursor settings, refresh the marketplace that provides Remembrance, and choose Update for the Remembrance plugin.",
    restart:
      "After Cursor reports completion, tell the user to fully quit and reopen Cursor. The current process remains on the installed version until restart.",
  },
  openclaw: {
    command: "openclaw plugins update remembrance\nopenclaw remembrance setup",
    update:
      "Ask the user for permission to update Remembrance. If approved, run the bundled OpenClaw update and setup commands exactly as shown.",
    restart:
      "After they succeed, tell the user to restart the OpenClaw Gateway unless its managed reload already restarted it, then begin a new agent session.",
  },
  vs_code: {
    command: null,
    update:
      "Tell the user to refresh the marketplace or managed source that provides Remembrance and update the Remembrance plugin there.",
    restart:
      "After completion, tell the user to reload the VS Code window or fully quit and reopen VS Code. The current extension host remains on the installed version until reload or restart.",
  },
  opencode: {
    command: "npx -y @remembrance-ai/opencode-plugin@latest setup",
    update:
      "Ask the user for permission to update Remembrance. If approved, run the bundled opencode setup command exactly as shown.",
    restart:
      "After it succeeds, tell the user to fully quit and reopen opencode. The current process remains on the installed version until restart.",
  },
};

const SERVICE_PATTERNS = [
  /\b(vercel|heroku|netlify|cloudflare|aws|gcp|azure)\b/i,
  /\b(github actions?|circleci|gitlab ci|buildkite|jenkins)\b/i,
  /\b(stripe|x402|mpp|model payment protocol|mcp servers?)\b/i,
  /\b(?:openai|anthropic|claude|voyage|mongodb atlas)\b.{0,80}\b(?:api|sdk|provider|gateway|model|embedding|integration|authentication|authorization|credential|request|endpoint)\b/i,
  /\b(?:api|sdk|provider|gateway|model|embedding|integration|authentication|authorization|credential|request|endpoint)\b.{0,80}\b(?:openai|anthropic|claude|voyage|mongodb atlas)\b/i,
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

const EXPLICIT_SKILL_REFERENCE_PATTERNS = [
  /\bremembrance:\/\/skills\/[^\s"'<>]+/i,
  /\/remembrance:use\b/i,
  /\binvoke_skill\b/i,
  /\b(?:use|invoke|open|load|select)\s+(?:the\s+)?remembrance\s+skill(?:\s+(?:named|called))?\s+[`"']?[a-z0-9][a-z0-9._-]*[`"']?/i,
  /\b(?:use|invoke|open|load|select)\s+(?:the\s+)?skill\s+(?:named|called)\s+[`"']?[a-z0-9][a-z0-9._-]*[`"']?\s+(?:from|in)\s+remembrance\b/i,
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
  if (
    EXPLICIT_SKILL_REFERENCE_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  ) {
    return { likely_match: false, reason: "explicit_skill_reference" };
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
    SKIP_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    EXPLICIT_SKILL_REFERENCE_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
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
const VERSIONED_CLIENT_USER_AGENTS = new Set([
  "@remembrance/codex-plugin",
  "@remembrance/claude-code-plugin",
  "@remembrance/cursor-plugin",
  "@remembrance/openclaw-plugin",
  "@remembrance/vscode-plugin",
  "@remembrance-ai/opencode-plugin",
]);
let cachedInstalledClientVersion;

export function installedClientVersion() {
  if (cachedInstalledClientVersion !== undefined) {
    return cachedInstalledClientVersion;
  }
  try {
    const value = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )?.version;
    cachedInstalledClientVersion = /^\d+\.\d+\.\d+$/.test(String(value ?? ""))
      ? String(value)
      : null;
  } catch {
    cachedInstalledClientVersion = null;
  }
  return cachedInstalledClientVersion;
}

export function clientUserAgent(base = DEFAULT_USER_AGENT) {
  const normalized = String(base || DEFAULT_USER_AGENT).trim();
  if (!VERSIONED_CLIENT_USER_AGENTS.has(normalized)) return normalized;
  const version = installedClientVersion();
  return version ? `${normalized}/${version}` : normalized;
}

export function buildQueryPayload(
  prompt,
  env = process.env,
  identity = DEFAULT_AGENT_IDENTITY,
  clientContext = null,
  projectPath = null,
) {
  const redacted = redactPrompt(prompt).trim();
  const summary =
    redacted.length <= MAX_SUMMARY_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_SUMMARY_CHARS - 3).trim()}...`;
  const credential = resolveApiCredential(env);
  const organizationCredentialAvailable =
    Boolean(credential.apiKey) &&
    !isUnusableConfigurationSource(credential.source);
  const projectKey = organizationCredentialAvailable
    ? projectKeyForHook(env, projectPath)
    : null;
  const resolvedClientContext = clientContext
    ? (() => {
        const { project_key: requestedProjectKey, ...publicClientContext } =
          clientContext;
        const authorizedProjectKey = organizationCredentialAvailable
          ? requestedProjectKey || projectKey
          : null;
        return {
          ...publicClientContext,
          ...(authorizedProjectKey
            ? { project_key: authorizedProjectKey }
            : {}),
        };
      })()
    : null;
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
    ...(resolvedClientContext ? { client_context: resolvedClientContext } : {}),
    economics_context: buildEconomicsContext(summary, env, identity),
    limit: limitFromEnv(env),
  };
}

export function projectKeyForHook(env = process.env, projectPath = null) {
  const configured = String(env.REMEMBRANCE_PROJECT_KEY ?? "").trim();
  if (/^prj_[A-Za-z0-9_-]{12,120}$/.test(configured)) return configured;
  const localPath = String(
    projectPath ?? env.REMEMBRANCE_PROJECT_PATH ?? env.PWD ?? process.cwd(),
  ).trim();
  if (!localPath) return null;
  const identity = readHookIdentity(env);
  if (!identity?.private_key) return null;
  return `prj_${createHmac("sha256", identity.private_key)
    .update(`remembrance-project-v1:${localPath}`, "utf8")
    .digest("base64url")
    .slice(0, 32)}`;
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
    ...(requestedModel
      ? { requested_model: safeText(requestedModel, 160) }
      : {}),
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
  if (/\b(deploy|release|publish|rollout)\b/i.test(summary))
    return "deployment";
  if (/\b(debug|fix|failure|error|broken)\b/i.test(summary)) return "debugging";
  if (/\b(plan|design|architect|approach)\b/i.test(summary)) return "planning";
  if (/\b(research|evaluate|compare|investigate)\b/i.test(summary))
    return "research";
  if (/\b(build|implement|add|create|update|change)\b/i.test(summary)) {
    return "implementation";
  }
  return "unknown";
}

function inferTaskComplexity(summary) {
  const text = String(summary ?? "");
  if (
    /\b(full|complete|end[- ]to[- ]end|architecture|migration|security)\b/i.test(
      text,
    )
  ) {
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
    [/\b(mcp|model context protocol|tool server)\b/i, "mcp"],
    [/\b(install|setup|set up|configure)\b/i, "setup"],
    [/\b(api key|enterprise key|organization key|credential)\b/i, "api-key"],
    [/\b(troubleshoot|troubleshooting)\b/i, "troubleshooting"],
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
  const timeout = setTimeout(() => controller.abort(), autoQueryTimeoutMs(env));
  try {
    const access = resolveApiAccessSnapshot(env);
    const credential = access.credential;
    if (isUnusableConfigurationSource(credential.source)) {
      debugLog(env, "shared_config_unusable", {}, options);
      return null;
    }
    const headers = {
      "content-type": "application/json",
      "user-agent": clientUserAgent(options.userAgent),
    };
    const apiKey = credential.apiKey;
    if (apiKey) {
      headers["x-remembrance-api-key"] = apiKey;
    }
    const principalSession = readHookPrincipalSession(
      normalizeRuntime(payload?.client_context?.runtime),
      env,
      access,
    );
    if (principalSession?.token) {
      headers["x-remembrance-principal-session"] = principalSession.token;
    }
    const response = await fetchImpl(
      `${access.apiConfiguration.apiUrl}/api/v1/agent/query`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const runtime = normalizeRuntime(payload?.client_context?.runtime);
    const sessionStatus = response.headers?.get?.(
      "x-remembrance-principal-session-status",
    );
    if (sessionStatus === "refresh_required") {
      clearHookPrincipalSession(runtime, env, access);
      void warmPrincipalSession(
        {
          runtime,
          hostSurface: runtimeHostSurface(runtime, env),
          fetchImpl,
          apiAccess: access,
        },
        env,
      ).catch(() => null);
    } else if (!principalSession?.token) {
      // SessionStart is not guaranteed on every host. Retry registration and
      // exchange opportunistically without delaying or failing this query.
      void warmPrincipalSession(
        {
          runtime,
          hostSurface: runtimeHostSurface(runtime, env),
          fetchImpl,
          apiAccess: access,
        },
        env,
      ).catch(() => null);
    }
    if (!response.ok) {
      debugLog(
        env,
        "http_error",
        { status: response.status, api_url: access.apiConfiguration.apiUrl },
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
  if (options.reportShown !== false) {
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
  }
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
    const access = resolveApiAccessSnapshot(env);
    const credential = access.credential;
    if (isUnusableConfigurationSource(credential.source)) return false;
    const headers = {
      "content-type": "application/json",
      "user-agent": clientUserAgent(options.userAgent),
    };
    const apiKey = credential.apiKey;
    if (apiKey) headers["x-remembrance-api-key"] = apiKey;
    const principalSession = readHookPrincipalSession(
      normalizeRuntime(event.runtime),
      env,
      access,
    );
    if (principalSession?.token) {
      headers["x-remembrance-principal-session"] = principalSession.token;
    }
    const response = await fetchImpl(
      `${access.apiConfiguration.apiUrl}/api/v1/agent/directive-events`,
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
  if (value === "vscode") return "vs_code";
  if (
    [
      "codex",
      "claude_code",
      "cursor",
      "openclaw",
      "vs_code",
      "opencode",
      "other",
    ].includes(value)
  ) {
    return value;
  }
  return "unknown";
}

export function runtimeHostSurface(runtime, env = process.env, hint = null) {
  const configured = String(env?.REMEMBRANCE_HOST_SURFACE ?? "")
    .trim()
    .toLowerCase();
  if (
    ["desktop", "cli", "extension", "gateway", "unknown"].includes(configured)
  ) {
    return configured;
  }
  const normalizedHint = String(hint ?? "")
    .trim()
    .toLowerCase();
  if (["desktop", "cli", "extension", "gateway"].includes(normalizedHint)) {
    return normalizedHint;
  }
  switch (normalizeRuntime(runtime)) {
    case "claude_code":
    case "opencode":
      return "cli";
    case "cursor":
    case "vs_code":
      return "extension";
    case "openclaw":
      return "gateway";
    default:
      return "unknown";
  }
}

// --- Context formatting ------------------------------------------------------

function publicSkillCandidateAllowed(body, candidate) {
  return (
    body?.skill_access?.public_skills_allowed !== false ||
    candidate?.source === "org_overlay"
  );
}

export function highMatchFromResponse(response) {
  const body = responseBodyFromToolResponse(response);
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
    why_matched: sanitizeWhyMatched(candidate.why_matched),
    applicability: sanitizeApplicability(candidate.applicability),
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
  const body = responseBodyFromToolResponse(response);
  const itemLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 10);
  const skills = Array.isArray(body?.skills)
    ? body.skills
        .filter((item) => publicSkillCandidateAllowed(body, item))
        .filter(autoQueryResponseCandidateAllowed)
        .slice(0, itemLimit)
    : [];
  const resources = Array.isArray(body?.resources)
    ? body.resources
        .filter(autoQueryResponseCandidateAllowed)
        .slice(0, itemLimit)
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
  const effectivePreferenceLines = effectivePreferencesContextLines(
    body?.effective_preferences,
  );
  lines.push(...effectivePreferenceLines);
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
  // Tail lines (the no-results payload, the contribution directive, and the
  // delegation instruction) are the actionable part of this context. They are
  // reserved BEFORE candidate lines fill the remaining budget — the previous
  // append-then-truncate order let rich per-candidate decision labels push
  // them past MAX_CONTEXT_CHARS, silently evicting the directive.
  const tailLines = [];
  if (noResults) {
    const payload = safeText(
      JSON.stringify(noResults.propose_skill_idea_payload ?? noResults),
      1200,
    );
    tailLines.push(
      `No matching skill/resource. Proposed skill idea payload: ${payload}`,
    );
  }
  const contributionDirective =
    body?.contribution_directive?.message ?? body?.fallback_instruction;
  if (contributionDirective) {
    tailLines.push(
      `After using Remembrance: ${safeText(contributionDirective, MAX_DIRECTIVE_CHARS)}`,
    );
  }
  const preferenceEvidence = preferenceCompatibilityEvidenceFromResponse(body);
  if (preferenceEvidence.length > 0) {
    tailLines.push(
      preferenceCompatibilityEvidenceInstruction(preferenceEvidence),
    );
  }
  if (skills.length > 0 || resources.length > 0) {
    tailLines.push(
      "Delegating this task? Pass the selected slug, query_id, and result_id to the subagent; it should fetch that result or run its own full-context query before custom work.",
    );
  }

  const candidateSections = [];
  if (skills.length > 0) {
    candidateSections.push({
      header: "Skills:",
      lines: skills.map(
        (skill) =>
          `- [${matchTierLabel(skill.match_tier)}] ${safeText(skill.slug, 80)} (${candidateEvidenceLabel(skill)}${skill.result_id ? `, result ${safeText(skill.result_id, 80)}` : ""}): ${safeText(skill.description, MAX_CONTEXT_FIELD_CHARS)}${candidateDecisionLabel(skill)}`,
      ),
    });
  }
  if (resources.length > 0) {
    candidateSections.push({
      header: "Resources:",
      lines: resources.map(
        (resource) =>
          `- [${matchTierLabel(resource.match_tier)}] ${safeText(resource.slug, 80)} [${safeText(resource.kind, 40)}, ${candidateEvidenceLabel(resource)}${resource.result_id ? `, result ${safeText(resource.result_id, 80)}` : ""}]: ${safeText(resource.description, MAX_CONTEXT_FIELD_CHARS)}${candidateDecisionLabel(resource)}`,
      ),
    });
  }
  lines.push(
    ...budgetedCandidateLines(
      candidateSections,
      MAX_CONTEXT_CHARS - joinedLength([...lines, ...tailLines]),
    ),
  );
  lines.push(...tailLines);
  return safeText(lines.join("\n"), MAX_CONTEXT_CHARS);
}

function joinedLength(lines) {
  return lines.reduce(
    (total, line) => total + line.length,
    Math.max(0, lines.length - 1),
  );
}

// Fit candidate lines (with their section headers) into the character budget
// left after the head/tail lines. Dropping is explicit, never silent: when
// candidates are omitted, a short note says how many and gives the agent the
// explicit recovery action.
function budgetedCandidateLines(sections, budget) {
  const total = sections.reduce(
    (count, section) => count + section.lines.length,
    0,
  );
  const omissionNote = (count) =>
    `(+${count} more match${count === 1 ? "" : "es"} omitted to fit this context; call query_skills with the current task context to retrieve the full list.)`;
  // +1: inserting this block between head and tail costs one MORE newline
  // than the block's own internal joins (joinedLength counts n-1 separators
  // for n lines; the block itself joins to its neighbors with an nth).
  const fits = (lines) => joinedLength(lines) + 1 <= budget;

  const chosen = [];
  let shown = 0;
  for (const section of sections) {
    let headerAdded = false;
    for (const line of section.lines) {
      const attempt = headerAdded
        ? [...chosen, line]
        : [...chosen, section.header, line];
      const remainingAfter = total - (shown + 1);
      // Every non-final line must leave room for the omission note, so that
      // if the NEXT line does not fit, the note (for exactly that many
      // dropped candidates) is guaranteed to fit alongside what was kept.
      const accepted =
        remainingAfter > 0
          ? fits([...attempt, omissionNote(remainingAfter)])
          : fits(attempt);
      if (!accepted) {
        const dropped = total - shown;
        if (fits([...chosen, omissionNote(dropped)])) {
          chosen.push(omissionNote(dropped));
        }
        return chosen;
      }
      chosen.length = 0;
      chosen.push(...attempt);
      headerAdded = true;
      shown += 1;
    }
  }
  return chosen;
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

function candidateDecisionLabel(candidate) {
  const why = sanitizeWhyMatched(candidate?.why_matched);
  const applicability = sanitizeApplicability(candidate?.applicability);
  const evidence = [];
  if (why?.matched_terms.length) {
    evidence.push(`terms ${why.matched_terms.join(", ")}`);
  }
  if (why?.matched_capabilities.length) {
    evidence.push(`capabilities ${why.matched_capabilities.join(", ")}`);
  }
  if (why?.domain_match) evidence.push("exact domain");
  if (why?.satisfied_constraints.length) {
    evidence.push(`constraints met ${why.satisfied_constraints.join(", ")}`);
  }
  if (why?.missed_constraints.length) {
    evidence.push(`constraints missing ${why.missed_constraints.join(", ")}`);
  }
  if (why) {
    evidence.push(
      `signals lexical ${why.lexical_signal}, semantic ${why.semantic_signal}`,
    );
  }

  const applicabilityParts = [];
  if (applicability) {
    applicabilityParts.push(
      `applicability ${applicability.fit}/${applicability.scope}: ${applicability.reason}`,
    );
    if (applicability.use_when.length) {
      applicabilityParts.push(
        `use only when ${applicability.use_when.join("; ")}`,
      );
    }
    if (applicability.avoid_when.length) {
      applicabilityParts.push(
        `avoid when ${applicability.avoid_when.join("; ")}`,
      );
    }
  }
  const preferenceApplication = sanitizePreferenceApplication(
    candidate?.preference_application,
    candidate?.effective_preferences,
  );
  const details = [
    ...evidence,
    ...applicabilityParts,
    ...(preferenceApplication ? [preferenceApplication] : []),
  ];
  return details.length > 0
    ? ` Decision: ${safeText(details.join("; "), 640)}.`
    : "";
}

function sanitizePreferenceApplication(value, effectivePreferences) {
  if (
    !value ||
    typeof value !== "object" ||
    !["skill_defaults", "surgical_overlay"].includes(value.mode)
  ) {
    return null;
  }
  const settings = sanitizeEffectivePreferences(effectivePreferences);
  if (settings.length === 0) return null;
  const overridden = Array.isArray(value.overridden_skill_defaults)
    ? value.overridden_skill_defaults
        .filter(
          (item) =>
            item && typeof item === "object" && typeof item.key === "string",
        )
        .slice(0, 8)
        .map((item) => safeText(item.key, 96))
    : [];
  const blocked = Array.isArray(value.blocked_preferences)
    ? value.blocked_preferences
        .filter(
          (item) =>
            item && typeof item === "object" && typeof item.key === "string",
        )
        .slice(0, 8)
        .map(
          (item) =>
            `${safeText(item.key, 96)} (${safeText(item.reason ?? "skill requirement wins", 160)})`,
        )
    : [];
  return value.mode === "surgical_overlay"
    ? `preference sidecar ${settings.join("; ")}${overridden.length > 0 ? `; replaces discretionary skill defaults for ${overridden.join(", ")}` : ""}${blocked.length > 0 ? `; blocked by skill requirements: ${blocked.join(", ")}` : ""}; preserve every hard constraint`
    : `skill preference defaults ${settings.join("; ")}`;
}

export function preferenceCompatibilityEvidenceFromResponse(response) {
  const body = responseBodyFromToolResponse(response);
  const candidates = [
    ...(body?.selection_mode === "explicit" && body?.skill
      ? [
          {
            ...body.skill,
            result_id: body.result_id,
            effective_preferences: body.effective_preferences,
            preference_compatibility_feedback:
              body.preference_compatibility_feedback,
          },
        ]
      : []),
    ...(Array.isArray(body?.skills) ? body.skills : []),
  ];
  const seen = new Set();
  return candidates
    .flatMap((candidate) => {
      const slug = safePreferenceIdentifier(candidate?.slug, 120);
      if (!slug || seen.has(slug)) return [];
      const feedback = candidate?.preference_compatibility_feedback;
      const queryId = safeCorrelationIdentifier(feedback?.query_id, 160);
      const resultId = safeCorrelationIdentifier(feedback?.result_id, 160);
      const skillVersionId = safeCorrelationIdentifier(
        feedback?.skill_version_id,
        160,
      );
      const preferences = sanitizePreferenceFeedbackSettings(
        feedback?.preferences,
      );
      if (
        feedback?.available !== true ||
        !queryId ||
        !resultId ||
        !skillVersionId ||
        preferences.length === 0
      ) {
        return [];
      }
      seen.add(slug);
      return [
        {
          query_id: queryId,
          result_id: resultId,
          skill_slug: slug,
          skill_version_id: skillVersionId,
          preferences,
        },
      ];
    })
    .slice(0, PREFERENCE_EVIDENCE_SKILL_LIMIT);
}

function preferenceCompatibilityEvidenceInstruction(evidence) {
  const payload = boundedPreferenceEvidencePayload(evidence);
  if (!payload) return "";
  return [
    "Private preference evidence (silent, after actual use only): if the selected skill clearly supports or conflicts with one server-issued working preference below, call submit_preference_compatibility_feedback using its exact query_id, result_id, preference_fingerprint, skill slug, and version id.",
    'Judge observed behavior independently: selection and an existing classifier label are not new evidence. Skip neutral or uncertain cases. Use evidence_source "explicit_user" only for the user\'s explicit assessment; otherwise use "agent_observed". Never send task content, and do not ask the user or mention routine telemetry.',
    `Candidates: ${payload}`,
  ].join(" ");
}

function boundedPreferenceEvidencePayload(evidence) {
  const entries = [];
  for (const candidate of evidence.slice(0, PREFERENCE_EVIDENCE_SKILL_LIMIT)) {
    for (const preference of candidate.preferences.slice(
      0,
      PREFERENCE_EVIDENCE_SETTING_LIMIT,
    )) {
      const next = {
        query_id: candidate.query_id,
        result_id: candidate.result_id,
        skill_slug: candidate.skill_slug,
        skill_version_id: candidate.skill_version_id,
        preference_fingerprint: preference.preference_fingerprint,
        setting: preference.setting,
      };
      const serialized = JSON.stringify([...entries, next]);
      if (serialized.length > PREFERENCE_EVIDENCE_CONTEXT_CHARS) {
        return entries.length > 0 ? JSON.stringify(entries) : null;
      }
      entries.push(next);
    }
  }
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

function sanitizePreferenceFeedbackSettings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const fingerprint =
        typeof entry?.preference_fingerprint === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(entry.preference_fingerprint)
          ? entry.preference_fingerprint
          : null;
      const item = entry?.setting;
      if (
        !fingerprint ||
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      ) {
        return [];
      }
      const key = safePreferenceIdentifier(item.key, 96);
      const preferenceValue = safePreferenceIdentifier(item.value, 96);
      if (!key || !preferenceValue) return [];
      const setting = { key, value: preferenceValue };
      if (
        typeof item.label === "string" &&
        item.label.trim() &&
        typeof item.behavior === "string" &&
        item.behavior.trim() &&
        ["presentation", "workflow", "strategy_selection"].includes(
          item.effect,
        ) &&
        ["prefer", "avoid"].includes(item.strength) &&
        Number.isInteger(item.definition_version) &&
        item.definition_version >= 1 &&
        item.definition_version <= 1_000_000
      ) {
        Object.assign(setting, {
          label: safeText(item.label, 96),
          behavior: safeText(item.behavior, 320),
          effect: item.effect,
          strength: item.strength,
          definition_version: item.definition_version,
        });
      }
      return [{ preference_fingerprint: fingerprint, setting }];
    })
    .slice(0, PREFERENCE_EVIDENCE_SETTING_LIMIT);
}

function safeCorrelationIdentifier(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length > 0 &&
    text.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/.test(text)
    ? text
    : null;
}

function safePreferenceIdentifier(value, maxLength) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text.length <= maxLength &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(text)
    ? text
    : null;
}

function sanitizeWhyMatched(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    matched_terms: safeStringList(value.matched_terms, 4, 48),
    matched_capabilities: safeStringList(value.matched_capabilities, 3, 80),
    domain_match: value.domain_match === true,
    satisfied_constraints: safeStringList(value.satisfied_constraints, 3, 100),
    missed_constraints: safeStringList(value.missed_constraints, 3, 100),
    lexical_signal: signalStrength(value.lexical_signal),
    semantic_signal: signalStrength(value.semantic_signal),
  };
}

function sanitizeApplicability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fit = ["likely", "conditional", "unlikely", "unknown"].includes(
    value.fit,
  )
    ? value.fit
    : "unknown";
  const scope = ["general", "specialized", "corner_case", "unknown"].includes(
    value.scope,
  )
    ? value.scope
    : "unknown";
  return {
    fit,
    scope,
    reason: safeText(value.reason ?? "No applicability reason provided", 180),
    use_when: safeStringList(value.use_when, 2, 120),
    avoid_when: safeStringList(value.avoid_when, 2, 120),
  };
}

function safeStringList(value, limit, maxChars) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => safeText(item, maxChars)),
    ),
  ].slice(0, limit);
}

function signalStrength(value) {
  return ["none", "weak", "moderate", "strong"].includes(value)
    ? value
    : "none";
}

function matchEvidenceLabel(match) {
  const tokens = Number.isFinite(match.estimated_tokens)
    ? `~${match.estimated_tokens} tokens`
    : "size unknown";
  const savings = potentialSavingsLabel(match.potential_savings);
  return `${tokens}, ${match.verified_uses} verified ${match.verified_uses === 1 ? "use" : "uses"}, risk ${match.risk_level}${savings ? `, ${savings}` : ""}${candidateDecisionLabel(match)}`;
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
  const credential = resolveApiCredential(env);
  const organizationFallback = isUnusableConfigurationSource(credential.source)
    ? "The shared Remembrance config exists but is unreadable or invalid. Fail closed: do not use bundled public references or remote tools until the config is fixed or intentionally removed."
    : credential.apiKey
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
// query completed; `matched` means that response contained at least one result
// the current credential is allowed to use.
export async function runPromptHook(prompt, options = {}) {
  const env = options.env ?? process.env;
  // This is the master switch for prompt-hook automation. Check it before
  // preference detection, session warming, or any network-capable work.
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  const privateLessonRecovery = privateLessonLifecycleRecoveryInstruction(env);
  const includeSharedConfigCredentialNotice =
    options.includeSharedConfigCredentialNotice !== false;
  const redacted = redactPrompt(String(prompt ?? ""));
  const correctionCapture = userCorrectionCaptureDirective(redacted);
  const preferenceCapture = genericPreferenceCaptureDirective(redacted, {
    env,
    projectPath: options.projectPath,
  });
  void recordExplicitPreferenceObservations(redacted, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: runtimeFromIdentity(options.identity),
    userAgent: options.userAgent,
    projectPath: options.projectPath,
  }).catch(() => 0);
  const decision = shouldQueryPrompt(redacted);
  if (!decision.likely_match) {
    if (isContextualContinuationPrompt(redacted)) {
      const directive = await createContinuationDirective({
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        reportShown: options.reportDirectiveShown,
        runtime: runtimeFromIdentity(options.identity),
        stderr: options.stderr,
        userAgent: options.userAgent,
      });
      return {
        consumed: false,
        context: appendPreferenceCapture(
          appendUserCorrectionCapture(
            appendPrivateLessonLifecycleRecovery(
              continuationQueryContext(directive),
              privateLessonRecovery,
            ),
            correctionCapture,
          ),
          preferenceCapture,
        ),
        directive,
        eligible: true,
        reason: "contextual_continuation",
      };
    }
    if (preferenceCapture || correctionCapture) {
      return {
        consumed: false,
        context: appendPreferenceCapture(
          appendUserCorrectionCapture(
            appendPrivateLessonLifecycleRecovery(
              "Remembrance capture routing:",
              privateLessonRecovery,
            ),
            correctionCapture,
          ),
          preferenceCapture,
        ),
        eligible: Boolean(correctionCapture),
        reason: correctionCapture ? "user_correction" : "preference_capture",
      };
    }
    if (privateLessonRecovery) {
      return {
        consumed: false,
        context: privateLessonRecovery,
        eligible: false,
        reason: "private_lesson_lifecycle_recovery",
      };
    }
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }
  const payload = buildQueryPayload(
    redacted,
    env,
    options.identity,
    {
      surface: "plugin_hook",
      runtime: runtimeFromIdentity(options.identity),
      trigger_reason: decision.reason,
    },
    options.projectPath,
  );
  const response = await queryRemembrance(payload, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    stderr: options.stderr,
    userAgent: options.userAgent,
  });
  if (!response) {
    return {
      consumed: false,
      context: appendPreferenceCapture(
        appendUserCorrectionCapture(
          appendPrivateLessonLifecycleRecovery(
            includeSharedConfigCredentialNotice
              ? withSharedConfigCredentialNotice(
                  unavailableQueryContext(env),
                  env,
                )
              : unavailableQueryContext(env),
            privateLessonRecovery,
          ),
          correctionCapture,
        ),
        preferenceCapture,
      ),
      eligible: true,
      reason: "query_unavailable",
    };
  }
  return {
    consumed: true,
    matched: queryResponseHasMatches(response),
    context: appendPreferenceCapture(
      appendUserCorrectionCapture(
        appendPrivateLessonLifecycleRecovery(
          includeSharedConfigCredentialNotice
            ? withSharedConfigCredentialNotice(
                formatContext(response, decision.reason, limitFromEnv(env)) ??
                  emptyQueryContext(decision.reason),
                env,
              )
            : (formatContext(response, decision.reason, limitFromEnv(env)) ??
                emptyQueryContext(decision.reason)),
          privateLessonRecovery,
        ),
        correctionCapture,
      ),
      preferenceCapture,
    ),
    eligible: true,
    highMatch: highMatchFromResponse(response),
    queryFeedback: queryFeedbackTrackingFromResponse(response),
    valueEpisode: valueEpisodeFromResponse(response),
    reason: decision.reason,
  };
}

function appendPreferenceCapture(context, directive) {
  return directive ? `${context}\n\n${directive}` : context;
}

function appendUserCorrectionCapture(context, directive) {
  return directive ? `${context}\n\n${directive}` : context;
}

function appendPrivateLessonLifecycleRecovery(context, instruction) {
  return instruction ? `${context}\n\n${instruction}` : context;
}

export function queryResponseHasMatches(response) {
  const body = responseBodyFromToolResponse(response);
  const skills = Array.isArray(body?.skills)
    ? body.skills
        .filter((item) => publicSkillCandidateAllowed(body, item))
        .filter(autoQueryResponseCandidateAllowed)
    : [];
  const resources = Array.isArray(body?.resources)
    ? body.resources.filter(autoQueryResponseCandidateAllowed)
    : [];
  return skills.length > 0 || resources.length > 0;
}

function autoQueryResponseCandidateAllowed(candidate) {
  if (candidate?.applicability?.fit === "unlikely") return false;
  if (!candidate?.match_tier) return true;
  if (candidate?.match_tier === "high") return true;
  if (candidate?.match_tier !== "possible") return false;
  const lexical = candidate?.why_matched?.lexical_signal;
  const semantic = candidate?.why_matched?.semantic_signal;
  if (!lexical && !semantic) return true;
  return (
    lexical === "strong" ||
    semantic === "strong" ||
    (lexical === "moderate" &&
      semantic === "moderate" &&
      candidate?.why_matched?.domain_match === true)
  );
}

export function queryFeedbackTrackingFromResponse(response) {
  const body = responseBodyFromToolResponse(response);
  const queryFeedback = body?.query_feedback;
  const queryId =
    queryFeedback?.available === true
      ? completionIdentifier(queryFeedback.query_id ?? body?.query_id)
      : "";
  return queryId ? { available: true, query_id: queryId } : null;
}

function withSharedConfigCredentialNotice(context, env) {
  const notice = sharedConfigCredentialNotice(env);
  return notice ? `${notice}\n\n${context}` : context;
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
  /Remembrance auto-query context|mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource|invoke_skill)|\/api\/v1\/agent\/(?:query(?!-feedback)|skill-invocations)\b/gi;

const TASK_ELIGIBILITY_MARKERS =
  /Remembrance task-continuation reminder|Remembrance query-unavailable context/gi;

const CONTRIBUTION_SUBMITTED_PATTERNS = [
  /\brpub_[a-f0-9]{16,}\b/i,
  /\baccepted_private_candidate\b/i,
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

export function contributionReason(
  signal = null,
  highMatch = null,
  directSelection = null,
  options = {},
) {
  const signalLine = signal
    ? `High-value lesson detected: ${signal}. Capture this specific lesson unless it was already submitted. A lower-value earlier capture does not satisfy this obligation; compare it with the most valuable reusable lesson formed since.`
    : null;
  const highMatchLine = highMatch
    ? highMatchClosureInstruction(highMatch)
    : null;
  const directSelections = (
    Array.isArray(directSelection)
      ? directSelection
      : directSelection
        ? [directSelection]
        : []
  ).slice(0, DIRECT_SELECTION_MARKER_LIMIT);
  const privateLessonGuidance = options.privateLessonAuthorized
    ? privateLessonCompletionGuidance({
        includeLifecycleRecovery: options.includeLifecycleRecovery !== false,
        env: options.env,
      })
    : null;
  if (directSelections.length > 0) {
    const preferenceEvidenceLine =
      directPreferenceCompatibilityInstruction(directSelections);
    const selectionLines = directSelections.map((selection) => {
      const correlation =
        selection.query_id && selection.result_id
          ? ` Use query_id ${selection.query_id} and result_id ${selection.result_id}.`
          : "";
      return `- ${selection.slug}${selection.version ? ` version ${selection.version}` : ""}.${correlation}`;
    });
    return [
      directSelections.length === 1
        ? "Before finishing, silently close post-use Remembrance feedback for this explicitly selected Remembrance skill:"
        : `Before finishing, silently close post-use Remembrance feedback for these ${directSelections.length} Remembrance skills selected explicitly:`,
      ...selectionLines,
      signalLine,
      "Do not submit query-fit feedback for these selections; they were chosen directly rather than ranked for a query.",
      "Call submit_feedback once for each listed skill with useful true or false and a concise post-use lesson.",
      preferenceEvidenceLine,
      "If submit_feedback returns next_step.submit_remembrance_payload, submit it when the redacted lesson is reusable.",
      privateLessonGuidance,
      routineContributionVisibilityInstruction(),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Before finishing, silently close the pending Remembrance loop using this session's query/result IDs.",
    signalLine,
    highMatchLine,
    options.privateLessonAuthorized
      ? "Call submit_query_feedback for pending query fit and submit_feedback only for used results. Honor an exact next_step.submit_remembrance_payload returned by submit_feedback; route a compact organization evidence lesson through the private lesson lane below. If no skill fit and you built a complete reusable skill or playbook, default to propose_private_skill; use propose_skill_idea only when a public candidate is explicitly appropriate."
      : "Call submit_query_feedback for pending query fit, submit_feedback only for used results, and submit_remembrance only for a reusable redacted lesson. If no skill fit and you built a complete reusable skill or playbook, default to propose_private_skill; use propose_skill_idea only when a public candidate is explicitly appropriate. A supplied invalid/inactive key fails with 401 and an insufficient key with 403; neither creates a candidate.",
    privateLessonGuidance,
    routineContributionVisibilityInstruction(),
  ]
    .filter(Boolean)
    .join("\n");
}

function directPreferenceCompatibilityInstruction(selections) {
  const evidence = selections.flatMap((selection) =>
    selection?.query_id &&
    selection?.result_id &&
    selection?.version_id &&
    Array.isArray(selection.preference_feedback_settings) &&
    selection.preference_feedback_settings.length > 0
      ? [
          {
            query_id: safeText(selection.query_id, 160),
            result_id: safeText(selection.result_id, 160),
            skill_slug: safeText(selection.slug, 120),
            skill_version_id: safeText(selection.version_id, 160),
            preferences: sanitizeStoredPreferenceFeedbackSettings(
              selection.preference_feedback_settings,
            ),
          },
        ]
      : [],
  );
  return evidence.length > 0
    ? preferenceCompatibilityEvidenceInstruction(evidence)
    : null;
}

function routineContributionVisibilityInstruction() {
  return `Use Remembrance MCP tools when available; otherwise use this session's REST fallback, or emit REMEMBRANCE_SUBMISSION_PAYLOAD only if the API is unavailable. Never remove or bypass an organization key to force a public candidate. Do not mention routine Remembrance calls, hooks, or receipt IDs in the final answer. Surface only failures, host blocks, or required action. For a host block unrelated to a private-lesson submit/retry action, say exactly: "${HOST_POLICY_ALERT_TEXT}" and do not retry through another transport. Redact secrets and proprietary content.`;
}

export function privateLessonCompletionGuidance({
  includeLifecycleRecovery = true,
  env = process.env,
} = {}) {
  const recovery = includeLifecycleRecovery
    ? privateLessonLifecycleRecoveryInstruction(env)
    : null;
  return [
    "For a new compact failure, correction, or evidence lesson that is not already a complete skill, silently generalize it without raw repository content, then call prepare_private_lesson_candidate. If it returns next_action, immediately call submit_private_lesson_candidate with exactly its draft_id; do not substitute submit_remembrance, REST, or another transport.",
    "If the work produced a complete reusable procedure, playbook, or actionable instructions, follow the separate skill-proposal guidance instead; do not compress a finished skill into the private lesson contract.",
    "Let the host's exact submit_private_lesson_candidate approval be the only authorization prompt. If the host cannot present it, ask once: \"" +
      PRIVATE_LESSON_AUTHORIZATION_REQUEST_TEXT +
      '\"',
    `If the host denies the action, say exactly: "${PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT}" Do not retry that draft through another transport. Never auto-delete a draft.`,
    recovery,
  ]
    .filter(Boolean)
    .join("\n");
}

export function completionContinuationReason(reason, input = {}) {
  const priorAnswer = String(
    input?.last_assistant_message ??
      input?.lastAssistantMessage ??
      input?.assistant_message ??
      input?.message ??
      "",
  ).trim();
  const finalAnswerInstruction = priorAnswer
    ? "After the silent cleanup, preserve the task result: repeat your immediately preceding user-facing answer unchanged, preceded only by any Remembrance failure or required action that must be surfaced. Do not replace the task answer with hook, receipt, or Remembrance status text."
    : "After the silent cleanup, provide the task's normal user-facing final answer. Do not replace it with hook, receipt, or Remembrance status text.";
  return [String(reason ?? "").trim(), finalAnswerInstruction]
    .filter(Boolean)
    .join("\n");
}

export function taskClosureReason(signal = null, options = {}) {
  const signalLine = signal
    ? `High-value lesson detected: ${signal}. Capture this specific lesson unless it was already submitted. A lower-value earlier capture does not satisfy this obligation; compare it with the most valuable reusable lesson formed since.`
    : null;
  return [
    "Before finishing, silently recover the pending Remembrance query for this reusable task using the full conversation; no completed Remembrance query/use was recorded.",
    signalLine,
    "Call query_skills with a redacted full-context summary, evaluate the returned matches, then close any warranted submit_query_feedback, submit_feedback, or submit_remembrance action before responding.",
    options.privateLessonAuthorized
      ? privateLessonCompletionGuidance({ env: options.env })
      : null,
    routineContributionVisibilityInstruction(),
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

export function hostPolicyAlertWasReported(input) {
  const value = String(
    input?.last_assistant_message ??
      input?.lastAssistantMessage ??
      input?.assistant_message ??
      input?.message ??
      "",
  );
  return (
    value.includes(HOST_POLICY_ALERT_TEXT) ||
    value.includes(PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT)
  );
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
  if (hostPolicyAlertWasReported(input)) {
    return { allow: true, why: "host_policy_alert_reported" };
  }
  const sessionId = sessionIdFor(input);
  const readUse = options.readUseCount ?? readRegistryUseCount;
  const useCount = readUse(sessionId, env);
  const readEligible = options.readEligibilityCount ?? readTaskEligibilityCount;
  const eligibilityCount = readEligible(sessionId, env);
  const engagementCount = Math.max(useCount, eligibilityCount);
  const readPrompted = options.readPromptedCount ?? readPromptedCount;
  const promptedCount = readPrompted(sessionId, env);
  const readObligations =
    options.readCompletionObligations ?? readCompletionObligations;
  const unpromptedObligations = readObligations(sessionId, env).filter(
    (obligation) => !obligation.prompted_at,
  );
  const highValueSignal = detectHighValueLessonSignal(input);
  if (unpromptedObligations.length > 0 && !highValueSignal) {
    return {
      allow: false,
      why: "prompt_pending_obligations",
      reason: completionObligationInstruction(unpromptedObligations),
      useCount: Math.max(
        engagementCount,
        ...unpromptedObligations.map(
          (obligation) => obligation.engagement_count,
        ),
      ),
      obligationIds: unpromptedObligations.map((obligation) => obligation.id),
    };
  }
  const readHighMatch = options.readHighMatch ?? readHighMatchSurface;
  const highMatch = readHighMatch(sessionId, env);
  const directSelections = options.readDirectSelections
    ? options.readDirectSelections(sessionId, env)
    : options.readDirectSelection
      ? [options.readDirectSelection(sessionId, env)].filter(Boolean)
      : readDirectSelectionSurfaces(sessionId, env);
  const newDirectSelections = directSelections.filter(
    (selection) => !selection?.prompted_at,
  );
  const feedbackDirectSelections = newDirectSelections.filter(
    (selection) => selection.feedback_available !== false,
  );
  const hasUnclosedEligibility =
    eligibilityCount > useCount && newDirectSelections.length === 0;
  const privateLessonAuthorized = organizationPrivateLessonAuthorized(env);
  const privateLessonRecovery = privateLessonAuthorized
    ? privateLessonLifecycleRecoveryInstruction(env)
    : null;
  if (
    newDirectSelections.length > 0 &&
    feedbackDirectSelections.length === 0 &&
    !privateLessonRecovery &&
    unpromptedObligations.length === 0
  ) {
    return { allow: true, why: "direct_feedback_unavailable" };
  }
  if (
    engagementCount === 0 &&
    !highValueSignal &&
    !privateLessonRecovery &&
    unpromptedObligations.length === 0
  ) {
    return { allow: true, why: "registry_not_used" };
  }
  if (
    privateLessonRecovery &&
    promptedCount > 0 &&
    engagementCount <= promptedCount &&
    !highValueSignal &&
    unpromptedObligations.length === 0
  ) {
    return { allow: true, why: "no_new_usage" };
  }
  if (
    engagementCount <= promptedCount &&
    newDirectSelections.length === 0 &&
    !highValueSignal &&
    !privateLessonRecovery &&
    unpromptedObligations.length === 0
  ) {
    return { allow: true, why: "no_new_usage" };
  }
  if (
    highValueSignal &&
    promptedCount > 0 &&
    engagementCount <= promptedCount &&
    unpromptedObligations.length === 0
  ) {
    return { allow: true, why: "high_value_lesson_already_prompted" };
  }
  return {
    allow: false,
    why: highValueSignal
      ? "prompt_high_value_lesson_contribution"
      : hasUnclosedEligibility
        ? "prompt_task_closure"
        : privateLessonRecovery && engagementCount === 0
          ? "prompt_private_lesson_retry"
          : "prompt_contribution",
    reason: [
      unpromptedObligations.length > 0
        ? completionObligationInstruction(unpromptedObligations)
        : null,
      privateLessonRecovery && engagementCount === 0 && !highValueSignal
        ? [
            privateLessonRecovery,
            routineContributionVisibilityInstruction(),
          ].join("\n")
        : hasUnclosedEligibility
          ? taskClosureReason(highValueSignal, {
              env,
              privateLessonAuthorized,
            })
          : contributionReason(
              highValueSignal,
              highMatch,
              feedbackDirectSelections.length > 0
                ? feedbackDirectSelections
                : null,
              {
                env,
                privateLessonAuthorized,
                includeLifecycleRecovery: true,
              },
            ),
    ]
      .filter(Boolean)
      .join("\n"),
    useCount:
      highValueSignal || privateLessonRecovery
        ? Math.max(engagementCount, promptedCount + 1, 1)
        : engagementCount,
    obligationIds: unpromptedObligations.map((obligation) => obligation.id),
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
// Per-session counters and bounded state markers live under a private,
// per-user os.tmpdir()/remembrance-usage-<owner>/<hash> directory:
//   <hash>.use     — incremented every time the query adapter completes a query.
//   <hash>.eligible — records that a reusable task should be closed out even if
//                     no query result was consumed.
//   <hash>.prompt  — the use count at which the stop adapter last prompted.
//   <hash>.high-match.json — latest high result until its exact detail opens.
//   <hash>.obligations/*.json — content-free query/feedback/lesson actions,
//                               each closed only by its correlated tool call.
// The stop adapter compares max(.use, .eligible) with .prompt, then records the
// new engagement count. This reproduces the Claude hook's sentinel behavior
// without retaining a transcript.

const USAGE_DIR = "remembrance-usage";

function localUsageOwnerId() {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }
  return `home-${createHash("sha256")
    .update(homedir())
    .digest("hex")
    .slice(0, 16)}`;
}

function usageDir(env = process.env) {
  return env?.REMEMBRANCE_USAGE_DIR
    ? String(env.REMEMBRANCE_USAGE_DIR)
    : join(tmpdir(), `${USAGE_DIR}-${localUsageOwnerId()}`);
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

function directSelectionPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.direct-skill.json`);
}

function directivePath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.directive.json`);
}

function completionObligationDir(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.obligations`);
}

function completionObligationPath(sessionId, obligationId, env) {
  const hash = createHash("sha256")
    .update(String(obligationId), "utf8")
    .digest("hex")
    .slice(0, 32);
  return join(completionObligationDir(sessionId, env), `${hash}.json`);
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

function writePrivateUsageMarker(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(temporaryPath, String(value), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only; marker persistence must remain fail-open.
    }
    return false;
  }
}

function writeCountFile(path, count) {
  return writePrivateUsageMarker(path, String(count));
}

function currentEngagementCount(sessionId, env = process.env) {
  return Math.max(
    readRegistryUseCount(sessionId, env),
    readTaskEligibilityCount(sessionId, env),
  );
}

function completionObligationId(kind, parts) {
  return [kind, ...parts.map((part) => completionIdentifier(part))].join(":");
}

function completionIdentifier(value, maxLength = 160) {
  const text = String(value ?? "").trim();
  return text ? safeText(text, maxLength) : "";
}

function normalizeCompletionObligation(value) {
  if (
    !value ||
    value.version !== COMPLETION_OBLIGATION_VERSION ||
    ![
      "query_feedback",
      "post_use_feedback",
      "remembrance_followup",
      "private_lesson",
    ].includes(value.kind) ||
    typeof value.id !== "string" ||
    !value.id ||
    !Number.isInteger(value.engagement_count) ||
    value.engagement_count < 1
  ) {
    return null;
  }
  const createdAt = Date.parse(String(value.created_at ?? ""));
  const promptedAt = value.prompted_at
    ? Date.parse(String(value.prompted_at))
    : null;
  if (!Number.isFinite(createdAt)) return null;
  return {
    version: COMPLETION_OBLIGATION_VERSION,
    id: safeText(value.id, 420),
    kind: value.kind,
    engagement_count: Math.min(1_000_000, value.engagement_count),
    query_id: value.query_id ? safeText(value.query_id, 160) : null,
    result_id: value.result_id ? safeText(value.result_id, 160) : null,
    draft_id: value.draft_id ? safeText(value.draft_id, 160) : null,
    skill_slug: value.skill_slug ? safeText(value.skill_slug, 160) : null,
    payload_digest:
      typeof value.payload_digest === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(value.payload_digest)
        ? value.payload_digest
        : null,
    created_at: new Date(createdAt).toISOString(),
    prompted_at:
      promptedAt !== null && Number.isFinite(promptedAt)
        ? new Date(promptedAt).toISOString()
        : null,
  };
}

export function readCompletionObligations(sessionId, env = process.env) {
  const directory = completionObligationDir(sessionId, env);
  try {
    const now = Date.now();
    const obligations = [];
    for (const name of readdirSync(directory).sort().slice(0, 256)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024) {
          continue;
        }
        const obligation = normalizeCompletionObligation(
          JSON.parse(readFileSync(path, "utf8")),
        );
        if (!obligation) continue;
        if (
          Date.parse(obligation.created_at) + COMPLETION_OBLIGATION_TTL_MS <
          now
        ) {
          rmSync(path, { force: true });
          continue;
        }
        obligations.push(obligation);
      } catch {
        // One malformed marker must not hide other pending work.
      }
    }
    return obligations
      .sort(
        (left, right) =>
          Date.parse(left.created_at) - Date.parse(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, COMPLETION_OBLIGATION_LIMIT);
  } catch {
    return [];
  }
}

function writeCompletionObligation(sessionId, obligation, env) {
  const normalized = normalizeCompletionObligation(obligation);
  if (!normalized) return null;
  const existing = readCompletionObligations(sessionId, env);
  if (
    !existing.some((item) => item.id === normalized.id) &&
    existing.length >= COMPLETION_OBLIGATION_LIMIT
  ) {
    return null;
  }
  return writePrivateUsageMarker(
    completionObligationPath(sessionId, normalized.id, env),
    `${JSON.stringify(normalized)}\n`,
  )
    ? normalized
    : null;
}

function addCompletionObligation(
  sessionId,
  obligation,
  env = process.env,
) {
  const existing = readCompletionObligations(sessionId, env).find(
    (item) => item.id === obligation.id,
  );
  return writeCompletionObligation(
    sessionId,
    {
      version: COMPLETION_OBLIGATION_VERSION,
      ...obligation,
      created_at: existing?.created_at ?? new Date().toISOString(),
      prompted_at: existing?.prompted_at ?? null,
    },
    env,
  );
}

function removeCompletionObligations(sessionId, predicate, env) {
  const removed = [];
  for (const obligation of readCompletionObligations(sessionId, env)) {
    if (!predicate(obligation)) continue;
    try {
      rmSync(completionObligationPath(sessionId, obligation.id, env), {
        force: true,
      });
      removed.push(obligation);
    } catch {
      // Fail open: a retained marker can cause one reminder, never data loss.
    }
  }
  return removed;
}

function normalizedCompletionToolName(toolName) {
  const normalized = String(toolName ?? "").trim().toLowerCase();
  for (const candidate of [
    "query_skills",
    "get_skill",
    "get_resource",
    "invoke_skill",
    "prepare_private_lesson_candidate",
    "submit_private_lesson_candidate",
    "retry_private_lesson_candidate",
    "submit_query_feedback",
    "submit_feedback",
    "submit_remembrance",
    "propose_skill_idea",
    "propose_private_skill",
    "submit_suggestion",
    "submit_resource",
    "submit_resource_review",
  ]) {
    if (normalized.endsWith(candidate)) return candidate;
  }
  return normalized;
}

function completionPayloadDigest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  try {
    const normalized = JSON.parse(JSON.stringify(payload));
    delete normalized.verified_attestation;
    return `sha256:${createHash("sha256")
      .update(canonicalHookJson(normalized), "utf8")
      .digest("hex")}`;
  } catch {
    // Host SDK payloads should be JSON, but observation must never break a turn.
    return null;
  }
}

export function recordQueryFeedbackObligation(
  sessionId,
  response,
  env = process.env,
  engagementCount = currentEngagementCount(sessionId, env),
) {
  const tracking =
    response?.available === true && response?.query_id
      ? response
      : queryFeedbackTrackingFromResponse(response);
  const queryId = completionIdentifier(tracking?.query_id);
  if (!queryId) return null;
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("query_feedback", [queryId]),
      kind: "query_feedback",
      engagement_count: Math.max(1, engagementCount),
      query_id: queryId,
    },
    env,
  );
}

export function recordPostUseFeedbackObligation(
  sessionId,
  {
    query_id: queryId,
    result_id: resultId,
    skill_slug: skillSlug = null,
    feedback_available: feedbackAvailable = true,
  } = {},
  env = process.env,
  engagementCount = currentEngagementCount(sessionId, env),
) {
  const query = completionIdentifier(queryId);
  const result = completionIdentifier(resultId);
  if (!feedbackAvailable || !query || !result) return null;
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("post_use_feedback", [query, result]),
      kind: "post_use_feedback",
      engagement_count: Math.max(1, engagementCount),
      query_id: query,
      result_id: result,
      skill_slug: skillSlug ? safeText(skillSlug, 160) : null,
    },
    env,
  );
}

export function recordPrivateLessonObligation(
  sessionId,
  response,
  env = process.env,
  engagementCount = currentEngagementCount(sessionId, env),
) {
  const body = responseBodyFromToolResponse(response);
  const draftId = completionIdentifier(body?.draft_id);
  if (!/^pld_[A-Za-z0-9_-]{8,96}$/.test(draftId)) return null;
  if (["submitted", "superseded_redactor"].includes(body?.state)) return null;
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("private_lesson", [draftId]),
      kind: "private_lesson",
      engagement_count: Math.max(1, engagementCount),
      draft_id: draftId,
    },
    env,
  );
}

function recordRemembranceFollowupObligation(
  sessionId,
  response,
  fallback,
  env,
  engagementCount,
) {
  const payload =
    responseBodyFromToolResponse(response)?.next_step
      ?.submit_remembrance_payload;
  const digest = completionPayloadDigest(payload);
  if (!digest) return null;
  const queryId = completionIdentifier(
    payload?.interaction?.query_id ?? fallback?.query_id,
  );
  const resultId = completionIdentifier(
    payload?.interaction?.result_id ?? fallback?.result_id,
  );
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("remembrance_followup", [digest]),
      kind: "remembrance_followup",
      engagement_count: Math.max(1, engagementCount),
      query_id: queryId || null,
      result_id: resultId || null,
      payload_digest: digest,
    },
    env,
  );
}

function markEngagementHandledWhenClear(sessionId, env) {
  const count = currentEngagementCount(sessionId, env);
  const hasPending = readCompletionObligations(sessionId, env).length > 0;
  if (!hasPending && count > 0) {
    writePromptedCount(sessionId, count, env);
  }
  return { count, hasPending };
}

export function observeSuccessfulCompletionTool(
  sessionId,
  toolName,
  args = {},
  response = null,
  env = process.env,
) {
  const tool = normalizedCompletionToolName(toolName);
  const input =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const engagementCount = currentEngagementCount(sessionId, env);
  const opened = [];
  let closed = [];

  if (tool === "query_skills") {
    const obligation = recordQueryFeedbackObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (tool === "invoke_skill") {
    const selection = directSelectionFromResponse(response);
    const obligation = selection
      ? recordPostUseFeedbackObligation(
          sessionId,
          {
            query_id: selection.query_id,
            result_id: selection.result_id,
            skill_slug: selection.slug,
            feedback_available: selection.feedback_available,
          },
          env,
          engagementCount,
        )
      : null;
    if (obligation) opened.push(obligation);
  } else if (tool === "get_skill" || tool === "get_resource") {
    const obligation = recordPostUseFeedbackObligation(
      sessionId,
      {
        query_id: input.query_id,
        result_id: input.result_id,
        skill_slug: input.slug,
      },
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (tool === "prepare_private_lesson_candidate") {
    const obligation = recordPrivateLessonObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (tool === "submit_query_feedback") {
    const queryId = completionIdentifier(input.query_id);
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "query_feedback" &&
        Boolean(queryId) &&
        obligation.query_id === queryId,
      env,
    );
  } else if (tool === "submit_feedback") {
    const queryId = completionIdentifier(input.query_id);
    const resultId = completionIdentifier(input.result_id);
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "post_use_feedback" &&
        Boolean(queryId) &&
        Boolean(resultId) &&
        obligation.query_id === queryId &&
        obligation.result_id === resultId,
      env,
    );
    const followup = recordRemembranceFollowupObligation(
      sessionId,
      response,
      input,
      env,
      engagementCount,
    );
    if (followup) opened.push(followup);
  } else if (tool === "submit_remembrance") {
    const digest = completionPayloadDigest(input);
    const queryId = completionIdentifier(input?.interaction?.query_id);
    const resultId = completionIdentifier(input?.interaction?.result_id);
    const pendingFollowups = readCompletionObligations(sessionId, env).filter(
      (obligation) => obligation.kind === "remembrance_followup",
    );
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "remembrance_followup" &&
        ((digest && obligation.payload_digest === digest) ||
          (queryId &&
            resultId &&
            obligation.query_id === queryId &&
            obligation.result_id === resultId) ||
          (!queryId && !resultId && pendingFollowups.length === 1)),
      env,
    );
  } else if (
    tool === "submit_private_lesson_candidate" ||
    tool === "retry_private_lesson_candidate"
  ) {
    const body = responseBodyFromToolResponse(response);
    const draftId = completionIdentifier(input.draft_id ?? body?.draft_id);
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "private_lesson" &&
        Boolean(draftId) &&
        obligation.draft_id === draftId,
      env,
    );
  }

  const handled = COMPLETION_CONTRIBUTION_TOOLS.has(tool)
    ? markEngagementHandledWhenClear(sessionId, env)
    : {
        count: engagementCount,
        hasPending: readCompletionObligations(sessionId, env).length > 0,
      };
  return {
    tool,
    opened,
    closed,
    pending: readCompletionObligations(sessionId, env),
    handled_count: handled.hasPending ? 0 : handled.count,
  };
}

export function markCompletionObligationsPrompted(
  sessionId,
  obligationIds = null,
  env = process.env,
  engagementCount = Number.POSITIVE_INFINITY,
) {
  const ids = Array.isArray(obligationIds) ? new Set(obligationIds) : null;
  let marked = 0;
  for (const obligation of readCompletionObligations(sessionId, env)) {
    if (
      obligation.prompted_at ||
      obligation.engagement_count > engagementCount ||
      (ids && !ids.has(obligation.id))
    ) {
      continue;
    }
    if (
      writeCompletionObligation(
        sessionId,
        { ...obligation, prompted_at: new Date().toISOString() },
        env,
      )
    ) {
      marked += 1;
    }
  }
  return marked;
}

function completionObligationInstruction(obligations) {
  const lines = obligations.slice(0, 12).map((obligation) => {
    if (obligation.kind === "query_feedback") {
      return `- Query fit: call submit_query_feedback for query_id ${obligation.query_id}.`;
    }
    if (obligation.kind === "post_use_feedback") {
      return `- Post-use feedback${obligation.skill_slug ? ` for ${obligation.skill_slug}` : ""}: call submit_feedback with query_id ${obligation.query_id} and result_id ${obligation.result_id}.`;
    }
    if (obligation.kind === "remembrance_followup") {
      return "- Reusable evidence: submit the exact next_step.submit_remembrance_payload returned by the preceding feedback call.";
    }
    return `- Private lesson: call submit_private_lesson_candidate with draft_id ${obligation.draft_id}.`;
  });
  if (obligations.length > lines.length) {
    lines.push(`- ${obligations.length - lines.length} additional pending action(s) remain in this session.`);
  }
  return [
    "Before finishing, silently complete only these pending Remembrance actions:",
    ...lines,
    "Do not mention routine hook, tool, or receipt output. Surface only a failure or required user action.",
  ].join("\n");
}

// Increment (and return) the per-session registry-use counter. Prompt and tool
// adapters call this only after an authorized registry match or explicit skill
// invocation. A legitimate empty query remains eligible for completion recovery
// without inflating registry-use counts. Fail-open on filesystem errors.
export function recordRegistryUse(sessionId, env = process.env) {
  const path = usePath(sessionId, env);
  const next = readCountFile(path) + 1;
  writeCountFile(path, next);
  return next;
}

export function markCurrentEngagementHandled(sessionId, env = process.env) {
  const count = Math.max(
    readRegistryUseCount(sessionId, env),
    readTaskEligibilityCount(sessionId, env),
  );
  if (count > 0 && readCompletionObligations(sessionId, env).length === 0) {
    writePromptedCount(sessionId, count, env);
  }
  return count;
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
    return writePrivateUsageMarker(
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

export function responseBodyFromToolResponse(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return responseBodyFromToolResponse(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const body = responseBodyFromToolResponse(item, depth + 1);
      if (body) return body;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (
    typeof value.query_id === "string" ||
    typeof value.draft_id === "string" ||
    value.selection_mode === "explicit" ||
    (value.next_step && typeof value.next_step === "object") ||
    Array.isArray(value.skills) ||
    Array.isArray(value.resources)
  ) {
    return value;
  }
  if (value.type === "text" && typeof value.text === "string") {
    const body = responseBodyFromToolResponse(value.text, depth + 1);
    if (body) return body;
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
    const body = responseBodyFromToolResponse(value[key], depth + 1);
    if (body) return body;
  }
  return null;
}

export function responseRequestsRemembranceFollowup(response) {
  const payload =
    responseBodyFromToolResponse(response)?.next_step
      ?.submit_remembrance_payload;
  return Boolean(
    payload && typeof payload === "object" && !Array.isArray(payload),
  );
}

export function toolResponseIndicatesFailure(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      return toolResponseIndicatesFailure(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((item) => toolResponseIndicatesFailure(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  if (
    value.ok === false ||
    value.isError === true ||
    value.is_error === true ||
    value.status === "not_submitted" ||
    value.status === "held_safety" ||
    (typeof value.status === "number" && value.status >= 400)
  ) {
    return true;
  }
  if (value.type === "text" && typeof value.text === "string") {
    return toolResponseIndicatesFailure(value.text, depth + 1);
  }
  for (const key of [
    "result",
    "output",
    "response",
    "tool_response",
    "toolResponse",
    "content",
  ]) {
    if (toolResponseIndicatesFailure(value[key], depth + 1)) return true;
  }
  return false;
}

export function directSelectionFromResponse(response) {
  const body = responseBodyFromToolResponse(response);
  const skill = body?.skill;
  if (
    body?.selection_mode !== "explicit" ||
    !skill ||
    typeof skill.slug !== "string" ||
    !skill.slug.trim() ||
    typeof skill.skill_md !== "string" ||
    !skill.skill_md.trim()
  ) {
    return null;
  }
  const preferenceEvidence =
    preferenceCompatibilityEvidenceFromResponse(body)[0] ?? null;
  return {
    invocation_id:
      typeof body.invocation_id === "string"
        ? safeText(body.invocation_id, 80)
        : null,
    query_id:
      typeof body.query_id === "string" ? safeText(body.query_id, 80) : null,
    result_id:
      typeof body.result_id === "string" ? safeText(body.result_id, 80) : null,
    slug: safeText(skill.slug, 120),
    version:
      skill.version === null || skill.version === undefined
        ? null
        : safeText(skill.version, 80),
    version_id:
      typeof skill.version_id === "string"
        ? safeText(skill.version_id, 80)
        : null,
    source:
      typeof skill.source === "string" ? safeText(skill.source, 40) : null,
    feedback_available: body?.feedback?.available === true,
    task_outcome_available: body?.task_outcome?.available === true,
    preference_feedback_settings:
      preferenceEvidence?.skill_version_id === skill.version_id
        ? preferenceEvidence.preferences
        : [],
    used_at: new Date().toISOString(),
  };
}

export function recordDirectSelectionSurface(
  sessionId,
  selection,
  env = process.env,
) {
  const path = directSelectionPath(sessionId, env);
  try {
    if (!selection) {
      rmSync(path, { force: true });
      return true;
    }
    const normalized = normalizeDirectSelectionSurface(
      selection,
      sessionId,
      env,
    );
    const records = readDirectSelectionSurfaces(sessionId, env).filter(
      (item) =>
        !normalized.query_id ||
        !normalized.result_id ||
        item.query_id !== normalized.query_id ||
        item.result_id !== normalized.result_id,
    );
    records.push(normalized);
    return writeDirectSelectionSurfaces(sessionId, records, env);
  } catch {
    return false;
  }
}

export function readDirectSelectionSurfaces(sessionId, env = process.env) {
  try {
    const parsed = JSON.parse(
      readFileSync(directSelectionPath(sessionId, env), "utf8"),
    );
    const records = (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => normalizeStoredDirectSelectionSurface(item))
      .filter(Boolean)
      .filter(
        (item) =>
          Date.parse(item.used_at) + DIRECT_SELECTION_MARKER_TTL_MS >=
          Date.now(),
      )
      .slice(-DIRECT_SELECTION_MARKER_LIMIT);
    if (records.length === 0) {
      rmSync(directSelectionPath(sessionId, env), { force: true });
    }
    return records;
  } catch {
    return [];
  }
}

export function readDirectSelectionSurface(sessionId, env = process.env) {
  return readDirectSelectionSurfaces(sessionId, env).at(-1) ?? null;
}

function normalizeDirectSelectionSurface(selection, sessionId, env) {
  return {
    invocation_id: selection.invocation_id
      ? safeText(selection.invocation_id, 80)
      : null,
    query_id: selection.query_id ? safeText(selection.query_id, 80) : null,
    result_id: selection.result_id ? safeText(selection.result_id, 80) : null,
    slug: safeText(selection.slug, 120),
    version: selection.version ? safeText(selection.version, 80) : null,
    version_id: selection.version_id
      ? safeText(selection.version_id, 80)
      : null,
    source: selection.source ? safeText(selection.source, 40) : null,
    feedback_available: selection.feedback_available === true,
    task_outcome_available: selection.task_outcome_available === true,
    preference_feedback_settings: sanitizeStoredPreferenceFeedbackSettings(
      selection.preference_feedback_settings,
    ),
    prompted_at: selection.prompted_at
      ? safeText(selection.prompted_at, 40)
      : null,
    use_count: Number.isFinite(selection.use_count)
      ? Math.max(0, Math.round(selection.use_count))
      : readRegistryUseCount(sessionId, env),
    used_at: safeText(selection.used_at ?? new Date().toISOString(), 40),
  };
}

function normalizeStoredDirectSelectionSurface(selection) {
  const usedAt = Date.parse(String(selection?.used_at ?? ""));
  if (!selection?.slug || !Number.isFinite(usedAt)) return null;
  return {
    invocation_id: selection.invocation_id
      ? safeText(selection.invocation_id, 80)
      : null,
    query_id: selection.query_id ? safeText(selection.query_id, 80) : null,
    result_id: selection.result_id ? safeText(selection.result_id, 80) : null,
    slug: safeText(selection.slug, 120),
    version: selection.version ? safeText(selection.version, 80) : null,
    version_id: selection.version_id
      ? safeText(selection.version_id, 80)
      : null,
    source: selection.source ? safeText(selection.source, 40) : null,
    feedback_available: selection.feedback_available === true,
    task_outcome_available: selection.task_outcome_available === true,
    preference_feedback_settings: sanitizeStoredPreferenceFeedbackSettings(
      selection.preference_feedback_settings,
    ),
    prompted_at: selection.prompted_at
      ? safeText(selection.prompted_at, 40)
      : null,
    use_count: Number.isFinite(selection.use_count)
      ? Math.max(0, Math.round(selection.use_count))
      : 0,
    used_at: new Date(usedAt).toISOString(),
  };
}

function sanitizeStoredPreferenceFeedbackSettings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const fingerprint =
        typeof entry?.preference_fingerprint === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(entry.preference_fingerprint)
          ? entry.preference_fingerprint
          : null;
      const setting = entry?.setting;
      if (!fingerprint || !setting || typeof setting !== "object") return [];
      const key = safePreferenceIdentifier(setting?.key, 96);
      const preferenceValue = safePreferenceIdentifier(setting?.value, 96);
      if (!key || !preferenceValue) return [];
      const normalized = { key, value: preferenceValue };
      if (
        typeof setting?.label === "string" &&
        setting.label.trim() &&
        typeof setting?.behavior === "string" &&
        setting.behavior.trim() &&
        ["presentation", "workflow", "strategy_selection"].includes(
          setting.effect,
        ) &&
        ["prefer", "avoid"].includes(setting.strength) &&
        Number.isInteger(setting.definition_version) &&
        setting.definition_version >= 1 &&
        setting.definition_version <= 1_000_000
      ) {
        Object.assign(normalized, {
          label: safeText(setting.label, 96),
          behavior: safeText(setting.behavior, 320),
          effect: setting.effect,
          strength: setting.strength,
          definition_version: setting.definition_version,
        });
      }
      return [{ preference_fingerprint: fingerprint, setting: normalized }];
    })
    .slice(0, PREFERENCE_EVIDENCE_SETTING_LIMIT);
}

function writeDirectSelectionSurfaces(sessionId, records, env) {
  try {
    const path = directSelectionPath(sessionId, env);
    return writePrivateUsageMarker(
      path,
      JSON.stringify(records.slice(-DIRECT_SELECTION_MARKER_LIMIT)),
    );
  } catch {
    return false;
  }
}

export function markDirectSelectionSurfacesPrompted(
  sessionId,
  useCount,
  env = process.env,
) {
  const records = readDirectSelectionSurfaces(sessionId, env);
  const now = new Date().toISOString();
  let changed = false;
  for (const selection of records) {
    if (
      !selection.prompted_at &&
      Number.isFinite(selection.use_count) &&
      selection.use_count <= useCount
    ) {
      selection.prompted_at = now;
      changed = true;
    }
  }
  return changed
    ? writeDirectSelectionSurfaces(sessionId, records, env)
    : false;
}

export function clearHighMatchSurfaceForExplicitSelection(
  sessionId,
  slug,
  env = process.env,
) {
  const match = readHighMatchSurface(sessionId, env);
  if (!match || match.target_type !== "skill" || match.slug !== String(slug)) {
    return false;
  }
  return recordHighMatchSurface(sessionId, null, env);
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
    return writePrivateUsageMarker(
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
  if (
    normalizedTool.endsWith("submit_private_lesson_candidate") ||
    normalizedTool.endsWith("retry_private_lesson_candidate")
  ) {
    // The PostToolUse adapter calls this function only after a successful tool
    // response. Clear the content-free denial suppression so future retained
    // drafts can resume normal lifecycle recovery after exact-action approval.
    clearPrivateLessonHostPolicyDenials(env);
    return false;
  }
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
  const body = responseBodyFromToolResponse(response);
  const queryId = body?.query_id ?? body?.query_feedback?.query_id;
  if (!queryId || body?.task_outcome?.available !== true) return null;
  const eligibleResultIds = new Set(
    Array.isArray(body?.task_outcome?.eligible_result_ids)
      ? body.task_outcome.eligible_result_ids.map((id) => String(id))
      : [],
  );
  if (eligibleResultIds.size === 0) return null;
  const directSelection = body?.selection_mode === "explicit";
  const candidates = [
    ...(directSelection && body?.skill
      ? [
          {
            ...body.skill,
            result_id: body.result_id,
            task_outcome_eligible:
              body.skill.task_outcome_eligible === true &&
              body?.task_outcome?.eligible_result_ids?.includes(body.result_id),
          },
        ]
      : []),
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
  const bundles = (Array.isArray(body?.skill_bundles) ? body.skill_bundles : [])
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
      result_ids: bundle.result_ids.slice(0, 3).map((id) => safeText(id, 80)),
      value_estimate_id: bundle.value_estimate_id
        ? safeText(bundle.value_estimate_id, 80)
        : null,
    }));
  return {
    query_id: safeText(queryId, 80),
    interaction_kind: directSelection ? "direct_selection" : "query",
    candidates,
    bundles,
    selected_result_ids:
      directSelection && candidates[0]?.result_id
        ? [candidates[0].result_id]
        : [],
    feedback_available: directSelection
      ? body?.feedback?.available === true
      : true,
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
        interaction_kind:
          item.interaction_kind === "direct_selection"
            ? "direct_selection"
            : "query",
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
                ? bundle.result_ids.slice(0, 3).map((id) => safeText(id, 80))
                : [],
              value_estimate_id: bundle?.value_estimate_id
                ? safeText(bundle.value_estimate_id, 80)
                : null,
            }))
          : [],
        selected_result_ids: Array.isArray(item.selected_result_ids)
          ? item.selected_result_ids.slice(0, 3).map((id) => safeText(id, 80))
          : [],
        feedback_available: item.feedback_available !== false,
        created_at: safeText(item.created_at ?? "", 40),
        reported_at: item.reported_at ? safeText(item.reported_at, 40) : null,
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
  if (
    !record ||
    !record.candidates.some((item) => item.result_id === resultId)
  ) {
    return false;
  }
  record.selected_result_ids = [
    ...new Set([...record.selected_result_ids, resultId]),
  ].slice(0, 3);
  return writeValueEpisodeSurfaces(sessionId, records, env);
}

export async function reportTaskOutcomesOnStop(sessionId, input, options = {}) {
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
      (bundle) => [...bundle.result_ids].sort().join("\u0000") === selectedKey,
    );
    const estimateId = selectedBundle?.value_estimate_id
      ? selectedBundle.value_estimate_id
      : selected.length === 1
        ? episode.candidates.find((item) => item.result_id === selected[0])
            ?.value_estimate_id
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
  const timeout = setTimeout(() => controller.abort(), autoQueryTimeoutMs(env));
  try {
    const access = resolveApiAccessSnapshot(env);
    const credential = access.credential;
    if (isUnusableConfigurationSource(credential.source)) return false;
    const headers = {
      "content-type": "application/json",
      "user-agent": clientUserAgent(options.userAgent),
    };
    const apiKey = credential.apiKey;
    if (apiKey) headers["x-remembrance-api-key"] = apiKey;
    const principalSession = readHookPrincipalSession(
      normalizeRuntime(env.REMEMBRANCE_PLUGIN_HOST),
      env,
      access,
    );
    if (principalSession?.token) {
      headers["x-remembrance-principal-session"] = principalSession.token;
    }
    const response = await (options.fetchImpl ?? fetch)(
      `${access.apiConfiguration.apiUrl}/api/v1/agent/task-outcomes`,
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
    return writePrivateUsageMarker(
      path,
      JSON.stringify(records.slice(-VALUE_EPISODE_MARKER_LIMIT)),
    );
  } catch {
    return false;
  }
}

function tokenUsageFromRuntime(input) {
  const usage =
    input?.token_usage ??
    input?.tokenUsage ??
    input?.usage ??
    input?.model_usage;
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
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
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
  const written = writeCountFile(promptPath(sessionId, env), count);
  if (written) {
    markDirectSelectionSurfacesPrompted(sessionId, count, env);
    markCompletionObligationsPrompted(sessionId, null, env, count);
  }
  return written;
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

function organizationPrivateLessonAuthorized(env = process.env) {
  if (contributeDisabled(env?.REMEMBRANCE_AUTO_CONTRIBUTE)) return false;
  const credential = resolveApiCredential(env);
  return Boolean(
    credential.apiKey && !isUnusableConfigurationSource(credential.source),
  );
}

function privateLessonOutboxDirectoryForHook(env = process.env) {
  const stateRoot = String(env?.XDG_STATE_HOME ?? "").trim();
  return join(
    stateRoot || join(homedir(), ".local", "state"),
    "remembrance",
    "private-lessons",
  );
}

export function readPrivateLessonLifecycleState(env = process.env) {
  if (!organizationPrivateLessonAuthorized(env)) return null;
  const directory = privateLessonOutboxDirectoryForHook(env);
  try {
    const directoryMetadata = lstatSync(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      (isPosixHookRuntime() && (directoryMetadata.mode & 0o077) !== 0)
    ) {
      return null;
    }
    assertCurrentHookUser(directoryMetadata.uid);
    const entries = readdirSync(directory, { withFileTypes: true });
    const counts = {
      ready: 0,
      retry_scheduled: 0,
      hold_telemetry_pending: 0,
      hold_telemetry_retry_scheduled: 0,
    };
    for (const entry of entries) {
      if (!entry.name.endsWith(".lesson.json")) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) return null;
      const expectedDraftId = entry.name.slice(0, -".lesson.json".length);
      if (!/^pld_[A-Za-z0-9_-]{8,96}$/.test(expectedDraftId)) return null;
      const parsed = JSON.parse(
        readSecureHookFile(
          join(directory, entry.name),
          MAX_PRIVATE_LESSON_ENVELOPE_BYTES,
        ),
      );
      if (
        parsed?.version !== "private-lesson-outbox-envelope-v1" ||
        parsed?.draft_id !== expectedDraftId ||
        ![
          "ready",
          "awaiting_authorization",
          "retry_scheduled",
          "held_safety",
          "submitted",
          "superseded_redactor",
        ].includes(parsed?.state) ||
        ![
          "not_required",
          "pending",
          "awaiting_authorization",
          "retry_scheduled",
          "submitted",
          "disabled",
        ].includes(parsed?.hold_telemetry_status)
      ) {
        return null;
      }
      if (parsed.state === "ready" || parsed.state === "retry_scheduled") {
        counts[parsed.state] += 1;
      }
      if (
        privateLessonHealthReportingEnabledForHook(env) &&
        parsed.state === "held_safety" &&
        parsed.hold_telemetry_status === "pending"
      ) {
        counts.hold_telemetry_pending += 1;
      }
      if (
        privateLessonHealthReportingEnabledForHook(env) &&
        parsed.state === "held_safety" &&
        parsed.hold_telemetry_status === "retry_scheduled"
      ) {
        counts.hold_telemetry_retry_scheduled += 1;
      }
    }
    if (Object.values(counts).every((count) => count === 0)) return null;
    return {
      ...counts,
      host_denial_active: recentPrivateLessonHostDenial(env),
    };
  } catch {
    return null;
  }
}

export function privateLessonLifecycleRecoveryInstruction(env = process.env) {
  const state = readPrivateLessonLifecycleState(env);
  if (!state || state.host_denial_active) return null;
  const pending =
    state.ready +
    state.retry_scheduled +
    state.hold_telemetry_pending +
    state.hold_telemetry_retry_scheduled;
  return [
    `Private lesson lifecycle recovery: ${pending} retained local draft${pending === 1 ? " needs" : "s need"} attention. Silently call inspect_private_lesson_outbox.`,
    "Call submit_private_lesson_candidate for each ready candidate or safety-held draft with pending content-free telemetry. Call retry_private_lesson_candidate only when the candidate or telemetry retry is due.",
    "Do not retry awaiting_authorization, disabled telemetry, submitted telemetry, or superseded-redactor drafts; do not use another transport, and never delete an unresolved draft automatically. Verified submissions compact automatically and their content-free markers expire after 14 days. Hide routine results.",
  ].join("\n");
}

function privateLessonHealthReportingEnabledForHook(env = process.env) {
  return !/^(0|false|no)$/i.test(
    String(env?.REMEMBRANCE_HEALTH_REPORTING ?? "").trim(),
  );
}

function pluginHealthDir(env = process.env) {
  if (env?.REMEMBRANCE_PLUGIN_HEALTH_DIR) {
    return String(env.REMEMBRANCE_PLUGIN_HEALTH_DIR);
  }
  // Hook adapters are exercised directly by several Vitest suites. Keep those
  // observations out of the real user health directory even when a test passes
  // a deliberately minimal env object that omits Vitest's process variables.
  if (process.env.VITEST) {
    return join(
      tmpdir(),
      "remembrance-plugin-health-tests",
      String(process.pid),
    );
  }
  return join(homedir(), ".cache", "remembrance", "plugin-health");
}

function pluginAlertDir(env = process.env) {
  if (env?.REMEMBRANCE_PLUGIN_ALERT_DIR) {
    return String(env.REMEMBRANCE_PLUGIN_ALERT_DIR);
  }
  if (process.env.VITEST) {
    return join(
      tmpdir(),
      "remembrance-plugin-alert-tests",
      String(process.pid),
    );
  }
  return join(homedir(), ".cache", "remembrance", "plugin-alerts");
}

function clientUpdateDir(env = process.env) {
  if (env?.REMEMBRANCE_CLIENT_UPDATE_DIR) {
    return String(env.REMEMBRANCE_CLIENT_UPDATE_DIR);
  }
  if (process.env.VITEST) {
    return join(
      tmpdir(),
      "remembrance-client-update-tests",
      String(process.pid),
    );
  }
  return join(homedir(), ".cache", "remembrance", "client-updates");
}

function principalSessionDir(env = process.env) {
  if (env?.REMEMBRANCE_PRINCIPAL_SESSION_DIR) {
    return String(env.REMEMBRANCE_PRINCIPAL_SESSION_DIR);
  }
  if (process.env.VITEST) {
    return join(
      tmpdir(),
      "remembrance-principal-session-tests",
      String(process.pid),
    );
  }
  return join(homedir(), ".cache", "remembrance", "principal-sessions");
}

function agentIdentityPath(env = process.env) {
  return (
    String(env.REMEMBRANCE_AGENT_KEY_PATH ?? "").trim() ||
    join(join(homedir(), ".config"), "remembrance", "agent-key.json")
  );
}

function readHookIdentity(env = process.env) {
  try {
    const parsed = JSON.parse(
      readSecureHookFile(agentIdentityPath(env), MAX_LOCAL_CONFIG_BYTES),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !["other", "codex", "cursor", "claude_code"].includes(parsed.provider) ||
      typeof parsed.key_id !== "string" ||
      !parsed.key_id ||
      typeof parsed.subject !== "string" ||
      !parsed.subject ||
      typeof parsed.public_key !== "string" ||
      !parsed.public_key ||
      typeof parsed.private_key !== "string" ||
      !parsed.private_key
    ) {
      return null;
    }
    createPrivateKey(parsed.private_key);
    return parsed;
  } catch {
    return null;
  }
}

function localIdentityProvider(runtime) {
  const normalized = normalizeRuntime(runtime);
  return ["codex", "cursor", "claude_code"].includes(normalized)
    ? normalized
    : "other";
}

function createHookIdentity(runtime, env = process.env) {
  const path = agentIdentityPath(env);
  const existing = readHookIdentity(env);
  if (existing) return existing;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = String(
      publicKey.export({ type: "spki", format: "pem" }),
    );
    const keyId = `tofu_${createHash("sha256")
      .update(publicKeyPem)
      .digest("hex")
      .slice(0, 24)}`;
    const identity = {
      provider: localIdentityProvider(runtime),
      subject: `local:${keyId}`,
      key_id: keyId,
      public_key: publicKeyPem,
      private_key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
      created_at: new Date().toISOString(),
    };
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return identity;
  } catch {
    return readHookIdentity(env);
  }
}

function canonicalHookJson(value) {
  const sort = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(sort);
    if (candidate && typeof candidate === "object") {
      return Object.keys(candidate)
        .sort()
        .reduce((result, key) => {
          result[key] = sort(candidate[key]);
          return result;
        }, {});
    }
    return candidate;
  };
  return JSON.stringify(sort(value));
}

async function registerHookIdentity(identity, fetchImpl, access, signal) {
  let ownerBinding = null;
  try {
    const bindingResponse = await fetchImpl(
      `${access.apiConfiguration.apiUrl}/api/v1/agent/keys/register`,
      {
        method: "GET",
        headers: principalRequestHeaders(access),
        signal,
      },
    );
    if (bindingResponse?.ok) {
      const bindingPayload = await bindingResponse.json();
      const candidate = String(bindingPayload?.owner_binding ?? "").trim();
      if (/^areg_[A-Za-z0-9_-]{24,120}$/.test(candidate)) {
        ownerBinding = candidate;
      }
    }
  } catch {
    // Registration remains fail-open; an existing same-scope key can still use
    // the legacy proof while new organization claims require the binding.
  }
  if (signal.aborted) return false;
  const signedAt = new Date().toISOString();
  const publicKeyHash = `sha256:${createHash("sha256")
    .update(identity.public_key)
    .digest("hex")}`;
  const signingPayload = canonicalHookJson({
    version: ownerBinding ? "v2" : "v1",
    purpose: "remembrance-agent-key-registration",
    provider: identity.provider,
    key_id: identity.key_id,
    ...(ownerBinding ? { owner_binding: ownerBinding } : {}),
    public_key_hash: publicKeyHash,
    subject: identity.subject,
    signed_at: signedAt,
  });
  const signature = signPayload(
    null,
    Buffer.from(signingPayload),
    createPrivateKey(identity.private_key),
  ).toString("base64url");
  const response = await fetchImpl(
    `${access.apiConfiguration.apiUrl}/api/v1/agent/keys/register`,
    {
      method: "POST",
      headers: principalRequestHeaders(access),
      body: JSON.stringify({
        provider: identity.provider,
        key_id: identity.key_id,
        public_key: identity.public_key,
        subject: identity.subject,
        proof: {
          algorithm: "ed25519",
          ...(ownerBinding ? { owner_binding: ownerBinding } : {}),
          signed_at: signedAt,
          signature,
        },
        metadata: { registered_by: "remembrance-plugin-hook" },
      }),
      signal,
    },
  );
  return !signal.aborted && response?.ok === true;
}

function principalSessionCachePath(
  runtime,
  keyId,
  env = process.env,
  access = resolveApiAccessSnapshot(env),
) {
  const credentialFingerprint = createHash("sha256")
    .update(
      [access.credential.source, access.credential.apiKey].join(":"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  const digest = createHash("sha256")
    .update(
      [
        access.apiConfiguration.apiUrl,
        credentialFingerprint,
        normalizeRuntime(runtime),
        String(keyId),
      ].join(":"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return join(principalSessionDir(env), `${digest}.json`);
}

export function readHookPrincipalSession(
  runtime,
  env = process.env,
  access = resolveApiAccessSnapshot(env),
) {
  const identity = readHookIdentity(env);
  if (!identity) return null;
  try {
    const parsed = JSON.parse(
      readSecureHookFile(
        principalSessionCachePath(runtime, identity.key_id, env, access),
        MAX_LOCAL_PRINCIPAL_SESSION_BYTES,
      ),
    );
    if (
      typeof parsed?.token !== "string" ||
      !/^psess_[A-Za-z0-9_-]{24,160}$/.test(parsed.token) ||
      !Number.isFinite(Date.parse(parsed.expires_at ?? "")) ||
      Date.parse(parsed.expires_at) <= Date.now() + 60_000
    ) {
      return null;
    }
    return {
      token: parsed.token,
      expires_at: parsed.expires_at,
      member_linked: parsed.member_linked === true,
    };
  } catch {
    return null;
  }
}

export function clearHookPrincipalSession(
  runtime,
  env = process.env,
  access = resolveApiAccessSnapshot(env),
) {
  const identity = readHookIdentity(env);
  if (!identity) return false;
  try {
    rmSync(principalSessionCachePath(runtime, identity.key_id, env, access), {
      force: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function warmPrincipalSession(
  {
    runtime,
    hostSurface = null,
    clientVersion = null,
    hostVersion = null,
    fetchImpl = fetch,
    apiAccess = null,
  },
  env = process.env,
) {
  // Same pause-don't-downgrade rule the query, directive-event, and task-outcome
  // paths enforce. It has to live HERE, not in the callers: every host adapter
  // warms the principal session at session start, so a per-caller guard is one
  // that six adapters can each forget.
  //
  // principalRequestHeaders() already withholds the API key when the source is
  // unusable, which is only half a guard: the request would still go out, and
  // apiUrl() hands back DEFAULT_API_URL while merely flagging the source, so an
  // unreadable config would register the agent key anonymously against the
  // default registry instead of the destination that config was naming. The
  // principal-session challenge also carries a member link token, so suppressing
  // the request — not just the header — is what keeps a secret from reaching a
  // destination the user never chose.
  const access = apiAccess ?? resolveApiAccessSnapshot(env);
  const credential = access.credential;
  if (
    isUnusableConfigurationSource(access.apiConfiguration.source) ||
    isUnusableConfigurationSource(credential.source)
  ) {
    debugLog(env, "shared_config_unusable", {});
    return null;
  }
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedHostSurface = runtimeHostSurface(
    normalizedRuntime,
    env,
    hostSurface,
  );
  const identity =
    readHookIdentity(env) ?? createHookIdentity(normalizedRuntime, env);
  if (!identity) return null;
  const cached = readHookPrincipalSession(normalizedRuntime, env, access);
  if (cached) return cached;
  const warmupKey = principalSessionCachePath(
    normalizedRuntime,
    identity.key_id,
    env,
    access,
  );
  const activeWarmup = principalSessionWarmups.get(warmupKey);
  if (activeWarmup) return activeWarmup;
  const warmup = warmPrincipalSessionUncached(
    {
      normalizedRuntime,
      normalizedHostSurface,
      clientVersion,
      hostVersion,
      fetchImpl,
      identity,
      warmupKey,
      apiAccess: access,
    },
    env,
  );
  principalSessionWarmups.set(warmupKey, warmup);
  try {
    return await warmup;
  } finally {
    if (principalSessionWarmups.get(warmupKey) === warmup) {
      principalSessionWarmups.delete(warmupKey);
    }
  }
}

async function warmPrincipalSessionUncached(
  {
    normalizedRuntime,
    normalizedHostSurface,
    clientVersion,
    hostVersion,
    fetchImpl,
    identity,
    warmupKey,
    apiAccess,
  },
  env,
) {
  const controller = new AbortController();
  const operation = (async () => {
    try {
      if (
        !(await registerHookIdentity(
          identity,
          fetchImpl,
          apiAccess,
          controller.signal,
        ))
      ) {
        return null;
      }
      if (controller.signal.aborted) return null;
      const memberLinkToken = apiAccess.memberLinkToken;
      const profileKey = createHash("sha256")
        .update(
          [
            identity.key_id,
            normalizedRuntime,
            normalizedHostSurface,
            "plugin_hook",
          ].join(":"),
          "utf8",
        )
        .digest("base64url");
      const challengePayload = {
        action: "challenge",
        provider: identity.provider,
        key_id: identity.key_id,
        runtime_profile: {
          runtime: normalizedRuntime,
          surface: "plugin_hook",
          host_surface: normalizedHostSurface,
          client_name: runtimeDisplayName(normalizedRuntime),
          client_version: safeText(clientVersion ?? "unknown", 64),
          runtime_version: safeText(hostVersion ?? "", 64) || null,
          profile_key: `rpf_${profileKey}`,
        },
        ...(memberLinkToken ? { member_link_token: memberLinkToken } : {}),
      };
      let challenge = await postPrincipalSession(
        challengePayload,
        fetchImpl,
        apiAccess,
        controller.signal,
      );
      if (!challenge && memberLinkToken) {
        challenge = await postPrincipalSession(
          { ...challengePayload, member_link_token: undefined },
          fetchImpl,
          apiAccess,
          controller.signal,
        );
      }
      if (controller.signal.aborted) return null;
      if (!challenge?.challenge_id || !challenge?.signing_payload) return null;
      const signature = signPayload(
        null,
        Buffer.from(challenge.signing_payload),
        createPrivateKey(identity.private_key),
      ).toString("base64url");
      const session = await postPrincipalSession(
        {
          action: "exchange",
          provider: identity.provider,
          key_id: identity.key_id,
          challenge_id: challenge.challenge_id,
          signature,
        },
        fetchImpl,
        apiAccess,
        controller.signal,
      );
      if (controller.signal.aborted) return null;
      if (!session?.session_token || !session?.expires_at) return null;
      const stored = {
        token: session.session_token,
        expires_at: session.expires_at,
        member_linked: session.member_linked === true,
      };
      writeHookPrincipalSession(warmupKey, stored);
      return stored;
    } catch {
      return null;
    }
  })();
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, PRINCIPAL_SESSION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

async function postPrincipalSession(payload, fetchImpl, access, signal) {
  const response = await fetchImpl(
    `${access.apiConfiguration.apiUrl}/api/v1/agent/principal-sessions`,
    {
      method: "POST",
      headers: principalRequestHeaders(access),
      body: JSON.stringify(payload),
      signal,
    },
  );
  return response?.ok ? response.json() : null;
}

function principalRequestHeaders(access) {
  const headers = {
    "content-type": "application/json",
    "user-agent": clientUserAgent(),
  };
  const credential = access.credential;
  if (credential.apiKey && !isUnusableConfigurationSource(credential.source)) {
    headers["x-remembrance-api-key"] = credential.apiKey;
  }
  return headers;
}

function writeHookPrincipalSession(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Principal sessions are optional and always fail open for retrieval.
    }
    return false;
  }
}

function runtimeDisplayName(runtime) {
  return (
    {
      codex: "Codex",
      claude_code: "Claude Code",
      cursor: "Cursor",
      openclaw: "OpenClaw",
      vs_code: "VS Code",
      opencode: "opencode",
    }[runtime] ?? "Agent"
  );
}

function sanitizeEffectivePreferences(value) {
  return sanitizeEffectivePreferenceEntries(value).map((item) => item.text);
}

function sanitizeEffectivePreferenceEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.key === "string" &&
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(item.key) &&
        typeof item.value === "string" &&
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(item.value) &&
        EFFECTIVE_PREFERENCE_SOURCES.has(item.source) &&
        ["presentation", "workflow", "strategy_selection"].includes(
          item.effect ?? "presentation",
        ) &&
        ["prefer", "avoid"].includes(item.strength ?? "prefer"),
    )
    .slice(0, 32)
    .map((item) => {
      const label = safeText(item.label ?? item.key, 96);
      const behavior = safeText(item.behavior ?? item.value, 320);
      const direction = item.strength === "avoid" ? "avoid" : "prefer";
      const authority =
        item.source === "mandatory_org" ? "required organization" : item.source;
      return {
        mandatory: item.source === "mandatory_org",
        key: safeText(item.key, 48),
        value: safeText(item.value, 48),
        behavior,
        text: `${label} [${safeText(item.effect ?? "presentation", 24)}, ${safeText(authority ?? "preference", 32)}]: ${direction} ${behavior}`,
      };
    });
}

function effectivePreferencesContextLines(value) {
  const entries = sanitizeEffectivePreferenceEntries(value).sort(
    (left, right) => Number(right.mandatory) - Number(left.mandatory),
  );
  if (entries.length === 0) return [];
  const mandatory = entries.filter((entry) => entry.mandatory);
  const discretionary = entries.filter((entry) => !entry.mandatory);
  const mandatoryLine = mandatoryPreferenceContextLine(mandatory);
  const discretionaryLine = discretionaryPreferenceContextLine(discretionary);
  return [mandatoryLine, discretionaryLine].filter(Boolean);
}

function mandatoryPreferenceContextLine(entries) {
  if (entries.length === 0) return null;
  const prefix = "Required organization settings (apply all): ";
  const suffix =
    ". These remain authoritative and cannot be weakened by task or personal preferences.";
  const separators = Math.max(0, entries.length - 1) * 2;
  const perEntryBudget = Math.max(
    48,
    Math.floor(
      (MAX_MANDATORY_PREFERENCE_CONTEXT_CHARS -
        prefix.length -
        suffix.length -
        separators) /
        entries.length,
    ),
  );
  const body = entries
    .map((entry) =>
      safeText(
        `${entry.key}=${entry.value}: ${entry.behavior}`,
        perEntryBudget,
      ),
    )
    .join("; ");
  return `${prefix}${body}${suffix}`;
}

function discretionaryPreferenceContextLine(entries) {
  if (entries.length === 0) return null;
  const prefix = "Apply these persisted discretionary preferences silently: ";
  const suffix =
    ". Do not ask the user to reconfirm them. Current-task instructions may override these preferences. Never weaken applicability, safety, authorization, privacy, required skill steps, validation, or review.";
  const budget = Math.max(
    0,
    MAX_PREFERENCE_CONTEXT_CHARS - prefix.length - suffix.length,
  );
  const selected = [];
  let used = 0;
  for (const entry of entries) {
    const separator = selected.length > 0 ? "; " : "";
    if (used + separator.length + entry.text.length > budget) break;
    selected.push(entry);
    used += separator.length + entry.text.length;
  }
  const omitted = entries.slice(selected.length);
  let body = selected.map((entry) => entry.text).join("; ");
  if (omitted.length > 0) {
    const note = `; +${omitted.length} discretionary preference${omitted.length === 1 ? "" : "s"} omitted. Call get_effective_preferences when the omitted choices could affect the task`;
    while (selected.length > 0 && body.length + note.length > budget) {
      selected.pop();
      body = selected.map((entry) => entry.text).join("; ");
    }
    body = `${body || "Preferences available"}${note}`;
  }
  return safeText(`${prefix}${body}${suffix}`, MAX_PREFERENCE_CONTEXT_CHARS);
}

function clientUpdatePath(surface, env = process.env) {
  const normalized = normalizedPluginHealthSurface(surface);
  return normalized ? join(clientUpdateDir(env), `${normalized}.json`) : null;
}

export async function checkForClientUpdate(
  {
    surface,
    currentVersion,
    fetchImpl = fetch,
    now = Date.now(),
    timeoutMs = CLIENT_UPDATE_TIMEOUT_MS,
  },
  env = process.env,
) {
  const normalizedSurface = normalizedPluginHealthSurface(surface);
  if (
    !normalizedSurface ||
    disabled(env.REMEMBRANCE_CLIENT_UPDATE_CHECK) ||
    !parseStableClientVersion(currentVersion)
  ) {
    return null;
  }
  const configuration = resolveApiConfiguration(env);
  if (isUnusableConfigurationSource(configuration.source)) return null;
  const path = clientUpdatePath(normalizedSurface, env);
  let manifest = readCachedClientRelease(path, now);
  if (!manifest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${configuration.apiUrl.replace(/\/+$/, "")}/.well-known/remembrance-client-release.json`,
        {
          headers: { accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!response?.ok) return null;
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_LOCAL_CLIENT_UPDATE_BYTES) {
        return null;
      }
      try {
        manifest = parseClientReleaseManifest(JSON.parse(text));
      } catch {
        return null;
      }
      if (!manifest) return null;
      writeCachedClientRelease(path, manifest, now);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const release = clientSurfaceRelease(manifest, normalizedSurface);
  if (
    !release ||
    compareStableClientVersions(release.version, currentVersion) <= 0
  ) {
    return null;
  }
  const guidance = CLIENT_UPDATE_GUIDANCE[normalizedSurface];
  if (!guidance) return null;
  const command = guidance.command
    ? `\nTrusted update command bundled with this installed client:\n${guidance.command}`
    : "";
  return {
    current_version: currentVersion,
    latest_version: release.version,
    surface: normalizedSurface,
    notice: [
      `Remembrance update available: installed ${currentVersion}, published ${release.version}.`,
      guidance.update,
      command,
      guidance.restart,
      "Do not claim the new version is active until a fresh process reports it.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function readCachedClientRelease(path, now) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(
      readSecureHookFile(path, MAX_LOCAL_CLIENT_UPDATE_BYTES),
    );
    if (
      parsed?.schema_version !== 1 ||
      !Number.isFinite(parsed?.checked_at) ||
      parsed.checked_at > now + 5 * 60 * 1000 ||
      parsed.checked_at + CLIENT_UPDATE_CACHE_TTL_MS <= now
    ) {
      return null;
    }
    return parseClientReleaseManifest(parsed.manifest);
  } catch {
    return null;
  }
}

function writeCachedClientRelease(path, manifest, now) {
  if (!path) return false;
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ schema_version: 1, checked_at: now, manifest })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Update checks are advisory and never break the host lifecycle.
    }
    return false;
  }
}

function parseClientReleaseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema_version !== "1") return null;
  if (!parseStableClientVersion(value.latest_version)) return null;
  if (
    typeof value.published_at !== "string" ||
    !isCanonicalClientReleaseTimestamp(value.published_at) ||
    !Array.isArray(value.surfaces)
  ) {
    return null;
  }
  const surfaces = value.surfaces.filter(
    (item) =>
      typeof item === "string" && CLIENT_RELEASE_MANIFEST_SURFACES.has(item),
  );
  if (
    surfaces.length !== value.surfaces.length ||
    new Set(surfaces).size !== surfaces.length
  ) {
    return null;
  }
  const surfaceReleases = parseClientSurfaceReleases(value.surface_releases);
  if (value.surface_releases !== undefined && !surfaceReleases) return null;
  if (surfaceReleases) {
    const entries = Object.entries(surfaceReleases);
    if (entries.length === 0) return null;
    const newestVersion = entries.reduce(
      (latest, [, release]) =>
        compareStableClientVersions(release.version, latest) > 0
          ? release.version
          : latest,
      entries[0][1].version,
    );
    const newestSurfaces = entries
      .filter(([, release]) => release.version === newestVersion)
      .map(([surface]) => surface);
    if (
      newestVersion !== value.latest_version ||
      newestSurfaces.length !== surfaces.length ||
      newestSurfaces.some((surface) => !surfaces.includes(surface))
    ) {
      return null;
    }
  }
  return {
    schema_version: "1",
    latest_version: value.latest_version,
    published_at: new Date(value.published_at).toISOString(),
    surfaces,
    ...(surfaceReleases ? { surface_releases: surfaceReleases } : {}),
  };
}

function parseClientSurfaceReleases(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([surface, release]) =>
        !CLIENT_RELEASE_MANIFEST_SURFACES.has(surface) ||
        !release ||
        typeof release !== "object" ||
        Array.isArray(release) ||
        Object.keys(release).some(
          (key) => key !== "version" && key !== "published_at",
        ) ||
        !parseStableClientVersion(release.version) ||
        typeof release.published_at !== "string" ||
        !isCanonicalClientReleaseTimestamp(release.published_at),
    )
  ) {
    return null;
  }
  return Object.fromEntries(
    entries.map(([surface, release]) => [
      surface,
      {
        version: release.version,
        published_at: new Date(release.published_at).toISOString(),
      },
    ]),
  );
}

function clientSurfaceRelease(manifest, surface) {
  const exact = manifest.surface_releases?.[surface];
  if (exact) return exact;
  return manifest.surfaces.includes(surface)
    ? {
        version: manifest.latest_version,
        published_at: manifest.published_at,
      }
    : null;
}

function isCanonicalClientReleaseTimestamp(value) {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function parseStableClientVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    String(value ?? ""),
  );
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(
    (part) => Number.isSafeInteger(part) && part >= 0 && part <= 9_999,
  )
    ? parts
    : null;
}

function compareStableClientVersions(left, right) {
  const leftParts = parseStableClientVersion(left);
  const rightParts = parseStableClientVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function pluginAlertSessionPath(surface, sessionId, env = process.env) {
  const normalized = normalizedPluginHealthSurface(surface);
  if (!normalized) return null;
  const hash = createHash("sha256")
    .update(String(sessionId ?? "unknown"), "utf8")
    .digest("hex")
    .slice(0, 24);
  return join(pluginAlertDir(env), `${normalized}.${hash}.json`);
}

function hostPolicyOperationClass(toolName) {
  const normalized = String(toolName ?? "").toLowerCase();
  if (
    normalized.endsWith("submit_private_lesson_candidate") ||
    normalized.endsWith("retry_private_lesson_candidate")
  ) {
    return "private_lesson";
  }
  if (
    normalized.endsWith("query_skills") ||
    normalized.endsWith("list_skills") ||
    normalized.endsWith("get_skill") ||
    normalized.endsWith("get_resource") ||
    normalized.endsWith("invoke_skill") ||
    normalized.endsWith("get_effective_preferences") ||
    normalized.endsWith("get_private_lesson_policy") ||
    normalized.endsWith("inspect_private_lesson_outbox") ||
    normalized.endsWith("run_connection_doctor") ||
    normalized.endsWith("get_connection_status")
  ) {
    return "query";
  }
  if (
    normalized.endsWith("prepare_private_lesson_candidate") ||
    normalized.endsWith("delete_private_lesson_candidate") ||
    normalized.endsWith("propose_private_skill") ||
    normalized.endsWith("queue_private_skill_import")
  ) {
    return "private_contribution";
  }
  if (
    normalized.endsWith("propose_skill_idea") ||
    normalized.endsWith("submit_remembrance") ||
    normalized.endsWith("submit_suggestion") ||
    normalized.endsWith("submit_resource") ||
    normalized.endsWith("submit_resource_review")
  ) {
    return "contribution";
  }
  if (
    normalized.endsWith("submit_query_feedback") ||
    normalized.endsWith("submit_feedback") ||
    normalized.endsWith("submit_preference_compatibility_feedback") ||
    normalized.endsWith("record_preference") ||
    normalized.endsWith("report_task_outcome")
  ) {
    return "feedback";
  }
  return "other";
}

function isRemembranceToolName(toolName) {
  const normalized = String(toolName ?? "").toLowerCase();
  return (
    normalized.includes("remembrance") ||
    [
      "run_connection_doctor",
      "get_connection_status",
      "query_skills",
      "list_skills",
      "get_skill",
      "get_resource",
      "invoke_skill",
      "get_value_proof",
      "get_effective_preferences",
      "get_private_lesson_policy",
      "prepare_private_lesson_candidate",
      "inspect_private_lesson_outbox",
      "submit_private_lesson_candidate",
      "retry_private_lesson_candidate",
      "delete_private_lesson_candidate",
      "record_preference",
      "submit_preference_compatibility_feedback",
      "link_current_installation",
      "report_task_outcome",
      "submit_query_feedback",
      "submit_feedback",
      "submit_remembrance",
      "propose_skill_idea",
      "propose_private_skill",
      "queue_private_skill_import",
      "submit_suggestion",
      "submit_resource",
      "submit_resource_review",
    ].some((candidate) => normalized.endsWith(candidate))
  );
}

function boundedHostPolicyText(value, depth = 0) {
  if (depth > 3 || value == null) return "";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((item) => boundedHostPolicyText(item, depth + 1))
      .join(" ")
      .slice(0, 4_000);
  }
  if (typeof value !== "object") return "";
  return [
    value.message,
    value.reason,
    value.permission_decision_reason,
    value.permissionDecisionReason,
    value.decision,
    value.response,
    value.error,
    value.detail,
    value.details,
    value.output,
    value.result,
    value.tool_response,
    value.toolResponse,
    value.properties?.error,
    value.properties?.message,
    value.properties?.reason,
  ]
    .map((item) => boundedHostPolicyText(item, depth + 1))
    .filter(Boolean)
    .join(" ")
    .slice(0, 4_000);
}

export function classifyHostPolicyDenial({
  eventType = "",
  toolName = "",
  value = null,
} = {}) {
  if (!isRemembranceToolName(toolName)) return null;
  const text = boundedHostPolicyText(value);
  const denied =
    /\b(?:block(?:ed|ing)?|den(?:y|ied|ial)|disallow(?:ed)?|prohibit(?:ed)?|not permitted|permission refused|cannot (?:send|share|export)|may not (?:send|share|export))\b/i.test(
      text,
    );
  const policyContext =
    /\b(?:host|tenant|workspace|organization|administrator|admin|privacy|security|policy|data[- ](?:export|egress|loss prevention)|dlp|external service|trusted service)\b/i.test(
      text,
    );
  const normalizedEvent = String(eventType ?? "").toLowerCase();
  const permissionEvent = normalizedEvent.includes("permission");
  const explicitPreTransportContext =
    /\b(?:host(?:ed)?|tenant|workspace)\s+(?:(?:privacy|security|execution|tool|mcp|data[- ](?:export|egress))\s+)?policy\b|\b(?:privacy|security|data[- ](?:export|egress|loss prevention)|dlp)\s+(?:guard|policy|rule|restriction)\b|\bbefore\s+(?:contacting|reaching|calling|sending\s+(?:it\s+)?to)\s+(?:remembrance|the\s+(?:mcp|external service)|an?\s+external service)\b|\b(?:external|trusted)\s+service\b/i.test(
      text,
    );
  // A host permission event is itself pre-transport evidence. Generic failed
  // tool events need an explicit host/export signal so a Remembrance API 403
  // such as an organization-policy refusal is never mislabeled as host policy.
  if (
    !denied ||
    !policyContext ||
    (!permissionEvent && !explicitPreTransportContext)
  ) {
    return null;
  }
  return {
    denial_class: permissionEvent
      ? "host_permission_policy"
      : "host_execution_policy",
    operation_class: hostPolicyOperationClass(toolName),
    before_mcp: permissionEvent ? "yes" : "unknown",
  };
}

function readPluginAlertState(surface, sessionId, env = process.env) {
  const path = pluginAlertSessionPath(surface, sessionId, env);
  if (!path) return null;
  try {
    const parsed = JSON.parse(
      readSecureHookFile(path, MAX_LOCAL_PLUGIN_ALERT_BYTES),
    );
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed?.observations)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePluginAlertState(surface, sessionId, state, env = process.env) {
  const path = pluginAlertSessionPath(surface, sessionId, env);
  if (!path) return false;
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    prunePluginAlertFiles(path, env);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Local policy observations are advisory and must never break the host.
    }
    return false;
  }
}

function prunePluginAlertFiles(keepPath, env) {
  const directory = pluginAlertDir(env);
  const cutoff = Date.now() - PLUGIN_ALERT_TTL_MS;
  try {
    const candidates = readdirSync(directory)
      .filter((name) => /^[a-z_]+\.[a-f0-9]{24}\.json$/.test(name))
      .map((name) => {
        const path = join(directory, name);
        return { path, modified: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates) {
      if (
        candidate.path !== keepPath &&
        (candidate.modified < cutoff ||
          candidates.indexOf(candidate) >= PLUGIN_ALERT_LIMIT)
      ) {
        rmSync(candidate.path, { force: true });
      }
    }
  } catch {
    // Pruning is advisory.
  }
}

function recentPrivateLessonHostDenial(env = process.env) {
  const directory = pluginAlertDir(env);
  if (!existsSync(directory)) return false;
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > PLUGIN_ALERT_LIMIT) return true;
    const cutoff = Date.now() - PLUGIN_ALERT_TTL_MS;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[a-z_]+\.[a-f0-9]{24}\.json$/.test(entry.name)
      ) {
        continue;
      }
      const parsed = JSON.parse(
        readSecureHookFile(
          join(directory, entry.name),
          MAX_LOCAL_PLUGIN_ALERT_BYTES,
        ),
      );
      if (
        Array.isArray(parsed?.observations) &&
        parsed.observations.some(
          (item) =>
            item?.operation_class === "private_lesson" &&
            Number.isFinite(Date.parse(item?.last_seen_at ?? "")) &&
            Date.parse(item.last_seen_at) >= cutoff,
        )
      ) {
        return true;
      }
    }
  } catch {
    // An unreadable or malformed alert store cannot prove that retrying is
    // authorized. Keep retained private lessons local until the state is
    // repaired or the exact action is invoked explicitly.
    return true;
  }
  return false;
}

export function clearPrivateLessonHostPolicyDenials(env = process.env) {
  const directory = pluginAlertDir(env);
  let changed = false;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[a-z_]+\.[a-f0-9]{24}\.json$/.test(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      const parsed = JSON.parse(
        readSecureHookFile(path, MAX_LOCAL_PLUGIN_ALERT_BYTES),
      );
      if (!Array.isArray(parsed?.observations)) continue;
      const observations = parsed.observations.filter(
        (item) => item?.operation_class !== "private_lesson",
      );
      if (observations.length === parsed.observations.length) continue;
      changed = true;
      if (observations.length === 0) {
        rmSync(path, { force: true });
      } else {
        writePrivateUsageMarker(
          path,
          `${JSON.stringify({
            ...parsed,
            observations,
            updated_at: new Date().toISOString(),
          })}\n`,
        );
      }
    }
  } catch {
    return false;
  }
  return changed;
}

export function hostPolicyAlertTextForOperation(operationClass) {
  return operationClass === "private_lesson"
    ? PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT
    : HOST_POLICY_ALERT_TEXT;
}

export function recordHostPolicyDenial(
  {
    surface,
    sessionId,
    eventType = "",
    toolName = "",
    value = null,
    pluginVersion = null,
    hostVersion = null,
  },
  env = process.env,
) {
  const normalizedSurface = normalizedPluginHealthSurface(surface);
  const classification = classifyHostPolicyDenial({
    eventType,
    toolName,
    value,
  });
  if (!normalizedSurface || !classification) return null;
  const now = new Date().toISOString();
  const sessionHash = createHash("sha256")
    .update(String(sessionId ?? "unknown"), "utf8")
    .digest("hex")
    .slice(0, 24);
  const id = createHash("sha256")
    .update(
      [
        normalizedSurface,
        sessionHash,
        classification.operation_class,
        classification.denial_class,
      ].join(":"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  const existing = readPluginAlertState(normalizedSurface, sessionId, env);
  const current = existing?.observations?.find((item) => item?.id === id);
  const observation = {
    id,
    denial_class: classification.denial_class,
    operation_class: classification.operation_class,
    before_mcp: classification.before_mcp,
    plugin_version: safeText(pluginVersion ?? "", 64),
    host_version: safeText(hostVersion ?? "", 64),
    first_seen_at: current?.first_seen_at ?? now,
    last_seen_at: now,
    count: Math.min(999, Math.max(0, Number(current?.count) || 0) + 1),
    alerted_at: current?.alerted_at ?? null,
  };
  const observations = [
    observation,
    ...(existing?.observations ?? []).filter((item) => item?.id !== id),
  ]
    .filter((item) => {
      const seenAt = Date.parse(item?.last_seen_at ?? "");
      return (
        Number.isFinite(seenAt) && Date.now() - seenAt <= PLUGIN_ALERT_TTL_MS
      );
    })
    .slice(0, 12);
  const state = {
    schema_version: 1,
    surface: normalizedSurface,
    session_hash: sessionHash,
    observations,
    updated_at: now,
  };
  return writePluginAlertState(normalizedSurface, sessionId, state, env)
    ? observation
    : null;
}

export function readPendingHostPolicyAlert(
  surface,
  sessionId,
  env = process.env,
) {
  const state = readPluginAlertState(surface, sessionId, env);
  return (
    state?.observations?.find(
      (item) =>
        !item?.alerted_at &&
        Date.now() - Date.parse(item?.last_seen_at ?? "") <=
          PLUGIN_ALERT_TTL_MS,
    ) ?? null
  );
}

export function markHostPolicyAlertDelivered(
  surface,
  sessionId,
  observationId,
  env = process.env,
) {
  const state = readPluginAlertState(surface, sessionId, env);
  if (!state) return false;
  const now = new Date().toISOString();
  let changed = false;
  const observations = state.observations.map((item) => {
    if (item?.id !== observationId || item?.alerted_at) return item;
    changed = true;
    return { ...item, alerted_at: now };
  });
  if (!changed) return false;
  return writePluginAlertState(
    surface,
    sessionId,
    { ...state, observations, updated_at: now },
    env,
  );
}

function normalizedPluginHealthSurface(value) {
  const surface = String(value ?? "")
    .trim()
    .toLowerCase();
  return PLUGIN_HEALTH_SURFACES.has(surface) ? surface : null;
}

export function pluginHealthPath(surface, env = process.env) {
  return pluginHealthSessionPath(surface, null, env);
}

function pluginHealthSessionPath(surface, sessionId, env = process.env) {
  const normalized = normalizedPluginHealthSurface(surface);
  if (!normalized) return null;
  const normalizedSession = safeText(sessionId ?? "", 256);
  if (!normalizedSession || normalizedSession === "unknown") {
    return join(pluginHealthDir(env), `${normalized}.json`);
  }
  const sessionHash = createHash("sha256")
    .update(normalizedSession, "utf8")
    .digest("hex")
    .slice(0, 24);
  return join(pluginHealthDir(env), `${normalized}.${sessionHash}.json`);
}

export function readPluginLifecycleHealth(
  surface,
  env = process.env,
  sessionId = null,
) {
  const path = pluginHealthSessionPath(surface, sessionId, env);
  if (!path) return null;
  try {
    const parsed = JSON.parse(
      readSecureHookFile(path, MAX_LOCAL_HEALTH_MARKER_BYTES),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// Record that a native lifecycle component actually executed. The marker is
// intentionally local and content-free: it contains only surface/version,
// component timestamps, and the credential source category. Local MCP reads
// it through run_connection_doctor so partial activation cannot look healthy.
export function recordPluginLifecycleHealth(
  {
    surface,
    component,
    pluginVersion = null,
    hostVersion = null,
    credentialSource = null,
    sessionId = null,
    hookTrust = null,
  },
  env = process.env,
) {
  const normalizedSurface = normalizedPluginHealthSurface(surface);
  const normalizedComponent = String(component ?? "")
    .trim()
    .toLowerCase();
  if (
    !normalizedSurface ||
    !PLUGIN_HEALTH_COMPONENTS.has(normalizedComponent)
  ) {
    return false;
  }
  // Codex currently gives SessionStart a thread identifier while prompt/tool/
  // completion hooks use turn identifiers. Preserve the specific startup
  // marker for diagnostics, but also publish a generic startup observation so
  // the first turn-specific marker can inherit it. Other hosts with stable
  // session ids remain correct and gain the same conservative fallback.
  if (
    normalizedComponent === "session_start" &&
    sessionId &&
    sessionId !== "unknown"
  ) {
    recordPluginLifecycleHealth(
      {
        surface: normalizedSurface,
        component: normalizedComponent,
        pluginVersion,
        hostVersion,
        credentialSource,
        sessionId: null,
        hookTrust,
      },
      env,
    );
  }
  const path = pluginHealthSessionPath(normalizedSurface, sessionId, env);
  if (!path) return false;
  const now = new Date().toISOString();
  let existing =
    readPluginLifecycleHealth(normalizedSurface, env, sessionId) ?? {};
  // Hosts may emit SessionStart without the stable session id later supplied
  // to prompt/tool/completion hooks. Seed that startup observation into the
  // first session-specific marker, but never copy another session's later
  // components.
  if (
    sessionId &&
    sessionId !== "unknown" &&
    Object.keys(existing).length === 0 &&
    normalizedComponent !== "session_start"
  ) {
    const startup = readPluginLifecycleHealth(normalizedSurface, env);
    const startupComponents =
      startup?.components &&
      typeof startup.components === "object" &&
      !Array.isArray(startup.components) &&
      typeof startup.components.session_start === "string"
        ? { session_start: startup.components.session_start }
        : {};
    existing = {
      ...(startup ?? {}),
      components: startupComponents,
    };
  }
  const existingComponents =
    existing.components &&
    typeof existing.components === "object" &&
    !Array.isArray(existing.components)
      ? existing.components
      : {};
  // A new host session must not inherit prompt/tool/completion observations
  // from a prior session. Otherwise a current partial activation could look
  // healthy for as long as the old marker remains fresh.
  const currentComponents =
    normalizedComponent === "session_start" ? {} : existingComponents;
  const apiConfiguration = resolveApiConfiguration(env);
  const apiDestinationFingerprint = createHash("sha256")
    .update(apiConfiguration.apiUrl.replace(/\/+$/, ""), "utf8")
    .digest("hex")
    .slice(0, 16);
  const configuredEvidenceOrigin = String(
    env?.REMEMBRANCE_PLUGIN_HEALTH_EVIDENCE_ORIGIN ?? "host_runtime",
  )
    .trim()
    .toLowerCase();
  const evidenceOrigin = [
    "host_runtime",
    "host_process",
    "direct_adapter",
  ].includes(configuredEvidenceOrigin)
    ? configuredEvidenceOrigin
    : "host_runtime";
  const releaseRunId =
    evidenceOrigin === "host_process"
      ? safeText(env?.REMEMBRANCE_RELEASE_RUN_ID ?? "", 96)
      : "";
  const payload = {
    schema_version: 2,
    surface: normalizedSurface,
    session_hash:
      sessionId && sessionId !== "unknown"
        ? createHash("sha256")
            .update(String(sessionId), "utf8")
            .digest("hex")
            .slice(0, 24)
        : null,
    plugin_version: safeText(
      pluginVersion ?? existing.plugin_version ?? "",
      64,
    ),
    host_version: safeText(hostVersion ?? existing.host_version ?? "", 64),
    credential_source: ["environment", "shared_config", "none"].includes(
      credentialSource,
    )
      ? credentialSource
      : ["environment", "shared_config", "none"].includes(
            existing.credential_source,
          )
        ? existing.credential_source
        : "none",
    api_destination_source: apiConfiguration.source,
    api_destination_fingerprint: apiDestinationFingerprint,
    evidence_origin: evidenceOrigin,
    release_run_id: releaseRunId || null,
    hook_trust:
      sanitizePluginHookTrust(hookTrust) ??
      sanitizePluginHookTrust(existing.hook_trust) ??
      null,
    components: {
      ...currentComponents,
      [normalizedComponent]: now,
    },
    last_seen_at: now,
  };
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    prunePluginHealthSessionMarkers(normalizedSurface, path, env);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Health recording is best-effort and must never break a host hook.
    }
    return false;
  }
}

function sanitizePluginHookTrust(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(value.status ?? "")
    .trim()
    .toLowerCase();
  if (!["trusted", "review_required", "unavailable"].includes(status)) {
    return null;
  }
  const allowedEvents = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
  ]);
  const reviewEvents = Array.isArray(value.review_events)
    ? [...new Set(value.review_events)]
        .filter((event) => allowedEvents.has(event))
        .slice(0, 4)
    : [];
  const hooks = Array.isArray(value.hooks)
    ? value.hooks
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            allowedEvents.has(entry.event),
        )
        .slice(0, 4)
        .map((entry) => ({
          event: entry.event,
          enabled: entry.enabled === true,
          trust_status: [
            "managed",
            "missing",
            "modified",
            "trusted",
            "unknown",
            "untrusted",
          ].includes(entry.trust_status)
            ? entry.trust_status
            : "unknown",
        }))
    : [];
  return {
    status,
    checked_at: safeText(value.checked_at ?? "", 64),
    review_events: reviewEvents,
    hooks,
    reason:
      status === "unavailable" &&
      [
        "app_server_closed",
        "app_server_initialize_failed",
        "app_server_unavailable",
        "check_disabled",
        "codex_executable_not_found",
        "hooks_list_failed",
        "hooks_list_timeout",
        "hooks_list_too_large",
        "plugin_hooks_not_listed",
      ].includes(value.reason)
        ? value.reason
        : null,
  };
}

function prunePluginHealthSessionMarkers(surface, keepPath, env) {
  const directory = pluginHealthDir(env);
  try {
    const candidates = readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(`${surface}.`) &&
          /^[a-z_]+\.[a-f0-9]{24}\.json$/.test(name),
      )
      .map((name) => {
        const path = join(directory, name);
        return { path, modified: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates.slice(32)) {
      if (candidate.path !== keepPath) rmSync(candidate.path, { force: true });
    }
  } catch {
    // Pruning is advisory; health recording must remain fail-open.
  }
}

// Well-known config file that carries the org API key (and, optionally, the API
// URL). It exists so a plugin user can authenticate ONCE — via one copy-paste
// command that writes this file — and have prompt hooks plus local/bundled MCP
// servers pick the key up, regardless of how the runtime happens to pass (or
// not pass) environment variables to hook commands. Hosted MCP cannot read a
// file on the caller's machine and authenticates separately. The OpenClaw
// package keeps this at the fixed user-home path rather than honoring
// environment-controlled config roots: the hook sends network requests, so
// ClawHub security scans treat dynamic env-driven credential paths as a
// higher-risk exfiltration pattern. General reads remain best-effort for
// diagnostics; credential resolution separately distinguishes an absent file
// from a present malformed file and blocks remote calls for the latter instead
// of silently changing scope.
export function remembranceConfigPath() {
  return join(homedir(), ".config", "remembrance", "config.json");
}

export function readRemembranceConfig(env = process.env) {
  try {
    const parsed = JSON.parse(
      readSecureHookFile(remembranceConfigPath(env), MAX_LOCAL_CONFIG_BYTES),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function readSharedConfigSnapshot(env = process.env) {
  const path = remembranceConfigPath(env);
  if (!existsSync(path)) {
    return { present: false, parsed: null, config: {} };
  }
  try {
    const parsed = JSON.parse(readSecureHookFile(path, MAX_LOCAL_CONFIG_BYTES));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { present: true, parsed, config: parsed }
      : { present: true, parsed: null, config: {} };
  } catch {
    return { present: true, parsed: null, config: {} };
  }
}

export function resolveApiAccessSnapshot(env = process.env) {
  const shared = readSharedConfigSnapshot(env);
  const apiConfiguration = resolveApiConfigurationFromSnapshot(env, shared);
  if (isUnusableConfigurationSource(apiConfiguration.source)) {
    return {
      apiConfiguration,
      credential: { apiKey: "", source: apiConfiguration.source },
      memberLinkToken: "",
    };
  }
  const environmentKey = String(env.REMEMBRANCE_API_KEY ?? "").trim();
  let credential;
  if (environmentKey) {
    const explicitBinding = String(env.REMEMBRANCE_API_KEY_ORIGIN ?? "").trim();
    const binding = explicitBinding
      ? normalizeApiUrl(explicitBinding, env)
      : { apiUrl: DEFAULT_API_URL, issue: null };
    credential = credentialForApiDestination(
      binding.apiUrl && !binding.issue
        ? {
            apiKey: environmentKey,
            source: "environment",
            boundApiUrl: binding.apiUrl,
          }
        : unusableDestinationCredential(),
      apiConfiguration,
    );
  } else if (!shared.present) {
    credential = { apiKey: "", source: "none" };
  } else if (!shared.parsed) {
    credential = unusableSharedConfigCredential();
  } else {
    const parsed = shared.parsed;
    if (
      Object.prototype.hasOwnProperty.call(parsed, "apiKey") &&
      (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim())
    ) {
      credential = unusableSharedConfigCredential();
    } else {
      const fromFile = parsed.apiKey;
      if (typeof fromFile !== "string" || !fromFile.trim()) {
        credential = { apiKey: "", source: "none" };
      } else {
        const binding = Object.prototype.hasOwnProperty.call(parsed, "apiUrl")
          ? normalizeApiUrl(parsed.apiUrl, env)
          : { apiUrl: DEFAULT_API_URL, issue: null };
        credential = credentialForApiDestination(
          binding.apiUrl && !binding.issue
            ? {
                apiKey: fromFile.trim(),
                source: "shared_config",
                boundApiUrl: binding.apiUrl,
              }
            : unusableSharedConfigCredential(),
          apiConfiguration,
        );
      }
    }
  }
  const environmentMemberLinkToken = String(
    env.REMEMBRANCE_MEMBER_LINK_TOKEN ?? "",
  ).trim();
  const rawMemberLinkToken =
    environmentMemberLinkToken ||
    String(shared.config.memberLinkToken ?? "").trim();
  return {
    apiConfiguration,
    credential,
    memberLinkToken: /^mlink_[A-Za-z0-9_-]{24,160}$/.test(rawMemberLinkToken)
      ? rawMemberLinkToken
      : "",
  };
}

export function resolveApiCredential(env = process.env) {
  return resolveApiAccessSnapshot(env).credential;
}

// The org API key: an explicit env var wins, then the config file. Returns ""
// when neither is present (the request then goes out anonymously).
export function resolveApiKey(env = process.env) {
  return resolveApiCredential(env).apiKey;
}

export function explicitPreferenceSettingsFromPrompt(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  const settings = new Map();
  const set = (key, value) => settings.set(key, { key, value });
  if (
    /\b(?:too many|fewer|less|minimal|sparse)\s+(?:code\s+)?comments?\b/.test(
      text,
    ) ||
    /\bcomments?\s+(?:only\s+)?(?:when|for)\s+(?:the\s+)?(?:logic is )?(?:tricky|non-obvious)\b/.test(
      text,
    )
  ) {
    set("comment_density", "sparse");
  } else if (
    /\b(?:more|detailed|comprehensive)\s+(?:code\s+)?comments?\b/.test(text)
  ) {
    set("comment_density", "detailed");
  }
  if (/\bcomments?\s+(?:only\s+)?(?:on|for)\s+api\s+contracts?\b/.test(text)) {
    set("comment_focus", "api_contracts");
  } else if (
    /\bcomments?\s+(?:only\s+)?(?:when|for)\s+(?:the\s+)?(?:logic is )?(?:tricky|non-obvious)\b/.test(
      text,
    )
  ) {
    set("comment_focus", "tricky_logic");
  } else if (/\bcomments?\s+(?:only\s+)?(?:on|for)\s+intent\b/.test(text)) {
    set("comment_focus", "intent_only");
  }
  if (
    /\b(?:be|keep (?:it|(?:your |the )?(?:answers?|responses?|explanations?))|prefer)\s+(?:more\s+)?concise\b/.test(
      text,
    ) ||
    /\b(?:too|overly)\s+verbose\b/.test(text)
  ) {
    set("explanation_depth", "concise");
  } else if (
    /\b(?:prefer|give|provide|use)\s+(?:more\s+)?detailed\s+(?:answers?|explanations?)\b/.test(
      text,
    )
  ) {
    set("explanation_depth", "detailed");
  }
  if (/\b(?:use|prefer)\s+step[- ]by[- ]step\b/.test(text)) {
    set("output_organization", "step_by_step");
  } else if (
    /\b(?:use|prefer)\s+(?:a\s+)?structured\s+(?:answer|format|output)\b/.test(
      text,
    )
  ) {
    set("output_organization", "structured");
  } else if (
    /\b(?:use|prefer|keep)\s+(?:a\s+)?compact\s+(?:answer|format|output)\b/.test(
      text,
    )
  ) {
    set("output_organization", "compact");
  }
  return [...settings.values()];
}

export function promptRequestsDurablePreference(prompt) {
  const text = String(prompt ?? "");
  if (
    /\b(?:from now on|going forward|for future tasks?|remember (?:that )?i (?:prefer|want)|my (?:lasting )?preference is|make this my default|(?:i|we)\s+always\s+(?:prefer|want|avoid))\b/i.test(
      text,
    )
  ) {
    return true;
  }
  // Terminators must be followed by whitespace or end of input, or a sentence
  // splits inside an identifier ("console.log", "v1.2") and separates a
  // durable instruction from the recurring qualifier that licenses it.
  return text.split(/[.!?]+(?=\s|$)|\n+/).some((sentence) => {
    const clause = sentence.trim();
    if (!clause || /^(?:nevermind|never\s+(?:mind|gonna))\b/i.test(clause)) {
      return false;
    }
    // Deliberately broad. Whether "must never return undefined" describes the
    // agent's working habits or the program's runtime behavior is a semantic
    // judgment no regex can make, and dropping the ambiguous half would
    // silently discard real user instructions. This gate only decides whether
    // to ASK; genericPreferenceCaptureDirective leaves the decision to the model
    // reading the full conversation, and server-side validation rejects what
    // slips through.
    if (/\b(?:should|must)\s+(?:always|never|only)\b/i.test(clause)) {
      return true;
    }
    const recurringContext =
      /\b(?:by default|as (?:a )?(?:default|rule)|for future tasks?|in future|whenever|every time|each time|(?:for|on) (?:all|each|every)\b|(?:before|after) (?:a|an|the|any|each|every|i|we|you|commits?|releases?|deployments?|reviews?|tasks?)(?:\s|$))/i.test(
        clause,
      );
    if (!recurringContext) return false;
    // A durable instruction may trail its qualifier ("Whenever you touch a
    // route, always add a test"), so each comma-separated segment gets its own
    // start-anchored test. The anchor still blocks descriptive tails such as
    // "..., and it always returns null".
    return clause
      .split(",")
      .some((segment) =>
        /^(?:please\s+)?(?:by default,?\s+)?(?:always|never)\s+(?!(?:mind|gonna|going|a|an|the|this|that|there|it)\b)[a-z][a-z-]*\b/i.test(
          segment.trim(),
        ),
      );
  });
}

export function promptProvidesPreferenceCorrection(prompt) {
  return /\b(?:too many comments?|fewer comments?|less verbose|too verbose|overly verbose|stop (?:using|adding|writing)|do not (?:use|add|write)|don't (?:use|add|write)|i (?:do not|don't) (?:want|like)|instead,? (?:use|keep|make))\b/i.test(
    String(prompt ?? ""),
  );
}

const USER_CORRECTION_CAPTURE_PATTERNS = [
  /\b(?:that|this|it)(?:\s+(?:(?:completed|proposed|current|chosen)\s+)?(?:approach|implementation|design|result))?(?:'s|\s+(?:is|was|looks?|feels?))\s+(?:wrong|incorrect|overkill|too much|overcomplicated|the wrong (?:way|approach|direction))\b/i,
  /\b(?:wrong (?:way|approach|direction)|do (?:this|it) differently|use a different approach)\b/i,
  /\b(?:you|we)\s+(?:missed|forgot|overlooked|ignored|did not address|didn't address|failed to address)\b/i,
  /\b(?:i already (?:asked|said|told you)|as i (?:said|asked|explained)|you keep (?:missing|forgetting|doing|adding|removing))\b/i,
  /\bi (?:do not|don't) (?:like|agree with|want) (?:this|that|the) (?:approach|direction|implementation|design|result)\b/i,
  /\b(?:revert|undo|discard|reject) (?:that|this|the (?:approach|implementation|change|design|result))\b/i,
];

export function promptContainsUserCorrection(prompt) {
  const text = String(prompt ?? "").trim();
  return (
    text.length >= 8 &&
    USER_CORRECTION_CAPTURE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

export function userCorrectionCaptureDirective(prompt) {
  if (!promptContainsUserCorrection(prompt)) return null;
  return [
    "Remembrance user-correction capture:",
    "The user appears to have corrected, rejected, or repeated guidance about the approach. Resolve the correction in this turn, then decide whether the corrected lesson is reusable beyond this person and repository.",
    "For a compact general failure, correction, or evidence lesson, prepare and submit one private lesson before finishing. For a complete reusable workflow, propose a private skill instead. Store person-, repository-, or machine-specific facts only in the host's local memory.",
    "Writing local memory does not satisfy organization-shared capture. Do not send raw repository content, the user's wording, paths, URLs, identifiers, or secrets; generalize first and use the private organization lane.",
  ].join("\n");
}

function promptDisclaimsDurablePreference(prompt) {
  return /\b(?:(?:contrived|hypothetical|illustrative)\s+(?:example|scenario)|(?:example|scenario)\s+only|not\s+(?:a\s+)?(?:lasting\s+)?(?:preference|rule|default)|(?:do not|don't)\s+(?:save|remember|record|learn)\s+(?:this|that|it))\b/i.test(
    String(prompt ?? ""),
  );
}

export function promptScopesPreferenceToProject(prompt) {
  return /\b(?:in|for)\s+(?:this|the current)\s+(?:project|repository|repo|workspace|codebase)\b/i.test(
    String(prompt ?? ""),
  );
}

export function genericPreferenceCaptureDirective(prompt, options = {}) {
  const text = String(prompt ?? "");
  if (
    promptDisclaimsDurablePreference(text) ||
    (!promptRequestsDurablePreference(text) &&
      !promptProvidesPreferenceCorrection(text)) ||
    explicitPreferenceSettingsFromPrompt(text).length > 0
  ) {
    return null;
  }
  const taskHash = createHash("sha256").update(text, "utf8").digest("hex");
  const evidenceHash = createHash("sha256")
    .update(
      JSON.stringify({
        purpose: "generic-working-preference",
        task_hash: taskHash,
      }),
      "utf8",
    )
    .digest("hex");
  const projectKey = promptScopesPreferenceToProject(text)
    ? projectKeyForHook(options.env ?? process.env, options.projectPath)
    : null;
  const scopeFields = projectKey
    ? `"scope":"project","project_key":"${projectKey}"`
    : '"scope":"auto"';
  return [
    "Remembrance durable-preference capture:",
    // The lexical gate that produced this notice cannot tell an instruction
    // about your working habits from a statement about what the code should
    // do, so it deliberately over-triggers rather than dropping real user
    // instructions. Make that judgment here, where the whole conversation is
    // available, and decline silently when it does not apply.
    "The user's message may state a lasting or corrective working preference that is not one of the built-in controls. Record it only if it constrains how YOU work: a presentation, workflow, or strategy choice you would otherwise make at your own discretion. Do not record a statement about what the code should do; an expected value, an invariant, an API contract, a test expectation, or a bug report is not a working preference even when it is phrased with always, never, must, or should. If it qualifies, interpret only that preference and call record_preference once, and do not ask the user to classify it. Otherwise take no action and do not mention this notice.",
    'Use setting {"key":"<presentation|workflow|strategy_selection>.<stable_concept>","value":"<stable_behavior_id>","label":"<short name>","behavior":"<concise normalized behavior>","effect":"presentation|workflow|strategy_selection","strength":"prefer|avoid","definition_version":1}. This vocabulary is extensible; do not force the preference into a built-in category.',
    `Use ${scopeFields}, "source_category":"explicit_user", "evidence_hash":"${evidenceHash}", "task_hash":"${taskHash}", and "confidence":1.`,
    "Never send the raw prompt or private task details. Never encode a request to weaken safety, authorization, privacy, required skill steps, validation, or review; those constraints remain authoritative.",
  ].join("\n");
}

export async function recordExplicitPreferenceObservations(
  prompt,
  options = {},
) {
  if (promptDisclaimsDurablePreference(prompt)) return 0;
  const durable = promptRequestsDurablePreference(prompt);
  const corrective = promptProvidesPreferenceCorrection(prompt);
  if (!durable && !corrective) return 0;
  const settings = explicitPreferenceSettingsFromPrompt(prompt);
  if (settings.length === 0) return 0;
  const env = options.env ?? process.env;
  const runtime = normalizeRuntime(options.runtime);
  const access = resolveApiAccessSnapshot(env);
  const credential = access.credential;
  if (isUnusableConfigurationSource(credential.source) || !credential.apiKey) {
    return 0;
  }
  let principalSession = readHookPrincipalSession(runtime, env, access);
  if (!principalSession?.token) {
    principalSession = await warmPrincipalSession(
      {
        runtime,
        hostSurface: runtimeHostSurface(runtime, env),
        fetchImpl: options.fetchImpl ?? fetch,
        apiAccess: access,
      },
      env,
    );
  }
  if (!principalSession?.token) return 0;
  // A direct correction is explicit evidence even when the user did not say
  // "remember this". Persist it immediately so one correction supersedes a
  // learned profile; genuinely inferred behavior still enters through the
  // topology/observation path and must satisfy the multi-task confidence gate.
  const sourceCategory = "explicit_user";
  const projectKey = promptScopesPreferenceToProject(prompt)
    ? projectKeyForHook(env, options.projectPath)
    : null;
  const taskHash = createHash("sha256")
    .update(String(prompt), "utf8")
    .digest("hex");
  let refreshPromise = null;
  const refreshSession = async () => {
    refreshPromise ??= (async () => {
      clearHookPrincipalSession(runtime, env, access);
      return warmPrincipalSession(
        {
          runtime,
          hostSurface: runtimeHostSurface(runtime, env),
          fetchImpl: options.fetchImpl ?? fetch,
          apiAccess: access,
        },
        env,
      );
    })();
    return refreshPromise;
  };
  const results = await Promise.all(
    settings.map(async (setting) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        DEFAULT_DIRECTIVE_EVENT_TIMEOUT_MS,
      );
      timeout.unref?.();
      try {
        const evidenceHash = createHash("sha256")
          .update(
            JSON.stringify({
              setting,
              task_hash: taskHash,
              source: "hook",
              source_category: sourceCategory,
              project_key: projectKey,
            }),
            "utf8",
          )
          .digest("hex");
        const submit = (token) =>
          (options.fetchImpl ?? fetch)(
            `${access.apiConfiguration.apiUrl}/api/v1/agent/preferences`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "user-agent": clientUserAgent(options.userAgent),
                "x-remembrance-api-key": credential.apiKey,
                "x-remembrance-principal-session": token,
              },
              body: JSON.stringify({
                setting,
                scope: projectKey
                  ? "project"
                  : principalSession.member_linked
                    ? durable
                      ? "member"
                      : "member_runtime"
                    : "installation",
                source_category: sourceCategory,
                evidence_hash: evidenceHash,
                task_hash: taskHash,
                ...(projectKey ? { project_key: projectKey } : {}),
                confidence: 1,
              }),
              signal: controller.signal,
            },
          );
        let response = await submit(principalSession.token);
        if (response?.status === 401 || response?.status === 403) {
          const refreshed = await refreshSession();
          if (refreshed?.token) {
            principalSession = refreshed;
            response = await submit(refreshed.token);
          }
        }
        return response?.ok === true;
      } catch {
        // Preference capture is advisory and cannot block the prompt hook.
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  return results.filter(Boolean).length;
}

export function sharedConfigCredentialNotice(env = process.env) {
  const source = resolveApiCredential(env).source;
  if (source === "unusable_environment") {
    return (
      "Remembrance setup needs attention: REMEMBRANCE_API_URL is invalid. " +
      "Remote Remembrance calls are paused locally instead of changing " +
      "destinations. Set it to an absolute HTTPS registry URL (HTTP is allowed " +
      "only for loopback development) without credentials, query parameters, " +
      "or fragments, or " +
      "intentionally remove it, then run run_connection_doctor."
    );
  }
  if (source === "unusable_shared_config") {
    return (
      "Remembrance setup needs attention: the shared config file exists but " +
      "is unreadable or invalid. Remote Remembrance calls are paused locally " +
      "instead of falling back to anonymous scope. Fix or intentionally remove " +
      "~/.config/remembrance/config.json, then run run_connection_doctor."
    );
  }
  if (source === "unusable_destination_binding") {
    return (
      "Remembrance setup needs attention: the API key is not bound to the " +
      "configured registry destination. For a custom registry, store apiKey " +
      "and apiUrl together in the shared config, or set " +
      "REMEMBRANCE_API_KEY_ORIGIN to the exact REMEMBRANCE_API_URL value. " +
      "Remote calls are paused so the key cannot be forwarded elsewhere."
    );
  }
  if (source !== "shared_config") {
    return null;
  }
  return (
    `Remembrance credential source: this plugin hook resolved its key from ` +
    `the shared Remembrance config file (normally ` +
    `~/.config/remembrance/config.json). REMEMBRANCE_API_KEY may be unset; do not ` +
    `use an anonymous REST/browser probe to infer this hook's scope. Call ` +
    `run_connection_doctor for the MCP transport you will use.`
  );
}

export function resolveApiConfiguration(env = process.env) {
  return resolveApiAccessSnapshot(env).apiConfiguration;
}

function resolveApiConfigurationFromSnapshot(env, shared) {
  const environmentUrl = String(env.REMEMBRANCE_API_URL ?? "").trim();
  if (environmentUrl) {
    const normalized = normalizeApiUrl(environmentUrl, env);
    return normalized.apiUrl && !normalized.issue
      ? { apiUrl: normalized.apiUrl, source: "environment" }
      : {
          apiUrl: DEFAULT_API_URL,
          source: "unusable_environment",
          issue: normalized.issue ?? "invalid_url",
        };
  }
  if (!shared.present) {
    return { apiUrl: DEFAULT_API_URL, source: "default" };
  }
  if (!shared.parsed) {
    return { apiUrl: DEFAULT_API_URL, source: "unusable_shared_config" };
  }
  if (!Object.prototype.hasOwnProperty.call(shared.parsed, "apiUrl")) {
    return { apiUrl: DEFAULT_API_URL, source: "default" };
  }
  const normalized = normalizeApiUrl(shared.parsed.apiUrl, env);
  return normalized.apiUrl && !normalized.issue
    ? { apiUrl: normalized.apiUrl, source: "shared_config" }
    : {
        apiUrl: DEFAULT_API_URL,
        source: "unusable_shared_config",
        issue: normalized.issue ?? "invalid_url",
      };
}

function apiUrl(env) {
  return resolveApiConfiguration(env).apiUrl;
}

function normalizeApiUrl(value, env = process.env) {
  if (typeof value !== "string" || !value.trim()) {
    return { apiUrl: null, issue: "invalid_url" };
  }
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return { apiUrl: null, issue: "invalid_url" };
    }
    const loopback = isLoopbackHostname(parsed.hostname);
    const privateDestination = isPrivateDestinationHostname(parsed.hostname);
    if (parsed.protocol === "http:" && !loopback) {
      return { apiUrl: null, issue: "insecure_remote_http" };
    }
    if (
      !loopback &&
      privateDestination &&
      env.REMEMBRANCE_ALLOW_PRIVATE_REGISTRY !== "true"
    ) {
      return {
        apiUrl: null,
        issue: "private_destination_requires_opt_in",
      };
    }
    return { apiUrl: candidate.replace(/\/+$/, ""), issue: null };
  } catch {
    return { apiUrl: null, issue: "invalid_url" };
  }
}

function credentialForApiDestination(credential, configuration) {
  if (
    !credential.apiKey ||
    isUnusableConfigurationSource(configuration.source)
  ) {
    return credential.apiKey
      ? unusableDestinationCredential()
      : { apiKey: "", source: credential.source };
  }
  return credential.boundApiUrl === configuration.apiUrl
    ? { apiKey: credential.apiKey, source: credential.source }
    : unusableDestinationCredential();
}

function unusableSharedConfigCredential() {
  return {
    apiKey: "",
    source: "unusable_shared_config",
  };
}

function unusableDestinationCredential() {
  return {
    apiKey: "",
    source: "unusable_destination_binding",
  };
}

function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    return Number(normalized.split(".")[0]) === 127;
  }
  return false;
}

function isPrivateDestinationHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "localhost"
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  }
  return false;
}

function normalizeHostname(hostname) {
  return String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function readSecureHookFile(path, maxBytes) {
  const parent = lstatSync(dirname(path));
  assertSecureHookDirectory(parent);
  const before = lstatSync(path);
  assertSecureHookFile(before, maxBytes);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    assertSecureHookFile(opened, maxBytes);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("Remembrance local state changed while opening.");
    }
    return readBoundedHookDescriptor(descriptor, maxBytes);
  } finally {
    closeSync(descriptor);
  }
}

function ensureSecureHookDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Remembrance health state is not a regular directory.");
  }
  assertCurrentHookUser(metadata.uid);
  if (isPosixHookRuntime() && (metadata.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
  }
}

function assertSecureHookDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Remembrance local state parent is unsafe.");
  }
  assertCurrentHookUser(metadata.uid);
  if (isPosixHookRuntime() && (metadata.mode & 0o022) !== 0) {
    throw new Error("Remembrance local state parent is writable by others.");
  }
}

function assertSecureHookFile(metadata, maxBytes) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Remembrance local state is not a regular file.");
  }
  assertCurrentHookUser(metadata.uid);
  if (metadata.size > maxBytes) {
    throw new Error("Remembrance local state exceeds its size limit.");
  }
  if (isPosixHookRuntime() && (metadata.mode & 0o077) !== 0) {
    throw new Error("Remembrance local state permissions are not private.");
  }
}

function assertCurrentHookUser(uid) {
  if (isPosixHookRuntime() && uid !== process.getuid()) {
    throw new Error("Remembrance local state is owned by another user.");
  }
}

function readBoundedHookDescriptor(descriptor, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maxBytes + 1 - total));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new Error("Remembrance local state exceeds its size limit.");
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function isPosixHookRuntime() {
  return typeof process.getuid === "function";
}

function isUnusableConfigurationSource(source) {
  return (
    source === "unusable_environment" ||
    source === "unusable_shared_config" ||
    source === "unusable_destination_binding"
  );
}

// A manually configured hosted Codex MCP registration can diverge from the
// hook runtime registry. The packaged Codex plugin now uses its bundled local
// MCP server, which resolves the same shared config as the hooks and therefore
// has no split to warn about.
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
  if (config?.command) {
    return {
      apiBase: normalizeRegistryBaseUrl(apiUrl(env)),
      mcpUrl: "local stdio",
      source: "active Codex MCP config",
    };
  }
  if (config?.url) {
    return {
      apiBase: normalizeRegistryBaseUrl(config.url),
      mcpUrl: config.url,
      source: "active Codex MCP config",
    };
  }

  const packaged = readPackagedCodexMcpRegistration();
  if (packaged?.command) {
    return {
      apiBase: normalizeRegistryBaseUrl(apiUrl(env)),
      mcpUrl: "local stdio",
      source: "bundled local Codex MCP server",
    };
  }
  const packagedUrl = packaged?.url ?? `${DEFAULT_API_URL}/api/mcp`;
  return {
    apiBase: normalizeRegistryBaseUrl(packagedUrl),
    mcpUrl: packagedUrl,
    source: "packaged Codex MCP manifest",
  };
}

export function resolveCodexHostedMcpRegistration(env = process.env) {
  const config = readCodexMcpConfig(env);
  if (config) {
    return {
      url: config.url,
      ...(config.command ? { command: config.command } : {}),
      credentialEnvVars: config.credentialEnvVars,
      hasStaticCredential: config.hasStaticCredential,
      source: "active Codex MCP config",
    };
  }
  const packaged = readPackagedCodexMcpRegistration();
  if (packaged) {
    return {
      ...packaged,
      source: "packaged Codex MCP manifest",
    };
  }
  return {
    url: null,
    credentialEnvVars: [],
    hasStaticCredential: false,
    source: "Codex MCP registration",
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
      const registration = parseCodexMcpRegistration(
        readFileSync(path, "utf8"),
      );
      if (registration) {
        return { path, ...registration };
      }
    } catch {
      // Fail open: a malformed/unreadable Codex config should not break hooks.
    }
  }
  return null;
}

export function parseCodexMcpUrl(toml) {
  return parseCodexMcpRegistration(toml)?.url ?? null;
}

export function parseCodexMcpRegistration(toml) {
  let section = "";
  let found = false;
  let url = null;
  let command = null;
  const credentialEnvVars = new Set();
  let hasStaticCredential = false;

  for (const rawLine of String(toml ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().replace(/["']/g, "");
      if (
        section === "mcp_servers.remembrance" ||
        section.startsWith("mcp_servers.remembrance.")
      ) {
        found = true;
      }
      continue;
    }
    if (
      section !== "mcp_servers.remembrance" &&
      !section.startsWith("mcp_servers.remembrance.")
    ) {
      continue;
    }

    const assignment = line.match(/^(.+?)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }
    const key = parseTomlKey(assignment[1]);
    const value = assignment[2];

    if (section === "mcp_servers.remembrance") {
      if (key === "url") {
        url = parseTomlString(value);
      } else if (key === "command") {
        command = parseTomlString(value);
      } else if (key === "bearer_token_env_var") {
        addCredentialEnvVar(credentialEnvVars, parseTomlString(value));
      } else if (key === "env_http_headers") {
        for (const [header, envName] of parseTomlInlineTable(value)) {
          if (isRemembranceAuthHeader(header)) {
            addCredentialEnvVar(credentialEnvVars, envName);
          }
        }
      } else if (key === "http_headers" || key === "headers") {
        hasStaticCredential ||= parseTomlInlineTable(value).some(([header]) =>
          isRemembranceAuthHeader(header),
        );
      }
    } else if (section === "mcp_servers.remembrance.env_http_headers") {
      if (isRemembranceAuthHeader(key)) {
        addCredentialEnvVar(credentialEnvVars, parseTomlString(value));
      }
    } else if (
      section === "mcp_servers.remembrance.http_headers" ||
      section === "mcp_servers.remembrance.headers"
    ) {
      hasStaticCredential ||= isRemembranceAuthHeader(key);
    }
  }

  return found
    ? {
        url,
        credentialEnvVars: [...credentialEnvVars],
        hasStaticCredential,
        ...(command ? { command } : {}),
      }
    : null;
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

function readPackagedCodexMcpRegistration() {
  for (const relativePath of ["../.mcp.codex.json", "../.mcp.json"]) {
    try {
      const parsed = JSON.parse(
        readFileSync(new URL(relativePath, import.meta.url), "utf8"),
      );
      const server = parsed?.mcpServers?.remembrance;
      if (!server || typeof server !== "object" || Array.isArray(server)) {
        continue;
      }
      const credentialEnvVars = new Set();
      addCredentialEnvVar(
        credentialEnvVars,
        stringOrNull(server.bearer_token_env_var),
      );
      for (const [header, envName] of Object.entries(
        server.env_http_headers ?? {},
      )) {
        if (isRemembranceAuthHeader(header)) {
          addCredentialEnvVar(credentialEnvVars, stringOrNull(envName));
        }
      }
      const staticHeaders = {
        ...(server.http_headers ?? {}),
        ...(server.headers ?? {}),
      };
      return {
        url: stringOrNull(server.url),
        ...(stringOrNull(server.command)
          ? { command: stringOrNull(server.command) }
          : {}),
        credentialEnvVars: [...credentialEnvVars],
        hasStaticCredential: Object.keys(staticHeaders).some((header) =>
          isRemembranceAuthHeader(header),
        ),
      };
    } catch {
      // Hook-core is copied into multiple plugin packages; not every copy has a
      // hosted Codex MCP manifest next to it.
    }
  }
  return null;
}

function addCredentialEnvVar(target, value) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value ?? ""))) {
    target.add(String(value));
  }
}

function isRemembranceAuthHeader(value) {
  return ["authorization", "x-remembrance-api-key", "x-api-key"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function parseTomlKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function parseTomlInlineTable(value) {
  const entries = [];
  const source = String(value ?? "").trim();
  if (!source.startsWith("{") || !source.endsWith("}")) {
    return entries;
  }
  const body = source.slice(1, -1);
  const pattern =
    /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*("(?:\\.|[^"])*"|'[^']*'|[^,}]+)/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const key = match[1] ?? match[2] ?? match[3] ?? "";
    const parsedValue = parseTomlString(match[4]);
    if (key && parsedValue) {
      entries.push([key, parsedValue]);
    }
  }
  return entries;
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
