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
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acknowledgeFeedbackDenial,
  feedbackDenialAcknowledged,
} from "./feedback-disposition.mjs";
import {
  inventoryRetainedKeyConsumers,
  normalizeResupplyEnvelope,
  normalizeRetainedKeyHoldCodes,
  openResupplyEnvelope,
  resupplyEnvelopeBytes,
  resupplyPayloadDigest,
  retainedKeyHoldCodes,
  retainedKeyHoldRemediation,
  retainedLedgerRoot,
  retainedRootsUsable,
  sealResupplyPayload,
} from "./pending-action-payload.mjs";
import {
  boundedContextSection,
  composeBoundedHookContext,
  composeBoundedHookContextResult,
  PRIVATE_LEARNING_INSPECTOR_DIGEST,
  promptContainsFirstPartyCorrection,
  userCorrectionCaptureDirectiveText,
} from "./private-learning-hook-policy.mjs";

export { composeBoundedHookContext } from "./private-learning-hook-policy.mjs";

const DEFAULT_API_URL = "https://remembrance.dev";
const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 2000;
// The search waits longer than the hook's other registry requests: the
// server's relevance judge may take up to 2 s when Jev leaves candidates
// undecided (owner decision 40 = B), with ranking and network on top.
const DEFAULT_SEARCH_TIMEOUT_MS = 3000;
const DEFAULT_DIRECTIVE_EVENT_TIMEOUT_MS = 750;
const PRIVATE_LEARNING_CAPTURE_CAPABILITY = "private-learning-capture-v1";
// Tells the server this search waits for the judge's longer hook deadline.
const RELEVANCE_JUDGE_WAIT_CAPABILITY = "relevance-judge-wait-v1";
const CLIENT_CAPABILITIES_HEADER = "x-remembrance-client-capabilities";
const DIRECTIVE_MARKER_TTL_MS = 30 * 60 * 1000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_FIELD_CHARS = 280;
const MAX_DIRECTIVE_CHARS = 900;
// Room for the rules, one complete custom preference (96-char label, 320-char
// behavior), and an omission note that points to the rest.
const MAX_PREFERENCE_CONTEXT_CHARS = 1200;
const MAX_MANDATORY_PREFERENCE_CONTEXT_CHARS = 1200;
// Mirrors MAX_MANDATORY_ORG_PREFERENCES in core: up to eight exact keys
// (1,313 characters at the 96-character key limit) fit the required fetch.
const MAX_REQUIRED_SETTING_KEYS = 8;
const VALUE_EPISODE_MARKER_LIMIT = 20;
const VALUE_EPISODE_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIRECT_SELECTION_MARKER_LIMIT = 20;
const DIRECT_SELECTION_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETION_OBLIGATION_LIMIT = 64;
// The most pointer entries one read of a ledger examines over its two pointer
// homes, of which it presents at most COMPLETION_OBLIGATION_LIMIT: the bound
// of one listing of a ledger's own records.
const COMPLETION_POINTER_SCAN_LIMIT = 256;
// A post-use debt keeps the receipts of later invocations of its skill
// version (repeatedResultUse), newest last; feedback under any of them pays it.
const COMPLETION_ALIAS_QUERY_ID_LIMIT = 4;
// Results a ledger paid post-use feedback for, newest last.
const RATED_RESULT_LIMIT = 32;
const RATED_RESULTS_VERSION = "rated-results-v1";
// Every obligation file is read with this bound, so a retained re-supply
// payload must fit inside it whole. Sealed, a payload takes about four thirds
// of its bytes; at 12 KiB a record still keeps every payload the earlier 8 KiB
// plaintext record kept (the largest beside the longest provenance grew from
// 6,739 to 7,968 bytes). pending-action-payload.mjs reads the same bound.
const COMPLETION_OBLIGATION_MAX_BYTES = 12 * 1024;
// The most a record grows once written: the prompted mark, and the parent's
// engagement count and the largest provenance a transfer sets. A payload is
// retained only with room for all of it, so no rewrite has to drop it.
const COMPLETION_OBLIGATION_GROWN_FIELDS = Object.freeze({
  engagement_count: 1_000_000,
  prompted_at: new Date(0).toISOString(),
  transferred_from: Object.freeze({
    agent_id: "a".repeat(256),
    transcript_path: "p".repeat(512),
  }),
});
const PRIVATE_AUTHORIZATION_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A private draft whose session tree has had no user prompt for this long is
// offered to other sessions, and only as a user decision (owner decision,
// 0.2.3; recorded in DEPLOYMENT.md, "Private draft reminders"). The notice
// offering such drafts shows at most once per interval on a machine.
const PRIVATE_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
const PRIVATE_ORPHAN_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A declined or host-denied draft returns in that notice after these waits,
// then not again until its lane is allowed, the user asks for it, or the
// client updates (owner decision, 0.2.3; recorded in DEPLOYMENT.md).
const PRIVATE_PARKED_NOTICE_DELAYS_MS = [1, 7, 30].map(
  (days) => days * 24 * 60 * 60 * 1000,
);
// Inherited cleanup for a debt record without content (a marker), which a
// ledger read removes once it is this old. It never applies to a record
// that keeps an unresolved action's payload: only completing, declining or
// withdrawing the action removes that (review R2, Task 15). No owner
// decision set this age.
const COMPLETION_OBLIGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETION_OBLIGATION_POINTER_VERSION = "completion-obligation-pointer-v1";
// A ledger that hands over leaves a content-free forwarding marker naming the
// ledger it handed over to; when one page cannot hand everything over, the
// recipient gets a content-free association naming the ledger that still
// holds or points to the rest. A read, or a hand-over, follows at most
// COMPLETION_HOP_LIMIT of them in a row.
const COMPLETION_OBLIGATION_ASSOCIATION_VERSION =
  "completion-obligation-association-v1";
const COMPLETION_OBLIGATION_FORWARD_VERSION = "completion-obligation-forward-v1";
// What a forwarding marker becomes when its ledger's session runs again
// (releaseCompletionForward): content-free, it says only that this session
// runs, so a read elsewhere leaves to it what it keeps, and what is kept
// below it (completionOwner), until its next end writes a forwarding marker
// again. A hand-over stops there as at a ledger without a marker.
const COMPLETION_OBLIGATION_RELEASED_VERSION =
  "completion-obligation-released-v1";
const COMPLETION_OBLIGATION_RELEASED_TEXT = `${JSON.stringify({
  version: COMPLETION_OBLIGATION_RELEASED_VERSION,
})}\n`;
const COMPLETION_HOP_LIMIT = 8;
// The bound a pointer, an association or a forwarding marker is read with,
// as pointers were at master: the largest valid one is under 1 KiB (an agent
// id of at most 256 characters, a transcript path within its room).
const COMPLETION_POINTER_MAX_BYTES = 1024;
const COMPLETION_OBLIGATION_VERSION = "completion-obligation-v1";
const COMPLETION_OBLIGATION_OVERFLOW_VERSION =
  "completion-obligation-overflow-v1";
const PRIVATE_SKILL_NATIVE_CONTEXT_EVENT_MAX_BYTES = 512 * 1024;
const PRIVATE_SKILL_NATIVE_CONTEXT_OUTPUT_MAX_BYTES = 16 * 1024;
const PRIVATE_SKILL_NATIVE_CONTEXT_TIMEOUT_MS = 2_500;
const COMPLETION_CONTRIBUTION_TOOLS = new Set([
  "submit_query_feedback",
  "submit_feedback",
  "decline_pending_action",
  "capture_learning",
  "submit_remembrance",
  "propose_skill_idea",
  "propose_private_skill",
  "submit_private_lesson_candidate",
  "retry_private_lesson_candidate",
  "submit_private_skill_candidate",
  "retry_private_skill_candidate",
  "delete_private_lesson_candidate",
  "delete_private_skill_candidate",
  "record_preference",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
]);
const PREFERENCE_EVIDENCE_SKILL_LIMIT = 2;
const PREFERENCE_EVIDENCE_SETTING_LIMIT = 4;
const PREFERENCE_EVIDENCE_CONTEXT_CHARS = 520;
// submit_preference_compatibility_feedback accepts a query_id, result_id,
// skill_slug and skill_version_id of up to 160 characters each, so the hook
// carries them that far unchanged: a shortened ID is a wrong ID.
const MAX_FEEDBACK_IDENTIFIER_CHARS = 160;
// Mirrors MAX_EFFECTIVE_PREFERENCES in core: a response never states more.
const MAX_EFFECTIVE_PREFERENCE_STATEMENTS = 32;
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
// The recovery reminders parse a private skill draft's whole encrypted envelope
// to read its state. 4 MiB holds a 56,000-character skill with its projection,
// reformulation attempts and native contexts; a larger draft is left out of
// the reminders, never read partly. This is not a submission limit.
const MAX_PRIVATE_SKILL_ENVELOPE_BYTES = 4 * 1024 * 1024;
const principalSessionWarmups = new Map();
export const HOST_POLICY_ALERT_TEXT =
  "The host blocked this Remembrance action. Do not treat it as submitted. Earlier successful actions are unaffected; querying remains available.";
export const PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT =
  "The host blocked this private Remembrance submission. Do not treat it as submitted. Earlier successful actions are unaffected; querying remains available.";
const FEEDBACK_DENIAL_GUIDANCE =
  "For host-denied feedback, call local acknowledge_feedback_denial with the tool, exact receipt IDs, and reason host_policy_denied. Report once; do not retry through another transport.";
const PENDING_ACTION_DECLINE_REASONS = [
  "not_observed_by_this_agent",
  "agent_exited",
  "not_reusable",
  "duplicate",
];
const PENDING_ACTION_DECLINE_GUIDANCE =
  "If you cannot complete an action, call local decline_pending_action with the action_id under it and one reason (not_observed_by_this_agent, agent_exited, not_reusable, or duplicate) instead of guessing.";
// Accepted for a private line or notice only; feedback denials keep
// acknowledge_feedback_denial.
const PRIVATE_DECLINE_REASON = "host_policy_denied";
const PRIVATE_DECLINE_GUIDANCE =
  "If the host denies a private line's exact action, decline that line with reason host_policy_denied; a declined private draft stays retained, returns later only as a user decision, and is never deleted automatically.";
// The private notice for drafts awaiting the user is not a ledger record;
// it has one fixed action_id, which a decline names. The held-safety notice
// names none: its delivery marks the drafts it showed, and it needs no reply.
const PRIVATE_ORPHAN_NOTICE_ACTION_ID = createHash("sha256")
  .update("private_draft_notice:awaiting_user", "utf8")
  .digest("hex")
  .slice(0, 16);
export const PRIVATE_LESSON_AUTHORIZATION_REQUEST_TEXT =
  "Allow Remembrance to submit this retained private lesson or skill candidate to your organization?";
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
    // Byte-identical to the Codex update command in @remembrance/core
    // (codexCliCommand in agent-hosts.ts): plugins cannot import core, and
    // scripts/codex-cli-lookup.test.mjs compares every hook-core copy.
    command: `(
set +eu; unalias codex 2>/dev/null || :; unset -f codex 2>/dev/null || :
if [ -n "$CODEX_CLI" ]; then
  [ -x "$CODEX_CLI" ] || { printf 'CODEX_CLI is set but is not an executable file: %s\\n' "$CODEX_CLI" >&2; exit 1; }
else
  best=-1
  for c in "$(command -v codex 2>/dev/null)" \\
    /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \\
    /Applications/ChatGPT.app/Contents/Resources/codex \\
    /Applications/Codex.app/Contents/Resources/codex; do
    case "$c" in /*) [ -x "$c" ] || continue ;; *) continue ;; esac
    out=$("$c" --version </dev/null 2>/dev/null) || continue
    v=$(printf '%s\\n' "$out" | awk 'match($0, /[0-9]+[.][0-9]+[.][0-9]+/) { split(substr($0, RSTART, RLENGTH), n, "."); v = n[1] * 1000000 + n[2] * 1000 + n[3]; exit } END { print v + 0 }')
    [ "$v" -gt "$best" ] && best=$v && CODEX_CLI=$c
  done
  [ -n "$CODEX_CLI" ] || { printf '%s\\n' "Codex CLI not found. Install the Codex CLI, or install or update the ChatGPT desktop app on macOS, or set CODEX_CLI to a Codex CLI path, then try again." >&2; exit 1; }
fi
printf 'Using Codex CLI: %s\\n' "$CODEX_CLI" >&2
"$CODEX_CLI" plugin marketplace upgrade remembrance &&
  "$CODEX_CLI" plugin add remembrance@remembrance --json
)`,
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

// Every common word below also matches its plural and verb forms (-s/-es,
// -ed, -ing; a final e drops before -ed and -ing): the patterns end at a word
// boundary, so "deploying" or "components" missed their own entry. Names and
// abbreviations are left as they are. No word is added this way.
const SERVICE_PATTERNS = [
  /\b(vercel|heroku|netlify|cloudflare|aws|gcp|azure)\b/i,
  /\b(github actions?|circleci|gitlab ci|buildkite|jenkins)\b/i,
  // MPP is the Machine Payments Protocol; the earlier name stays matched.
  /\b(stripe|x402|mpp|model payment protocol|machine payments? protocol|mcp servers?)\b/i,
  /\b(?:openai|anthropic|claude|voyage|mongodb atlas)\b.{0,80}\b(?:apis?|sdks?|providers?|gateways?|models?|embeddings?|integrations?|authentication|authorization|credentials?|requests?|endpoints?)\b/i,
  /\b(?:apis?|sdks?|providers?|gateways?|models?|embeddings?|integrations?|authentication|authorization|credentials?|requests?|endpoints?)\b.{0,80}\b(?:openai|anthropic|claude|voyage|mongodb atlas)\b/i,
];

const TOOL_PATTERNS = [
  /\b(next\.?js|turbopack|webpack|vite|react|prisma|drizzle)\b/i,
  /\b(esbuild|playwright|vitest|jest|typescript|node\.?js|npm)\b/i,
  /\b(mongodb|redis|bullmq|atlas vector search)\b/i,
];

const WORKFLOW_PATTERNS = [
  /\b(deploy(?:s|ed|ing|ments?)?|migrat(?:e|es|ed|ing|ions?)|ci\/cd|ci|pipelin(?:e|es|ed|ing))\b/i,
  /\b(payments? integrations?|schemas? upgrad(?:e|es|ed|ing)|observability|monitoring)\b/i,
  /\b(build errors?|releas(?:e|es|ed|ing)|rollbacks?|provision(?:s|ed|ing)?|backfill(?:s|ed|ing)?)\b/i,
];

const UI_PATTERNS = [
  /\b(web ?uis?|ux|usability|accessibility|a11y|responsive|frontends?|front-ends?)\b/i,
  /\b(dashboards?|admin (?:pages?|panels?|surfaces?)|review cards?|settings layouts?)\b/i,
  /\b(layouts?|nav(?:igations?| bars?| panels?)?|sidebars?|modals?|tooltips?|popovers?)\b/i,
  /\b(tailwind|styling|components?|buttons?|form designs?|redesign(?:s|ed|ing)?|declutter(?:s|ed|ing)?|design systems?)\b/i,
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

// Positive setup-state acknowledgments can contain a service name without
// asking the agent to do any work. Keep this semantic and anchored: short
// action prompts still flow through the contextual-continuation path below.
const FRAGMENTARY_STATUS_ACKNOWLEDGMENT_PATTERNS = [
  /^\s*(?:the\s+)?[a-z][a-z0-9._-]*(?:\s+(?:cli|account|session))?\s+(?:(?:is|has)\s+)?(?:now\s+)?(?:logged\s+in|authenticated|connected)\s*[.!]*\s*$/i,
  /^\s*(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:now\s+)?(?:logged\s+in|authenticated|connected)\s+(?:to|with)\s+[a-z][a-z0-9._-]*\s*[.!]*\s*$/i,
  /^\s*[a-z][a-z0-9._-]*\s+(?:login|authentication|connection)\s+(?:succeeded|(?:is\s+)?(?:done|complete))\s*[.!]*\s*$/i,
];

const EXPLICIT_SKILL_REFERENCE_PATTERNS = [
  /\bremembrance:\/\/skills\/[^\s"'<>]+/i,
  /\/remembrance:use\b/i,
  /\binvoke_skill\b/i,
  /\b(?:use|invoke|open|load|select)\s+(?:the\s+)?remembrance\s+skill(?:\s+(?:named|called))?\s+[`"']?[a-z0-9][a-z0-9._-]*[`"']?/i,
  /\b(?:use|invoke|open|load|select)\s+(?:the\s+)?skill\s+(?:named|called)\s+[`"']?[a-z0-9][a-z0-9._-]*[`"']?\s+(?:from|in)\s+remembrance\b/i,
];

// A closed class (coordinator decision, 2026-09-29): a request for an
// existing reusable skill, resource, workflow or registry before building
// one, the request Remembrance exists for. It holds reuse and registry words
// only. No vendor, product or topic word belongs here: searching more topics
// is the owner's open decision, not an addition to this list. It is
// consulted only after every stop rule and every topic rule found nothing,
// and hygiene still applies to what it matches.
export const REUSE_REQUEST_PATTERNS = Object.freeze([
  /\bskills?\b.{0,60}\b(?:registry|registries|marketplace|installable|published)\b/i,
  /\b(?:find|search|look up|install)\b.{0,40}\bskills?\b/i,
  /\b(?:ready[- ]made|reusable|proven|off[- ]the[- ]shelf|already (?:published|built))\b.{0,40}\b(?:packages?|skills?|resources?|workflows?|approach(?:es)?|instructions?|capabilit(?:y|ies)|solutions?|recipes?|playbooks?)\b/i,
  /\b(?:someone|anyone)\s+(?:already|has)\s+(?:published|built|written|shared)\b/i,
  /\b(?:before|instead of|rather than)\s+(?:building|writing|creating|starting|prompting|rolling)\b.{0,40}\b(?:our own|custom|from scratch|ourselves)\b/i,
  /\bshared\s+(?:registry|operational memory)\b/i,
]);

export function isReuseRequest(prompt) {
  const text = String(prompt ?? "");
  return REUSE_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

// Task-shape default (owner decision 34C, 2026-09-29): a prompt no stop rule,
// topic rule or reuse rule decided is searched once it holds at least this
// many characters, with trigger reason task_shape. Hygiene still stops host
// text, redaction and the preview cap are unchanged, and a contextual
// continuation keeps its full-conversation query directive. An empty
// task-shape search adds no no-match block, eligibility or feedback
// obligation (see buildPromptHookResult). Cursor, whose hook never searches,
// keeps deciding on the keyword triggers alone.
// REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=0 restores keyword-only searching.
const TASK_SHAPE_MIN_CHARACTERS = 40;

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

// A triggered search stops when the prompt is host text (searchHygieneReason);
// REMEMBRANCE_AUTO_QUERY_HYGIENE=0 turns that off. Hygiene never turns a
// prompt without a trigger into a search or changes its reason.
export function shouldQueryPrompt(prompt, env = process.env) {
  const decision = triggerDecision(prompt, env);
  if (!decision.likely_match || disabled(env?.REMEMBRANCE_AUTO_QUERY_HYGIENE)) {
    return decision;
  }
  const hygiene = searchHygieneReason(prompt);
  return hygiene
    ? {
        likely_match: false,
        reason: `hygiene_${hygiene}`,
        hygiene,
        trigger: decision.reason,
      }
    : decision;
}

function triggerDecision(prompt, env = process.env) {
  const userPrompt = userPromptOutsideHostNotifications(prompt);
  if (userPrompt === null) {
    return { likely_match: false, reason: "host_notification" };
  }
  const normalized = userPrompt.trim();
  if (!normalized || normalized.length < 8) {
    return { likely_match: false, reason: "empty_or_too_short" };
  }
  if (
    FRAGMENTARY_STATUS_ACKNOWLEDGMENT_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  ) {
    return { likely_match: false, reason: "status_acknowledgment" };
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
  if (
    /\b(integrat(?:e|es|ed|ing|ions?)|configur(?:e|es|ed|ing)|setups?|set up|sets up|setting up)\b/i.test(
      normalized,
    )
  ) {
    return { likely_match: true, reason: "third_party_integration" };
  }
  if (isReuseRequest(normalized)) {
    return { likely_match: true, reason: "reuse_request" };
  }
  if (
    !disabled(env?.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE) &&
    normalized.length >= TASK_SHAPE_MIN_CHARACTERS &&
    !CONTEXTUAL_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return { likely_match: true, reason: "task_shape" };
  }
  return { likely_match: false, reason: "no_trigger_match" };
}

// Envelopes hosts wrap around text they generate: notifications, reminders
// and statuses; Claude Code's local-command, bash-mode and hook-output blocks
// (its own reserved names: command-name, local-command-caveat, bash-input,
// ...); and Codex's contextual items (turn_aborted, user_shell_command,
// environment_context), which it records as user-role messages.
const HOST_EVENT_TAG_NAME =
  /^(?:(?:codex|system|host|task|background|subagent|tool)[_-]?(?:notification|completion|status|result|reminder)|notification|system|command[_-](?:name|message|args)|local[_-]command[_-](?:caveat|stdout|stderr)|bash[_-](?:input|stdout|stderr|exit[_-]code)|user[_-]prompt[_-]submit[_-]hook|turn[_-]aborted|user[_-]shell[_-]command|environment[_-]context)$/iu;

// Claude Code builds a task notification as the envelope plus optional
// trailing text (a stalled command's last output, a cloud review's findings)
// and hooks each queued notification on its own, so nothing after one is the
// user's; a Codex subagent notification carries the subagent's own message.
// The header Claude's wrappers put before a notification says the same.
const NOTIFICATION_TAG = /<\s*(?:task|subagent)[_-]?notification(?=[\s/>]|$)/iu;
const HOST_NOTIFICATION_HEADER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

// Only leading host envelopes are metadata. Scan at most 64 KiB / 256 tokens,
// tracking nested host tags and quoted/opaque markup so an inner close cannot
// expose notification prose. An unclosed or over-budget envelope has no proven
// user-text boundary; null keeps it out of capture and querying. A body is
// host text, not markup (command output, a subagent's message): a closing tag
// in it ends its envelope early. So an envelope holding a notification or its
// header has no user text after it at all, and a stripped envelope's closing
// tag after its end shows that end was not the real one.
function userPromptOutsideHostNotifications(prompt) {
  const text = String(prompt ?? "");
  const scan = text.slice(0, 64 * 1024);
  const leading = /^\s*(?:<\?xml\s[^?]*\?>\s*)?/iu.exec(scan)[0];
  const opening = /<\s*([a-z][a-z0-9_.:-]*)(?=[\s/>]|$)/iy;
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\s*(\/?)\s*([a-z][a-z0-9_.:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/giy;
  let cursor = leading.length;
  let tokens = 0;
  const stripped = new Set();
  while (true) {
    if (scan.startsWith(HOST_NOTIFICATION_HEADER, cursor)) return null;
    opening.lastIndex = cursor;
    const start = opening.exec(scan);
    if (!start || !HOST_EVENT_TAG_NAME.test(start[1])) {
      if (stripped.size === 0) return text;
      const rest = text.slice(cursor).trimStart();
      return rest && !closesStrippedEnvelope(rest, stripped) ? rest : null;
    }
    const envelopeStart = cursor;
    const stack = [];
    do {
      if (++tokens > 256) return null;
      token.lastIndex = cursor;
      const part = token.exec(scan);
      if (!part) return null;
      const name = part[2]?.toLowerCase();
      if (name && HOST_EVENT_TAG_NAME.test(name)) {
        if (part[1]) {
          if (!/^<\s*\/\s*[a-z][a-z0-9_.:-]*\s*>$/iu.test(part[0])) return null;
          if (stack.pop() !== name) return null;
        } else if (!/\/\s*>$/u.test(part[0])) {
          stack.push(name);
        }
      }
      cursor = token.lastIndex;
      if (stack.length > 0) {
        cursor = scan.indexOf("<", cursor);
        if (cursor < 0) return null;
      }
    } while (stack.length > 0);
    // A notification, leading or inside another envelope, or its header:
    // nothing in this prompt is the user's.
    const envelope = scan.slice(envelopeStart, cursor);
    if (
      envelope.includes(HOST_NOTIFICATION_HEADER) ||
      NOTIFICATION_TAG.test(envelope)
    ) {
      return null;
    }
    stripped.add(start[1].toLowerCase());
    while (cursor < scan.length && /\s/u.test(scan[cursor])) cursor += 1;
    if (cursor === scan.length && scan.length < text.length) return null;
  }
}

function closesStrippedEnvelope(text, names) {
  for (const tag of text.matchAll(/<\s*\/\s*([a-z][a-z0-9_.:-]*)\s*>/giu)) {
    if (names.has(tag[1].toLowerCase())) return true;
  }
  return false;
}

export function isHostNotificationPrompt(prompt) {
  return userPromptOutsideHostNotifications(prompt) === null;
}

// --- Search hygiene ----------------------------------------------------------

// Text a host generates and delivers as if the user had typed it: a Codex
// commit or pull-request generation prompt, a Claude Code subagent's hand-back,
// a Codex message-board notification, Claude Code's persisted tool output,
// pasted `git status` output, or an explicit local skill invocation. Each rule
// is the host's own text anchored at the start of what remains after leading
// host envelopes are stripped, never a length or a user-written phrase. A text
// that holds the user's words after the host block is not matched, and a text
// cut inside the block (a stored 1,200-character summary) is: a replay may
// over-count stops but never misses one. A match stops only the skill search;
// the hook still delivers everything else it would have delivered.
const HOST_GENERATION_PROMPT =
  /^(?:Using the supplied git context below, generate a git commit message\.|You are a helpful assistant\. Generate a pull request title and body\.|Using the supplied commit and pull request contexts below, generate one git commit message plus one pull request title and body\.)\s*\n\s*Write the result into the structured response fields? /u;
const HOST_ENVELOPE_RULES = [
  {
    reason: "subagent_handback",
    open: /^<agent-message\b[^>]*>\s*\n\[Subagent hand-back\]/u,
    close: "</agent-message>",
    trailer: null,
  },
  {
    reason: "host_notification_relay",
    open: /^<agent_message_board_notification>/u,
    close: "</agent_message_board_notification>",
    trailer: "[Use read_post for the rest.]",
  },
  {
    reason: "tool_output_echo",
    open: /^<persisted-output>\s*\nOutput too large \(/u,
    close: "</persisted-output>",
    trailer: null,
  },
];
const GIT_STATUS_HEAD = /^(?:On branch \S+|HEAD detached (?:at|from) \S+)$/u;
const GIT_STATUS_LINE =
  /^(?:[\t ]|Your branch |and have \d+ and \d+ different commits each, respectively\.$|(?:Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Ignored files):$|You have unmerged paths\.$|All conflicts fixed but you are still merging\.$|You are currently |No commits yet$|no changes added to commit|nothing to commit|nothing added to commit but untracked files present)/u;
const LOCAL_SKILL_REFERENCES = [
  // Codex's explicit skill mention link (an app connector link is not one).
  /^\[\$[a-z0-9][a-z0-9_:-]*\]\((?!app:\/\/)[^()\n]+\)/u,
  // A namespaced (plugin) or dashed slash command.
  /^\/[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$)/u,
  /^\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?=\s|$)/u,
];

function wholeHostEnvelope(text, rule) {
  if (!rule.open.test(text)) return false;
  const end = text.indexOf(rule.close);
  if (end < 0) return true;
  let rest = text.slice(end + rule.close.length).trim();
  if (rule.trailer && rest.startsWith(rule.trailer)) {
    rest = rest.slice(rule.trailer.length).trim();
  }
  return rest.length === 0;
}

function wholeGitStatus(text) {
  const [head, ...lines] = text.split(/\r?\n/u);
  if (!GIT_STATUS_HEAD.test(head)) return false;
  const body = lines.filter((line) => line.trim());
  return body.length > 0 && body.every((line) => GIT_STATUS_LINE.test(line));
}

// OpenCode prompts can open with a closed block of other projects' examples
// that is not the user's request. With
// REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT=1 (off by default) the search
// decision and query read only what follows it; everything else still reads
// the whole prompt. An unclosed or later block leaves the prompt whole.
const INJECTED_CONTEXT_BLOCK =
  /^\s*<compartment_examples_from_other_projects>[\s\S]*?<\/compartment_examples_from_other_projects>/u;

export function searchTextForPrompt(prompt, env = process.env) {
  const text = String(prompt ?? "");
  if (
    !/^(1|true|yes)$/i.test(
      String(env?.REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT ?? "").trim(),
    )
  ) {
    return text;
  }
  const block = INJECTED_CONTEXT_BLOCK.exec(text);
  return block ? text.slice(block[0].length).trim() : text;
}

// A content-free reason when the prompt is host text a skill search should
// not run on, else null. Independent of the trigger rules.
export function searchHygieneReason(prompt) {
  const userPrompt = userPromptOutsideHostNotifications(prompt);
  if (userPrompt === null) return null;
  const text = userPrompt.trim();
  if (!text) return null;
  if (HOST_GENERATION_PROMPT.test(text)) return "host_generation_prompt";
  const envelope = HOST_ENVELOPE_RULES.find((rule) =>
    wholeHostEnvelope(text, rule),
  );
  if (envelope) return envelope.reason;
  if (wholeGitStatus(text)) return "status_output";
  if (LOCAL_SKILL_REFERENCES.some((pattern) => pattern.test(text))) {
    return "local_skill_reference";
  }
  return null;
}

function containsHostEventMarkup(value) {
  if (String(value ?? "").includes(HOST_NOTIFICATION_HEADER)) return true;
  const tags = String(value ?? "").matchAll(
    /<\s*\/?\s*([a-z][a-z0-9_.:-]*)(?=[\s/>]|$)/giu,
  );
  for (const tag of tags) {
    if (HOST_EVENT_TAG_NAME.test(tag[1])) return true;
  }
  return false;
}

// Servers before 2026-08-23 titled and described the proposal with the query's
// summary (the title cut to 77 characters and "..."), and a hook's summary is
// the user's prompt. The hook never offers prompt text as a skill idea: a
// proposal whose title or description is part of the summary, or holds all of
// it, is left out, and the agent names an idea after the work.
function echoedQueryText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/(?:\.\.\.|\u2026)$/u, "")
    .trim()
    .toLowerCase();
}

function echoesQuerySummary(value, querySummary) {
  const text = echoedQueryText(value);
  const summary = echoedQueryText(querySummary);
  return (
    text.length > 0 &&
    summary.length > 0 &&
    (summary.includes(text) || text.includes(summary))
  );
}

function safeProposedSkillIdeaPayload(noResults, querySummary = null) {
  const payload = noResults?.propose_skill_idea_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (
    typeof payload.title !== "string" ||
    !payload.title.trim() ||
    typeof payload.description !== "string" ||
    !payload.description.trim() ||
    containsHostEventMarkup(payload.title) ||
    containsHostEventMarkup(payload.description) ||
    echoesQuerySummary(payload.title, querySummary) ||
    echoesQuerySummary(payload.description, querySummary)
  ) {
    return null;
  }
  return payload;
}

export function isContextualContinuationPrompt(prompt) {
  const normalized = userPromptOutsideHostNotifications(prompt)?.trim() ?? "";
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
  let redacted = userPromptOutsideHostNotifications(prompt) ?? "";
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

// --- Private keys ------------------------------------------------------------

// Client 0.2.6 stopgap (lesson-redaction research, finding F1): redaction
// blanks named token shapes but not key blocks, and the server's relevance
// judge receives a search's task text as sent, so a search would carry a
// pasted private key off the machine. A search the hook would run on a prompt
// that carries a private key is skipped whole: nothing is sent, the prompt
// itself is left as it is, and the decision keeps only the content-free
// reason "private_key". It replaces a hygiene stop too, whose failed
// preference read would fall back to the search. Callers pass the prompt
// before redaction, which can blank a key's first line and keep the rest.
// Other decisions are returned as they are.
export function withoutPrivateKeySearch(decision, prompt) {
  if (!decision.likely_match && !decision.hygiene) return decision;
  return promptCarriesPrivateKey(prompt)
    ? { likely_match: false, reason: "private_key" }
    : decision;
}

// A PEM private-key label (RFC 7468, or the four-dash SSH2 form), whose words
// a wrapped or quoted line may split, the header of a legacy encrypted PEM key
// (RFC 1421), which stays when its label is lost, or a PuTTY key-file label
// and its value.
const PRIVATE_KEY_LABEL =
  /-{4,5}[^A-Za-z0-9]{0,8}?BEGIN(?:[^A-Za-z0-9]{1,8}[A-Z0-9]{1,16}){0,4}?[^A-Za-z0-9]{1,8}PRIVATE[^A-Za-z0-9]{1,8}KEY(?:[^A-Za-z0-9]{1,8}BLOCK)?[^A-Za-z0-9]{0,8}?-{4,5}|Proc-Type\s{0,4}:\s{0,4}4,ENCRYPTED|(?:PuTTY-User-Key-File-\d{1,2}|Private-Lines)\s{0,4}:\s{0,4}\S{0,64}/giu;
// Key text right after a label: past line breaks, quote or comment marks and
// at most four "Name: value" headers (Proc-Type, DEK-Info, Comment, ...), 16
// base64 characters.
const KEY_TEXT_AFTER_LABEL =
  /[^A-Za-z0-9]{0,32}(?:[A-Za-z][\w-]{0,40}:(?:[^\n]{0,256}\n|[ \t]{0,4}\S{1,256}[ \t])[^A-Za-z0-9]{0,32}){0,4}[A-Za-z0-9+/]{16}/uy;
const BASE64_RUN = /[A-Za-z0-9+/]{16,}/gu;
// A run and the lines that continue it, as openssl base64 (64 characters a
// line) and base64 (76) wrap an encoding: base64 characters and the line
// breaks and indentation between them, at most 768 of these steps.
const WRAPPED_RUN =
  /(?:[A-Za-z0-9+/]|\r?\n[ \t]{0,8}(?=[A-Za-z0-9+/])){1,768}/uy;

// Whether a text carries a private key in a common text form: a labeled key
// file (PEM, PuTTY) with its key text, or base64 whose leading bytes open a
// private key (a bare or MIME-wrapped body whose labels were lost, or a key
// file encoded once more, on one line or wrapped). Structural signals only,
// no word list: a few passes over the text, and at each of its first four
// positions a base64 run decodes at most 48 bytes (576 for an encoded key
// file, which is scanned in turn; no line is read as part of two wrapped
// encodings).
// ponytail: not recognized are a key missing both its begin label and its
// first body line; a PGP, SSH2 or PuTTY body without its labels, or a legacy
// encrypted PEM body without its Proc-Type header too; an SSH2 file flattened
// onto one line under a quoted Comment; a key file encoded once more whose
// text does not open with its label (a PuTTY file, a JSON file that holds a
// key); and byte-array, hex, JWK and PKCS #12 forms. The 0.2.6 redactor
// replaces this stopgap.
export function promptCarriesPrivateKey(prompt) {
  // Invisible format characters (a zero-width space, a soft hyphen) that a
  // page or editor puts inside long lines are not part of the key text.
  // String literals carry a key file's line breaks as "\n" and may escape
  // its "/" (PHP) or "+" (.NET): read the characters they stand for.
  const text = String(prompt ?? "")
    .replace(/\p{Cf}/gu, "")
    .replace(
      /\\(?:[nrt]|u00([0-7][0-9A-Fa-f])|(\/))/gu,
      (_escape, code, slash) =>
        code ? String.fromCharCode(Number.parseInt(code, 16)) : (slash ?? "\n"),
    );
  for (const label of text.matchAll(PRIVATE_KEY_LABEL)) {
    KEY_TEXT_AFTER_LABEL.lastIndex = label.index + label[0].length;
    if (KEY_TEXT_AFTER_LABEL.test(text)) return true;
  }
  let wrappedEnd = 0;
  for (const { 0: run, index } of text.matchAll(BASE64_RUN)) {
    WRAPPED_RUN.lastIndex = index;
    const wrapped = index < wrappedEnd ? run : WRAPPED_RUN.exec(text)[0];
    wrappedEnd = Math.max(wrappedEnd, index + wrapped.length);
    if (base64RunOpensPrivateKey(run, wrapped)) return true;
  }
  return false;
}

// A run may carry up to three stray characters (a diff's "+") before the key.
// "M" opens DER (0x30), "b" the OpenSSH magic and "L" the dashes of a key
// file, which `wrapped` holds with the lines that continue the run.
function base64RunOpensPrivateKey(run, wrapped) {
  for (let offset = 0; offset < 4; offset += 1) {
    const lead = run[offset];
    if (lead === "L") {
      const file = Buffer.from(wrapped.slice(offset, offset + 768), "base64");
      if (promptCarriesPrivateKey(file.toString("latin1"))) return true;
    } else if (lead === "M" || lead === "b") {
      const bytes = Buffer.from(run.slice(offset, offset + 64), "base64");
      if (
        derOpensPrivateKey(bytes) ||
        bytes.toString("latin1", 0, 15) === "openssh-key-v1\0"
      ) {
        return true;
      }
    }
  }
  return false;
}

// The first fields of a DER private key: PKCS #1 RSA or OpenSSL DSA (version,
// then a large integer), SEC 1 EC (version 1, then the private value), PKCS #8
// (version, then an algorithm) or an EncryptedPrivateKeyInfo (a PKCS #5 or
// PKCS #12 password-based scheme). Certificates, public keys, requests and
// signatures open with other fields.
function derOpensPrivateKey(bytes) {
  const key = derHeader(bytes, 0);
  if (key?.tag !== 0x30) return false;
  const first = derHeader(bytes, key.start);
  if (first?.tag === 0x30) {
    const scheme = derHeader(bytes, first.start);
    return (
      scheme?.tag === 0x06 &&
      /^2a864886f70d01(?:05|0c01)/u.test(
        bytes.toString("hex", scheme.start, scheme.start + scheme.length),
      )
    );
  }
  if (first?.tag !== 0x02 || first.length !== 1 || bytes[first.start] > 1) {
    return false;
  }
  const second = derHeader(bytes, first.start + 1);
  if (second?.tag === 0x02) return second.length >= 64;
  if (second?.tag === 0x04) {
    return (
      bytes[first.start] === 1 && second.length >= 16 && second.length <= 80
    );
  }
  return second?.tag === 0x30 && derHeader(bytes, second.start)?.tag === 0x06;
}

// A DER tag and definite length in their shortest form, or null.
function derHeader(bytes, offset) {
  if (offset + 2 > bytes.length || bytes[offset + 1] === 0x80) return null;
  let length = bytes[offset + 1];
  let start = offset + 2;
  if (length > 0x80) {
    const width = length - 0x80;
    if (width > 3 || start + width > bytes.length || bytes[start] === 0) {
      return null;
    }
    length = 0;
    for (let index = 0; index < width; index += 1) {
      length = length * 256 + bytes[start + index];
    }
    if (length < 0x80) return null;
    start += width;
  }
  return { tag: bytes[offset], length, start };
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
// The credential and principal-session headers a hook's registry request
// carries, the same for the query and for a stopped search's preference read.
function hookRegistryHeaders(access, runtime, env, userAgent) {
  const headers = {
    "content-type": "application/json",
    "user-agent": clientUserAgent(userAgent),
  };
  const apiKey = access.credential.apiKey;
  if (apiKey) {
    headers["x-remembrance-api-key"] = apiKey;
  }
  const principalSession = readHookPrincipalSession(runtime, env, access);
  if (principalSession?.token) {
    headers["x-remembrance-principal-session"] = principalSession.token;
  }
  return { headers, principalSession };
}

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
    const { headers: registryHeaders, principalSession } = hookRegistryHeaders(
      access,
      normalizeRuntime(payload?.client_context?.runtime),
      env,
      options.userAgent,
    );
    const headers = {
      ...registryHeaders,
      [CLIENT_CAPABILITIES_HEADER]:
        autoQueryTimeoutMs(env) >= DEFAULT_SEARCH_TIMEOUT_MS
          ? `${PRIVATE_LEARNING_CAPTURE_CAPABILITY}, ${RELEVANCE_JUDGE_WAIT_CAPABILITY}`
          : PRIVATE_LEARNING_CAPTURE_CAPABILITY,
    };
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

// A search the hygiene rules stopped still delivers what it would have
// governed the task with. An organization credential reads the policy,
// required settings and preferences from the effective-preferences endpoint
// for the would-be query's domain and project, with the query's credential
// and principal session; a caller without a credential has none to read.
// `context` opens with the header a search's context opens with; `governs`
// is false when it carries nothing past it, and the hook then delivers it
// only beside another addition. `search` is true when the read failed, the
// policy was not confirmed or the shared config is unusable: the hook then
// runs the search the rule stopped, exactly as without the rule, so a failed
// read never costs a delivery, and a search that fails too fails closed.
export async function stoppedSearchGovernance(payload, options = {}) {
  const env = options.env ?? process.env;
  const access = resolveApiAccessSnapshot(env);
  if (isUnusableConfigurationSource(access.credential.source)) {
    return { search: true };
  }
  const nothing = {
    search: false,
    governs: false,
    context: AUTO_QUERY_CONTEXT_HEADER,
  };
  if (!access.credential.apiKey) return nothing;
  const projectKey = payload?.client_context?.project_key;
  const body = await readEffectivePreferences(
    {
      keys: [],
      domains: [payload?.task?.domain].filter(Boolean),
      ...(projectKey ? { project_key: projectKey } : {}),
    },
    {
      ...options,
      env,
      access,
      runtime: normalizeRuntime(payload?.client_context?.runtime),
    },
  );
  if (!body || !["allow", "org_only"].includes(body.skill_access?.policy)) {
    return { search: true };
  }
  const context = governanceContext(body, {
    maxChars: options.maxChars ?? 32_000,
  });
  return context ? { search: false, governs: true, context } : nothing;
}

async function readEffectivePreferences(request, options) {
  const env = options.env;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    autoQueryTimeoutMs(env, DEFAULT_TIMEOUT_MS),
  );
  try {
    const { headers } = hookRegistryHeaders(
      options.access,
      options.runtime,
      env,
      options.userAgent,
    );
    const response = await (options.fetchImpl ?? fetch)(
      `${options.access.apiConfiguration.apiUrl}/api/v1/agent/preferences/effective`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      debugLog(
        env,
        "effective_preferences_http_error",
        { status: response.status },
        options,
      );
      return null;
    }
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch (error) {
    debugLog(
      env,
      errorName(error) === "AbortError"
        ? "effective_preferences_timeout"
        : "effective_preferences_error",
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
// `options.env` selects the capture guidance of the empty-result context that
// carries a filtered response's organization policy and required settings.
// `options.querySummary`, the summary the query sent, keeps a proposal that
// repeats it out of the context.
export function formatContext(
  response,
  reason = "trigger_match",
  limit = DEFAULT_LIMIT,
  options = {},
) {
  const body = responseBodyFromToolResponse(response);
  const itemLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 10);
  const skills = Array.isArray(body?.skills)
    ? body.skills
        .filter((item) => publicSkillCandidateAllowed(body, item))
        .filter(autoQuerySkillAllowed)
        .slice(0, itemLimit)
    : [];
  const resources = Array.isArray(body?.resources)
    ? body.resources
        .filter(autoQueryResponseCandidateAllowed)
        .slice(0, itemLimit)
    : [];
  const noResults = body?.no_results ?? null;
  const { governanceLines, discretionaryPreferenceLines } =
    governanceContextLines(body);
  if (skills.length === 0 && resources.length === 0 && !noResults) {
    // The server sends no_results only for raw-empty arrays, so a response
    // whose every candidate was filtered out arrives without it. Its
    // governance still applies, in the empty-result context and without any
    // filtered candidate, ID, or offer.
    return governanceLines.length > 0
      ? emptyQueryContext(reason, options.env, governanceLines)
      : null;
  }

  const lines = [
    "Remembrance auto-query context:",
    `Trigger: ${reason}. Use these results only if they fit the user's task constraints.`,
    ...governanceLines,
  ];
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
    const requiredAction = `HIGH MATCH — required next step: call ${tool} with ${JSON.stringify(args)} before proceeding.`;
    const explanation = boundedContextSection(
      `${highMatch.match_reason}; ${matchEvidenceLabel(highMatch)}. If it does not actually fit, do not force its use: submit query feedback with fit poor and a concrete reason.`,
      Math.max(80, 720 - requiredAction.length - 1),
    );
    lines.push(`${requiredAction} ${explanation}`.trim());
  }
  // Tail lines (the no-results payload, the contribution directive, and the
  // delegation instruction) are the actionable part of this context. They are
  // reserved BEFORE candidate lines fill the remaining budget — the previous
  // append-then-truncate order let rich per-candidate decision labels push
  // them past MAX_CONTEXT_CHARS, silently evicting the directive.
  const requiredTailLines = [];
  const optionalItems = [];
  if (noResults) {
    const proposedSkillIdea = safeProposedSkillIdeaPayload(
      noResults,
      options.querySummary,
    );
    requiredTailLines.push(
      proposedSkillIdea
        ? `No matching skill/resource. Proposed skill idea payload: ${safeText(JSON.stringify(proposedSkillIdea), 1200)}`
        : "No matching skill/resource.",
    );
  }
  const contributionDirective =
    body?.contribution_directive?.message ?? body?.fallback_instruction;
  if (contributionDirective) {
    requiredTailLines.push(
      `After using Remembrance: ${safeText(contributionDirective, MAX_DIRECTIVE_CHARS)}`,
    );
  }
  const preferenceEvidence = preferenceCompatibilityEvidenceFromResponse(body);
  if (preferenceEvidence.length > 0) {
    optionalItems.push({
      line: preferenceCompatibilityEvidenceInstruction(preferenceEvidence),
      fallback: null,
    });
  }
  if (skills.length > 0 || resources.length > 0) {
    requiredTailLines.push(
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
  return prioritizedQueryContext({
    criticalLines: lines,
    candidateSections,
    optionalItems: [
      ...optionalItems,
      ...discretionaryPreferenceItems(discretionaryPreferenceLines),
    ],
    requiredTailLines,
    maxChars: options.maxChars ?? MAX_CONTEXT_CHARS,
  });
}

const AUTO_QUERY_CONTEXT_HEADER = "Remembrance auto-query context:";

const ORGANIZATION_ONLY_POLICY_LINE =
  "Organization policy: use organization skills only. Do not use public skills or bundled public skill references, including as an offline fallback.";

// The organization policy and required settings govern the task whether or
// not any returned candidate applies to it; discretionary preferences follow.
function governanceContextLines(body) {
  const governanceLines = [];
  if (body?.skill_access?.policy === "org_only") {
    governanceLines.push(ORGANIZATION_ONLY_POLICY_LINE);
  }
  const effectivePreferenceLines = effectivePreferencesContextLines(
    body?.effective_preferences,
  );
  governanceLines.push(
    ...effectivePreferenceLines.filter((line) =>
      line.startsWith("Required organization settings"),
    ),
  );
  const discretionaryPreferenceLines = effectivePreferenceLines.filter(
    (line) => !line.startsWith("Required organization settings"),
  );
  return { governanceLines, discretionaryPreferenceLines };
}

function discretionaryPreferenceItems(lines) {
  return lines.map((line) => ({
    line,
    fallback:
      "Discretionary preferences omitted from this bounded hook context; call get_effective_preferences when they could affect the task.",
  }));
}

// What a query context says whatever the results: the organization policy,
// required settings and discretionary preferences of a query or
// effective-preferences response body, in a query context's own words and
// order. Null when there are none.
export function governanceContext(body, options = {}) {
  const { governanceLines, discretionaryPreferenceLines } =
    governanceContextLines(body);
  if (
    governanceLines.length === 0 &&
    discretionaryPreferenceLines.length === 0
  ) {
    return null;
  }
  return prioritizedQueryContext({
    criticalLines: [AUTO_QUERY_CONTEXT_HEADER, ...governanceLines],
    candidateSections: [],
    optionalItems: discretionaryPreferenceItems(discretionaryPreferenceLines),
    requiredTailLines: [],
    maxChars: options.maxChars ?? MAX_CONTEXT_CHARS,
  });
}

// What an empty task-shape search delivers (owner decision 34C): exactly what
// a keyword-triggered empty search delivers without its no-match block. That
// is the organization policy and required settings, and the discretionary
// preferences when the server reported the empty result itself (no_results);
// formatContext leaves those out of an answer whose every candidate the
// client dropped. `governs` is false when there is none of them, and the
// header then only introduces the prompt's own additions.
export function emptyTaskShapeContext(response, options = {}) {
  const body = responseBodyFromToolResponse(response);
  const { governanceLines, discretionaryPreferenceLines } =
    governanceContextLines(body);
  const discretionary = body?.no_results ? discretionaryPreferenceLines : [];
  if (governanceLines.length === 0 && discretionary.length === 0) {
    return { governs: false, context: AUTO_QUERY_CONTEXT_HEADER };
  }
  return {
    governs: true,
    context: prioritizedQueryContext({
      criticalLines: [AUTO_QUERY_CONTEXT_HEADER, ...governanceLines],
      candidateSections: [],
      optionalItems: discretionaryPreferenceItems(discretionary),
      requiredTailLines: [],
      maxChars: options.maxChars ?? 32_000,
    }),
  };
}

function joinedLength(lines) {
  return lines.reduce(
    (total, line) => total + line.length,
    Math.max(0, lines.length - 1),
  );
}

// Preserve task authority and one actionable candidate before reconstructable
// lifecycle guidance. Optional lines are included only as complete lines.
function prioritizedQueryContext({
  criticalLines,
  candidateSections,
  optionalItems,
  requiredTailLines,
  maxChars = MAX_CONTEXT_CHARS,
}) {
  const total = candidateSections.reduce(
    (count, section) => count + section.lines.length,
    0,
  );
  const omissionNote = (count) =>
    `(+${count} more match${count === 1 ? "" : "es"} omitted to fit this context; call query_skills with the current task context to retrieve the full list.)`;
  const selected = [...criticalLines];
  const entries = candidateSections.flatMap((section) =>
    section.lines.map((line, index) => ({
      header: index === 0 ? section.header : null,
      line,
    })),
  );
  const optionalFallbackLines = optionalItems
    .map((item) => item.fallback)
    .filter(Boolean);
  let shown = 0;

  if (entries.length > 0) {
    const first = entries[0];
    const header = [first.header].filter(Boolean);
    const fixedLines = [
      ...selected,
      ...header,
      ...optionalFallbackLines,
      ...requiredTailLines,
    ];
    const firstLineBudget = maxChars - joinedLength(fixedLines) - 1;
    if (firstLineBudget < 120) {
      throw new Error("Critical Remembrance query context exceeds its budget.");
    }
    selected.push(
      ...header,
      boundedContextSection(first.line, firstLineBudget),
    );
    shown = 1;
  }

  const appendIfFits = (candidateLines, reservedLines = []) => {
    const completeLines = candidateLines.filter(Boolean);
    const next = [...selected, ...completeLines, ...reservedLines];
    if (joinedLength(next) > maxChars) return false;
    selected.push(...completeLines);
    return true;
  };
  for (const entry of entries.slice(shown)) {
    const remainingAfter = total - (shown + 1);
    const reserve = [
      ...(remainingAfter > 0 ? [omissionNote(remainingAfter)] : []),
      ...optionalFallbackLines,
      ...requiredTailLines,
    ];
    if (!appendIfFits([entry.header, entry.line], reserve)) break;
    shown += 1;
  }
  if (total > shown) {
    appendIfFits(
      [omissionNote(total - shown)],
      [...optionalFallbackLines, ...requiredTailLines],
    );
  }
  for (let index = 0; index < optionalItems.length; index += 1) {
    const item = optionalItems[index];
    const laterFallbacks = optionalItems
      .slice(index + 1)
      .map((entry) => entry.fallback)
      .filter(Boolean);
    if (!appendIfFits([item.line], [...laterFallbacks, ...requiredTailLines])) {
      appendIfFits([item.fallback], [...laterFallbacks, ...requiredTailLines]);
    }
  }
  if (!appendIfFits(requiredTailLines)) {
    throw new Error("Critical Remembrance query tail exceeds its budget.");
  }
  return selected.join("\n");
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
  const judged = relevanceJudgeFit(candidate);
  if (judged) evidence.push(`relevance judge: ${judged} fit`);
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
      `applicability ${applicability.fit}/${applicability.scope}${APPLICABILITY_PROVENANCE_NOTES[applicability.provenance] ?? ""}: ${applicability.reason}`,
    );
    // A stated use condition only promotes (plan 15.8, owner decision 43 = A).
    if (applicability.use_when.length) {
      applicabilityParts.push(
        `use when ${applicability.use_when.join("; ")}`,
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
  // The decision note is capped, so it carries discretionary preferences only;
  // required settings stay in their own line, complete or fetched by key.
  const settings = sanitizeEffectivePreferenceEntries(effectivePreferences)
    .filter((entry) => !entry.mandatory)
    .map((entry) => entry.text);
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

// Reads both offer shapes. REST responses, and MCP results from a server that
// does not shape them, carry the full per-result offer: query_id, result_id and
// each setting beside its fingerprint. A shaped MCP query_skills result states
// each preference once, so its compact offer lists only
// `preference_fingerprints`; the query_id is the response's, the result_id the
// result's own, and each setting is the top-level effective_preferences entry
// that carries that fingerprint.
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
      const slug = safeFeedbackSkillSlug(candidate?.slug);
      if (!slug || seen.has(slug)) return [];
      const feedback = candidate?.preference_compatibility_feedback;
      const compact = isCompactPreferenceFeedbackOffer(feedback);
      const queryId = safeCorrelationIdentifier(
        compact ? (feedback.query_id ?? body?.query_id) : feedback?.query_id,
        160,
      );
      const resultId = safeCorrelationIdentifier(
        compact
          ? (feedback.result_id ?? candidate?.result_id)
          : feedback?.result_id,
        160,
      );
      const skillVersionId = safeCorrelationIdentifier(
        feedback?.skill_version_id,
        160,
      );
      const preferences = sanitizePreferenceFeedbackSettings(
        compact
          ? preferenceFeedbackEntriesFromStatements(
              feedback.preference_fingerprints,
              body?.effective_preferences,
            )
          : feedback?.preferences,
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

function isCompactPreferenceFeedbackOffer(feedback) {
  return (
    Boolean(feedback) &&
    typeof feedback === "object" &&
    !Array.isArray(feedback) &&
    !Array.isArray(feedback.preferences) &&
    Array.isArray(feedback.preference_fingerprints)
  );
}

// Resolve each compact fingerprint to the one top-level statement that carries
// it. A missing or ambiguous statement yields no evidence, never a guess.
function preferenceFeedbackEntriesFromStatements(fingerprints, statements) {
  if (!Array.isArray(statements)) return [];
  const candidates = statements
    .slice(0, MAX_EFFECTIVE_PREFERENCE_STATEMENTS)
    .filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    );
  return fingerprints
    .slice(0, MAX_EFFECTIVE_PREFERENCE_STATEMENTS)
    .flatMap((fingerprint) => {
      const matches =
        typeof fingerprint === "string"
          ? candidates.filter(
              (entry) => entry.preference_fingerprint === fingerprint,
            )
          : [];
      if (matches.length !== 1) return [];
      const [statement] = matches;
      return [
        {
          preference_fingerprint: fingerprint,
          setting: {
            key: statement.key,
            value: statement.value,
            label: statement.label,
            behavior: statement.behavior,
            effect: statement.effect,
            strength: statement.strength,
            definition_version: statement.definition_version,
          },
        },
      ];
    });
}

function preferenceCompatibilityEvidenceInstruction(evidence) {
  const payload = boundedPreferenceEvidencePayload(evidence);
  if (!payload) return "";
  const omitted =
    payload.omitted > 0
      ? ` (+${payload.omitted} more offered preference${payload.omitted === 1 ? "" : "s"} omitted to fit this hint.)`
      : "";
  return [
    "Private preference evidence (silent, after actual use only): if the selected skill clearly supports or conflicts with one server-issued working preference below, call submit_preference_compatibility_feedback using its exact query_id, result_id, preference_fingerprint, skill slug, and version id.",
    'Judge observed behavior independently: selection and an existing classifier label are not new evidence. Skip neutral or uncertain cases. Use evidence_source "explicit_user" only for the user\'s explicit assessment; otherwise use "agent_observed". Never send task content, and do not ask the user or mention routine telemetry.',
    payload.compact
      ? "An entry without label and behavior is a compact reference: before judging it, read that setting in full with get_effective_preferences and its key."
      : null,
    `Candidates: ${payload.entries}${omitted}`,
  ]
    .filter(Boolean)
    .join(" ");
}

// Inline evidence stays within PREFERENCE_EVIDENCE_CONTEXT_CHARS. An offer too
// large to repeat in full keeps its exact IDs, fingerprint, key and value as a
// compact reference, so its meaning is fetched rather than truncated. The
// first offer is always kept, at least in that form, instead of dropping the
// feedback opportunity; field limits then bound it (160-character IDs and
// slug, 96-character key and value: 1,033 characters at most). Later offers
// that do not fit are counted in the hint, never dropped silently.
function boundedPreferenceEvidencePayload(evidence) {
  const offers = evidence
    .slice(0, PREFERENCE_EVIDENCE_SKILL_LIMIT)
    .flatMap((candidate) =>
      candidate.preferences
        .slice(0, PREFERENCE_EVIDENCE_SETTING_LIMIT)
        .map((preference) => ({
          query_id: candidate.query_id,
          result_id: candidate.result_id,
          skill_slug: candidate.skill_slug,
          skill_version_id: candidate.skill_version_id,
          preference_fingerprint: preference.preference_fingerprint,
          setting: preference.setting,
        })),
    );
  const entries = [];
  const fits = (entry) =>
    JSON.stringify([...entries, entry]).length <=
    PREFERENCE_EVIDENCE_CONTEXT_CHARS;
  for (const offer of offers) {
    const reference = {
      ...offer,
      setting: { key: offer.setting.key, value: offer.setting.value },
    };
    if (fits(offer)) {
      entries.push(offer);
    } else if (entries.length === 0 || fits(reference)) {
      entries.push(reference);
    } else {
      break;
    }
  }
  return entries.length > 0
    ? {
        entries: JSON.stringify(entries),
        compact: entries.some((entry) => !("label" in entry.setting)),
        omitted: offers.length - entries.length,
      }
    : null;
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

// The exact catalog slug grammar the feedback request accepts.
function safeFeedbackSkillSlug(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text.length <= MAX_FEEDBACK_IDENTIFIER_CHARS &&
    SESSION_SKILL_SLUG_PATTERN.test(text)
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

// Who stated a result's applicability (plan 15.8): conditions the platform
// generated and no person reviewed are hints; an author's or a reviewer's
// exclusion is what makes a result unlikely. Unknown adds no note.
const APPLICABILITY_PROVENANCE_NOTES = {
  generated_unreviewed: " (generated, unreviewed)",
  reviewed: " (reviewed)",
  mixed: " (mixed provenance)",
};

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
    provenance: [
      "author_provided",
      "generated_unreviewed",
      "reviewed",
      "mixed",
    ].includes(value.provenance)
      ? value.provenance
      : "unknown",
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

export function continuationQueryContext(directive = null, env = process.env) {
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
    organizationPrivateLessonAuthorized(env)
      ? "Before finishing, call submit_query_feedback once with one complete good/partial/poor verdict set. Call submit_feedback only after real use. Route each new reusable item once through capture_learning; follow its exact next_action or bounded agent_recovery instructions. These are independent loops."
      : "Before finishing, use submit_query_feedback once with one complete set of explicit good/partial/poor query matches, submit_feedback and submit_remembrance when a returned skill was actually used, or submit a failure_report / skill idea only when a reusable lesson or genuinely missing workflow was found.",
  ].join("\n");
}

function organizationPolicyFallbackLine(env) {
  const credential = resolveApiCredential(env);
  return isUnusableConfigurationSource(credential.source)
    ? "The shared Remembrance config exists but is unreadable or invalid. Fail closed: do not use bundled public references or remote tools until the config is fixed or intentionally removed."
    : credential.apiKey
      ? "An organization API key is configured, but the organization skill policy could not be confirmed. Fail closed: do not use bundled public skill references while the query is unavailable."
      : "No organization API key is configured; bundled public references remain an optional offline fallback.";
}

export function unavailableQueryContext(env = process.env) {
  return [
    "Remembrance query-unavailable context:",
    "This task qualified for Remembrance, but the automatic query did not complete. Continue without blocking, and call query_skills directly when the MCP tool is visible.",
    organizationPolicyFallbackLine(env),
    organizationPrivateLessonAuthorized(env)
      ? "If the outage or workaround produced a reusable lesson, complete workflow, or durable preference, call capture_learning once. Query-fit feedback is unavailable without a query receipt. Never switch destination or visibility when submission is unavailable."
      : "Before finishing, submit a failure_report only if the outage or workaround produced a reusable lesson. Redact secrets, private URLs, credentials, and proprietary content.",
  ].join("\n");
}

// `governanceLines` are the organization policy and required-settings lines of
// a response whose candidates were all filtered out; they apply unchanged.
export function emptyQueryContext(
  reason = "trigger_match",
  env = process.env,
  governanceLines = [],
) {
  return [
    "Remembrance auto-query context:",
    `Trigger: ${reason}. The query completed but returned no matching skill or resource.`,
    ...governanceLines,
    organizationPrivateLessonAuthorized(env)
      ? "Use the full conversation before deciding whether the workflow is genuinely missing. A complete reusable workflow belongs in capture_learning.private_skill; a compact generalized lesson belongs in capture_learning.lesson."
      : "Use the full conversation before deciding whether the workflow is genuinely missing. Propose a skill idea only when you built a reusable workflow that the registry does not already cover.",
    organizationPrivateLessonAuthorized(env)
      ? "If you build a reusable workflow or discover a reusable lesson, capture each new item once with private_skill or lesson. Follow its exact next_action or bounded agent_recovery instructions."
      : "Before finishing, submit a failure_report when the task exposed a reusable failure lesson.",
  ].join("\n");
}

// --- High-level query orchestration ------------------------------------------

// Full prompt-hook result. `eligible` means this turn should be recovered at
// completion even if no registry result was consumed. `consumed` means a real
// query completed; `matched` means that response contained at least one result
// the current credential is allowed to use.
export async function runPromptHook(prompt, options = {}) {
  const result = await buildPromptHookResult(prompt, options);
  if (!options.deferReminderAcknowledgement) {
    acknowledgePrivateAuthorizationReminders(
      result?.context ?? "",
      options.env ?? process.env,
      options.sessionId ?? null,
    );
  }
  return result;
}

async function buildPromptHookResult(prompt, options = {}) {
  const env = options.env ?? process.env;
  const rawPrompt = userPromptOutsideHostNotifications(prompt);
  if (rawPrompt === null) {
    debugLog(env, "skip", { reason: "host_notification" }, options);
    return null;
  }
  if (options.sessionId) recordUserPrompt(options.sessionId, env);
  // Native recovery is local, bounded, and controlled by AUTO_CONTRIBUTE. It
  // remains available when registry auto-query is disabled, but only when an
  // adapter supplied a verified stable native session and an exhausted draft
  // exists. Ordinary prompts do not start a child process.
  await capturePrivateSkillNativeUserPrompt(rawPrompt, {
    env,
    nativeContextBridge: options.nativeContextBridge,
    nativeSessionId: options.nativeSessionId,
  });
  // This is the master switch for query/preference automation. Native retained
  // draft recovery above has its own explicit contribution switch.
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    debugLog(env, "disabled", {}, options);
    return null;
  }
  // Rendered for each prompt context in withContext below. A prompt that
  // names no session reads as the "unknown" ledger, as a stop that names none
  // does: silent lines only for the drafts that ledger holds a hint for, and
  // every other due or parked draft only as a user decision.
  const lifecycleRecovery =
    !options.sessionId &&
    privateLearningSessionRecovery(
      null,
      privateHintsOnMachine(null, env),
      readPrivateDrafts(env),
      env,
      { notices: !options.subagentSession },
    );
  // `subagentSession`: the host runs this session for a subagent, or cannot
  // show it is a main session, and its ledger names no agent (OpenClaw's
  // sessions_spawn; on OpenCode, every session but one created with no
  // parent session, isRecordedMainSession).
  const recovery = options.sessionId
    ? pendingCompletionRecovery(options.sessionId, env, {
        notices: !options.subagentSession,
      })
    : lifecycleRecovery && (() => lifecycleRecovery);
  const recoveryAddition = recovery
    ? { id: "private_learning_recovery", kind: "completion" }
    : null;
  const includeSharedConfigCredentialNotice =
    options.includeSharedConfigCredentialNotice !== false;
  const redacted = redactPrompt(rawPrompt);
  if (isHostNotificationPrompt(redacted)) {
    debugLog(env, "skip", { reason: "host_notification" }, options);
    return null;
  }
  const correctionCapture = userCorrectionCaptureDirective(redacted, env);
  const preferenceCapture = genericPreferenceCaptureDirective(redacted, {
    env,
    projectPath: options.projectPath,
  });
  const contextAdditions = [
    correctionCapture
      ? {
          id: "correction_capture",
          kind: "correction",
          text: correctionCapture,
        }
      : null,
    preferenceCapture
      ? {
          id: "preference_capture",
          kind: "preference",
          text: preferenceCapture,
        }
      : null,
    recoveryAddition,
    ...(Array.isArray(options.contextAdditions)
      ? options.contextAdditions
      : [options.contextAdditions]),
  ].filter(Boolean);
  const withContext = (baseContext, result) => {
    const composeWith = (text) =>
      composeBoundedHookContextResult(
        baseContext,
        contextAdditions.map((addition) =>
          addition === recoveryAddition ? { ...addition, text } : addition,
        ),
      );
    const composed = composeWith(
      recovery?.((text) => composeWith(text).context),
    );
    return {
      ...result,
      context: composed.context,
      deliveredContextAdditionIds: composed.deliveredAdditionIds,
    };
  };
  void recordExplicitPreferenceObservations(redacted, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: runtimeFromIdentity(options.identity),
    userAgent: options.userAgent,
    projectPath: options.projectPath,
  }).catch(() => 0);
  const searchText = searchTextForPrompt(redacted, env);
  let decision = withoutPrivateKeySearch(
    shouldQueryPrompt(searchText, env),
    prompt,
  );
  if (decision.hygiene) {
    // Only the skill search stops: the governance a search would have carried
    // and every addition this prompt earns are still delivered.
    debugLog(
      env,
      "search_hygiene",
      { reason: decision.reason, trigger: decision.trigger },
      options,
    );
    const stopped = await stoppedSearchGovernance(
      buildQueryPayload(
        searchText,
        env,
        options.identity,
        {
          surface: "plugin_hook",
          runtime: runtimeFromIdentity(options.identity),
          trigger_reason: decision.reason,
        },
        options.projectPath,
      ),
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        stderr: options.stderr,
        userAgent: options.userAgent,
      },
    );
    if (!stopped.search) {
      if (!stopped.governs && contextAdditions.length === 0) return null;
      return withContext(
        includeSharedConfigCredentialNotice
          ? withSharedConfigCredentialNotice(stopped.context, env)
          : stopped.context,
        {
          consumed: false,
          eligible: Boolean(correctionCapture),
          reason: decision.reason,
        },
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
    if (isContextualContinuationPrompt(searchText)) {
      const directive = await createContinuationDirective({
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        reportShown: options.reportDirectiveShown,
        runtime: runtimeFromIdentity(options.identity),
        stderr: options.stderr,
        userAgent: options.userAgent,
      });
      return withContext(continuationQueryContext(directive, env), {
        consumed: false,
        directive,
        eligible: true,
        reason: "contextual_continuation",
      });
    }
    if (preferenceCapture || correctionCapture) {
      return withContext("Remembrance capture routing:", {
        consumed: false,
        eligible: Boolean(correctionCapture),
        reason: correctionCapture ? "user_correction" : "preference_capture",
      });
    }
    if (recovery) {
      return withContext("", {
        consumed: false,
        eligible: false,
        reason: "private_learning_lifecycle_recovery",
      });
    }
    debugLog(env, "skip", { reason: decision.reason }, options);
    return null;
  }
  const payload = buildQueryPayload(
    searchText,
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
    return withContext(
      includeSharedConfigCredentialNotice
        ? withSharedConfigCredentialNotice(unavailableQueryContext(env), env)
        : unavailableQueryContext(env),
      {
        consumed: false,
        eligible: true,
        reason: "query_unavailable",
      },
    );
  }
  if (
    decision.reason === "task_shape" &&
    !queryResponseHasMatches(response)
  ) {
    // Owner decision 34C (coordinator, 2026-09-29): an empty task-shape
    // search shows no no-match block, makes the turn eligible for completion
    // recovery only through a correction, and records no query-feedback
    // obligation. Everything else a keyword-triggered empty search delivers
    // arrives unchanged; the server has recorded the receipt and the
    // missing-skill request. A result without context prints nothing.
    const empty = emptyTaskShapeContext(response);
    const result = {
      consumed: true,
      matched: false,
      eligible: Boolean(correctionCapture),
      reason: decision.reason,
    };
    if (!empty.governs && contextAdditions.length === 0) {
      debugLog(env, "task_shape_no_result", {}, options);
      return { ...result, context: "", deliveredContextAdditionIds: [] };
    }
    return withContext(
      includeSharedConfigCredentialNotice
        ? withSharedConfigCredentialNotice(empty.context, env)
        : empty.context,
      result,
    );
  }
  const context =
    formatContext(response, decision.reason, limitFromEnv(env), {
      maxChars: 32_000,
      env,
      querySummary: payload.task.summary,
    }) ?? emptyQueryContext(decision.reason, env);
  return withContext(
    includeSharedConfigCredentialNotice
      ? withSharedConfigCredentialNotice(context, env)
      : context,
    {
      consumed: true,
      matched: queryResponseHasMatches(response),
      eligible: true,
      highMatch: highMatchFromResponse(response),
      queryFeedback: queryFeedbackTrackingFromResponse(response),
      valueEpisode: valueEpisodeFromResponse(response),
      reason: decision.reason,
    },
  );
}

export function queryResponseHasMatches(response) {
  const body = responseBodyFromToolResponse(response);
  const skills = Array.isArray(body?.skills)
    ? body.skills
        .filter((item) => publicSkillCandidateAllowed(body, item))
        .filter(autoQuerySkillAllowed)
    : [];
  const resources = Array.isArray(body?.resources)
    ? body.resources.filter(autoQueryResponseCandidateAllowed)
    : [];
  return skills.length > 0 || resources.length > 0;
}

// Plan 15.4, P1 step 6: the server's tier floor decides which skills the hook
// shows, so the client drops only exploratory and known-inapplicable ones. A
// skill the relevance judge chose is shown whatever its tier; a
// known-inapplicable one (an exclusion its author stated or a person
// reviewed matches the task) is still dropped, since the judge never sees an
// author's own exclusions.
function autoQuerySkillAllowed(candidate) {
  if (candidate?.applicability?.fit === "unlikely") return false;
  if (relevanceJudgeFit(candidate)) return true;
  return (
    !candidate?.match_tier ||
    candidate.match_tier === "high" ||
    candidate.match_tier === "possible"
  );
}

function relevanceJudgeFit(candidate) {
  const fit = candidate?.relevance_judge?.fit;
  return fit === "direct" || fit === "partial" ? fit : null;
}

// Resources keep the defensive auto-query floor.
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
        lifecycleRecovery: options.lifecycleRecovery,
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
      options.privateLessonAuthorized
        ? "Call submit_feedback once for each listed skill with categorical useful true or false. Keep reusable prose separate."
        : "Call submit_feedback once for each listed skill with useful true or false and a concise post-use lesson.",
      preferenceEvidenceLine,
      options.privateLessonAuthorized
        ? "If this task produced reusable learning, call capture_learning once per new item; follow its exact next_action or bounded agent_recovery instructions."
        : "If submit_feedback returns next_step.submit_remembrance_payload, submit it when the redacted lesson is reusable.",
      privateLessonGuidance,
      routineContributionVisibilityInstruction(options.privateLessonAuthorized),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Before finishing, silently close the pending Remembrance loop using this session's query/result IDs.",
    signalLine,
    highMatchLine,
    options.privateLessonAuthorized
      ? "Call submit_query_feedback for pending query fit and submit_feedback only for used results. Separately route each new reusable item once through capture_learning; follow its exact next_action or bounded agent_recovery instructions. Never compress a complete workflow into a lesson."
      : "Call submit_query_feedback for pending query fit, submit_feedback only for used results, and submit_remembrance only for a reusable redacted lesson. If no skill fit and you built a complete reusable skill or playbook, default to propose_private_skill; use propose_skill_idea only when a public candidate is explicitly appropriate. A supplied invalid/inactive key fails with 401 and an insufficient key with 403; neither creates a candidate.",
    privateLessonGuidance,
    routineContributionVisibilityInstruction(options.privateLessonAuthorized),
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
            query_id: safeText(
              selection.query_id,
              MAX_FEEDBACK_IDENTIFIER_CHARS,
            ),
            result_id: safeText(
              selection.result_id,
              MAX_FEEDBACK_IDENTIFIER_CHARS,
            ),
            skill_slug: safeText(selection.slug, MAX_FEEDBACK_IDENTIFIER_CHARS),
            skill_version_id: safeText(
              selection.version_id,
              MAX_FEEDBACK_IDENTIFIER_CHARS,
            ),
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

function routineContributionVisibilityInstruction(privateCapture = false) {
  const visibility = privateCapture
    ? `Use the capture-capable Remembrance MCP tools. Private preparation is local and encrypted; invoke only the returned exact private action. Never substitute REST, a broad write tool, another destination, or another visibility. Query-fit feedback remains a separate bounded action. Do not mention routine calls, hooks, or receipts. Surface only failures, host blocks, or required action. For a host block unrelated to an exact private submit/retry action, say exactly: "${HOST_POLICY_ALERT_TEXT}". Redact secrets and proprietary content.`
    : `Use Remembrance MCP tools when available; REST or REMEMBRANCE_SUBMISSION_PAYLOAD fallback is for API unavailability, never host denial. Never remove or bypass an organization key to force a public candidate. Do not mention routine Remembrance calls, hooks, or receipt IDs. For a host block: "${HOST_POLICY_ALERT_TEXT}" Redact private content.`;
  return `${visibility} ${FEEDBACK_DENIAL_GUIDANCE}`;
}

// `lifecycleRecovery`: a caller's session-scoped recovery text, used in place
// of the machine-wide one.
export function privateLessonCompletionGuidance({
  includeLifecycleRecovery = true,
  env = process.env,
  lifecycleRecovery,
} = {}) {
  const recovery = !includeLifecycleRecovery
    ? null
    : lifecycleRecovery !== undefined
      ? lifecycleRecovery
      : privateLearningLifecycleRecoveryInstruction(env);
  return [
    "Call capture_learning once per new item: lesson for a compact generalized failure/correction, private_skill with complete instructions for a reusable procedure, or preference for a durable working preference. Follow its exact next_action or bounded agent_recovery instructions; reformulation updates the retained draft, not a new item.",
    "The router encrypts lesson and private-skill drafts locally before any network action. Do not substitute a legacy broad write, REST, another destination, or another visibility.",
    'Let the returned exact private submission action be the only authorization prompt. If the host cannot present it, ask once: "' +
      PRIVATE_LESSON_AUTHORIZATION_REQUEST_TEXT +
      '\"',
    `If the host denies the action, report the affected submission once: "${PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT}" Claim local retention only when preparation or inspection returned that draft_id. A preparation error with no draft_id does not prove retention. Do not retry that draft through another transport. Never auto-delete a draft.`,
    recovery,
  ]
    .filter(Boolean)
    .join("\n");
}

// answerShown is for hosts that keep the answer that triggered the stop on
// screen (Claude Code and VS Code), so the continuation must not restate it.
// subagent is for a subagent's stop: the cleanup must not displace its
// report, whichever way that reaches its caller.
export function completionContinuationReason(
  reason,
  input = {},
  env = process.env,
  { answerShown = false, subagent = false } = {},
) {
  acknowledgePrivateAuthorizationReminders(reason, env);
  const priorAnswer = String(
    input?.last_assistant_message ??
      input?.lastAssistantMessage ??
      input?.assistant_message ??
      input?.message ??
      "",
  ).trim();
  const finalAnswerInstruction = subagent
    ? "After the silent cleanup, make sure your caller still gets your complete final report, unchanged and without Remembrance status text. Deliver it again the way your task returns results, unless you already returned it through a tool meant to be called once."
    : answerShown
      ? "The user already sees your answer. After the cleanup, do not restate it; report only Remembrance failures or required action."
      : priorAnswer
        ? "After the silent cleanup, preserve the task result in the user-facing final answer. Do not repeat already reported Remembrance warnings. Do not replace the task answer with hook, receipt, or Remembrance status text."
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
    "Before finishing, silently recover the pending Remembrance query for this reusable task using the full conversation; no Remembrance query with the task's full context and no skill use was recorded for it.",
    signalLine,
    options.privateLessonAuthorized
      ? "Call query_skills with a redacted full-context summary, evaluate the returned matches, then close query-fit feedback and any real post-use feedback. Route reusable content only through capture_learning."
      : "Call query_skills with a redacted full-context summary, evaluate the returned matches, then close any warranted submit_query_feedback, submit_feedback, or submit_remembrance action before responding.",
    options.sessionSkills?.length
      ? `Skills already selected for this session (${options.sessionSkills.join(", ")}) stay active; do not invoke or query them again.`
      : null,
    options.privateLessonAuthorized
      ? privateLessonCompletionGuidance({
          env: options.env,
          lifecycleRecovery: options.lifecycleRecovery,
        })
      : null,
    routineContributionVisibilityInstruction(options.privateLessonAuthorized),
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
    value.includes(PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT) ||
    // Recognize older installed-client alerts without prescribing them again.
    value.includes(
      "Remembrance was blocked by host policy before reaching Remembrance.",
    )
  );
}

// Pure decision function (unit-tested): compare completed registry use and task
// eligibility with the last-prompted count. A completed use prompts for a
// contribution; eligible work with no completed query prompts for full-context
// recovery. `useCount`/`promptedCount` are injectable so tests never touch the
// filesystem. `subagentSession`: the host runs this session for a subagent,
// or cannot show it is a main session (runPromptHook), so it gets no user
// decisions.
export function decideStop(input, options = {}) {
  const env = options.env ?? process.env;
  if (contributeDisabled(env.REMEMBRANCE_AUTO_CONTRIBUTE)) {
    return { allow: true, why: "disabled" };
  }
  if (input?.stop_hook_active) {
    return { allow: true, why: "stop_hook_active" };
  }
  const subagent = input?.hook_event_name === "SubagentStop";
  // Without the host's agent id a subagent's debts cannot be told from its
  // parent's, so such a stop neither asks nor touches any ledger.
  if (subagent && !normalizeNativeSessionId(input?.agent_id)) {
    return { allow: true, why: "subagent_identity_unavailable" };
  }
  if (hostPolicyAlertWasReported(input)) {
    return { allow: true, why: "host_policy_alert_reported" };
  }
  // Hosts render a Stop-block reason as a new user-visible prompt. Routine
  // recovery therefore happens in the next prompt context by default, where
  // the agent can close exact durable obligations before its normal answer.
  // Keep visible Stop recovery only as an explicit diagnostic/strict mode.
  // A subagent has no next prompt, so its stop still asks it, once, for its
  // own pending actions.
  const silent =
    options.visibleCompletionRecovery !== true &&
    !visibleCompletionRecoveryEnabled(env);
  if (silent && !subagent) {
    return { allow: true, why: "silent_prompt_recovery" };
  }
  const sessionId = agentLedgerIdFor(input);
  const readUse = options.readUseCount ?? readRegistryUseCount;
  const useCount = readUse(sessionId, env);
  const readEligible = options.readEligibilityCount ?? readTaskEligibilityCount;
  const eligibilityCount = readEligible(sessionId, env);
  const engagementCount = Math.max(useCount, eligibilityCount);
  const readPrompted = options.readPromptedCount ?? readPromptedCount;
  const promptedCount = readPrompted(sessionId, env);
  const readObligations =
    options.readCompletionObligations ?? readCompletionObligations;
  const obligations = readObligations(sessionId, env);
  const drafts = readPrivateDrafts(env);
  const unpromptedObligations = duePendingActions(
    obligations.filter((obligation) => !obligation.prompted_at),
    env,
    drafts,
  );
  const overflow = readCompletionObligationOverflow(sessionId, env);
  const highValueSignal = detectHighValueLessonSignal(input);
  const directSelections = options.readDirectSelections
    ? options.readDirectSelections(sessionId, env)
    : options.readDirectSelection
      ? [options.readDirectSelection(sessionId, env)].filter(Boolean)
      : readDirectSelectionSurfaces(sessionId, env);
  if (
    !highValueSignal &&
    obligations.length > 0 &&
    obligations.every((obligation) =>
      feedbackObligationDenied(obligation, env),
    ) &&
    engagementCount <=
      Math.max(...obligations.map((item) => item.engagement_count))
  ) {
    return { allow: true, why: "feedback_host_denied" };
  }
  if (unpromptedObligations.length > 0 && (silent || !highValueSignal)) {
    return {
      allow: false,
      why: "prompt_pending_obligations",
      reason: completionObligationInstruction(
        unpromptedObligations,
        directSelections,
        overflow,
        stopRetainedPayloads(unpromptedObligations, sessionId, env),
      ),
      useCount: Math.max(
        engagementCount,
        ...unpromptedObligations.map(
          (obligation) => obligation.engagement_count,
        ),
      ),
      obligationIds: unpromptedObligations.map((obligation) => obligation.id),
    };
  }
  if (silent) {
    return { allow: true, why: "silent_prompt_recovery" };
  }
  const readHighMatch = options.readHighMatch ?? readHighMatchSurface;
  const highMatch = readHighMatch(sessionId, env);
  // A session-scoped selection stays active for the whole session, so its
  // post-use feedback and task outcome are not due at a turn's stop. Closing
  // them when the session ends is a follow-up. A turn whose only Remembrance
  // action was invoking such a skill is therefore treated like a turn with no
  // Remembrance action: an eligible task still gets the closure prompt, which
  // names these skills as already selected so they are not invoked or queried
  // again.
  const newDirectSelections = directSelections.filter(
    (selection) => !selection?.prompted_at && selection?.scope !== "session",
  );
  const sessionSkills = [
    ...new Set(
      directSelections
        .filter((selection) => selection?.scope === "session" && selection.slug)
        .map((selection) => selection.slug),
    ),
  ];
  const feedbackDirectSelections = newDirectSelections.filter(
    (selection) => selection.feedback_available !== false,
  );
  // A completed query, whatever it found, or a registry use closes the task
  // it was made in. The cumulative counts alone cannot tell: an agent's own
  // query that found nothing is no registry use, and a transcript read from
  // its tail after a long, compacted session no longer shows earlier calls.
  const readClosed = options.readClosedTaskCount ?? readClosedTaskCount;
  const hasUnclosedEligibility =
    eligibilityCount > useCount &&
    eligibilityCount > readClosed(sessionId, env) &&
    newDirectSelections.length === 0;
  const privateLessonAuthorized = organizationPrivateLessonAuthorized(env);
  // Scoped to this ledger's session tree: another session's drafts appear
  // only as a user decision, never as silent recovery.
  const privateLessonRecovery = privateLessonAuthorized
    ? privateLearningSessionRecovery(
        sessionId,
        privateHintsOnMachine(sessionId, env),
        drafts,
        env,
        { notices: !options.subagentSession },
      )
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
        ? completionObligationInstruction(
            unpromptedObligations,
            directSelections,
            overflow,
            stopRetainedPayloads(unpromptedObligations, sessionId, env),
          )
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
              sessionSkills,
              lifecycleRecovery: privateLessonRecovery,
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
                lifecycleRecovery: privateLessonRecovery,
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
//   <hash>.closed  — the .eligible count when a completed query or a registry
//                     use last closed the task.
//   <hash>.prompt  — the use count at which the stop adapter last prompted.
//   <hash>.high-match.json — latest high result until its exact detail opens.
//   <hash>.obligations/*.json — pending query/feedback/lesson actions, each
//                               closed only by its correlated tool call. A
//                               remembrance follow-up also keeps the exact
//                               payload the server returned, and a durable
//                               preference the exact record_preference
//                               arguments capture_learning returned, sealed
//                               with the private-learning key
//                               (local_resupply_envelope,
//                               pending-action-payload.mjs), so a demand can
//                               repeat a follow-up's payload or hand either
//                               back by action id; an earlier build's
//                               plaintext local_resupply_payload is still
//                               read.
//   <hash>.obligations-overflow.json — how many debts a full ledger could not
//                               record, since when, and of which kinds.
//   <hash>.user-prompts — the user prompts the agent received (host text and
//                         a subagent's task are not counted).
//   <hash>.main-session — the host created this session with no parent.
//   <hash>.parent-session — the parent session id the host created this
//                           child session with.
//   <hash>.rated.json — results the ledger paid post-use feedback for, each
//                               with the user prompt (.user-prompts count) it
//                               was paid in.
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

// A ledger known only by its hash (an association or a forwarding marker
// names no session id) is passed as { ledger: "<16 hex>" }.
function sessionHash(sessionId) {
  if (/^[a-f0-9]{16}$/.test(sessionId?.ledger ?? "")) return sessionId.ledger;
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

function closedTaskPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.closed`);
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

function ratedResultsPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.rated.json`);
}

function userPromptCountPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.user-prompts`);
}

function completionObligationDir(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.obligations`);
}

function completionObligationOverflowPath(sessionId, env) {
  return join(
    usageDir(env),
    `${sessionHash(sessionId)}.obligations-overflow.json`,
  );
}

function privateCompletionObligationDir(env) {
  return join(privateLearningLifecycleDirectory(env), "obligations");
}

// The lifecycle directory alone, for the private-learning hints kept in it
// (pending-action-payload.mjs, retainedRootsUsable).
function lifecycleDirectoryUsable(env) {
  return retainedRootsUsable(env, undefined, { retained: false });
}

function privateLearningLifecycleDirectory(env) {
  return join(
    dirname(privateLessonOutboxDirectoryForHook(env)),
    "private-learning-lifecycle",
  );
}

function legacyPrivateCompletionObligationDir(env) {
  return join(
    usageDir(env),
    `private-learning-${sessionHash(privateLessonOutboxDirectoryForHook(env))}.obligations`,
  );
}

function completionObligationPath(sessionId, obligationId, env) {
  const directory = /^(private_lesson|private_skill):/.test(obligationId)
    ? privateCompletionObligationDir(env)
    : completionObligationDir(sessionId, env);
  return join(directory, completionObligationFileName(obligationId));
}

function completionObligationFileName(obligationId) {
  return `${createHash("sha256")
    .update(String(obligationId), "utf8")
    .digest("hex")
    .slice(0, 32)}.json`;
}

// A ledger's two homes, by its 16-hex name: the temporary usage directory,
// where every debt record lived before, and the durable per-user state
// directory, where a record that keeps an unresolved action's payload lives
// (pending-action-payload.mjs, retainedLedgerRoot), so that the operating
// system's cleaning of temporary files never removes it. That durable root is
// used only while retainedRootsUsable allows it: a symlinked, foreign or
// group-writable private-learning-lifecycle or retained directory is refused,
// never followed, and a record then stays in the temporary ledger.
function ledgerObligationDir(ledger, env) {
  return join(usageDir(env), `${ledger}.obligations`);
}

function retainedObligationDir(ledger, env) {
  return join(retainedLedgerRoot(env), `${ledger}.obligations`);
}

// Content-free pointers to records another ledger keeps for this one: a
// subagent's debt whose payload could not move to its parent whole. A pointer
// lives in the durable root while that is usable, else in the temporary usage
// directory, from which a read moves it to the durable root.
function completionObligationPointerDir(ledger, env) {
  return join(retainedLedgerRoot(env), `${ledger}.pointers`);
}

function temporaryCompletionObligationPointerDir(ledger, env) {
  return join(usageDir(env), `${ledger}.pointers`);
}

function completionObligationPointerHomes(
  ledger,
  env,
  durable = retainedRootsUsable(env),
) {
  return [
    ...(durable ? [completionObligationPointerDir(ledger, env)] : []),
    temporaryCompletionObligationPointerDir(ledger, env),
  ];
}

function completionObligationPointerName(target, obligationId) {
  return `${createHash("sha256")
    .update(`${target}:${obligationId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}.json`;
}

// The association in a ledger to the ledger `from`.
function completionObligationAssociationName(from) {
  return `${createHash("sha256")
    .update(`association:${from}`, "utf8")
    .digest("hex")
    .slice(0, 32)}.json`;
}

// Where a ledger names the ledger it handed over to.
function completionObligationForwardPath(ledger, env) {
  return join(usageDir(env), `${ledger}.forward.json`);
}

// The subagent a debt came from, as a record names it.
function completionProvenance(value) {
  const agentId = normalizeNativeSessionId(value?.agent_id);
  return agentId
    ? {
        agent_id: agentId,
        transcript_path: transferTranscriptPath(value.transcript_path),
      }
    : null;
}

// A file of `ledger`'s pointer homes, from every home that is a directory of
// this user's: a refused durable root, or a home that is a link, is never
// reached through.
function removeCompletionObligationPointerFile(
  ledger,
  name,
  env,
  durable = retainedRootsUsable(env),
) {
  for (const directory of completionObligationPointerHomes(ledger, env, durable)) {
    try {
      assertSecureHookDirectory(lstatSync(directory));
    } catch {
      continue;
    }
    rmSync(join(directory, name), { force: true });
  }
}

// The pointer in `ledger` to `target`'s record.
function removeCompletionObligationPointer(
  ledger,
  target,
  obligationId,
  env,
  durable = retainedRootsUsable(env),
) {
  removeCompletionObligationPointerFile(
    ledger,
    completionObligationPointerName(target, obligationId),
    env,
    durable,
  );
}

// Whether a debt keeps its action's payload on this machine, sealed or as
// an earlier build kept it in plaintext.
function retainsResupplyContent(obligation) {
  return Boolean(
    obligation?.local_resupply_envelope || obligation?.local_resupply_payload,
  );
}

function sameResupplyContent(left, right) {
  return (
    left.id === right.id &&
    left.payload_digest === right.payload_digest &&
    JSON.stringify(left.local_resupply_envelope ?? null) ===
      JSON.stringify(right.local_resupply_envelope ?? null) &&
    JSON.stringify(left.local_resupply_payload ?? null) ===
      JSON.stringify(right.local_resupply_payload ?? null)
  );
}

function privateObligationCredentialDigest(env) {
  const credential = resolveApiCredential(env);
  if (!credential.apiKey || isUnusableConfigurationSource(credential.source))
    return null;
  return `sha256:${createHash("sha256").update(credential.apiKey).digest("hex")}`;
}

function privateAuthorizationMarkerPath(draftId, env) {
  if (!/^(pld|psd)_[A-Za-z0-9_-]{8,96}$/.test(draftId ?? "")) return null;
  return join(
    privateLearningLifecycleDirectory(env),
    `${draftId}.authorization.json`,
  );
}

function privateAuthorizationMarker(draftId, env) {
  const path = privateAuthorizationMarkerPath(draftId, env);
  if (!path) return null;
  try {
    const marker = JSON.parse(readSecureHookFile(path, 1024));
    if (
      marker.version !== 1 ||
      !Number.isFinite(Date.parse(marker.observed_at)) ||
      !/^sha256:[a-f0-9]{64}$/.test(marker.credential_digest)
    )
      return null;
    return marker;
  } catch {
    return null;
  }
}

// A draft's content-free markers beside its hint: authorization backoff,
// parking (a decline or host denial), its one held-safety notice, and its
// one offer of a hold the current safety check would not keep.
const PRIVATE_DRAFT_MARKERS = [
  "authorization",
  "parked",
  "held-notice",
  "release-offer",
];

function privateDraftMarkerPath(draftId, marker, env) {
  return /^(pld|psd)_[A-Za-z0-9_-]{8,96}$/.test(draftId ?? "")
    ? join(privateLearningLifecycleDirectory(env), `${draftId}.${marker}.json`)
    : null;
}

function clearPrivateDraftMarkers(
  draftId,
  env,
  markers = PRIVATE_DRAFT_MARKERS,
) {
  for (const marker of markers) {
    const path = privateDraftMarkerPath(draftId, marker, env);
    if (!path) return;
    try {
      rmSync(path, { force: true });
    } catch {
      // Content-free scheduling state never controls draft acceptance/deletion.
    }
  }
}

function privateTerminalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function privateTerminalDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function privateAuthorizationTerminalIsKnown(draftId, env) {
  if (!/^(?:pld|psd)_[A-Za-z0-9_-]{8,96}$/.test(draftId ?? "")) return false;
  const lesson = draftId.startsWith("pld_");
  const directory = lesson
    ? privateLessonOutboxDirectoryForHook(env)
    : privateSkillOutboxDirectoryForHook(env);
  const lane = lesson ? "lesson" : "skill";
  // A held lesson replaced by an accepted re-capture is terminal too.
  const terminals = lesson
    ? ["submitted", "deleted", "replaced"]
    : ["submitted", "deleted"];
  for (const terminal of terminals) {
    try {
      const value = JSON.parse(
        readSecureHookFile(
          join(directory, `${draftId}.${terminal}.json`),
          8 * 1024,
        ),
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.draft_id !== draftId ||
        value.version !==
          `private-${lane}-outbox-${terminal === "submitted" ? "submitted" : "deletion"}-v1`
      ) {
        continue;
      }
      if (
        terminal === "submitted"
          ? value.state === "submitted" &&
            privateTerminalTimestamp(value.submitted_at) &&
            privateTerminalDigest(
              lane === "lesson" ? value.receipt_digest : value.candidate_digest,
            )
          : value.reason ===
              (terminal === "deleted"
                ? "explicit_confirmed_deletion"
                : "replaced_by_verified_replacement") &&
            privateTerminalTimestamp(value.deleted_at)
      ) {
        return true;
      }
    } catch {
      // Missing or malformed terminal state cannot prove delivery, deletion
      // or replacement.
    }
  }
  return false;
}

function clearKnownTerminalAuthorizationOpportunities(env) {
  const directory = privateLearningLifecycleDirectory(env);
  try {
    assertSecureHookDirectory(lstatSync(directory));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const match = entry.name.match(
        /^((?:pld|psd)_[A-Za-z0-9_-]{8,96})\.(authorization|parked|held-notice|release-offer)\.json$/,
      );
      if (
        !match ||
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        (match[2] === "authorization" &&
          !privateAuthorizationMarker(match[1], env)) ||
        !privateAuthorizationTerminalIsKnown(match[1], env)
      ) {
        continue;
      }
      clearPrivateDraftMarkers(match[1], env, [match[2]]);
    }
  } catch {
    // Terminal cleanup is best-effort and never controls retained draft state.
  }
}

function retireKnownTerminalPrivateObligations(env) {
  removeCompletionObligations(
    null,
    (obligation) =>
      ["private_lesson", "private_skill"].includes(obligation.kind) &&
      privateAuthorizationTerminalIsKnown(obligation.draft_id, env),
    env,
  );
}

function recordPrivateAuthorizationOpportunity(draftId, env) {
  const path = privateAuthorizationMarkerPath(draftId, env);
  const credentialDigest = privateObligationCredentialDigest(env);
  return Boolean(
    path &&
    credentialDigest &&
    writePrivateUsageMarker(
      path,
      JSON.stringify({
        version: 1,
        observed_at: new Date().toISOString(),
        credential_digest: credentialDigest,
      }),
    ),
  );
}

function privateAuthorizationRetryIsDue(draftId, lastFailureAt, env) {
  const marker = privateAuthorizationMarker(draftId, env);
  const credentialDigest = privateObligationCredentialDigest(env);
  if (!credentialDigest) return false;
  if (marker && marker.credential_digest !== credentialDigest) return true;
  const timestamp = Date.parse(marker?.observed_at ?? lastFailureAt ?? "");
  // A future timestamp cannot strand recovery. The next emitted reminder
  // establishes a local cooldown; merely inspecting state never consumes it.
  if (timestamp > Date.now()) return true;
  return (
    Number.isFinite(timestamp) &&
    timestamp + PRIVATE_AUTHORIZATION_RETRY_INTERVAL_MS <= Date.now()
  );
}

// `ledgerId`: the ledger the delivered context was composed for. Where
// another session of the same process can compose between a composition and
// its delivery (OpenCode's turns, OpenClaw's prompts through runPromptHook),
// the host names it, so that session's notice in the same words is not
// acknowledged with this delivery's; without it, the newest composition is
// (acknowledgePrivateDraftNotices).
export function acknowledgePrivateAuthorizationReminders(
  context,
  env = process.env,
  ledgerId = null,
) {
  clearKnownTerminalAuthorizationOpportunities(env);
  retireKnownTerminalPrivateObligations(env);
  // Per-draft parking, not the lane-wide denial, now holds a denied draft's
  // line; an acknowledged retry still backs off.
  if (!organizationPrivateLessonAuthorized(env)) return;
  acknowledgePrivateDraftNotices(String(context ?? ""), env, ledgerId);
  const references = String(context ?? "").matchAll(
    /\bcall retry_private_(lesson|skill)_candidate with draft_id ((?:pld|psd)_[A-Za-z0-9_-]{8,96})(?![A-Za-z0-9_-])/g,
  );
  for (const [, lane, draftId] of references) {
    if (!draftId.startsWith(lane === "lesson" ? "pld_" : "psd_")) continue;
    let obligationIsDue = false;
    try {
      const obligation = normalizeCompletionObligation(
        JSON.parse(
          readSecureHookFile(
            completionObligationPath(null, `private_${lane}:${draftId}`, env),
            8 * 1024,
          ),
        ),
      );
      obligationIsDue = Boolean(
        obligation?.failed_credential_digest &&
        completionObligationIsDue(obligation, env),
      );
    } catch {
      // Envelope-only recovery does not require a tool-observer obligation.
    }
    let lastFailureAt = null;
    try {
      const directory =
        lane === "lesson"
          ? privateLessonOutboxDirectoryForHook(env)
          : privateSkillOutboxDirectoryForHook(env);
      const envelope = JSON.parse(
        readSecureHookFile(
          join(
            directory,
            `${draftId}${lane === "lesson" ? ".lesson" : ""}.json`,
          ),
          lane === "lesson"
            ? MAX_PRIVATE_LESSON_ENVELOPE_BYTES
            : MAX_PRIVATE_SKILL_ENVELOPE_BYTES,
        ),
      );
      if (
        envelope.draft_id === draftId &&
        (envelope.state === "awaiting_authorization" ||
          (envelope.state === "held_safety" &&
            envelope.hold_telemetry_status === "awaiting_authorization"))
      ) {
        lastFailureAt = envelope.updated_at;
      }
    } catch {
      // A retained tool-observer marker is sufficient without an envelope read.
    }
    if (
      obligationIsDue ||
      privateAuthorizationRetryIsDue(draftId, lastFailureAt, env)
    ) {
      recordPrivateAuthorizationOpportunity(draftId, env);
    }
  }
}

function feedbackObligationDenied(obligation, env) {
  const feedbackTool =
    obligation.kind === "query_feedback"
      ? "submit_query_feedback"
      : obligation.kind === "post_use_feedback"
        ? "submit_feedback"
        : null;
  return Boolean(
    feedbackTool &&
    feedbackDenialAcknowledged(
      {
        tool: feedbackTool,
        query_id: obligation.query_id,
        ...(feedbackTool === "submit_feedback"
          ? { result_id: obligation.result_id }
          : {}),
        reason: "host_policy_denied",
      },
      env,
    ),
  );
}

// `drafts` (readPrivateDrafts), when the caller has read the outboxes once
// for this prompt; without it a private hint reads its own draft's state.
function completionObligationIsDue(obligation, env, drafts = null) {
  if (feedbackObligationDenied(obligation, env)) return false;
  if (!["private_lesson", "private_skill"].includes(obligation.kind))
    return true;
  // A terminal artifact is authoritative even if a concurrent hook rewrites
  // an older content-free obligation after best-effort retirement.
  if (privateAuthorizationTerminalIsKnown(obligation.draft_id, env))
    return false;
  if (!organizationPrivateLessonAuthorized(env)) return false;
  // A parked draft returns only as a user decision, never as a silent line.
  if (
    drafts
      ? drafts.parked.has(obligation.draft_id)
      : readPrivateParkedMarker(obligation.draft_id, env)
  )
    return false;
  // A lesson's own envelope says what is due now; the hint's recorded
  // fields decide only when its outbox cannot answer. Only the hint knows
  // which credential an authorization refusal named: a changed one is due.
  if (obligation.kind === "private_lesson") {
    const known = privateLessonHintAction(
      obligation.draft_id,
      env,
      drafts?.lessons,
    );
    if (
      known?.action?.count === "awaiting_authorization" &&
      !known.action.due &&
      obligation.failed_credential_digest &&
      !privateAuthorizationMarker(obligation.draft_id, env)
    ) {
      return (
        obligation.failed_credential_digest !==
        privateObligationCredentialDigest(env)
      );
    }
    if (known) return Boolean(known.action?.due);
  }
  if (obligation.delivery_blocked) return false;
  if (obligation.next_retry_at && !retryIsDue(obligation.next_retry_at))
    return false;
  if (!obligation.failed_credential_digest) return true;
  const marker = privateAuthorizationMarker(obligation.draft_id, env);
  return marker
    ? privateAuthorizationRetryIsDue(obligation.draft_id, null, env)
    : obligation.failed_credential_digest !==
        privateObligationCredentialDigest(env) ||
        privateAuthorizationRetryIsDue(
          obligation.draft_id,
          obligation.created_at,
          env,
        );
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

// A drained ledger's directory is removed once empty, so a concurrent hook
// can remove it between its creation here and the first write into it: then
// it is created once more.
function writePrivateUsageMarker(path, value, retry = true) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    ensureSecureHookDirectory(dirname(path));
    writeFileSync(temporaryPath, String(value), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    return true;
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only; marker persistence must remain fail-open.
    }
    return retry && error?.code === "ENOENT"
      ? writePrivateUsageMarker(path, value, false)
      : false;
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
      "private_skill",
      "capture_next_action",
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
    // Local-only re-supply material: the exact payload the server returned
    // for a follow-up, or the exact record_preference arguments
    // capture_learning returned for a durable preference, so a demand after
    // compaction or in a fresh context, or get_pending_action_payload, can
    // hand it back verbatim. Nothing uploads, logs, or copies it; it leaves
    // this 0600 file only inside a demand shown to, or a retrieval by, the
    // agent that owes it, and moves with the debt when an exiting subagent
    // passes it to its parent. This version keeps it sealed
    // (local_resupply_envelope); a plaintext follow-up payload an earlier
    // version kept is read and carried as it is, never converted. Preference
    // arguments were never kept in plaintext.
    local_resupply_payload:
      value.kind === "remembrance_followup" &&
      value.local_resupply_payload &&
      typeof value.local_resupply_payload === "object" &&
      !Array.isArray(value.local_resupply_payload) &&
      completionPayloadDigest(value.local_resupply_payload) ===
        value.payload_digest
        ? value.local_resupply_payload
        : null,
    // Format: pending-action-payload.mjs.
    local_resupply_envelope: [
      "remembrance_followup",
      "capture_next_action",
    ].includes(value.kind)
      ? normalizeResupplyEnvelope(value.local_resupply_envelope)
      : null,
    local_resupply_payload_omitted: ["too_large", "key_unavailable"].includes(
      value.local_resupply_payload_omitted,
    )
      ? value.local_resupply_payload_omitted
      : null,
    // Why no key was made for it, as content-free codes
    // (pending-action-payload.mjs, retainedKeyHoldCodes).
    ...(value.local_resupply_payload_omitted === "key_unavailable" &&
    normalizeRetainedKeyHoldCodes(value.local_resupply_hold)
      ? {
          local_resupply_hold: normalizeRetainedKeyHoldCodes(
            value.local_resupply_hold,
          ),
        }
      : {}),
    // Set on every record this version writes; it names the writer, not an
    // agent. Only Claude Code and Codex hooks key a subagent's debts to that
    // subagent, so there a record without it was written by an older client
    // under the session alone and may be a subagent's.
    agent_keyed: value.agent_keyed === true,
    // Recorded where the host named no agent although it may have been a
    // subagent's (declareSubagentIdentityUnavailable).
    ...(value.subagent_identity === "unavailable"
      ? { subagent_identity: "unavailable" }
      : {}),
    ...privateHintOwnerFields(value),
    ...normalizedAliasQueryIds(value),
    // The subagent that left this debt unpaid when it exited.
    transferred_from: normalizeNativeSessionId(value.transferred_from?.agent_id)
      ? {
          agent_id: normalizeNativeSessionId(value.transferred_from.agent_id),
          transcript_path: transferTranscriptPath(
            value.transferred_from.transcript_path,
          ),
        }
      : null,
    action_tool:
      value.action_tool === "record_preference" ||
      (value.kind === "private_skill" &&
        [
          "inspect_private_learning_outbox",
          "submit_private_skill_candidate",
          "retry_private_skill_candidate",
        ].includes(value.action_tool)) ||
      (value.kind === "private_lesson" &&
        [
          "submit_private_lesson_candidate",
          "retry_private_lesson_candidate",
        ].includes(value.action_tool))
        ? value.action_tool
        : null,
    next_retry_at: Number.isFinite(Date.parse(value.next_retry_at ?? ""))
      ? new Date(value.next_retry_at).toISOString()
      : null,
    failed_credential_digest: /^sha256:[a-f0-9]{64}$/.test(
      value.failed_credential_digest ?? "",
    )
      ? value.failed_credential_digest
      : null,
    delivery_blocked: value.delivery_blocked === true,
    created_at: new Date(createdAt).toISOString(),
    prompted_at:
      promptedAt !== null && Number.isFinite(promptedAt)
        ? new Date(promptedAt).toISOString()
        : null,
  };
}

// Who a private hint belongs to: the session tree that captured or last
// acted on its draft (owner_session, the main session's ledger), and the
// ledger and agent that did (captured_by_*). A hint without them (written
// by an earlier client) belongs to no session. All are content-free.
function privateHintOwnerFields(value) {
  if (
    !["private_lesson", "private_skill"].includes(value.kind) ||
    !/^[a-f0-9]{16}$/.test(value.owner_session ?? "") ||
    !/^[a-f0-9]{16}$/.test(value.captured_by_ledger ?? "")
  ) {
    return {};
  }
  const agent = normalizeNativeSessionId(value.captured_by_agent);
  return {
    owner_session: value.owner_session,
    captured_by_ledger: value.captured_by_ledger,
    ...(agent ? { captured_by_agent: agent } : {}),
  };
}

// The owner fields for a hint `sessionId` (a ledger id, agentLedgerIdFor's
// form) records.
function privateHintOwner(sessionId) {
  const ledger = String(sessionId ?? "unknown");
  const split = ledger.indexOf(":agent:");
  const agent =
    split >= 0 ? normalizeNativeSessionId(ledger.slice(split + 7)) : null;
  return {
    owner_session: sessionHash(split >= 0 ? ledger.slice(0, split) : ledger),
    captured_by_ledger: sessionHash(ledger),
    ...(agent ? { captured_by_agent: agent } : {}),
  };
}

// A main thread holds the private hints of its whole session tree, a
// subagent only those it captured.
function privateHintOwnedBy(hint, sessionId) {
  if (sessionId !== null && typeof sessionId === "object") return false;
  const ledger = String(sessionId ?? "unknown");
  return ledger.includes(":agent:")
    ? hint.captured_by_ledger === sessionHash(ledger)
    : hint.owner_session === sessionHash(ledger);
}

function isPrivateHint(obligation) {
  return ["private_lesson", "private_skill"].includes(obligation?.kind);
}

// Rewrites a private hint where it is held with `to` as its owner; nothing
// else of it changes, and its draft is never touched. When the session
// whose tree `to` is in has handed over itself (OpenClaw: a nested subagent
// that ends after the one that spawned it), the hint goes on, as that
// session's debts went, to the session its forwarding markers lead to
// (resolveCompletionRecipient), which is the one that reads it.
function adoptPrivateHint(hint, to, env) {
  if (typeof to !== "string" || !lifecycleDirectoryUsable(env)) return false;
  const owner = privateHintOwner(to);
  const { recipient } = resolveCompletionRecipient(
    { ledger: owner.owner_session },
    to,
    env,
  );
  const adopted = normalizeCompletionObligation({
    ...hint,
    ...owner,
    owner_session: sessionHash(recipient),
  });
  return Boolean(
    adopted &&
    writePrivateUsageMarker(
      completionObligationPath(to, adopted.id, env),
      `${JSON.stringify(adopted)}\n`,
    ),
  );
}

function normalizedAliasQueryIds(value) {
  if (
    value.kind !== "post_use_feedback" ||
    !Array.isArray(value.alias_query_ids)
  ) {
    return {};
  }
  const primary = completionIdentifier(value.query_id);
  const aliases = [
    ...new Set(
      value.alias_query_ids
        .filter((id) => typeof id === "string")
        .map((id) => completionIdentifier(id))
        .filter((id) => id && id !== primary),
    ),
  ].slice(-COMPLETION_ALIAS_QUERY_ID_LIMIT);
  return aliases.length > 0 ? { alias_query_ids: aliases } : {};
}

// Kept only while its JSON form fits the room a retained payload leaves for
// it; a longer path is dropped.
function transferTranscriptPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = safeText(value, 512);
  const room = JSON.stringify(
    COMPLETION_OBLIGATION_GROWN_FIELDS.transferred_from.transcript_path,
  );
  return Buffer.byteLength(JSON.stringify(path), "utf8") <=
    Buffer.byteLength(room, "utf8")
    ? path
    : null;
}

// `pointers: false` reads only the ledger's own records, for a decision that
// needs nothing else (is it held, is it full): no pointer entry is examined,
// and such a read never counts the ledger as drained. `privateHints: "all"`
// shows every private hint on this machine, not only the reader's
// (privateHintOwnedBy): for a removal, retirement, or the orphan scan.
export function readCompletionObligations(
  sessionId,
  env = process.env,
  options = {},
) {
  return readCompletionLedger(sessionId, env, options).obligations;
}

// What a session holds, read without asking it for anything (`ask: false`):
// the reads that record a debt or look one up, and those that end a tool
// call. Only a prompt's or a stop's read decides who is asked.
function heldCompletionObligations(sessionId, env) {
  return readCompletionObligations(sessionId, env, { ask: false });
}

// readCompletionObligations, with `complete`: every home of the ledger, and
// everything it points or associates to, was examined (the durable root
// usable, nothing out of reach, no bound reached). Only a complete read
// drains a ledger (retiring its count and its empty directories), and only
// a complete read lets a hand-over leave nothing behind.
// `associations: "list"` (a hand-over's read) shows each association
// `sessionId` holds as { association, transferred_from } instead of what it
// reaches, so a hand-over moves the association itself. `settle: true` (a
// completion's or a decline's read) follows every entry `sessionId` holds,
// whichever session asks for it now, and names nothing: a debt it was shown
// before its keeper ran again is settled once, and what it reaches through
// an OpenClaw entry is not named after anything. `ask: false` (a read that
// asks nothing of the session: one that records a debt or looks one up, or
// ends a tool call) follows every entry `sessionId` holds, moves or
// removes none and, as a completion's read, names nothing it reaches
// through an OpenClaw entry: a run that was asked keeps the entry it was
// asked through, and settles through it, until its next prompt or stop.
function readCompletionLedger(
  sessionId,
  env,
  {
    pointers = true,
    associations = "expand",
    settle = false,
    ask = true,
    privateHints = "own",
  } = {},
) {
  const obligations = new Map();
  const ledger = sessionHash(sessionId);
  const temporary = completionObligationDir(sessionId, env);
  const durable = retainedRootsUsable(env);
  const kept = durable ? retainedObligationDir(ledger, env) : null;
  const lifecycle = durable || lifecycleDirectoryUsable(env);
  let listed = false;
  let ownComplete = true;
  for (const directory of [
    temporary,
    ...(kept ? [kept] : []),
    legacyPrivateCompletionObligationDir(env),
    ...(lifecycle ? [privateCompletionObligationDir(env)] : []),
  ]) {
    try {
      const now = Date.now();
      assertSecureHookDirectory(lstatSync(directory));
      if (directory === temporary || directory === kept) listed = true;
      const names = readdirSync(directory).sort();
      if ((directory === temporary || directory === kept) && names.length > 256) {
        ownComplete = false;
      }
      for (const name of names.slice(0, 256)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const path = join(directory, name);
        try {
          const stat = lstatSync(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > COMPLETION_OBLIGATION_MAX_BYTES
          ) {
            continue;
          }
          const text = readSecureHookFile(
            path,
            COMPLETION_OBLIGATION_MAX_BYTES,
          );
          const raw = JSON.parse(text);
          const obligation = normalizeCompletionObligation(raw);
          if (!obligation) continue;
          if (
            ["private_lesson", "private_skill"].includes(obligation.kind) &&
            directory !== privateCompletionObligationDir(env)
          ) {
            const destination = completionObligationPath(
              sessionId,
              obligation.id,
              env,
            );
            // Migrate content-free hints only; encrypted drafts remain untouched.
            if (
              lifecycle &&
              !existsSync(destination) &&
              writePrivateUsageMarker(destination, JSON.stringify(obligation))
            ) {
              rmSync(path, { force: true });
            }
          }
          // A sealed payload an earlier build kept in the temporary usage
          // directory moves to the durable ledger, whole.
          if (
            durable &&
            directory === temporary &&
            obligation.local_resupply_envelope
          ) {
            promoteRetainedRecord(
              path,
              join(retainedObligationDir(ledger, env), name),
              text,
            );
          }
          // Only a marker without content ages out. A record that keeps (or
          // may keep) an unresolved action's payload stays until the action
          // is completed, declined or withdrawn.
          if (
            !["private_lesson", "private_skill"].includes(obligation.kind) &&
            raw.local_resupply_envelope == null &&
            raw.local_resupply_payload == null &&
            Date.parse(obligation.created_at) + COMPLETION_OBLIGATION_TTL_MS <
              now
          ) {
            rmSync(path, { force: true });
            continue;
          }
          // The durable copy, read after the temporary one, is the one kept.
          obligations.set(obligation.id, obligation);
        } catch {
          // One malformed marker must not hide other pending work.
        }
      }
    } catch (error) {
      // Session-local feedback and durable draft obligations are independent.
      if (
        error?.code !== "ENOENT" &&
        (directory === temporary || directory === kept)
      ) {
        ownComplete = false;
      }
    }
  }
  const ordered = [...obligations.values()].sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at) ||
      left.id.localeCompare(right.id),
  );
  const privateKinds = ["private_lesson", "private_skill"];
  const walked = pointers
    ? readPointedCompletionObligations(ledger, env, durable, {
        examined: 0,
        presented: 0,
        seen: new Set(),
        list: associations === "list",
        reader: ask ? ledger : null,
        owners: new Map(),
        settle,
      })
    : { pointed: [], complete: false, present: false };
  const { pointed, present } = walked;
  // A refused durable root, a home not read, a bound reached, a record out
  // of reach or more own debts than one page shows leaves the ledger
  // undrained: nothing is retired on a partial view.
  const complete =
    durable &&
    ownComplete &&
    ordered.filter((item) => !privateKinds.includes(item.kind)).length <=
      COMPLETION_OBLIGATION_LIMIT &&
    walked.complete;
  // Once the ledger has drained, its overflow count is history, and its
  // directories go once empty.
  if (
    !ordered.some((item) => !privateKinds.includes(item.kind)) &&
    pointed.length === 0 &&
    complete
  ) {
    try {
      rmSync(completionObligationOverflowPath(sessionId, env), { force: true });
    } catch {
      // A stale count can only repeat a true, older report.
    }
    if (listed || present) removeEmptyLedgerDirectories(ledger, env, durable);
  }
  // Non-expiring private hints must never occupy the session feedback budget.
  // Records another ledger keeps for this one come after its own; they never
  // count against its own bound.
  const hints = ordered.filter((item) => privateKinds.includes(item.kind));
  return {
    complete,
    obligations: [
      ...ordered
        .filter((item) => !privateKinds.includes(item.kind))
        .slice(0, COMPLETION_OBLIGATION_LIMIT),
      ...pointed,
      ...(privateHints === "all"
        ? hints
        : hints
            .filter((item) => privateHintOwnedBy(item, sessionId))
            .slice(0, COMPLETION_OBLIGATION_LIMIT)),
    ],
  };
}

// Copies a sealed record from the temporary usage directory into the durable
// ledger and removes the temporary copy only once the durable one is
// byte-identical (by digest). A durable record that differs is never
// overwritten, and any failure leaves the temporary copy where it was.
function promoteRetainedRecord(path, destination, text) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  try {
    let held = null;
    try {
      held = readSecureHookFile(destination, COMPLETION_OBLIGATION_MAX_BYTES);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
    if (held === null) {
      if (!writePrivateUsageMarker(destination, text)) return;
      held = readSecureHookFile(destination, COMPLETION_OBLIGATION_MAX_BYTES);
    }
    if (digest(held) === digest(text)) rmSync(path, { force: true });
  } catch {
    // The temporary copy stays readable where it is.
  }
}

// A ledger's directory in each home, once nothing is left in it: a drained
// ledger must not count toward the inventory's directory bound. A refused
// durable root is never reached through, and a directory a concurrent hook
// has just written to stays.
function removeEmptyLedgerDirectories(
  ledger,
  env,
  durable = retainedRootsUsable(env),
) {
  for (const directory of [
    ledgerObligationDir(ledger, env),
    ...(durable ? [retainedObligationDir(ledger, env)] : []),
    ...completionObligationPointerHomes(ledger, env, durable),
  ]) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty, already gone, or holding a file this client does not read.
    }
  }
}

// A record kept in `ledger`'s temporary or durable home, if it is there. A
// sealed record found in the temporary home while the durable root is
// usable moves to the durable home, as its keeper's own read moves it: a
// keeper that never reads its ledger again (an ended subagent's) must not
// leave it to temporary-directory cleanup.
function readLedgerRecord(
  ledger,
  obligationId,
  env,
  durable = retainedRootsUsable(env),
) {
  const name = completionObligationFileName(obligationId);
  const temporary = ledgerObligationDir(ledger, env);
  let found = false;
  for (const directory of [
    ...(durable ? [retainedObligationDir(ledger, env)] : []),
    temporary,
  ]) {
    try {
      const path = join(directory, name);
      const text = readSecureHookFile(path, COMPLETION_OBLIGATION_MAX_BYTES);
      const obligation = normalizeCompletionObligation(JSON.parse(text));
      if (obligation?.id === obligationId) {
        if (
          durable &&
          directory === temporary &&
          obligation.local_resupply_envelope
        ) {
          promoteRetainedRecord(
            path,
            join(retainedObligationDir(ledger, env), name),
            text,
          );
        }
        return obligation;
      }
      found = true;
    } catch (error) {
      if (error?.code !== "ENOENT") found = true;
    }
  }
  return found ? undefined : null;
}

// The debts other ledgers keep for `ledger`. A pointer names one record (its
// keeper and id); an association names a ledger whose own records, and what
// it points or associates to in turn, `ledger` owes (at most
// COMPLETION_HOP_LIMIT associations deep). One read presents at most
// COMPLETION_OBLIGATION_LIMIT debts and examines at most
// COMPLETION_POINTER_SCAN_LIMIT entries over every home it visits (the
// temporary one first), in directory order, never a full listing. Resolving
// a debt removes its pointer or record, and a read removes pointers whose
// records are gone and associations to ledgers left empty, so the next read
// starts at the first unresolved debt. A temporary entry moves to the durable
// home once that is usable. Nothing goes as resolved unless the durable root
// is usable and the record is absent from both homes of its keeper, or the
// associated ledger was examined whole. On OpenClaw's path a flagged entry is
// followed only when no other session asks for what it names: an asking read
// (not a hand-over's list) first takes its keeper's owner (completionOwner),
// and an entry another session owns is never followed, named or tagged
// through; it goes to that session (settleForeignCompletionEntry), or, when it
// cannot go, stays and leaves the read incomplete. `complete`: every home was
// examined to its end, the durable one included, no bound was reached and
// nothing was out of reach; `present`: some pointer home exists.
function readPointedCompletionObligations(
  ledger,
  env,
  durable = retainedRootsUsable(env),
  walk = { examined: 0, presented: 0, seen: new Set() },
  depth = 0,
  provenance = null,
  quiet = false,
) {
  const pointed = [];
  const temporary = temporaryCompletionObligationPointerDir(ledger, env);
  const homes = [
    temporary,
    ...(durable ? [completionObligationPointerDir(ledger, env)] : []),
  ];
  let complete = durable;
  let present = false;
  for (const directory of homes) {
    let entries;
    try {
      assertSecureHookDirectory(lstatSync(directory));
      entries = opendirSync(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
      continue;
    }
    present = true;
    try {
      for (;;) {
        if (
          walk.presented >= COMPLETION_OBLIGATION_LIMIT ||
          walk.examined >= COMPLETION_POINTER_SCAN_LIMIT
        ) {
          complete = false;
          break;
        }
        const entry = entries.readSync();
        if (!entry) break;
        walk.examined += 1;
        const { name } = entry;
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        // Shown once per read. A temporary copy of an entry already shown is
        // still promoted below, so where an entry ends up never depends on
        // the order a read meets it in.
        const shown = walk.seen.has(name);
        if (shown && !(durable && directory === temporary)) continue;
        walk.seen.add(name);
        const path = join(directory, name);
        let text;
        try {
          text = readSecureHookFile(path, COMPLETION_POINTER_MAX_BYTES);
        } catch {
          complete = false;
          continue;
        }
        let pointer;
        try {
          pointer = JSON.parse(text);
        } catch {
          continue;
        }
        if (
          !/^[a-f0-9]{16}$/.test(pointer?.ledger ?? "") ||
          pointer.ledger === ledger
        ) {
          continue;
        }
        if (pointer.version === COMPLETION_OBLIGATION_ASSOCIATION_VERSION) {
          if (completionObligationAssociationName(pointer.ledger) !== name) {
            continue;
          }
          const owned = ownedCompletionEntry(
            directory,
            name,
            text,
            pointer,
            env,
            durable,
            walk,
          );
          if (owned !== true) {
            if (owned === false) complete = false;
            continue;
          }
          if (durable && directory === temporary) {
            promoteRetainedRecord(path, join(homes[1], name), text);
          }
          if (shown) continue;
          if (walk.list) {
            pointed.push({
              association: pointer.ledger,
              transferred_from: completionProvenance(pointer.transferred_from),
            });
            walk.presented += 1;
            continue;
          }
          if (depth >= COMPLETION_HOP_LIMIT) {
            complete = false;
            continue;
          }
          const through = readAssociatedCompletionObligations(
            pointer.ledger,
            env,
            durable,
            walk,
            depth + 1,
            completionProvenance(pointer.transferred_from) ?? provenance,
            quiet ||
              ((walk.settle || !walk.reader) && pointer.forwarded === true),
          );
          pointed.push(...through.pointed);
          if (through.drained) {
            try {
              removeCompletionObligationPointerFile(ledger, name, env, true);
              removeEmptyLedgerDirectories(pointer.ledger, env, true);
            } catch {
              // Expanded again, and removed, by a later read.
            }
          } else if (!through.complete) {
            complete = false;
          }
          continue;
        }
        // Only a pointer this client wrote, named by its keeper and id.
        if (
          pointer.version !== COMPLETION_OBLIGATION_POINTER_VERSION ||
          typeof pointer.id !== "string" ||
          completionObligationPointerName(pointer.ledger, pointer.id) !== name
        ) {
          continue;
        }
        const owned = ownedCompletionEntry(
          directory,
          name,
          text,
          pointer,
          env,
          durable,
          walk,
        );
        if (owned !== true) {
          if (owned === false) complete = false;
          continue;
        }
        if (shown) {
          promoteRetainedRecord(path, join(homes[1], name), text);
          continue;
        }
        const obligation = readLedgerRecord(
          pointer.ledger,
          pointer.id,
          env,
          durable,
        );
        if (obligation === null && durable) {
          try {
            removeCompletionObligationPointer(
              ledger,
              pointer.ledger,
              pointer.id,
              env,
              true,
            );
          } catch {
            // Removed by a later read.
          }
          continue;
        }
        if (durable && directory === temporary) {
          promoteRetainedRecord(path, join(homes[1], name), text);
        }
        if (!obligation || !retainsResupplyContent(obligation)) {
          complete = false;
          continue;
        }
        pointed.push(
          presentAssociatedCompletionObligation(
            obligation,
            pointer.ledger,
            provenance,
            env,
            !(
              quiet ||
              ((walk.settle || !walk.reader) && pointer.forwarded === true)
            ),
          ),
        );
        walk.presented += 1;
      }
    } catch {
      // One unreadable home must not hide the other.
      complete = false;
    } finally {
      entries.closeSync();
    }
  }
  return { pointed, complete, present };
}

// Whether an asking read follows an entry (mechanism A, OpenClaw only): true
// for every entry Claude Code or Codex wrote (no `forwarded` flag: nothing is
// looked up), for every entry a hand-over's list, a completion's read or a
// read that asks nothing (`ask: false`) meets, and for a flagged one whose
// keeper's debts no other session asks for. A flagged entry whose debts
// another session owns is never followed: it is settled
// (settleForeignCompletionEntry) and this returns "settled", or it stays
// and this returns false (the read is then incomplete). False as well when
// the read's bound is reached while its owner is looked up.
function ownedCompletionEntry(
  directory,
  name,
  text,
  pointer,
  env,
  durable,
  walk,
) {
  if (pointer.forwarded !== true || walk.list || walk.settle || !walk.reader) {
    return true;
  }
  const owner = completionOwner(pointer.ledger, env, walk);
  if (owner === undefined) return false;
  if (!owner || owner === walk.reader) return true;
  return settleForeignCompletionEntry(
    directory,
    name,
    text,
    pointer.ledger,
    owner,
    env,
    durable,
  )
    ? "settled"
    : false;
}

// The session that asks for what `keeper` keeps (OpenClaw's path): the
// keeper's own when its marker is released (its session runs again), else
// the first ledger along its forwarding markers whose marker is released;
// null when none is (a ledger without a marker, such as the top session's,
// an invalid or looping marker, or COMPLETION_HOP_LIMIT markers read). Then
// a reader follows, as before. Every marker read counts as an examined entry
// of the read, which stops looking (undefined) once its bound is reached; an
// owner found is kept for each ledger on the way, for the rest of the read.
function completionOwner(keeper, env, walk) {
  const owners = (walk.owners ??= new Map());
  if (owners.has(keeper)) return owners.get(keeper);
  const visited = [];
  let ledger = keeper;
  let owner = null;
  let limited = true;
  for (let hop = 0; hop < COMPLETION_HOP_LIMIT; hop += 1) {
    if (owners.has(ledger)) {
      owner = owners.get(ledger);
      limited = false;
      break;
    }
    if (walk.examined >= COMPLETION_POINTER_SCAN_LIMIT) return undefined;
    visited.push(ledger);
    let marker;
    try {
      marker = JSON.parse(
        readSecureHookFile(
          completionObligationForwardPath(ledger, env),
          COMPLETION_POINTER_MAX_BYTES,
        ),
      );
    } catch {
      limited = false;
      break;
    }
    walk.examined += 1;
    if (marker?.version === COMPLETION_OBLIGATION_RELEASED_VERSION) {
      owner = ledger;
      limited = false;
      break;
    }
    if (
      marker?.version !== COMPLETION_OBLIGATION_FORWARD_VERSION ||
      !/^[a-f0-9]{16}$/.test(marker.ledger ?? "") ||
      visited.includes(marker.ledger)
    ) {
      limited = false;
      break;
    }
    ledger = marker.ledger;
  }
  // A walk cut by the hop limit says nothing about a ledger further on.
  for (const each of limited ? [keeper] : visited) owners.set(each, owner);
  return owner;
}

// A flagged entry whose debts the live session `owner` asks for: removed
// when that session keeps them itself, else moved, byte for byte, into its
// pointer homes, where its own reads follow it. Where that session already
// holds an entry of that name naming the same record or ledger (another
// holder's provenance), that one stays as it is and this one goes. The
// copy is written first (writePrivateUsageMarker: a 0600 file in a 0700
// home, never through a link); only then does the entry go, after an
// lstat of its home and of the entry itself. Nothing moves or goes while
// the durable root is refused, and a write that fails leaves the entry
// where it is. True once it is gone.
function settleForeignCompletionEntry(
  directory,
  name,
  text,
  keeper,
  owner,
  env,
  durable,
) {
  if (!durable) return false;
  try {
    if (
      owner !== keeper &&
      !writeCompletionObligationPointerFile(owner, name, text, env, true)
    ) {
      return false;
    }
    assertSecureHookDirectory(lstatSync(directory));
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// What an association to `ledger` names: its own records (every kind but the
// private hints, which stay per machine), then what it points or associates
// to in turn, within the walk's bounds. `drained`: nothing is left there and
// every home of it was examined.
function readAssociatedCompletionObligations(
  ledger,
  env,
  durable,
  walk,
  depth,
  provenance,
  quiet = false,
) {
  const pointed = [];
  const own = new Map();
  const temporary = ledgerObligationDir(ledger, env);
  let complete = durable;
  for (const directory of [
    ...(durable ? [retainedObligationDir(ledger, env)] : []),
    temporary,
  ]) {
    let entries;
    try {
      assertSecureHookDirectory(lstatSync(directory));
      entries = opendirSync(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
      continue;
    }
    try {
      for (;;) {
        if (walk.examined >= COMPLETION_POINTER_SCAN_LIMIT) {
          complete = false;
          break;
        }
        const entry = entries.readSync();
        if (!entry) break;
        walk.examined += 1;
        if (!/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
        if (walk.presented + own.size >= COMPLETION_OBLIGATION_LIMIT) {
          complete = false;
          break;
        }
        const path = join(directory, entry.name);
        try {
          const text = readSecureHookFile(path, COMPLETION_OBLIGATION_MAX_BYTES);
          const raw = JSON.parse(text);
          const obligation = normalizeCompletionObligation(raw);
          if (
            !obligation ||
            ["private_lesson", "private_skill"].includes(obligation.kind) ||
            completionObligationFileName(obligation.id) !== entry.name
          ) {
            continue;
          }
          // A sealed record in the temporary home moves to the durable one,
          // as in readLedgerRecord.
          if (
            durable &&
            directory === temporary &&
            obligation.local_resupply_envelope
          ) {
            promoteRetainedRecord(
              path,
              join(retainedObligationDir(ledger, env), entry.name),
              text,
            );
          }
          // A marker without content ages out here as in its owner's read.
          if (
            raw.local_resupply_envelope == null &&
            raw.local_resupply_payload == null &&
            Date.parse(obligation.created_at) + COMPLETION_OBLIGATION_TTL_MS <
              Date.now()
          ) {
            rmSync(path, { force: true });
            continue;
          }
          // The durable copy, read first, is the one kept.
          if (!own.has(obligation.id)) own.set(obligation.id, obligation);
        } catch {
          complete = false;
        }
      }
    } catch {
      complete = false;
    } finally {
      entries.closeSync();
    }
  }
  for (const obligation of own.values()) {
    const key = completionObligationPointerName(ledger, obligation.id);
    if (walk.seen.has(key)) continue;
    if (walk.presented >= COMPLETION_OBLIGATION_LIMIT) {
      complete = false;
      break;
    }
    walk.seen.add(key);
    pointed.push(
      presentAssociatedCompletionObligation(
        obligation,
        ledger,
        provenance,
        env,
        !quiet,
      ),
    );
    walk.presented += 1;
  }
  const deeper = readPointedCompletionObligations(
    ledger,
    env,
    durable,
    walk,
    depth,
    provenance,
    quiet,
  );
  return {
    pointed: [...pointed, ...deeper.pointed],
    complete: complete && deeper.complete,
    drained:
      complete &&
      deeper.complete &&
      own.size === 0 &&
      deeper.pointed.length === 0,
  };
}

// A debt `keeper` keeps, as the ledger that owes it shows it. One reached
// through an association that names a subagent, and that names none yet, is
// named after it where it is kept (once: the first name stays), so its
// retrieval says second-hand as its demand line does; not by a completion's
// read through an OpenClaw entry (`tag` false), which names nothing.
function presentAssociatedCompletionObligation(
  obligation,
  keeper,
  provenance,
  env,
  tag = true,
) {
  if (!provenance || obligation.transferred_from) {
    return { ...obligation, ledger: keeper };
  }
  if (tag) tagKeptCompletionObligation(keeper, obligation.id, provenance, env);
  return { ...obligation, ledger: keeper, transferred_from: provenance };
}

function completionLedgerIsFull(existing, obligation) {
  const isPrivate = (item) =>
    ["private_lesson", "private_skill"].includes(item.kind);
  // A record another ledger keeps for this one takes no room here.
  const own = existing.filter((item) => !item.ledger);
  return (
    !own.some((item) => item.id === obligation.id) &&
    own.filter((item) => isPrivate(item) === isPrivate(obligation)).length >=
      COMPLETION_OBLIGATION_LIMIT
  );
}

// A full machine-wide bound of private hints makes room for the writer's by
// dropping the oldest hint whose draft is already the user's to decide
// (privateDraftsAwaitingUser): a parked draft's, or one with no owner or an
// owner outside the writer's tree that is idle (privateHintIdle). That
// draft is offered as before; only its pointer goes. When every hint
// belongs to an active session, none goes, and the new draft, with no hint,
// reaches the user as one of those decisions.
function evictUserGatedPrivateHint(sessionId, existing, env) {
  const writer = privateHintOwner(sessionId).owner_session;
  const gated = existing.find(
    (hint) =>
      isPrivateHint(hint) &&
      !hint.ledger &&
      (readPrivateParkedMarker(hint.draft_id, env) ||
        (hint.owner_session !== writer &&
          (!hint.owner_session ||
            privateHintIdle(hint, (ledger) => privateSessionIdle(ledger, env))))),
  );
  if (gated) dropPrivateHint(gated.draft_id, env);
  return Boolean(gated);
}

// Debts a full ledger could not record are counted, never dropped silently:
// every demand for that ledger reports them until it has drained.
function readCompletionObligationOverflow(sessionId, env) {
  return readCompletionObligationOverflowAt(
    completionObligationOverflowPath(sessionId, env),
  );
}

function readCompletionObligationOverflowAt(path) {
  try {
    const value = JSON.parse(readSecureHookFile(path, 4096));
    const first = Date.parse(value?.first_dropped_at);
    const last = Date.parse(value?.last_dropped_at);
    if (
      value?.version !== COMPLETION_OBLIGATION_OVERFLOW_VERSION ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      !Number.isFinite(first) ||
      !Number.isFinite(last)
    ) {
      return null;
    }
    return {
      count: Math.min(1_000_000, value.count),
      first_dropped_at: new Date(first).toISOString(),
      last_dropped_at: new Date(last).toISOString(),
      kinds: (Array.isArray(value.kinds) ? value.kinds : []).filter((kind) =>
        [
          "query_feedback",
          "post_use_feedback",
          "remembrance_followup",
          "capture_next_action",
        ].includes(kind),
      ),
    };
  } catch {
    return null;
  }
}

function addCompletionObligationOverflow(sessionId, dropped, env) {
  const current = readCompletionObligationOverflow(sessionId, env);
  const earliest = [current?.first_dropped_at, dropped.first_dropped_at]
    .filter(Boolean)
    .sort()[0];
  const latest = [current?.last_dropped_at, dropped.last_dropped_at]
    .filter(Boolean)
    .sort()
    .at(-1);
  return writePrivateUsageMarker(
    completionObligationOverflowPath(sessionId, env),
    `${JSON.stringify({
      version: COMPLETION_OBLIGATION_OVERFLOW_VERSION,
      count: (current?.count ?? 0) + dropped.count,
      first_dropped_at: earliest,
      last_dropped_at: latest,
      kinds: [...new Set([...(current?.kinds ?? []), ...dropped.kinds])].sort(),
    })}\n`,
  );
}

// `kept`: the caller keeps the debt elsewhere when this ledger is full, or
// counts it itself (a hand-over points to it, or counts it before the debt
// leaves where it was), so it is not counted here.
function writeCompletionObligation(sessionId, obligation, env, { kept = false } = {}) {
  let normalized = normalizeCompletionObligation(obligation);
  if (!normalized) return null;
  // A record another ledger keeps for this one is rewritten where it is.
  const own = sessionHash(sessionId);
  const ledger = /^[a-f0-9]{16}$/.test(obligation?.ledger ?? "")
    ? obligation.ledger
    : own;
  // Private hints are bounded per machine, whoever owns them.
  const existing =
    ledger === own &&
    readCompletionObligations(sessionId, env, {
      pointers: false,
      privateHints: "all",
    });
  if (
    existing &&
    completionLedgerIsFull(existing, normalized) &&
    !(isPrivateHint(normalized) && evictUserGatedPrivateHint(sessionId, existing, env))
  ) {
    // A private hint only points into the private-learning outbox, which
    // stays authoritative; any other debt not kept elsewhere is counted.
    if (!kept && !["private_lesson", "private_skill"].includes(normalized.kind)) {
      countCompletionObligation(sessionId, normalized.kind, env);
    }
    return null;
  }
  let serialized = `${JSON.stringify(normalized)}\n`;
  // A payload is retained whole or not at all, and only while the record
  // still fits once every field a later rewrite can grow has grown.
  if (
    (normalized.local_resupply_payload || normalized.local_resupply_envelope) &&
    Buffer.byteLength(
      `${JSON.stringify({
        ...normalized,
        ...COMPLETION_OBLIGATION_GROWN_FIELDS,
        transferred_from:
          normalized.transferred_from ??
          COMPLETION_OBLIGATION_GROWN_FIELDS.transferred_from,
      })}\n`,
      "utf8",
    ) > COMPLETION_OBLIGATION_MAX_BYTES
  ) {
    normalized = {
      ...normalized,
      local_resupply_payload: null,
      local_resupply_envelope: null,
      local_resupply_payload_omitted: "too_large",
    };
    serialized = `${JSON.stringify(normalized)}\n`;
  }
  if (["private_lesson", "private_skill"].includes(normalized.kind)) {
    // A private hint lives in the lifecycle directory, which is refused,
    // never followed, as the retained root is; the outbox stays authoritative.
    return lifecycleDirectoryUsable(env) &&
      writePrivateUsageMarker(
        completionObligationPath(sessionId, normalized.id, env),
        serialized,
      )
      ? normalized
      : null;
  }
  const name = completionObligationFileName(normalized.id);
  const written = normalized.local_resupply_envelope
    ? writeRetainedRecord(ledger, name, serialized, normalized, env)
    : writePrivateUsageMarker(
        join(ledgerObligationDir(ledger, env), name),
        serialized,
      );
  if (!written) return null;
  return ledger === own ? normalized : { ...normalized, ledger };
}

// One debt of `kind` that ledger `sessionId` could not record, counted: true
// once the count is written.
function countCompletionObligation(sessionId, kind, env) {
  const now = new Date().toISOString();
  return addCompletionObligationOverflow(
    sessionId,
    { count: 1, first_dropped_at: now, last_dropped_at: now, kinds: [kind] },
    env,
  );
}

// A record that keeps a sealed payload is written to the durable ledger; only
// when that fails does it go to the temporary one, which the next read moves
// to the durable ledger again. A temporary copy that keeps nothing, or this
// same envelope, is then redundant and removed; any other is left alone.
function writeRetainedRecord(ledger, name, serialized, normalized, env) {
  const temporary = join(ledgerObligationDir(ledger, env), name);
  if (
    !retainedRootsUsable(env) ||
    !writePrivateUsageMarker(
      join(retainedObligationDir(ledger, env), name),
      serialized,
    )
  ) {
    return writePrivateUsageMarker(temporary, serialized);
  }
  try {
    const raw = JSON.parse(
      readSecureHookFile(temporary, COMPLETION_OBLIGATION_MAX_BYTES),
    );
    const stale = normalizeCompletionObligation(raw);
    if (
      stale?.id === normalized.id &&
      raw.local_resupply_payload == null &&
      (raw.local_resupply_envelope == null ||
        JSON.stringify(stale.local_resupply_envelope) ===
          JSON.stringify(normalized.local_resupply_envelope))
    ) {
      rmSync(temporary, { force: true });
    }
  } catch {
    // Nothing there, or nothing this write can vouch for.
  }
  return true;
}

// A private hint is (re)stamped with the recording ledger as its owner: the
// session tree that captured its draft, or acted on it last (an observed
// submit or retry adopts another session's draft).
function addCompletionObligation(sessionId, obligation, env = process.env) {
  const existing = readCompletionObligations(sessionId, env, {
    ask: false,
    privateHints: "all",
  }).find((item) => item.id === obligation.id);
  const owner = isPrivateHint(obligation) ? privateHintOwner(sessionId) : {};
  return writeCompletionObligation(
    sessionId,
    {
      version: COMPLETION_OBLIGATION_VERSION,
      ...obligation,
      ...owner,
      agent_keyed: true,
      ...(subagentIdentityUnavailable
        ? { subagent_identity: "unavailable" }
        : {}),
      created_at: existing?.created_at ?? new Date().toISOString(),
      prompted_at:
        existing?.action_tool === (obligation.action_tool ?? null) &&
        existing?.next_retry_at === (obligation.next_retry_at ?? null) &&
        existing?.failed_credential_digest ===
          (obligation.failed_credential_digest ?? null) &&
        existing?.captured_by_ledger === owner.captured_by_ledger
          ? (existing?.prompted_at ?? null)
          : null,
    },
    env,
  );
}

// A subagent's debts are kept under its agent id, and nothing reads that
// ledger once it has exited. At its stop (SubagentStop, or StopFailure when
// an API error ended it), whatever it left unpaid moves to the session's
// ledger with its payload and the subagent it came from, for the
// parent to submit as given or decline. A debt without content the parent
// already owes itself stays first-hand; one a full parent ledger cannot take
// is counted in its overflow marker, as is the subagent's own overflow count,
// once. A debt that keeps its action's payload leaves the subagent's ledger
// only once the parent holds it whole, and only on its first hop
// (handOverCompletionObligation); otherwise it stays where it is,
// second-hand, and the parent's ledger gets one content-free pointer to it,
// however many it already holds; so does every debt the subagent itself only
// points to. One stop hands over one page; the parent's reads reach the rest
// through one association (handOverLedger). A kept debt is never counted.
// Private-learning hints are held per machine, not per agent, and stay where
// they are; the subagent's session tree, its parent's, already owns them
// (privateHintOwner).
export function transferSubagentObligations(
  input,
  env = process.env,
  { forward = false } = {},
) {
  const agentId = normalizeNativeSessionId(input?.agent_id);
  if (
    !["SubagentStop", "StopFailure"].includes(input?.hook_event_name) ||
    !agentId
  ) {
    return 0;
  }
  const from = agentLedgerIdFor(input);
  // The ledger it was started from, never past it: an OpenClaw subagent
  // whose session runs again for this one's result owes what it left there.
  const to = mainLedgerIdFor(input);
  const provenance = {
    agent_id: agentId,
    transcript_path: input?.agent_transcript_path,
  };
  // A moved debt takes the parent's current engagement count, never the
  // subagent's. The parent's stop records the highest count it asked about,
  // so a subagent's higher count would hide the parent's next own use.
  const engagementCount = Math.max(1, currentEngagementCount(to, env));
  // The subagent's own count is claimed by rename before anything reads its
  // ledger (a drained read retires it), and passes on once: a repeated stop
  // finds no count to add, as a turn's is folded once.
  const overflowPath = completionObligationOverflowPath(from, env);
  const claimed = `${overflowPath}.${process.pid}.${randomBytes(6).toString("hex")}.transfer`;
  let overflow = null;
  try {
    renameSync(overflowPath, claimed);
    overflow = readCompletionObligationOverflowAt(claimed);
  } catch {
    // No count, or a concurrent stop claimed it first.
  }
  const { moved } = handOverLedger(
    from,
    to,
    ({ ledger: _kept, ...rest }) => ({
      ...rest,
      engagement_count: engagementCount,
      prompted_at: null,
      transferred_from: provenance,
    }),
    env,
    provenance,
    { forward },
  );
  try {
    if (!overflow || addCompletionObligationOverflow(to, overflow, env)) {
      rmSync(claimed, { force: true });
    } else {
      // Not added: the count goes back where it was, for the next stop.
      renameSync(claimed, overflowPath);
    }
  } catch {
    // A claimed count that cannot be returned is not counted twice.
  }
  return moved;
}

// Hands one page of `from` over to `to`: its own records and at most a page
// of what it points to (readCompletionLedger's bounds), so one event's work
// does not grow with what `from` holds. `to` first gets one content-free
// association to `from`, so whatever this page leaves (more debts, a home
// out of reach, a debt not handed over, an interrupted hook) stays
// reachable: `to`'s reads expand it under the same bounds. It goes again
// once the page handed everything over, and comes back if anything reached
// `from` meanwhile. An association `from` holds moves to `to` as it is. Only
// on OpenClaw's path (`forward`), where a ledger that handed over can still
// receive (a nested subagent's late end): `from` leaves a forwarding marker,
// and when `to` has handed over itself, the ledger it went to gets an
// association to `to`; every pointer and association it writes there says it
// is OpenClaw's (`forwarded`). `to` is always the ledger the caller names.
// `prepare` gives a debt's form in `to`. Returns how many moved, and whether
// everything moved or is pointed or associated to by `to`.
function handOverLedger(
  from,
  to,
  prepare,
  env,
  provenance = null,
  { forward = false } = {},
) {
  const source = sessionHash(from);
  const recipient = sessionHash(to);
  // No caller names one ledger twice; never hand a ledger into itself.
  if (source === recipient) return { moved: 0, associated: false };
  if (forward) writeCompletionObligationForward(from, to, provenance, env);
  // A ledger with no home hands nothing over: no association, nothing in
  // `to`'s homes. Its marker came first, so a hand-over into it that chose it
  // before the marker existed finds the marker in its own onward check (the
  // end of this function) and gives the ledger it went to an association.
  if (completionLedgerAbsent(source, env)) return { moved: 0, associated: true };
  const associated = writeCompletionObligationAssociation(
    recipient,
    source,
    provenance,
    env,
    forward,
  );
  const { obligations, complete } = readCompletionLedger(from, env, {
    associations: "list",
  });
  let moved = 0;
  let handed = complete;
  // Records of `from`'s own that this page leaves in its homes: kept records
  // `to` now points to. (Private hints are held per machine, not there, and
  // stay where they are: a subagent's already belong to `to`'s session tree,
  // an OpenClaw subagent session's went to the session that reads `to`'s
  // tree when its fold began (foldTurnLedgerIntoSession), and a Codex turn
  // records none.)
  let left = 0;
  for (const obligation of obligations) {
    if (obligation.association) {
      if (
        writeCompletionObligationAssociation(
          recipient,
          obligation.association,
          obligation.transferred_from ?? provenance,
          env,
          forward,
        )
      ) {
        try {
          removeCompletionObligationPointerFile(
            source,
            completionObligationAssociationName(obligation.association),
            env,
          );
        } catch {
          // Two associations to one ledger show its debts once.
        }
      } else {
        handed = false;
      }
      continue;
    }
    if (isPrivateHint(obligation)) continue;
    const result = handOverCompletionObligation(
      from,
      to,
      obligation,
      prepare(obligation),
      env,
      forward,
    );
    if (result === "moved") moved += 1;
    if (result === "pointed" && !obligation.ledger) left += 1;
    if (!result) handed = false;
  }
  if (handed) {
    try {
      removeCompletionObligationPointerFile(
        recipient,
        completionObligationAssociationName(source),
        env,
      );
    } catch {
      // A read of `to` removes it once `from` is found empty.
    }
    // Its directories go once nothing is left in them.
    removeEmptyLedgerDirectories(source, env);
    // What a nested hand-over put into `from` after its page was read (two
    // hooks at once, OpenClaw's path only) keeps `to`'s way to it: a pointer
    // home of `from` that is still there, or a record home when this page
    // left no record of its own there.
    if (forward && !completionLedgerAbsent(source, env, { records: !left })) {
      writeCompletionObligationAssociation(
        recipient,
        source,
        provenance,
        env,
        forward,
      );
    }
  }
  if (forward) {
    const onward = resolveCompletionRecipient(to, from, env);
    if (sessionHash(onward.recipient) !== recipient) {
      writeCompletionObligationAssociation(
        sessionHash(onward.recipient),
        recipient,
        onward.provenance,
        env,
        true,
      );
    }
  }
  return { moved, associated: handed || associated };
}

// Hands one debt from ledger `from` to ledger `to`, as `moved`: "moved" once
// `from` no longer keeps it, "pointed" once `to` points to where it stays,
// else false. A debt without content moves as before: once `to` holds its
// id, or is full and has counted it in its overflow marker; while that
// count cannot be written, it stays, where `to`'s association reaches it,
// and the next hand-over counts it. A debt that
// keeps its action's payload moves whole only on its first hop (`from`'s
// own, named after no subagent yet), before any other ledger can point to
// it, and leaves where it was kept only once `to` holds a record with the
// same id, digest and payload, byte for byte; otherwise it stays, and `to`
// gets one content-free pointer to it, so the parent's demands name it and
// the payload is never dropped; a pointer `from` held for it then goes. It
// is never counted. Whatever leaves `from` is removed by name, where it was
// kept. A repeated hand-over finds the same state and changes nothing.
function handOverCompletionObligation(
  from,
  to,
  obligation,
  moved,
  env,
  forward = false,
) {
  const keptBy = obligation.ledger ?? sessionHash(from);
  // Whether `to` holds it, or has room, depends on its own records alone.
  const own = () => readCompletionObligations(to, env, { pointers: false });
  const held = (records) =>
    records.some((item) => item.id === obligation.id && !item.ledger);
  const release = () => {
    try {
      removeCompletionObligationRecord(
        from,
        obligation,
        env,
        retainedRootsUsable(env),
      );
    } catch {
      // What `to` now holds, or has counted, is the one demanded.
    }
  };
  if (!retainsResupplyContent(obligation)) {
    if (
      held(own()) ||
      writeCompletionObligation(to, moved, env, { kept: true }) ||
      (completionLedgerIsFull(own(), moved) &&
        countCompletionObligation(to, moved.kind, env))
    ) {
      release();
      return "moved";
    }
    return false;
  }
  if (!obligation.ledger && !obligation.transferred_from) {
    const records = own();
    if (!held(records) && !completionLedgerIsFull(records, moved)) {
      writeCompletionObligation(to, moved, env, { kept: true });
    }
  }
  const holder = readLedgerRecord(sessionHash(to), obligation.id, env);
  if (holder && sameResupplyContent(holder, obligation)) {
    // The equal copy `to` holds is the one demanded now.
    release();
    try {
      removeCompletionObligationPointer(
        sessionHash(to),
        keptBy,
        obligation.id,
        env,
      );
    } catch {
      // A pointer to a record that is gone is removed by the next read.
    }
    return "moved";
  }
  // Kept where it is, the debt is the parent's now and second-hand there: the
  // first hop names the subagent it came from, and later hops keep that name.
  if (moved.transferred_from) {
    tagKeptCompletionObligation(
      keptBy,
      obligation.id,
      moved.transferred_from,
      env,
    );
  }
  if (
    !writeCompletionObligationPointer(
      sessionHash(to),
      keptBy,
      obligation.id,
      env,
      forward,
    )
  ) {
    return false;
  }
  if (obligation.ledger) {
    try {
      removeCompletionObligationPointer(
        sessionHash(from),
        keptBy,
        obligation.id,
        env,
      );
    } catch {
      // A second pointer to the same record shows it once more, never less.
    }
  }
  return "pointed";
}

// Names, once, the subagent a kept record came from, in every home of the
// ledger that keeps it. Only transferred_from changes: the id, digest and
// payload stay byte for byte, so the envelope still opens (its AAD is the id
// and digest) and an equal copy still compares equal. A record that already
// names one, or would outgrow the record bound, is left as it is. True when
// this call named it in some home.
function tagKeptCompletionObligation(ledger, obligationId, provenance, env) {
  const name = completionObligationFileName(obligationId);
  let named = false;
  for (const directory of [
    ...(retainedRootsUsable(env) ? [retainedObligationDir(ledger, env)] : []),
    ledgerObligationDir(ledger, env),
  ]) {
    const path = join(directory, name);
    try {
      const raw = JSON.parse(
        readSecureHookFile(path, COMPLETION_OBLIGATION_MAX_BYTES),
      );
      const from = normalizeCompletionObligation({
        ...raw,
        transferred_from: provenance,
      })?.transferred_from;
      if (raw?.id !== obligationId || raw.transferred_from || !from) continue;
      const tagged = `${JSON.stringify({ ...raw, transferred_from: from })}\n`;
      if (
        Buffer.byteLength(tagged, "utf8") <= COMPLETION_OBLIGATION_MAX_BYTES &&
        writePrivateUsageMarker(path, tagged)
      ) {
        named = true;
      }
    } catch {
      // Not kept in this home, or not readable: nothing to name there.
    }
  }
  return named;
}

// One content-free file of `ledger`'s pointer homes: in the durable home, or
// in the temporary one when the durable root is refused or the write fails
// (a read moves it to the durable home). No listing and no cap: a repeated
// hand-over finds it where it is. A file counts as there only when it reads
// back exactly as a read accepts it; one whose mode, owner or bytes changed
// is written again, since a read skips it. True once it is there.
// `keep` (a move): an entry of that name already there that names the same
// record or ledger (whatever provenance or flag it carries) is kept as it
// is, never written over; one that cannot be read, or names something
// else, is written over, as by every other write.
function writeCompletionObligationPointerFile(
  ledger,
  name,
  text,
  env,
  keep = false,
) {
  for (const directory of completionObligationPointerHomes(ledger, env)) {
    const path = join(directory, name);
    try {
      const existing = readSecureHookFile(path, COMPLETION_POINTER_MAX_BYTES);
      if (existing === text || (keep && sameCompletionEntry(existing, text))) {
        return true;
      }
    } catch {
      // Not there yet, unreadable, or a home this write must refuse.
    }
    if (writePrivateUsageMarker(path, text)) return true;
  }
  return false;
}

function sameCompletionEntry(existing, text) {
  try {
    const [before, after] = [JSON.parse(existing), JSON.parse(text)];
    return ["version", "ledger", "id"].every(
      (field) => before?.[field] === after?.[field],
    );
  } catch {
    return false;
  }
}

// One pointer per kept record: `target`'s record of that id. On OpenClaw's
// path (`forwarded`), where the session that keeps it can run again, it says
// so, and a read decides whose session asks for it before it follows it
// (completionOwner); Claude Code's and Codex's are written as before.
function writeCompletionObligationPointer(
  ledger,
  target,
  obligationId,
  env,
  forwarded = false,
) {
  return writeCompletionObligationPointerFile(
    ledger,
    completionObligationPointerName(target, obligationId),
    `${JSON.stringify({
      version: COMPLETION_OBLIGATION_POINTER_VERSION,
      ledger: target,
      id: obligationId,
      ...(forwarded ? { forwarded: true } : {}),
    })}\n`,
    env,
  );
}

// One association per ledger whose rest `ledger` owes: `from`, with the
// subagent its debts came from, if one is named; `forwarded` as for a pointer.
function writeCompletionObligationAssociation(
  ledger,
  from,
  provenance,
  env,
  forwarded = false,
) {
  return writeCompletionObligationPointerFile(
    ledger,
    completionObligationAssociationName(from),
    `${JSON.stringify({
      version: COMPLETION_OBLIGATION_ASSOCIATION_VERSION,
      ledger: from,
      transferred_from: completionProvenance(provenance),
      ...(forwarded ? { forwarded: true } : {}),
    })}\n`,
    env,
  );
}

// `from` handed over to `to` (OpenClaw's path): a later hand-over into
// `from` gives the ledger this leads to an association to `from`
// (resolveCompletionRecipient), until `from`'s session runs again
// (releaseCompletionForward). Content-free, in the temporary usage directory
// beside the ledger's other markers.
function writeCompletionObligationForward(from, to, provenance, env) {
  const path = completionObligationForwardPath(sessionHash(from), env);
  const text = `${JSON.stringify({
    version: COMPLETION_OBLIGATION_FORWARD_VERSION,
    ledger: sessionHash(to),
    transferred_from: completionProvenance(provenance),
  })}\n`;
  try {
    if (readSecureHookFile(path, COMPLETION_POINTER_MAX_BYTES) === text) {
      return true;
    }
  } catch {
    // Not there yet.
  }
  return writePrivateUsageMarker(path, text);
}

// True only while the durable root is usable and none of `ledger`'s homes
// exists: nothing kept, pointed or associated there, and nothing out of sight.
// `records: false` checks its pointer homes only.
function completionLedgerAbsent(ledger, env, { records = true } = {}) {
  if (!retainedRootsUsable(env)) return false;
  return [
    ...(records
      ? [ledgerObligationDir(ledger, env), retainedObligationDir(ledger, env)]
      : []),
    ...completionObligationPointerHomes(ledger, env, true),
  ].every((path) => {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  });
}

// Where a hand-over into `ledger` goes: on along the forwarding markers
// ledgers leave when they hand over, at most COMPLETION_HOP_LIMIT of them and
// never back to `from`, stopping at a ledger whose session runs again (its
// released marker) as at one without a marker; with the provenance of the
// nearest hop that names a subagent, for a hand-over that names none (a fold).
function resolveCompletionRecipient(ledger, from, env) {
  let recipient = ledger;
  let provenance = null;
  const visited = new Set([sessionHash(from), sessionHash(ledger)]);
  for (let hop = 0; hop < COMPLETION_HOP_LIMIT; hop += 1) {
    let marker;
    try {
      marker = JSON.parse(
        readSecureHookFile(
          completionObligationForwardPath(sessionHash(recipient), env),
          COMPLETION_POINTER_MAX_BYTES,
        ),
      );
    } catch {
      break;
    }
    if (
      marker?.version !== COMPLETION_OBLIGATION_FORWARD_VERSION ||
      !/^[a-f0-9]{16}$/.test(marker.ledger ?? "") ||
      visited.has(marker.ledger)
    ) {
      break;
    }
    visited.add(marker.ledger);
    provenance ??= completionProvenance(marker.transferred_from);
    recipient = { ledger: marker.ledger };
  }
  return { recipient, provenance };
}

// An OpenClaw session that handed over runs again (its next prompt): what its
// ledger holds is its own to settle again, as on master, and its next end
// hands up what is left. Its marker becomes a released one, so a read
// elsewhere leaves this session's debts, and those kept below it, to it while
// it runs (completionOwner): an association to it that a session above holds
// stays until that session's next prompt or stop, whose read removes it, and
// a run asked through it settles through it until then. Should that write
// fail, the marker goes, as before. True when it had a forwarding marker; a
// released one is left as it is. It writes nothing else.
export function releaseCompletionForward(sessionId, env = process.env) {
  const ledger = sessionHash(sessionId);
  const path = completionObligationForwardPath(ledger, env);
  if (!existsSync(path)) return false;
  try {
    if (
      readSecureHookFile(path, COMPLETION_POINTER_MAX_BYTES) ===
      COMPLETION_OBLIGATION_RELEASED_TEXT
    ) {
      return false;
    }
  } catch {
    // Unreadable: released below all the same.
  }
  if (!writePrivateUsageMarker(path, COMPLETION_OBLIGATION_RELEASED_TEXT)) {
    rmSync(path, { force: true });
  }
  return true;
}

// A debt `sessionId` holds or points to, from both homes of the ledger that
// keeps it, and the pointer to it; a refused durable root, or a home that is
// a link, is never reached through. Returns the ledger that kept it.
function removeCompletionObligationRecord(sessionId, obligation, env, durable) {
  const ledger = obligation.ledger ?? sessionHash(sessionId);
  const name = completionObligationFileName(obligation.id);
  for (const directory of [
    ...(durable ? [retainedObligationDir(ledger, env)] : []),
    ledgerObligationDir(ledger, env),
  ]) {
    try {
      assertSecureHookDirectory(lstatSync(directory));
    } catch {
      continue;
    }
    rmSync(join(directory, name), { force: true });
  }
  if (obligation.ledger) {
    removeCompletionObligationPointer(
      sessionHash(sessionId),
      obligation.ledger,
      obligation.id,
      env,
      durable,
    );
  }
  return ledger;
}

// A private hint any session holds can be removed (its draft was accepted,
// deleted or is no longer actionable); a decline passes `privateHints:
// "own"`, closing only what the caller was shown, and `keepAuthorization`,
// since its draft is only parked.
function removeCompletionObligations(
  sessionId,
  predicate,
  env,
  { privateHints = "all", keepAuthorization = false } = {},
) {
  const removed = [];
  const durable = retainedRootsUsable(env);
  const emptied = new Set();
  for (const obligation of readCompletionObligations(sessionId, env, {
    settle: true,
    privateHints,
  })) {
    if (!predicate(obligation)) continue;
    try {
      if (!["private_lesson", "private_skill"].includes(obligation.kind)) {
        emptied.add(
          removeCompletionObligationRecord(sessionId, obligation, env, durable),
        );
      } else if (lifecycleDirectoryUsable(env)) {
        rmSync(completionObligationPath(sessionId, obligation.id, env), {
          force: true,
        });
      }
      // Clear the old session-local form lazily without touching other sessions.
      if (["private_lesson", "private_skill"].includes(obligation.kind)) {
        const hash = createHash("sha256")
          .update(obligation.id, "utf8")
          .digest("hex")
          .slice(0, 32);
        rmSync(join(completionObligationDir(sessionId, env), `${hash}.json`), {
          force: true,
        });
        rmSync(
          join(legacyPrivateCompletionObligationDir(env), `${hash}.json`),
          { force: true },
        );
        const marker =
          !keepAuthorization &&
          privateAuthorizationMarkerPath(obligation.draft_id, env);
        if (marker) rmSync(marker, { force: true });
      }
      removed.push(obligation);
    } catch {
      // Fail open: a retained marker can cause one reminder, never data loss.
    }
  }
  for (const ledger of emptied) {
    removeEmptyLedgerDirectories(ledger, env, durable);
  }
  return removed;
}

function normalizedCompletionToolName(toolName) {
  const normalized = String(toolName ?? "")
    .trim()
    .toLowerCase();
  for (const candidate of [
    "query_skills",
    "get_skill",
    "get_resource",
    "invoke_skill",
    "capture_learning",
    "inspect_private_learning_outbox",
    "prepare_private_lesson_candidate",
    "submit_private_lesson_candidate",
    "retry_private_lesson_candidate",
    "submit_private_skill_candidate",
    "retry_private_skill_candidate",
    "delete_private_lesson_candidate",
    "delete_private_skill_candidate",
    "record_preference",
    "submit_query_feedback",
    "submit_feedback",
    "decline_pending_action",
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

// Host SDK payloads should be JSON, but observation must never break a turn:
// anything else has no digest.
function completionPayloadDigest(payload) {
  return resupplyPayloadDigest(payload);
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

// Post-use feedback is owed once per use, and invoking a skill version again
// while it is in use (reloading it after the host compacted the context, for
// example) is the same use. A result is in use while this ledger owes feedback
// for it under another receipt, and after the payment until the next user
// prompt (.user-prompts), whatever that prompt asks: a prompt that only names
// the skill starts a new use too. Returns the pending debt (the new receipt
// then pays it too), true for a use paid since the last prompt, or null for a
// new use.
function repeatedResultUse(
  sessionId,
  { query_id: queryId, result_id: resultId } = {},
  env = process.env,
) {
  const query = completionIdentifier(queryId);
  const result = completionIdentifier(resultId);
  if (!query || !result) return null;
  const pending = heldCompletionObligations(sessionId, env).find(
    (obligation) =>
      obligation.kind === "post_use_feedback" &&
      obligation.result_id === result,
  );
  if (pending) return pending.query_id === query ? null : pending;
  const prompt = readUserPromptCount(sessionId, env);
  return readRatedResults(sessionId, env).some(
    (item) => item.result_id === result && item.prompt === prompt,
  )
    ? true
    : null;
}

function aliasPostUseFeedbackObligation(sessionId, obligation, queryId, env) {
  const query = completionIdentifier(queryId);
  if (
    !query ||
    query === obligation.query_id ||
    (obligation.alias_query_ids ?? []).includes(query)
  ) {
    return obligation;
  }
  return writeCompletionObligation(
    sessionId,
    {
      ...obligation,
      alias_query_ids: [...(obligation.alias_query_ids ?? []), query],
    },
    env,
  );
}

// Opens the debt for a use, or, for a repeat of a use still in progress, adds
// its receipt to the debt already open.
function recordResultUseObligation(
  sessionId,
  use,
  env = process.env,
  engagementCount = currentEngagementCount(sessionId, env),
) {
  const repeat = repeatedResultUse(sessionId, use, env);
  if (repeat) {
    if (repeat !== true) {
      aliasPostUseFeedbackObligation(sessionId, repeat, use.query_id, env);
    }
    return null;
  }
  return recordPostUseFeedbackObligation(sessionId, use, env, engagementCount);
}

function readRatedResults(sessionId, env) {
  try {
    const value = JSON.parse(
      readSecureHookFile(ratedResultsPath(sessionId, env), 16 * 1024),
    );
    if (
      value?.version !== RATED_RESULTS_VERSION ||
      !Array.isArray(value.results)
    ) {
      return [];
    }
    return value.results
      .filter(
        (item) =>
          typeof item?.result_id === "string" &&
          completionIdentifier(item.result_id) &&
          Number.isInteger(item.prompt) &&
          item.prompt >= 0,
      )
      .map((item) => ({
        result_id: completionIdentifier(item.result_id),
        prompt: Math.min(1_000_000, item.prompt),
      }))
      .slice(-RATED_RESULT_LIMIT);
  } catch {
    return [];
  }
}

function recordRatedResult(sessionId, resultId, env) {
  const result = completionIdentifier(resultId);
  if (!result) return false;
  const results = readRatedResults(sessionId, env).filter(
    (item) => item.result_id !== result,
  );
  results.push({
    result_id: result,
    prompt: readUserPromptCount(sessionId, env),
  });
  return writePrivateUsageMarker(
    ratedResultsPath(sessionId, env),
    `${JSON.stringify({
      version: RATED_RESULTS_VERSION,
      results: results.slice(-RATED_RESULT_LIMIT),
    })}\n`,
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
  // The draft's own envelope says which exact action is due; the response's
  // exact next_action stands in only while the envelope cannot be read.
  // Nothing an agent can do (null): no hint, and the caller retires one.
  const envelope = readPrivateLessonEnvelope(draftId, env);
  const actionTool = envelope
    ? (privateLessonDraftAction(envelope, env)?.tool ?? null)
    : privateLessonSubmissionAction(body, draftId);
  if (!actionTool) return null;
  if (
    body?.state === "awaiting_authorization" &&
    body?.status === "not_submitted"
  ) {
    recordPrivateAuthorizationOpportunity(draftId, env);
  }
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("private_lesson", [draftId]),
      kind: "private_lesson",
      engagement_count: Math.max(1, engagementCount),
      draft_id: draftId,
      action_tool: actionTool,
      next_retry_at: body?.next_retry_at ?? null,
      failed_credential_digest:
        body?.state === "awaiting_authorization" &&
        body?.status === "not_submitted"
          ? privateObligationCredentialDigest(env)
          : null,
    },
    env,
  );
}

export function recordPrivateSkillObligation(
  sessionId,
  response,
  env = process.env,
  engagementCount = currentEngagementCount(sessionId, env),
) {
  const body = responseBodyFromToolResponse(response);
  const draftId = completionIdentifier(body?.draft_id);
  if (!/^psd_[A-Za-z0-9_-]{8,96}$/.test(draftId)) return null;
  const reformulationAvailable = privateSkillReformulationAvailable(body);
  const submissionAction = privateSkillSubmissionAction(body, draftId);
  if (
    body?.state === "submitted" ||
    (!submissionAction && !reformulationAvailable)
  )
    return null;
  if (
    body?.state === "awaiting_authorization" &&
    body?.status === "not_submitted"
  ) {
    recordPrivateAuthorizationOpportunity(draftId, env);
  }
  return addCompletionObligation(
    sessionId,
    {
      id: completionObligationId("private_skill", [draftId]),
      kind: "private_skill",
      engagement_count: Math.max(1, engagementCount),
      draft_id: draftId,
      action_tool: reformulationAvailable
        ? "inspect_private_learning_outbox"
        : submissionAction,
      next_retry_at: body?.next_retry_at ?? null,
      delivery_blocked:
        body?.status === "not_submitted" &&
        !submissionAction &&
        !reformulationAvailable,
      failed_credential_digest:
        body?.state === "awaiting_authorization" &&
        body?.status === "not_submitted"
          ? privateObligationCredentialDigest(env)
          : null,
    },
    env,
  );
}

// A response's exact next_action for one draft: the named lane's submit or
// retry tool with exactly { draft_id }.
function exactPrivateDraftAction(value, draftId, lane) {
  const action = value?.next_action;
  return action &&
    typeof action === "object" &&
    !Array.isArray(action) &&
    [
      `submit_private_${lane}_candidate`,
      `retry_private_${lane}_candidate`,
    ].includes(action.tool) &&
    action.arguments &&
    typeof action.arguments === "object" &&
    !Array.isArray(action.arguments) &&
    Object.keys(action.arguments).join(",") === "draft_id" &&
    action.arguments.draft_id === draftId
    ? action.tool
    : null;
}

function privateLessonSubmissionAction(value, draftId) {
  return exactPrivateDraftAction(value, draftId, "lesson");
}

function privateSkillSubmissionAction(value, draftId) {
  const tool = exactPrivateDraftAction(value, draftId, "skill");
  if (
    !tool ||
    (tool === "submit_private_skill_candidate" && value?.state !== "ready") ||
    (tool === "retry_private_skill_candidate" &&
      !["retry_scheduled", "awaiting_authorization"].includes(value?.state))
  ) {
    return null;
  }
  return tool;
}

function recordCaptureLearningObligation(
  sessionId,
  response,
  env,
  engagementCount,
) {
  const body = responseBodyFromToolResponse(response);
  if (body?.capture_route === "private_lesson") {
    return recordPrivateLessonObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
  }
  if (body?.capture_route === "private_skill") {
    return recordPrivateSkillObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
  }
  const nextAction = body?.next_action;
  if (
    body?.capture_route !== "preference" ||
    nextAction?.tool !== "record_preference"
  ) {
    return null;
  }
  const digest = completionPayloadDigest(nextAction.arguments);
  if (!digest) return null;
  const id = completionObligationId("capture_next_action", [digest]);
  // The exact arguments are kept sealed, as a follow-up's payload is, so a
  // demand after compaction, a restart or a subagent's exit can hand them
  // back by action id. A repeated callback keeps what is already retained.
  const existing = heldCompletionObligations(sessionId, env).find(
    (item) => item.id === id,
  );
  const retained = existing?.local_resupply_envelope
    ? { local_resupply_envelope: existing.local_resupply_envelope }
    : sealRetainedPayload(
        { id, payload_digest: digest },
        nextAction.arguments,
        env,
      );
  return addCompletionObligation(
    sessionId,
    {
      id,
      kind: "capture_next_action",
      engagement_count: Math.max(1, engagementCount),
      payload_digest: digest,
      action_tool: "record_preference",
      ...retained,
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
  const id = completionObligationId("remembrance_followup", [digest]);
  // A repeated callback keeps what is already retained, sealed or not.
  const existing = heldCompletionObligations(sessionId, env).find(
    (item) => item.id === id,
  );
  const retained =
    existing?.local_resupply_envelope || existing?.local_resupply_payload
      ? {
          local_resupply_envelope: existing.local_resupply_envelope,
          local_resupply_payload: existing.local_resupply_payload,
        }
      : sealRetainedPayload({ id, payload_digest: digest }, payload, env);
  return addCompletionObligation(
    sessionId,
    {
      id,
      kind: "remembrance_followup",
      engagement_count: Math.max(1, engagementCount),
      query_id: queryId || null,
      result_id: resultId || null,
      payload_digest: digest,
      ...retained,
    },
    env,
  );
}

// --- Retained payload key -----------------------------------------------------
//
// Owner decision 2 (Task 13) approved encrypted local retention with the
// plugin's existing local encryption, no new prompts, existing records
// readable and keys never switched. A follow-up's payload, and a durable
// preference's record_preference arguments, are therefore sealed with the
// private-learning outbox key; the format lives in pending-action-payload.mjs.
// The key sources and the rules for creating a key mirror the bundled MCP
// server's outbox (private-lesson-keychain.ts, private-lesson-outbox.ts): the
// login Keychain item first, then an existing mode-0600 key file. With
// neither, a key is created only where the outbox would create it (the
// Keychain when it confirms no item exists, else the file) and only while a
// complete inventory finds nothing retained that any key sealed
// (inventoryRetainedKeyConsumers): a first key for an installation that
// holds nothing. An existing key is never replaced; a key that cannot be
// found or made leaves the payload unretained, and the demand says so.
// Restoring the original key is the only recovery for what it sealed.
const PRIVATE_LESSON_KEYCHAIN_SERVICE = "dev.remembrance.private-lessons";
const SECURITY_BINARY = "/usr/bin/security";
let testKeychainExecutor = null;

// Tests stand in for the Keychain command on any platform; they never reach
// the real one. Passing nothing restores it.
export function useKeychainExecutorForTests(executor) {
  testKeychainExecutor = executor ?? null;
}

function keychainExecutor(...args) {
  return (testKeychainExecutor ?? execFileSync)(...args);
}

function privateLessonKeychainEnabled(env) {
  const optedOut = (value) => /^(0|false|no)$/i.test(value ?? "");
  return (
    !optedOut(env?.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN) &&
    !optedOut(process.env.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN) &&
    (testKeychainExecutor !== null ||
      (process.platform === "darwin" && existsSync(SECURITY_BINARY)))
  );
}

function privateLessonKeychainAccount() {
  return `uid-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
}

function probePrivateLessonKeychain(env) {
  if (!privateLessonKeychainEnabled(env)) return { status: "disabled" };
  try {
    const key = Buffer.from(
      String(
        keychainExecutor(
          SECURITY_BINARY,
          [
            "find-generic-password",
            "-s",
            PRIVATE_LESSON_KEYCHAIN_SERVICE,
            "-a",
            privateLessonKeychainAccount(),
            "-w",
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
          },
        ),
      ).trim(),
      "base64url",
    );
    return key.length === 32 ? { status: "ready", key } : { status: "invalid" };
  } catch (error) {
    // errSecItemNotFound (-25300) is exit status 44; nothing else proves
    // that no item exists.
    return {
      status: error?.status === 44 ? "confirmed_missing" : "unavailable",
    };
  }
}

function privateLessonKeyPath(env) {
  return join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "remembrance",
    "private-lesson-outbox.key",
  );
}

function readPrivateLessonKeyFile(env) {
  let encoded;
  try {
    encoded = readSecureHookFile(privateLessonKeyPath(env), 256).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("The private-learning key is unavailable.");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new Error("The private-learning key is invalid.");
  }
  return key;
}

function createPrivateLessonKey(env, keychain) {
  if (keychain.status === "confirmed_missing") {
    try {
      // Interactive mode reads the command from stdin, so the key never
      // appears in an argument list.
      keychainExecutor(SECURITY_BINARY, ["-i"], {
        input: `add-generic-password -s ${PRIVATE_LESSON_KEYCHAIN_SERVICE} -a ${privateLessonKeychainAccount()} -w ${randomBytes(32).toString("base64url")}\n`,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 2_000,
      });
    } catch {
      // Another process may have won the first write; never overwrite it.
    }
    // Adopt only a key the Keychain holds, ours or a concurrent winner's.
    // With still none there, the file is next, as in the outbox.
    const created = probePrivateLessonKeychain(env);
    if (created.status === "ready") {
      return { key: created.key, source: "os_keychain" };
    }
    if (created.status !== "confirmed_missing") {
      throw new Error("The private-learning Keychain key is unusable.");
    }
  }
  const path = privateLessonKeyPath(env);
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // An existing directory others can write to is refused, not repaired.
    if (existsSync(directory)) assertSecureHookDirectory(lstatSync(directory));
    ensureSecureHookDirectory(directory);
    writeFileSync(temporaryPath, `${randomBytes(32).toString("base64url")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    // Published whole or not at all; a concurrent winner's key stays.
    linkSync(temporaryPath, path);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error("The private-learning key is unavailable.");
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  const key = readPrivateLessonKeyFile(env);
  if (!key) throw new Error("The private-learning key is unavailable.");
  return { key, source: "mode_0600_file" };
}

function retainedPayloadWriteKey(env) {
  const keychain = probePrivateLessonKeychain(env);
  if (keychain.status === "ready") {
    return { key: keychain.key, source: "os_keychain" };
  }
  const file = readPrivateLessonKeyFile(env);
  if (file) return { key: file, source: "mode_0600_file" };
  if (keychain.status === "invalid") {
    throw new Error("The private-learning key is invalid.");
  }
  // Anything retained, or anything the inventory could not account for, may
  // need the original key: no other key is made beside it. The outbox holds
  // on this same inventory of both lanes and every ledger, and the hold says
  // why (pending-action-payload.mjs, retainedKeyHoldCodes).
  // The decision is the inventory's; the codes only say why.
  const inventory = inventoryRetainedKeyConsumers(env, {
    lanes: [
      privateLessonOutboxDirectoryForHook(env),
      privateSkillOutboxDirectoryForHook(env),
    ],
  });
  if (inventory.consumers.total > 0 || inventory.incomplete) {
    // A first use running at the same time may have made the key, then
    // sealed with it, since the lookup above: look once more before holding.
    const again =
      keychain.status === "confirmed_missing"
        ? probePrivateLessonKeychain(env)
        : keychain;
    if (again.status === "ready") {
      return { key: again.key, source: "os_keychain" };
    }
    const made = readPrivateLessonKeyFile(env);
    if (made) return { key: made, source: "mode_0600_file" };
    throw Object.assign(new Error("The private-learning key is missing."), {
      holdCodes: retainedKeyHoldCodes(inventory),
    });
  }
  return createPrivateLessonKey(env, keychain);
}

function sealRetainedPayload(obligation, payload, env) {
  try {
    return {
      local_resupply_envelope: sealResupplyPayload(
        obligation,
        payload,
        retainedPayloadWriteKey(env),
      ),
    };
  } catch (error) {
    const hold = normalizeRetainedKeyHoldCodes(error?.holdCodes);
    return {
      local_resupply_payload_omitted: "key_unavailable",
      ...(hold ? { local_resupply_hold: hold } : {}),
    };
  }
}

// Opens a retained payload for a demand, reading each key source at most
// once; never creates a key. Null when it cannot be opened now: the demand
// then shows the handle, and the retrieval tool reports why.
function retainedPayloadOpener(env) {
  const keys = new Map();
  const readKey = (source) => {
    if (!keys.has(source)) {
      let key = null;
      try {
        if (source === "os_keychain") {
          const probe = probePrivateLessonKeychain(env);
          key = probe.status === "ready" ? probe.key : null;
        } else {
          key = readPrivateLessonKeyFile(env);
        }
      } catch {
        key = null;
      }
      keys.set(source, key);
    }
    return keys.get(source);
  };
  return (obligation) => {
    if (obligation.local_resupply_payload) {
      return obligation.local_resupply_payload;
    }
    const envelope = obligation.local_resupply_envelope;
    const key = envelope ? readKey(envelope.key_source) : null;
    if (!key) return null;
    try {
      return openResupplyEnvelope(obligation, key);
    } catch {
      return null;
    }
  };
}

// A private hint counts as pending only while its action is due.
function completionObligationPending(obligation, env) {
  return isPrivateHint(obligation)
    ? completionObligationIsDue(obligation, env)
    : !feedbackObligationDenied(obligation, env);
}

function markEngagementHandledWhenClear(sessionId, env) {
  const count = currentEngagementCount(sessionId, env);
  const hasPending = heldCompletionObligations(sessionId, env).some(
    (obligation) => completionObligationPending(obligation, env),
  );
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
    // A query the agent completed closes the task, whatever it found.
    const body = responseBodyFromToolResponse(response);
    if (Array.isArray(body?.skills) || Array.isArray(body?.resources)) {
      closeCurrentTask(sessionId, env);
    }
    const obligation = recordQueryFeedbackObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (tool === "invoke_skill") {
    const selection = directSelectionFromResponse(response);
    // A session-scoped skill is still in use when a turn ends; see decideStop.
    const obligation =
      selection && selection.scope !== "session"
        ? recordResultUseObligation(
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
    const obligation = recordResultUseObligation(
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
  } else if (tool === "capture_learning") {
    const obligation = recordCaptureLearningObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (tool === "inspect_private_learning_outbox") {
    const body = responseBodyFromToolResponse(response);
    const selected = body?.private_skills?.selected_draft;
    if (
      /^psd_[A-Za-z0-9_-]{8,96}$/.test(
        String(input.private_skill_draft_id ?? ""),
      ) &&
      selected?.draft_id === input.private_skill_draft_id &&
      privateSkillReformulationAvailable(selected)
    ) {
      // Advance only after the exact local inspection returned. This cursor is
      // a fair prompt-selection hint, never a submission/completion receipt.
      writePrivateUsageMarker(
        join(usageDir(env), "private-skill-recovery-cursor"),
        selected.draft_id,
      );
    }
  } else if (tool === "prepare_private_lesson_candidate") {
    const obligation = recordPrivateLessonObligation(
      sessionId,
      response,
      env,
      engagementCount,
    );
    if (obligation) opened.push(obligation);
  } else if (
    tool === "delete_private_lesson_candidate" ||
    tool === "delete_private_skill_candidate"
  ) {
    const body = responseBodyFromToolResponse(response);
    const kind =
      tool === "delete_private_lesson_candidate"
        ? "private_lesson"
        : "private_skill";
    if (
      input.confirm === true &&
      body?.draft_id === input.draft_id &&
      (["deleted", "already_absent"].includes(body?.state) ||
        (body?.version === "private-lesson-outbox-deletion-v1" &&
          body?.reason === "explicit_confirmed_deletion"))
    ) {
      clearPrivateDraftMarkers(input.draft_id, env);
      closed = removeCompletionObligations(
        sessionId,
        (obligation) =>
          obligation.kind === kind && obligation.draft_id === input.draft_id,
        env,
      );
    }
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
        (obligation.query_id === queryId ||
          (obligation.alias_query_ids ?? []).includes(queryId)) &&
        obligation.result_id === resultId,
      env,
    );
    if (queryId && resultId) recordRatedResult(sessionId, resultId, env);
    const followup = recordRemembranceFollowupObligation(
      sessionId,
      response,
      input,
      env,
      engagementCount,
    );
    if (followup) opened.push(followup);
  } else if (tool === "decline_pending_action") {
    // Only the observed call closes an action, in the caller's own ledger;
    // nothing in a message can. A declined private line parks its draft
    // (keeping its authorization backoff), a declined notice for drafts
    // awaiting the user the drafts it offered; host_policy_denied is for
    // private lines and notices only. The held-safety notice names no
    // action to decline (an earlier client's did, and its decline changes
    // nothing): its delivery marked the drafts it showed. An unattended run
    // shows no notice, so its keep (an earlier transcript's action_id) is no
    // user's and parks nothing.
    const actionId = String(input.action_id ?? "");
    const reason = String(input.reason ?? "");
    const privateOnly = reason === PRIVATE_DECLINE_REASON;
    if (PENDING_ACTION_DECLINE_REASONS.includes(reason) || privateOnly) {
      closed = removeCompletionObligations(
        sessionId,
        (obligation) =>
          (!privateOnly || isPrivateHint(obligation)) &&
          completionActionId(obligation) === actionId,
        env,
        { privateHints: "own", keepAuthorization: true },
      );
      for (const hint of closed.filter(isPrivateHint)) {
        parkPrivateDraft(hint.draft_id, reason, env);
      }
      if (
        actionId === PRIVATE_ORPHAN_NOTICE_ACTION_ID &&
        organizationPrivateLessonAuthorized(env) &&
        !unattendedRun(env)
      ) {
        parkPrivateDraftsAwaitingUser(sessionId, reason, env);
      }
    }
  } else if (tool === "submit_remembrance") {
    const digest = completionPayloadDigest(input);
    const queryId = completionIdentifier(input?.interaction?.query_id);
    const resultId = completionIdentifier(input?.interaction?.result_id);
    const pendingFollowups = readCompletionObligations(sessionId, env, {
      settle: true,
    }).filter(
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
  } else if (tool === "record_preference") {
    const digest = completionPayloadDigest(input);
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "capture_next_action" &&
        obligation.action_tool === "record_preference" &&
        Boolean(digest) &&
        obligation.payload_digest === digest,
      env,
    );
  } else if (
    tool === "submit_private_lesson_candidate" ||
    tool === "retry_private_lesson_candidate"
  ) {
    const body = responseBodyFromToolResponse(response);
    const draftId = completionIdentifier(input.draft_id ?? body?.draft_id);
    // The host let this exact call through, whatever the server answered:
    // the lane is allowed again, and this explicit request unparks the draft.
    allowPrivateLane("pld_", env);
    clearPrivateDraftMarkers(draftId, env, ["parked"]);
    if (body?.retained_locally === true) {
      const retained = recordPrivateLessonObligation(
        sessionId,
        response,
        env,
        engagementCount,
      );
      if (!retained) {
        // Retained terminal work is not completed, but its old delivery hint is
        // no longer actionable. The encrypted outbox remains authoritative.
        removeCompletionObligations(
          sessionId,
          (obligation) =>
            obligation.kind === "private_lesson" &&
            obligation.draft_id === draftId,
          env,
        );
      }
      return {
        tool,
        opened: retained ? [retained] : [],
        closed: [],
        pending: heldCompletionObligations(sessionId, env),
        handled_count: 0,
      };
    }
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "private_lesson" &&
        Boolean(draftId) &&
        obligation.draft_id === draftId,
      env,
    );
    clearPrivateDraftMarkers(draftId, env);
  } else if (
    tool === "submit_private_skill_candidate" ||
    tool === "retry_private_skill_candidate"
  ) {
    const body = responseBodyFromToolResponse(response);
    const draftId = completionIdentifier(input.draft_id ?? body?.draft_id);
    allowPrivateLane("psd_", env);
    clearPrivateDraftMarkers(draftId, env, ["parked"]);
    if (body?.retained_locally === true) {
      const retained = recordPrivateSkillObligation(
        sessionId,
        response,
        env,
        engagementCount,
      );
      if (!retained) {
        removeCompletionObligations(
          sessionId,
          (obligation) =>
            obligation.kind === "private_skill" &&
            obligation.draft_id === draftId,
          env,
        );
      }
      return {
        tool,
        opened: retained ? [retained] : [],
        closed: [],
        pending: heldCompletionObligations(sessionId, env),
        handled_count: 0,
      };
    }
    closed = removeCompletionObligations(
      sessionId,
      (obligation) =>
        obligation.kind === "private_skill" &&
        Boolean(draftId) &&
        obligation.draft_id === draftId,
      env,
    );
    clearPrivateDraftMarkers(draftId, env);
  }

  const handled = COMPLETION_CONTRIBUTION_TOOLS.has(tool)
    ? markEngagementHandledWhenClear(sessionId, env)
    : {
        count: engagementCount,
        hasPending: heldCompletionObligations(sessionId, env).length > 0,
      };
  return {
    tool,
    opened,
    closed,
    pending: heldCompletionObligations(sessionId, env),
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

// An explicitly selected skill's preference offer stays in the invoke_skill
// result the agent already holds. Its post-use feedback line only points
// there, naming exact keys when they fit, so a recovery repeated on every
// prompt while the obligation is pending stays small. The pointer ends the
// line's one sentence, so the allocator keeps or drops it with the IDs.
const PREFERENCE_OFFER_POINTER_MAX_CHARS = 100;

function preferenceOfferPointer(obligation, directSelections) {
  const selection = directSelections.find(
    (candidate) =>
      candidate?.query_id === obligation.query_id &&
      candidate?.result_id === obligation.result_id,
  );
  const keys = [
    ...new Set(
      (selection?.preference_feedback_settings ?? [])
        .map((entry) => entry?.setting?.key)
        .filter(Boolean),
    ),
  ];
  if (keys.length === 0) return "";
  const label = keys.length === 1 ? "preference" : "preferences";
  const tail = ": see your invoke_skill result or get_effective_preferences";
  for (let shown = keys.length; shown > 0; shown -= 1) {
    const more = keys.length - shown;
    const pointer = `; ${label} ${keys.slice(0, shown).join(", ")}${more > 0 ? ` +${more}` : ""}${tail}`;
    if (pointer.length <= PREFERENCE_OFFER_POINTER_MAX_CHARS) return pointer;
  }
  return `; offered ${label}${tail}`;
}

// A reminder lists each action with this id, which decline_pending_action
// echoes back. A declined private line parks its draft (parkPrivateDraft).
function completionActionId(obligation) {
  return createHash("sha256")
    .update(obligation.id, "utf8")
    .digest("hex")
    .slice(0, 16);
}

const RESUPPLY_POINTER =
  "call submit_remembrance with exactly the payload on the next line";

// The bounded recovery for exact arguments this machine could not keep.
const REPEAT_ORIGINAL_REQUEST =
  "repeat the original request so the exact arguments can be supplied again";

// A prompt shares its 4,000-character context with the task, so a payload
// line may take at most half of it.
const PROMPT_PAYLOAD_MAX_CHARS = 2000;

// The plaintext size of a retained payload, known without opening it.
function retainedPayloadBytes(obligation) {
  return obligation.local_resupply_envelope
    ? resupplyEnvelopeBytes(obligation.local_resupply_envelope)
    : Buffer.byteLength(JSON.stringify(obligation.local_resupply_payload));
}

// `retained.inline` maps each follow-up whose retained payload this demand
// shows to that payload. Any other retained payload, and every durable
// preference's retained arguments, gets a handle instead: the local
// get_pending_action_payload returns it from `retained.ledger`, the ledger
// this demand was read from.
function completionObligationInstruction(
  obligations,
  directSelections,
  overflow,
  retained,
) {
  const shown = obligations.slice(0, 12);
  // The first line with each tag carries the tag's explanation, so the
  // context allocator keeps or drops the two together. Private-learning
  // lines always come after the others; one a subagent of this session
  // captured says which.
  const explained = new Set(
    [...PROVENANCE_TAG_EXPLANATIONS.keys()].map((tag) =>
      shown.find((obligation) => provenanceLabel(obligation) === tag),
    ),
  );
  const lines = shown.map((obligation) => {
    const from = explained.has(obligation)
      ? PROVENANCE_TAG_EXPLANATIONS.get(provenanceLabel(obligation))
      : provenanceLabel(obligation);
    if (obligation.kind === "query_feedback") {
      return `- Query fit${from}: call submit_query_feedback for query_id ${obligation.query_id}.`;
    }
    if (obligation.kind === "post_use_feedback") {
      return `- Post-use feedback${obligation.skill_slug ? ` for ${obligation.skill_slug}` : ""}${from}: call submit_feedback with query_id ${obligation.query_id} and result_id ${obligation.result_id}${preferenceOfferPointer(obligation, directSelections)}.`;
    }
    if (obligation.kind === "remembrance_followup") {
      const ids =
        obligation.query_id && obligation.result_id
          ? ` for query_id ${obligation.query_id} and result_id ${obligation.result_id}`
          : "";
      const payload = retained.inline.get(obligation.id);
      if (payload) {
        return `- Reusable evidence${ids}${from}: ${RESUPPLY_POINTER}, which submit_feedback returned and Remembrance keeps on this machine only to re-supply it.\n  ${resupplyPayloadLine(payload)}`;
      }
      if (
        obligation.local_resupply_envelope ||
        obligation.local_resupply_payload
      ) {
        return `- Reusable evidence${ids}${from}: payload kept on this machine (${retainedPayloadBytes(obligation)} bytes, ${obligation.payload_digest}); call local get_pending_action_payload with action_id ${completionActionId(obligation)} and ledger ${obligation.ledger ?? retained.ledger}, then submit_remembrance with exactly the payload it returns.`;
      }
      const unretained = {
        too_large: "payload too large to retain",
        key_unavailable:
          "payload not retained because the local encryption key was unavailable",
      }[obligation.local_resupply_payload_omitted];
      return unretained
        ? `- Reusable evidence${ids}${from}: ${unretained}; call submit_remembrance with the payload submit_feedback returned only if you still hold it verbatim.`
        : `- Reusable evidence${ids}${from}: submit the exact next_step.submit_remembrance_payload returned by the preceding feedback call.`;
    }
    const by =
      obligation.captured_by_agent &&
      obligation.captured_by_ledger !== retained.ledger
        ? ` (captured by subagent ${obligation.captured_by_agent})`
        : "";
    if (obligation.kind === "private_lesson") {
      return `- Private lesson${by}${from}: call ${obligation.action_tool ?? "submit_private_lesson_candidate"} with draft_id ${obligation.draft_id}.`;
    }
    if (obligation.kind === "private_skill") {
      if (obligation.action_tool === "inspect_private_learning_outbox") {
        return `- Recoverable private skill${by}${from}: call inspect_private_learning_outbox with private_skill_draft_id ${obligation.draft_id}, then follow its bounded agent reformulation instructions. Do not submit the held original.`;
      }
      if (obligation.action_tool === "retry_private_skill_candidate") {
        return `- Retry private skill${by}${from}: call retry_private_skill_candidate with draft_id ${obligation.draft_id}.`;
      }
      return `- Complete private skill${by}${from}: call submit_private_skill_candidate with draft_id ${obligation.draft_id}.`;
    }
    if (obligation.local_resupply_envelope) {
      return `- Durable preference${from}: arguments kept on this machine (${retainedPayloadBytes(obligation)} bytes, ${obligation.payload_digest}); call local get_pending_action_payload with action_id ${completionActionId(obligation)} and ledger ${obligation.ledger ?? retained.ledger}, then record_preference with exactly the arguments it returns.`;
    }
    const unretained = {
      too_large: "arguments too large to retain",
      key_unavailable:
        "arguments not retained because the local encryption key was unavailable",
    }[obligation.local_resupply_payload_omitted];
    return unretained
      ? `- Durable preference${from}: ${unretained}; call record_preference with the arguments capture_learning returned only if you still hold them verbatim${obligation.local_resupply_payload_omitted === "too_large" ? `; otherwise ${REPEAT_ORIGINAL_REQUEST}` : ""}.`
      : `- Durable preference${from}: call record_preference with the exact next_action returned by capture_learning.`;
  });
  shown.forEach((obligation, index) => {
    lines[index] += `\n  action_id ${completionActionId(obligation)}`;
  });
  if (obligations.length > lines.length) {
    lines.push(
      `- ${obligations.length - lines.length} additional pending action(s) remain in this session.`,
    );
  }
  if (overflow) {
    const kinds = overflow.kinds.length
      ? ` (${overflow.kinds.join(", ")})`
      : "";
    // Nothing of a debt that was not recorded is kept, so only the original
    // request can supply its exact arguments again.
    const action = overflow.kinds.some((kind) =>
      ["capture_next_action", "remembrance_followup"].includes(kind),
    )
      ? ` To complete a durable preference or follow-up among them, ${REPEAT_ORIGINAL_REQUEST}.`
      : "";
    lines.push(
      `- ${overflow.count} ${overflow.count === 1 ? "obligation" : "obligations"} could not be recorded since ${overflow.first_dropped_at}${kinds}: the pending list was full.${action}`,
    );
  }
  // Why the newest debt kept without its payload for want of a key has none,
  // once, with what clears that (retainedKeyHoldRemediation, shared with the
  // outbox's hold).
  const hold = obligations.findLast(
    (obligation) => obligation.local_resupply_hold,
  )?.local_resupply_hold;
  if (hold) {
    lines.push(
      `- No local encryption key was made. ${retainedKeyHoldRemediation(hold)}`,
    );
  }
  return [
    "Before finishing, silently complete only these pending Remembrance actions:",
    ...lines,
    PENDING_ACTION_DECLINE_GUIDANCE,
    shown.some(isPrivateHint) ? PRIVATE_DECLINE_GUIDANCE : null,
    FEEDBACK_DENIAL_GUIDANCE,
    "Do not mention routine hook, tool, or receipt output. Surface only a failure or required user action.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Says so when the agent reading a demand may not be the one that earned the
// debt: a subagent passed it up when it exited, an older client recorded it
// under the session alone, where a subagent's debts looked like its
// parent's, or the host named no agent where a subagent may have acted.
const PRE_AGENT_KEYING_TAG = " [pre-agent-keying]";
const SUBAGENT_IDENTITY_UNAVAILABLE_TAG = " [subagent identity unavailable]";
const PROVENANCE_TAG_EXPLANATIONS = new Map([
  [
    PRE_AGENT_KEYING_TAG,
    " [pre-agent-keying: this and every debt tagged so were recorded before per-agent keying and may be a subagent's; decline one with not_observed_by_this_agent if you did not receive it]",
  ],
  [
    SUBAGENT_IDENTITY_UNAVAILABLE_TAG,
    " [subagent identity unavailable: this host does not say whether you or a subagent received this and every debt tagged so; decline one with not_observed_by_this_agent if you did not receive it]",
  ],
]);

function provenanceLabel(obligation) {
  const from = obligation.transferred_from;
  if (from) {
    const transcript = from.transcript_path ? ` (${from.transcript_path})` : "";
    return ` (second-hand from subagent ${from.agent_id}${transcript})`;
  }
  if (obligation.subagent_identity === "unavailable") {
    return SUBAGENT_IDENTITY_UNAVAILABLE_TAG;
  }
  return obligation.agent_keyed ? "" : PRE_AGENT_KEYING_TAG;
}

// The retained payload follows its instruction as one JSON line. Whitespace
// after sentence punctuation inside its strings is escaped, so the context
// allocator sees one directive unit and keeps or drops the payload whole;
// JSON.parse still returns the identical payload.
function resupplyPayloadLine(payload) {
  return JSON.stringify(payload).replace(
    /([.!?])(\s)/gu,
    (_, mark, space) =>
      `${mark}\\u${space.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function pendingCompletionRecoveryInstruction(
  sessionId,
  env = process.env,
) {
  return pendingCompletionRecovery(sessionId, env)?.() ?? null;
}

// Null when nothing is pending, else a renderer for one prompt: `compose`
// maps a recovery text to the context that prompt would carry (by default the
// recovery alone). The prompt context is shared with the task, so it
// re-supplies one payload: the oldest within the cap whose line and pointer
// it keeps. Every other retained payload gets its retrieval handle; a payload
// of more bytes than the cap is not opened, since its line cannot fit. A
// durable preference's arguments are never opened here: only its handle is
// shown.
// The outboxes are read once for the whole prompt (readPrivateDrafts); the
// ledger once, with every private hint on the machine, of which this session
// tree's own become lines and the rest only feed the user decisions, which
// a session the host runs for a subagent does not get (`notices: false`).
export function pendingCompletionRecovery(
  sessionId,
  env = process.env,
  { notices = true } = {},
) {
  const drafts = readPrivateDrafts(env);
  const held = readCompletionObligations(sessionId, env, {
    privateHints: "all",
  });
  const retired = retireUnactionablePrivateLessonHints(
    held.filter(isPrivateHint),
    drafts,
    env,
  );
  const hints = held.filter(
    (obligation) => isPrivateHint(obligation) && !retired.has(obligation.id),
  );
  const obligations = duePendingActions(
    [
      ...held.filter((obligation) => !isPrivateHint(obligation)),
      ...hints
        .filter((hint) => privateHintOwnedBy(hint, sessionId))
        .slice(0, COMPLETION_OBLIGATION_LIMIT),
    ],
    env,
    drafts,
  );
  const lifecycle = privateLearningSessionRecovery(
    sessionId,
    hints,
    drafts,
    env,
    { notices },
  );
  if (obligations.length === 0 && !lifecycle) return null;
  const directSelections = readDirectSelectionSurfaces(sessionId, env);
  const overflow = readCompletionObligationOverflow(sessionId, env);
  // Both prompt adapters pass this source through the one shared context
  // allocator. Pre-truncating here could lose consent or query identifiers
  // before that allocator has a chance to preserve their compact forms.
  const ledger = sessionHash(sessionId);
  const render = (inline) =>
    [
      lifecycle,
      obligations.length > 0
        ? completionObligationInstruction(
            obligations,
            directSelections,
            overflow,
            { ledger, inline },
          )
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  return (compose = composeRecoveryAlone) => {
    const open = retainedPayloadOpener(env);
    for (const obligation of obligations.slice(0, 12)) {
      if (
        obligation.kind !== "remembrance_followup" ||
        !(
          obligation.local_resupply_envelope ||
          obligation.local_resupply_payload
        ) ||
        retainedPayloadBytes(obligation) > PROMPT_PAYLOAD_MAX_CHARS
      ) {
        continue;
      }
      const payload = open(obligation);
      if (!payload) continue;
      const line = resupplyPayloadLine(payload);
      if (line.length > PROMPT_PAYLOAD_MAX_CHARS) continue;
      const text = render(new Map([[obligation.id, payload]]));
      const context = compose(text);
      if (context.includes(RESUPPLY_POINTER) && context.includes(line)) {
        return text;
      }
    }
    return render(new Map());
  };
}

function composeRecoveryAlone(text) {
  return composeBoundedHookContext("", [
    { id: "private_learning_recovery", kind: "completion", text },
  ]);
}

// A Stop demand has no shared context budget: it shows every retained
// follow-up payload of the obligations it lists that opens now. A durable
// preference's arguments get their handle only.
function stopRetainedPayloads(obligations, ledgerId, env) {
  const open = retainedPayloadOpener(env);
  const inline = new Map();
  for (const obligation of obligations.slice(0, 12)) {
    if (
      obligation.kind === "remembrance_followup" &&
      (obligation.local_resupply_envelope || obligation.local_resupply_payload)
    ) {
      const payload = open(obligation);
      if (payload) inline.set(obligation.id, payload);
    }
  }
  return { ledger: sessionHash(ledgerId), inline };
}

// Increment (and return) the per-session registry-use counter. Prompt and tool
// adapters call this only after an authorized registry match or explicit skill
// invocation. A legitimate empty query remains eligible for completion recovery
// without inflating registry-use counts. Fail-open on filesystem errors.
export function recordRegistryUse(sessionId, env = process.env) {
  const path = usePath(sessionId, env);
  const next = readCountFile(path) + 1;
  writeCountFile(path, next);
  closeCurrentTask(sessionId, env);
  return next;
}

// Marks the current task (.eligible count) closed; see decideStop.
function closeCurrentTask(sessionId, env) {
  const task = readTaskEligibilityCount(sessionId, env);
  return task > 0 && writeCountFile(closedTaskPath(sessionId, env), task);
}

export function readClosedTaskCount(sessionId, env = process.env) {
  return readCountFile(closedTaskPath(sessionId, env));
}

export function markCurrentEngagementHandled(sessionId, env = process.env) {
  const count = Math.max(
    readRegistryUseCount(sessionId, env),
    readTaskEligibilityCount(sessionId, env),
  );
  if (
    count > 0 &&
    !heldCompletionObligations(sessionId, env).some((obligation) =>
      completionObligationPending(obligation, env),
    )
  ) {
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

// Every prompt adapter counts each user prompt its agent receives, after
// host text and a subagent's task are set aside and whether or not it
// queries; a paid result stays in use until the next one (repeatedResultUse).
export function recordUserPrompt(sessionId, env = process.env) {
  const path = userPromptCountPath(sessionId, env);
  const next = readCountFile(path) + 1;
  writeCountFile(path, next);
  return next;
}

export function readUserPromptCount(sessionId, env = process.env) {
  return readCountFile(userPromptCountPath(sessionId, env));
}

// A session the host showed to be a main session, not one it runs for a
// subagent: OpenCode's session.created names no parent session. Kept,
// content-free, with the session's other usage markers, so the host's next
// process still knows a session it resumes. On such a host only these get
// the user decisions about retained drafts (`subagentSession`).
function mainSessionPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.main-session`);
}

export function recordMainSession(sessionId, env = process.env) {
  return writePrivateUsageMarker(mainSessionPath(sessionId, env), "main\n");
}

export function isRecordedMainSession(sessionId, env = process.env) {
  try {
    return readSecureHookFile(mainSessionPath(sessionId, env), 16) === "main\n";
  } catch {
    return false;
  }
}

// A child session's parent, as the host named it when it created the child
// (OpenCode's session.created parentID): the parent's session id, kept
// beside the main-session marker, so every later hook of the child, in any
// process, finds the root of its session tree (sessionTreeRoot).
const SESSION_TREE_DEPTH_LIMIT = 8;

function sessionParentPath(sessionId, env) {
  return join(usageDir(env), `${sessionHash(sessionId)}.parent-session`);
}

export function recordSessionParent(sessionId, parentId, env = process.env) {
  const parent = normalizeNativeSessionId(parentId);
  return Boolean(
    parent &&
      writePrivateUsageMarker(sessionParentPath(sessionId, env), `${parent}\n`),
  );
}

// The ledger a session's usage, debts and drafts are kept under. A child
// session's is its tree root's agent ledger (<root>:agent:<child>), as a
// subagent's is, so its drafts belong to the root's session tree: listed
// silently there and to the child itself, never as a user decision to the
// child. Any other session's, a child whose root is not proven among them,
// is its own id.
export function sessionTreeLedgerId(sessionId, env = process.env) {
  const root = sessionTreeRoot(sessionId, env);
  return root && normalizeNativeSessionId(sessionId)
    ? agentLedgerIdFor({ session_id: root, agent_id: sessionId })
    : sessionId;
}

// The root of a child session's tree, its recorded parent links followed at
// most SESSION_TREE_DEPTH_LIMIT times. Null for a session with no recorded
// parent, and for a chain that does not end within the bound, which proves
// nothing.
function sessionTreeRoot(sessionId, env) {
  let current = sessionId;
  for (let depth = 0; depth <= SESSION_TREE_DEPTH_LIMIT; depth += 1) {
    let parent = null;
    try {
      parent = normalizeNativeSessionId(
        readSecureHookFile(sessionParentPath(current, env), 512).trim(),
      );
    } catch {
      // No recorded parent: `current` is the root.
    }
    if (!parent) return depth === 0 ? null : current;
    current = parent;
  }
  return null;
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
  // A local capture_learning result names its route and nothing else here:
  // the preference route carries no query or draft id.
  if (
    typeof value.capture_route === "string" ||
    typeof value.query_id === "string" ||
    typeof value.draft_id === "string" ||
    typeof value.private_skills?.selected_draft?.draft_id === "string" ||
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
    (value.status === "not_submitted" && value.retained_locally !== true) ||
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
      typeof body.query_id === "string"
        ? safeText(body.query_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
        : null,
    result_id:
      typeof body.result_id === "string"
        ? safeText(body.result_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
        : null,
    slug: safeText(skill.slug, MAX_FEEDBACK_IDENTIFIER_CHARS),
    version:
      skill.version === null || skill.version === undefined
        ? null
        : safeText(skill.version, 80),
    version_id:
      typeof skill.version_id === "string"
        ? safeText(skill.version_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
        : null,
    source:
      typeof skill.source === "string" ? safeText(skill.source, 40) : null,
    // "session" marks a skill invoked to stay active for the whole session;
    // anything else, including a missing field, is one task.
    scope: body.scope === "session" ? "session" : "task",
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

// Every tool observer records an invoke_skill selection through this helper.
// A session-scoped skill stays active for the whole session, so invoking it is
// not registry use that a turn's stop should close: it is stored at the
// current use count instead of advancing it. Invoking a skill version again
// while it is in use (repeatedResultUse), or a host reporting the same
// invocation twice, is the same use: nothing is recorded and the first
// receipt's surface stays, but the skill was used for the current task, so
// that task is closed. Returns the use count.
export function recordDirectSelectionUse(
  sessionId,
  selection,
  env = process.env,
  options = {},
) {
  if (
    selection.scope !== "session" &&
    (repeatedResultUse(sessionId, selection, env) ||
      (selection.query_id &&
        selection.result_id &&
        readDirectSelectionSurfaces(sessionId, env).some(
          (item) =>
            item.query_id === selection.query_id &&
            item.result_id === selection.result_id,
        )))
  ) {
    closeCurrentTask(sessionId, env);
    return readRegistryUseCount(sessionId, env);
  }
  const recordUse = options.recordRegistryUse ?? recordRegistryUse;
  const useCount =
    selection.scope === "session"
      ? readRegistryUseCount(sessionId, env)
      : recordUse(sessionId, env);
  const recordSelection =
    options.recordDirectSelection ?? recordDirectSelectionSurface;
  recordSelection(sessionId, { ...selection, use_count: useCount }, env);
  return useCount;
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
    query_id: selection.query_id
      ? safeText(selection.query_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    result_id: selection.result_id
      ? safeText(selection.result_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    slug: safeText(selection.slug, MAX_FEEDBACK_IDENTIFIER_CHARS),
    version: selection.version ? safeText(selection.version, 80) : null,
    version_id: selection.version_id
      ? safeText(selection.version_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    source: selection.source ? safeText(selection.source, 40) : null,
    scope: selection.scope === "session" ? "session" : "task",
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
    query_id: selection.query_id
      ? safeText(selection.query_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    result_id: selection.result_id
      ? safeText(selection.result_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    slug: safeText(selection.slug, MAX_FEEDBACK_IDENTIFIER_CHARS),
    version: selection.version ? safeText(selection.version, 80) : null,
    version_id: selection.version_id
      ? safeText(selection.version_id, MAX_FEEDBACK_IDENTIFIER_CHARS)
      : null,
    source: selection.source ? safeText(selection.source, 40) : null,
    scope: selection.scope === "session" ? "session" : "task",
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
      selection.scope !== "session" &&
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
    scope: directSelection && body.scope === "session" ? "session" : "task",
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
        scope: item.scope === "session" ? "session" : "task",
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
  // A session-scoped skill has not completed when a turn stops, so its
  // episode stays unreported. Reporting it when the session ends is a
  // follow-up.
  const pending = records
    .filter((item) => !item.reported_at && item.scope !== "session")
    .slice(0, 5);
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
  const timeout = setTimeout(
    () => controller.abort(),
    autoQueryTimeoutMs(env, DEFAULT_TIMEOUT_MS),
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

// The main thread's ledger. Debts outlive a turn, so it is keyed by the
// session: Codex sends session_id ("Session id shared by threads that belong
// to the same session tree") with every hook and a new turn_id ("the active
// turn id") for every prompt. The turn id is only a fallback for a host that
// sends no session id; Claude Code and VS Code send no turn id.
function mainLedgerIdFor(input) {
  return input?.session_id ?? input?.turn_id ?? "unknown";
}

// The ledger of the agent that received a Remembrance payload. A subagent
// shares its parent's session_id, and Claude Code derives transcript_path from
// that id too, so only the host's agent_id, sent when a hook fires inside a
// subagent, separates a subagent's debts from its parent's. Without an agent id
// this is the main thread's ledger.
export function agentLedgerIdFor(input) {
  const agentId = normalizeNativeSessionId(input?.agent_id);
  return agentId
    ? `${mainLedgerIdFor(input)}:agent:${agentId}`
    : mainLedgerIdFor(input);
}

// VS Code (Copilot Chat 0.61) runs a subagent under its parent's session_id
// and names it only in SubagentStart and SubagentStop; its prompt and tool
// hooks carry no agent id. An adapter for such a host declares that once at
// load, and each debt it then records is stamped subagent_identity
// "unavailable": it may be a subagent's. Nothing is recorded under the
// subagent's own id there, so its SubagentStop finds nothing to ask.
let subagentIdentityUnavailable = false;
export function declareSubagentIdentityUnavailable() {
  subagentIdentityUnavailable = true;
}

// Such a host also sends a subagent's task through UserPromptSubmit, just
// after its SubagentStart and under the parent's session_id: Copilot Chat
// 0.61 awaits a subagent request's SubagentStart hooks, then runs its
// UserPromptSubmit hooks (extension.js:2815), each input stamped with the
// host's clock when that hook starts (`timestamp`, extension.js:6677). A
// SubagentStart leaves a marker, and a prompt the host stamped within
// SUBAGENT_START_CLAIM_MS after it claims it: that prompt is the subagent's
// task, neither the user's nor its parent's. Between the two lie only the
// rest of the SubagentStart hook and the host's transcript flush (at most
// 500 ms). A marker whose prompt never came, because the request was
// cancelled between the two hooks, is discarded by the next prompt stamped
// later than that; one the host stamped within it is still taken for the
// subagent's (it gets no query or recovery context; the next prompt does).
// Without a host stamp, the time of the claim stands in for it.
const SUBAGENT_START_CLAIM_MS = 10_000;
// Clock granularity between a file's mtime and a host's millisecond stamp.
const SUBAGENT_START_CLOCK_SLACK_MS = 1_000;

function subagentStartDir(input, env) {
  return join(
    usageDir(env),
    `${sessionHash(mainLedgerIdFor(input))}.subagent-starts`,
  );
}

export function recordSubagentStart(input, env = process.env) {
  const agentId = normalizeNativeSessionId(input?.agent_id);
  if (input?.hook_event_name !== "SubagentStart" || !agentId) return false;
  const name = createHash("sha256")
    .update(agentId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return writePrivateUsageMarker(
    join(subagentStartDir(input, env), `${name}.start`),
    "subagent-start-v1\n",
  );
}

export function claimSubagentStart(input, env = process.env) {
  const directory = subagentStartDir(input, env);
  let names;
  try {
    assertSecureHookDirectory(lstatSync(directory));
    names = readdirSync(directory)
      .filter((name) => /^[a-f0-9]{32}\.start$/.test(name))
      .slice(0, COMPLETION_OBLIGATION_LIMIT);
  } catch {
    return false;
  }
  const stamped = Date.parse(String(input?.timestamp ?? ""));
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  for (const name of names) {
    const marker = join(directory, name);
    let written;
    try {
      written = lstatSync(marker).mtimeMs;
    } catch {
      continue;
    }
    // A start recorded after the host stamped this prompt awaits its own.
    if (written > at + SUBAGENT_START_CLOCK_SLACK_MS) continue;
    const claimed = join(
      directory,
      `${name}.${process.pid}.${randomBytes(6).toString("hex")}.claimed`,
    );
    try {
      // Only one prompt can move a marker.
      renameSync(marker, claimed);
    } catch {
      continue;
    }
    rmSync(claimed, { force: true });
    if (at - written <= SUBAGENT_START_CLAIM_MS) return true;
  }
  return false;
}

// Before this client a Codex main thread kept its debts under turn_id, so
// turn N's debts were read under turn N+1 and never demanded. Each Codex hook
// folds the ledger of the turn it names into the session's: whole records,
// unchanged, each removed from the turn's ledger only once the session holds
// it; a kept one a full session ledger cannot take stays and the session
// points to it, any other is counted in its overflow marker, and the turn
// ledger's own count follows once every debt is moved, pointed or
// associated to (one page per hook; the session's reads reach the rest). The
// ledgers of earlier turns record no session id, so nothing links them to
// this one.
export function foldTurnLedgerIntoSession(
  input,
  env = process.env,
  { forward = false } = {},
) {
  const session = input?.session_id;
  const turn = input?.turn_id;
  if (
    typeof session !== "string" ||
    typeof turn !== "string" ||
    !session ||
    !turn ||
    session === turn
  ) {
    return 0;
  }
  const overflowPath = completionObligationOverflowPath(turn, env);
  // OpenClaw hands a subagent's session ledger up through here, `forward`:
  // it leaves its marker even when it holds nothing, so a nested subagent
  // whose end comes later still reaches where it went. Its private hints are
  // held per machine, not in its homes, so the ones it owns become the
  // session's tree's here (adoptPrivateHint), whatever else it holds.
  if (forward) {
    writeCompletionObligationForward(turn, session, null, env);
    for (const hint of privateHintsOnMachine(turn, env)) {
      if (privateHintOwnedBy(hint, turn) && !privateHintOwnedBy(hint, session)) {
        adoptPrivateHint(hint, session, env);
      }
    }
  }
  // Once folded, a turn leaves nothing behind: one check per home per hook.
  // A ledger that only points to debts (an OpenClaw subagent's whose own
  // subagent left them) is folded too.
  if (
    !existsSync(completionObligationDir(turn, env)) &&
    !existsSync(retainedObligationDir(sessionHash(turn), env)) &&
    !existsSync(completionObligationPointerDir(sessionHash(turn), env)) &&
    !existsSync(temporaryCompletionObligationPointerDir(sessionHash(turn), env)) &&
    !existsSync(overflowPath)
  ) {
    return 0;
  }
  // Into the session it names, never past it; whole records, unchanged.
  const { moved, associated } = handOverLedger(
    turn,
    session,
    ({ ledger: _kept, ...whole }) => whole,
    env,
    null,
    { forward },
  );
  // A debt the session neither holds, nor points or associates to, stays,
  // and the turn's overflow count waits with it: moved alone, a count would
  // be retired by the next read of a session ledger holding no debt.
  if (!associated) return moved;
  removeEmptyLedgerDirectories(sessionHash(turn), env);
  // Claimed by rename, so a concurrent hook cannot count it twice.
  const claimed = `${overflowPath}.${process.pid}.${randomBytes(6).toString("hex")}.fold`;
  try {
    renameSync(overflowPath, claimed);
  } catch {
    return moved;
  }
  const overflow = readCompletionObligationOverflowAt(claimed);
  if (!overflow || addCompletionObligationOverflow(session, overflow, env)) {
    rmSync(claimed, { force: true });
  } else {
    renameSync(claimed, overflowPath);
  }
  return moved;
}

// Native recovery has a stricter provenance boundary than lifecycle counters.
// Adapters pass only a host-provided stable session/thread identifier here;
// turn IDs and compatibility fallbacks remain valid only for the older marker
// accounting performed by sessionIdFor().
export function normalizeNativeSessionId(value) {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  if (
    sessionId.length === 0 ||
    sessionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(sessionId) ||
    /^(?:unknown|null|undefined|cursor|opencode-session)$/iu.test(sessionId)
  ) {
    return null;
  }
  return sessionId;
}

export function disabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? ""));
}

export function contributeDisabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? "").trim());
}

export function visibleCompletionRecoveryEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(
    String(env?.REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY ?? "").trim(),
  );
}

// REMEMBRANCE_UNATTENDED=1 marks a run no person attends, such as a
// scheduled or headless one. Its prompts and stops compose none of the
// user-decision notices (privateDraftNotices), so it neither shows nor uses
// one up, and a keep it observes parks nothing. Its own drafts' lines and
// learning are unchanged.
function unattendedRun(env = process.env) {
  return /^(1|true|yes)$/i.test(
    String(env?.REMEMBRANCE_UNATTENDED ?? "").trim(),
  );
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

function privateSkillOutboxDirectoryForHook(env = process.env) {
  const stateRoot = String(env?.XDG_STATE_HOME ?? "").trim();
  return join(
    stateRoot || join(homedir(), ".local", "state"),
    "remembrance",
    "private-skills",
  );
}

const PRIVATE_LESSON_STATES = [
  "ready",
  "awaiting_authorization",
  "retry_scheduled",
  "awaiting_compatible_profile",
  "held_safety",
  "held_policy",
  "held_validation",
  "submitted",
  "superseded_redactor",
];
const PRIVATE_HOLD_TELEMETRY_STATUSES = [
  "not_required",
  "pending",
  "awaiting_authorization",
  "retry_scheduled",
  "awaiting_compatible_profile",
  "submitted",
  "disabled",
];
// The held_policy codes a retry refreshes, as the server's retry gate allows.
const PRIVATE_POLICY_REFRESH_CODES = [
  "policy_expired",
  "policy_changed",
  "policy_sequence_conflict",
  "unsupported_redaction_version",
  "unsupported_redactor_digest",
];

function privateLessonEnvelopeValid(value, draftId) {
  return (
    value?.version === "private-lesson-outbox-envelope-v1" &&
    value.draft_id === draftId &&
    PRIVATE_LESSON_STATES.includes(value.state) &&
    (value.last_error_code == null ||
      typeof value.last_error_code === "string") &&
    PRIVATE_HOLD_TELEMETRY_STATUSES.includes(value.hold_telemetry_status)
  );
}

// The one exact agent action a lesson draft's content-free envelope allows
// now, as the server's retry gate permits it: { tool, count, due }, where
// `count` names the lifecycle tally it adds to. Null when only inspection, a
// user decision or nothing is left: held_validation, a classified safety
// hold (or any safety hold while health reporting is off), a policy hold a
// retry cannot refresh, a terminal state. A line, a notice and the lifecycle
// counts all come from this one rule.
function privateLessonDraftAction(envelope, env) {
  const submit = "submit_private_lesson_candidate";
  const retry = "retry_private_lesson_candidate";
  const whenDue = (count) => ({
    tool: retry,
    count,
    due: retryIsDue(envelope.next_retry_at),
  });
  const authorization = () => ({
    tool: retry,
    count: "awaiting_authorization",
    due: privateAuthorizationRetryIsDue(
      envelope.draft_id,
      envelope.updated_at,
      env,
    ),
  });
  const { state } = envelope;
  if (state === "ready") return { tool: submit, count: "ready", due: true };
  if (state === "retry_scheduled" || state === "awaiting_compatible_profile")
    return whenDue(state);
  if (state === "awaiting_authorization") return authorization();
  if (state === "held_policy") {
    return PRIVATE_POLICY_REFRESH_CODES.includes(envelope.last_error_code)
      ? { tool: retry, count: "held_policy_refresh", due: true }
      : null;
  }
  if (state !== "held_safety" || !privateLessonHealthReportingEnabledForHook(env))
    return null;
  const status = envelope.hold_telemetry_status;
  if (status === "pending")
    return { tool: submit, count: "hold_telemetry_pending", due: true };
  if (status === "retry_scheduled" || status === "awaiting_compatible_profile")
    return whenDue(`hold_telemetry_${status}`);
  return status === "awaiting_authorization" ? authorization() : null;
}

// One read of an outbox, bounded by its directory: each draft named there
// with what `evaluate` makes of its envelope ({ envelope: null } when it
// cannot be read or trusted). `readable` is false when no organization
// credential applies or the directory itself is refused; nothing is then
// known about any draft.
function scanPrivateOutbox(env, directory, pattern, maxBytes, evaluate) {
  const drafts = new Map();
  if (!privateOutboxReadable(env, directory)) return { readable: false, drafts };
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const draftId = entry.name.match(pattern)?.[1];
      if (!draftId) continue;
      let known = null;
      try {
        if (!entry.isSymbolicLink() && entry.isFile()) {
          known = evaluate(
            JSON.parse(readSecureHookFile(join(directory, entry.name), maxBytes)),
            draftId,
          );
        }
      } catch {
        // An interrupted or unreadable entry must not hide independent drafts.
      }
      drafts.set(draftId, known ?? { envelope: null });
    }
    return { readable: true, drafts };
  } catch {
    return { readable: false, drafts: new Map() };
  }
}

// Whether an outbox can answer for its drafts: an organization credential
// applies and its directory is the current user's own, private one.
function privateOutboxReadable(env, directory) {
  if (!organizationPrivateLessonAuthorized(env)) return false;
  try {
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (isPosixHookRuntime() && (metadata.mode & 0o077) !== 0)
    ) {
      return false;
    }
    assertCurrentHookUser(metadata.uid);
    return true;
  } catch {
    return false;
  }
}

function scanPrivateLessonOutbox(env) {
  return scanPrivateOutbox(
    env,
    privateLessonOutboxDirectoryForHook(env),
    /^(pld_[A-Za-z0-9_-]{8,96})\.lesson\.json$/,
    MAX_PRIVATE_LESSON_ENVELOPE_BYTES,
    (envelope, draftId) =>
      privateLessonEnvelopeValid(envelope, draftId)
        ? { envelope, action: privateLessonDraftAction(envelope, env) }
        : null,
  );
}

// One draft's envelope, or null when it cannot be read or trusted.
function readPrivateLessonEnvelope(draftId, env) {
  try {
    const envelope = JSON.parse(
      readSecureHookFile(
        join(privateLessonOutboxDirectoryForHook(env), `${draftId}.lesson.json`),
        MAX_PRIVATE_LESSON_ENVELOPE_BYTES,
      ),
    );
    return privateLessonEnvelopeValid(envelope, draftId) ? envelope : null;
  } catch {
    return null;
  }
}

// What a lesson hint's draft allows, as its outbox answers: { action } (null
// when no agent action is due from it, or no such draft is retained), or
// null when the outbox cannot answer and the hint's recorded fields decide.
// `scan` is this prompt's scanPrivateLessonOutbox; without it, one read.
function privateLessonHintAction(draftId, env, scan = null) {
  if (!scan) {
    const envelope = readPrivateLessonEnvelope(draftId, env);
    if (envelope) return { action: privateLessonDraftAction(envelope, env) };
    // A readable outbox without the draft has nothing to act on, as a scan
    // finds it.
    const directory = privateLessonOutboxDirectoryForHook(env);
    try {
      lstatSync(join(directory, `${draftId}.lesson.json`));
      return null;
    } catch (error) {
      return error?.code === "ENOENT" && privateOutboxReadable(env, directory)
        ? { action: null }
        : null;
    }
  }
  if (!scan.readable) return null;
  const entry = scan.drafts.get(draftId);
  if (!entry) return { action: null };
  return entry.envelope ? { action: entry.action } : null;
}

// `scan` (scanPrivateLessonOutbox) may hold only some drafts: the counts are
// theirs.
export function readPrivateLessonLifecycleState(
  env = process.env,
  scan = scanPrivateLessonOutbox(env),
) {
  if (!scan.readable) return null;
  const counts = {
    ready: 0,
    retry_scheduled: 0,
    awaiting_authorization: 0,
    awaiting_compatible_profile: 0,
    held_policy_refresh: 0,
    hold_telemetry_pending: 0,
    hold_telemetry_retry_scheduled: 0,
    hold_telemetry_awaiting_compatible_profile: 0,
  };
  const authorizationIds = [];
  for (const [draftId, { action }] of scan.drafts) {
    if (!action?.due) continue;
    counts[action.count] += 1;
    if (action.count === "awaiting_authorization") authorizationIds.push(draftId);
  }
  if (Object.values(counts).every((count) => count === 0)) return null;
  return {
    ...counts,
    next_authorization_draft_id: authorizationIds.sort()[0] ?? null,
    host_denial_active: recentPrivateLessonHostDenial(env),
  };
}

function retryIsDue(value) {
  if (!value) return true;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function privateSkillRecoveryAction(value, allowStaleInspectorAction = false) {
  const action = value?.next_action;
  if (!action || typeof action !== "object" || Array.isArray(action))
    return null;
  if (
    Object.keys(action).sort().join(",") !==
      "candidate_digest,draft_updated_at,inspector_digest,kind,version" ||
    action.version !== "private-skill-recovery-action-v1" ||
    ![
      "submit_candidate",
      "retry_delivery",
      "retry_resolution",
      "reformulate",
      "retry_operational",
      "reinspect",
      "capture_native_context",
    ].includes(action.kind) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(action.candidate_digest ?? "")) ||
    action.draft_updated_at !== value.updated_at ||
    action.inspector_digest !== (value.inspector_digest ?? null)
  ) {
    return null;
  }
  const currentInspector =
    action.inspector_digest === PRIVATE_LEARNING_INSPECTOR_DIGEST;
  const staleInspectorAction =
    allowStaleInspectorAction &&
    typeof action.inspector_digest === "string" &&
    !currentInspector &&
    ((action.kind === "submit_candidate" && value.state === "ready") ||
      (["reformulate", "retry_operational", "capture_native_context"].includes(
        action.kind,
      ) &&
        value.state === "held_validation"));
  if (
    (action.kind === "submit_candidate" &&
      ((!currentInspector && !staleInspectorAction) ||
        value.state !== "ready")) ||
    (action.kind === "retry_delivery" &&
      !["ready", "retry_scheduled"].includes(value.state)) ||
    (action.kind === "retry_resolution" &&
      ![
        "held_validation",
        "retry_scheduled",
        "awaiting_authorization",
      ].includes(value.state)) ||
    (["reformulate", "retry_operational", "capture_native_context"].includes(
      action.kind,
    ) &&
      ((!currentInspector && !staleInspectorAction) ||
        value.state !== "held_validation")) ||
    (action.kind === "reinspect" &&
      (currentInspector ||
        !["ready", "held_safety", "held_validation"].includes(value.state)))
  ) {
    return null;
  }
  return action;
}

// Tool responses already carry the outbox's outcome-derived availability.
// This compatibility helper never reconstructs eligibility from a reason code.
function privateSkillReformulationAvailable(value) {
  if (privateSkillRecoveryAction(value)?.kind === "reformulate") return true;
  return (
    value?.state === "held_validation" &&
    value?.attempts === 0 &&
    value?.reformulation_available === true &&
    value?.reformulation_status === "awaiting_candidate" &&
    value?.reformulation_attempt_count === 0 &&
    value?.retained_locally === true &&
    value?.next_action === null
  );
}

function bundledNativeContextServerPath() {
  try {
    const path = fileURLToPath(
      new URL("../servers/remembrance-mcp.mjs", import.meta.url),
    );
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    assertCurrentHookUser(metadata.uid);
    if (isPosixHookRuntime() && (metadata.mode & 0o022) !== 0) return null;
    return path;
  } catch {
    return null;
  }
}

function privateSkillNativeContextEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sessionId = normalizeNativeSessionId(value.session_id);
  if (!sessionId) return null;
  if (
    value.kind === "qualified_user_prompt" &&
    value.producer === "openclaw_reply_dispatch" &&
    typeof value.prompt === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(String(value.source_event_digest ?? ""))
  ) {
    return {
      kind: "qualified_user_prompt",
      producer: "openclaw_reply_dispatch",
      session_id: sessionId,
      prompt: value.prompt,
      source_event_digest: value.source_event_digest,
    };
  }
  if (
    value.kind === "user_prompt" &&
    value.origin === "user" &&
    typeof value.prompt === "string"
  ) {
    return {
      kind: "user_prompt",
      session_id: sessionId,
      origin: "user",
      prompt: value.prompt,
    };
  }
  if (
    value.kind === "private_skill_capture" &&
    /^psd_[A-Za-z0-9_-]{8,96}$/u.test(String(value.draft_id ?? "")) &&
    value.original_capture === true
  ) {
    return {
      kind: "private_skill_capture",
      session_id: sessionId,
      draft_id: value.draft_id,
      original_capture: true,
    };
  }
  return null;
}

function nativeContextBridgeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(value.status ?? "");
  if (
    !["bound", "recorded", "regranted", "revoked", "ignored", "disabled", "unavailable"].includes(
      status,
    )
  ) {
    return null;
  }
  const result = { status };
  if (["recorded", "regranted"].includes(status) && Number.isSafeInteger(value.count)) {
    result.count = Math.max(0, Number(value.count));
  }
  if (
    status === "unavailable" &&
    /^native_context_[a-z_]{1,80}$/u.test(String(value.reason_code ?? ""))
  ) {
    result.reason_code = value.reason_code;
  }
  return result;
}

/**
 * Invoke the fixed local native-context command. The child receives no shell,
 * no MCP request, and no alternate transport. All output is reduced to a
 * bounded content-free status before it reaches adapter code.
 */
export function runPrivateSkillNativeContextBridge(event, options = {}) {
  const parsed = privateSkillNativeContextEvent(event);
  if (!parsed) {
    return Promise.resolve({
      status: "unavailable",
      reason_code: "native_context_event_invalid",
    });
  }
  let input;
  try {
    input = `${JSON.stringify(parsed)}\n`;
  } catch {
    return Promise.resolve({
      status: "unavailable",
      reason_code: "native_context_event_invalid",
    });
  }
  if (
    Buffer.byteLength(input, "utf8") >
    PRIVATE_SKILL_NATIVE_CONTEXT_EVENT_MAX_BYTES
  ) {
    return Promise.resolve({
      status: "unavailable",
      reason_code: "native_context_event_too_large",
    });
  }
  const serverPath = options.serverPath ?? bundledNativeContextServerPath();
  if (!serverPath) {
    return Promise.resolve({
      status: "unavailable",
      reason_code: "native_context_bundle_unavailable",
    });
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = Math.min(
    10_000,
    Math.max(
      100,
      Number(options.timeoutMs) || PRIVATE_SKILL_NATIVE_CONTEXT_TIMEOUT_MS,
    ),
  );
  return new Promise((resolvePromise) => {
    let settled = false;
    let outputBytes = 0;
    const output = [];
    const finish = (result, child, timer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.stdin?.end();
      } catch {
        // The local child may already have exited.
      }
      resolvePromise(result);
    };
    let child;
    try {
      child = spawnImpl(process.execPath, [serverPath, "--native-context"], {
        cwd: dirname(serverPath),
        env: { ...process.env, ...(options.env ?? {}) },
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolvePromise({
        status: "unavailable",
        reason_code: "native_context_bridge_unavailable",
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort bounded shutdown.
      }
      finish(
        {
          status: "unavailable",
          reason_code: "native_context_bridge_timeout",
        },
        child,
        timer,
      );
    }, timeoutMs);
    child.on("error", () => {
      finish(
        {
          status: "unavailable",
          reason_code: "native_context_bridge_unavailable",
        },
        child,
        timer,
      );
    });
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > PRIVATE_SKILL_NATIVE_CONTEXT_OUTPUT_MAX_BYTES) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Best-effort bounded shutdown.
        }
        finish(
          {
            status: "unavailable",
            reason_code: "native_context_output_too_large",
          },
          child,
          timer,
        );
        return;
      }
      output.push(bytes);
    });
    child.on("close", (code) => {
      if (settled) return;
      let parsedOutput = null;
      if (code === 0) {
        try {
          parsedOutput = nativeContextBridgeResult(
            JSON.parse(Buffer.concat(output).toString("utf8").trim()),
          );
        } catch {
          // Child diagnostics and malformed output stay inside the bridge.
        }
      }
      finish(
        parsedOutput ?? {
          status: "unavailable",
          reason_code: "native_context_bridge_unavailable",
        },
        child,
        timer,
      );
    });
    child.stdin?.on("error", () => {
      finish(
        {
          status: "unavailable",
          reason_code: "native_context_bridge_unavailable",
        },
        child,
        timer,
      );
    });
    try {
      child.stdin?.end(input, "utf8");
    } catch {
      finish(
        {
          status: "unavailable",
          reason_code: "native_context_bridge_unavailable",
        },
        child,
        timer,
      );
    }
  });
}

export async function capturePrivateSkillNativeUserPrompt(
  prompt,
  options = {},
) {
  // A user role or prompt callback does not identify its producer. In
  // particular Codex send_input can enqueue user-role text. Existing retained
  // recovery remains readable; new relations use a qualified host ingress.
  void prompt;
  void options;
  return { status: "ignored", reason_code: "applicability_unproven" };
}

export async function bindPrivateSkillNativeCapture(
  toolName,
  args,
  response,
  options = {},
) {
  const nativeSessionId = normalizeNativeSessionId(options.nativeSessionId);
  const tool = normalizedCompletionToolName(toolName);
  const input =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const body = responseBodyFromToolResponse(response);
  if (
    !nativeSessionId ||
    tool !== "capture_learning" ||
    toolResponseIndicatesFailure(response) ||
    input.replacement_of !== undefined ||
    !input.private_skill ||
    typeof input.private_skill !== "object" ||
    Array.isArray(input.private_skill) ||
    body?.capture_route !== "private_skill" ||
    !/^psd_[A-Za-z0-9_-]{8,96}$/u.test(String(body?.draft_id ?? ""))
  ) {
    return { status: "ignored" };
  }
  const bridge =
    options.nativeContextBridge ?? runPrivateSkillNativeContextBridge;
  try {
    return await bridge(
      {
        kind: "private_skill_capture",
        session_id: nativeSessionId,
        draft_id: body.draft_id,
        original_capture: true,
      },
      { env: options.env ?? process.env },
    );
  } catch {
    return {
      status: "unavailable",
      reason_code: "native_context_bridge_unavailable",
    };
  }
}

// The lifecycle tally a private skill draft adds to now (a count key of
// readPrivateSkillLifecycleState), from its content-free envelope and
// recovery action; null when nothing is due from it.
function privateSkillDraftCategory(parsed, env) {
  const action = privateSkillRecoveryAction(parsed, true);
  if (
    parsed.state === "awaiting_authorization" &&
    privateAuthorizationRetryIsDue(parsed.draft_id, parsed.updated_at, env)
  ) {
    return "awaiting_authorization";
  }
  const staleInspectorAction =
    action &&
    typeof action.inspector_digest === "string" &&
    action.inspector_digest !== PRIVATE_LEARNING_INSPECTOR_DIGEST &&
    ((action.kind === "submit_candidate" && parsed.state === "ready") ||
      (["reformulate", "retry_operational", "capture_native_context"].includes(
        action.kind,
      ) &&
        parsed.state === "held_validation"));
  const staleInspectorBlockedRecovery =
    action === null &&
    parsed.next_action === null &&
    typeof parsed.inspector_digest === "string" &&
    parsed.inspector_digest !== PRIVATE_LEARNING_INSPECTOR_DIGEST &&
    parsed.state === "held_validation" &&
    parsed.reformulation_available === false &&
    typeof parsed.reformulation_reason === "string" &&
    Number.isSafeInteger(parsed.reformulation_attempt_count) &&
    Number.isSafeInteger(parsed.recovery_epoch_attempt_count) &&
    parsed.reformulation_attempt_count - parsed.recovery_epoch_attempt_count >=
      3;
  if (staleInspectorAction || staleInspectorBlockedRecovery)
    return "inspector_refresh";
  if (action?.kind === "submit_candidate") return "ready";
  if (action?.kind === "retry_delivery" && retryIsDue(parsed.next_retry_at))
    return "retry_delivery";
  if (
    action?.kind === "retry_resolution" &&
    (parsed.state === "held_validation" ||
      (parsed.state === "retry_scheduled" && retryIsDue(parsed.next_retry_at)))
  ) {
    return "retry_resolution";
  }
  return (
    {
      reformulate: "reformulation_available",
      retry_operational: "operational_retry",
      reinspect: "inspector_refresh",
      capture_native_context: "native_context_needed",
    }[action?.kind] ?? null
  );
}

function scanPrivateSkillOutbox(env) {
  return scanPrivateOutbox(
    env,
    privateSkillOutboxDirectoryForHook(env),
    /^(psd_[A-Za-z0-9_-]{8,96})\.json$/,
    MAX_PRIVATE_SKILL_ENVELOPE_BYTES,
    (envelope, draftId) =>
      ["private-skill-outbox-envelope-v1", "private-skill-outbox-envelope-v2"].includes(envelope?.version) &&
      envelope.draft_id === draftId &&
      [
        "ready",
        "awaiting_authorization",
        "retry_scheduled",
        "held_safety",
        "held_validation",
      ].includes(envelope.state)
        ? { envelope, category: privateSkillDraftCategory(envelope, env) }
        : null,
  );
}

// `scan` (scanPrivateSkillOutbox) may hold only some drafts: the counts are
// theirs.
export function readPrivateSkillLifecycleState(
  env = process.env,
  scan = scanPrivateSkillOutbox(env),
) {
  if (!scan.readable) return null;
  const counts = {
    ready: 0,
    retry_scheduled: 0,
    awaiting_authorization: 0,
    retry_delivery: 0,
    retry_resolution: 0,
    reformulation_available: 0,
    operational_retry: 0,
    native_context_needed: 0,
    native_context_pending: 0,
    inspector_refresh: 0,
  };
  const recoveryIds = [];
  const authorizationIds = [];
  for (const [draftId, { category }] of scan.drafts) {
    if (!category) continue;
    counts[category] += 1;
    if (category === "awaiting_authorization") authorizationIds.push(draftId);
    if (
      ["inspector_refresh", "reformulation_available", "operational_retry"].includes(
        category,
      )
    ) {
      recoveryIds.push(draftId);
    }
  }
  if (Object.values(counts).every((count) => count === 0)) return null;
  recoveryIds.sort();
  let cursor = "";
  try {
    const value = readSecureHookFile(
      join(usageDir(env), "private-skill-recovery-cursor"),
      104,
    );
    if (/^psd_[A-Za-z0-9_-]{8,96}$/.test(value)) cursor = value;
  } catch {
    // A missing/stale hint cannot withhold recoverable drafts.
  }
  return {
    ...counts,
    next_authorization_draft_id: authorizationIds.sort()[0] ?? null,
    next_reformulation_draft_id:
      recoveryIds.find((id) => id > cursor) ?? recoveryIds[0] ?? null,
    host_denial_active: recentPrivateLessonHostDenial(env),
  };
}

export function privateSkillNativeContextCaptureNeeded(env = process.env) {
  return (readPrivateSkillLifecycleState(env)?.native_context_needed ?? 0) > 0;
}

// The machine-wide recovery: every due draft on the machine as silent
// submit and retry work, whoever holds it and parked ones included. A
// hook's prompt or stop renders only a ledger's share
// (privateLearningSessionRecovery), and one that names no session reads as
// the "unknown" ledger; only a privateLessonCompletionGuidance call without
// lifecycleRecovery falls back to this.
export function privateLearningLifecycleRecoveryInstruction(env = process.env) {
  return privateLearningLifecycleText(
    readPrivateLessonLifecycleState(env),
    readPrivateSkillLifecycleState(env),
  );
}

// `own` (privateLearningSessionRecovery): the reading session tree's due
// drafts, the only ones its silent recovery may act on.
function privateLearningLifecycleText(lessons, skills, own = null) {
  const hostDenialActive = Boolean(
    lessons?.host_denial_active || skills?.host_denial_active,
  );
  if (hostDenialActive || (!lessons && !skills)) return null;
  const lessonCandidates =
    (lessons?.ready ?? 0) +
    (lessons?.retry_scheduled ?? 0) +
    (lessons?.awaiting_compatible_profile ?? 0) +
    (lessons?.held_policy_refresh ?? 0);
  const lessonTelemetry =
    (lessons?.hold_telemetry_pending ?? 0) +
    (lessons?.hold_telemetry_retry_scheduled ?? 0) +
    (lessons?.hold_telemetry_awaiting_compatible_profile ?? 0);
  const skillCandidates = (skills?.ready ?? 0) + (skills?.retry_scheduled ?? 0);
  const skillDeliveryRetries =
    (skills?.retry_delivery ?? 0) + (skills?.retry_resolution ?? 0);
  const authorizationRetries =
    (lessons?.awaiting_authorization ?? 0) +
    (skills?.awaiting_authorization ?? 0);
  const reformulations =
    (skills?.reformulation_available ?? 0) +
    (skills?.operational_retry ?? 0) +
    (skills?.inspector_refresh ?? 0);
  const nativeContextNeeded = skills?.native_context_needed ?? 0;
  const authorizationId =
    lessons?.next_authorization_draft_id ?? skills?.next_authorization_draft_id;
  const authorizationReminder = authorizationId
    ? `Authorization recovery is due for ${authorizationId}. Inspect that exact draft, then call ${authorizationId.startsWith("pld_") ? "retry_private_lesson_candidate" : "retry_private_skill_candidate"} with draft_id ${authorizationId} once using the existing private lane approval. A repeated refusal remains retained and backs off for six hours; never switch transport to bypass a denial.`
    : null;
  if (
    !authorizationReminder &&
    lessonCandidates +
      lessonTelemetry +
      skillCandidates +
      skillDeliveryRetries +
      reformulations +
      nativeContextNeeded ===
      0
  )
    return null;
  return [
    `Private learning recovery: ${lessonCandidates} lesson candidate${lessonCandidates === 1 ? "" : "s"}, ${skillCandidates} complete skill candidate${skillCandidates === 1 ? "" : "s"}, ${skillDeliveryRetries} private skill delivery retr${skillDeliveryRetries === 1 ? "y" : "ies"}${authorizationRetries > 0 ? `, ${authorizationRetries} authorization retr${authorizationRetries === 1 ? "y" : "ies"}` : ""}, and ${lessonTelemetry} content-free hold event${lessonTelemetry === 1 ? "" : "s"} are due.`,
    ...(!own
      ? [
          "Silently call inspect_private_learning_outbox. Submit ready lessons with submit_private_lesson_candidate and ready complete skills with submit_private_skill_candidate. Use the matching retry tool only for a due retry.",
        ]
      : own.length > 0
        ? [
            // One directive unit each, so the context allocator keeps the
            // drafts with the instruction that names them.
            `Silently call inspect_private_learning_outbox only for this session's due private drafts (${own.slice(0, 12).join(", ")}${own.length > 12 ? `, and ${own.length - 12} more named in a later prompt` : ""}): submit a ready lesson with submit_private_lesson_candidate and a ready complete skill with submit_private_skill_candidate, and use the matching retry tool only for a due retry.`,
            "Do not submit or retry, on your own, any other draft inspect_private_learning_outbox lists.",
          ]
        : []),
    ...(authorizationReminder ? [authorizationReminder] : []),
    ...(reformulations > 0
      ? [
          `${reformulations} private skill draft${reformulations === 1 ? " awaits" : "s await"} bounded agent reformulation. Inspect private_skill_draft_id ${skills.next_reformulation_draft_id} with inspect_private_learning_outbox, independent of listing order. Use active task context or independently validated recovery context. Follow agent_recovery, then the replacement's exact next_action. Never copy suspected secrets or manufacture missing context.`,
        ]
      : []),
    ...(nativeContextNeeded > 0
      ? [
          `${nativeContextNeeded} retained private skill draft${nativeContextNeeded === 1 ? " has" : "s have"} exhausted the current reformulation epoch. Inspect the exact draft for already retained recovery context. New context requires a qualified host source selecting that exact draft with /remembrance-context <draft_id> followed by a newline and literal context. Ordinary prompts do not establish applicability. Use only supplied host-qualified retained context; never fabricate provenance. If this host cannot qualify the source, preserve the hold and attempts.`,
        ]
      : []),
    "Do not ask the user to inspect files or repeat an existing lane approval. Do not retry authorization, policy, validation, safety, or terminal holds through another transport. Never delete an unresolved draft automatically. Hide routine receipts; surface only a concrete failure or required user action.",
  ].join("\n");
}

// --- Private drafts: ownership, parking and the user decisions ---------------
//
// Silent recovery names only drafts the reading session tree holds a hint
// for. Every other due draft (captured by another session, or by one with no
// user prompt for PRIVATE_ORPHAN_AFTER_MS, or by an earlier client, or with
// no hint at all) and every parked one reaches a main thread only as one
// user decision. Parking (a decline, or a host's denial of that exact draft)
// is a content-free marker beside the hints; neither touches a draft, and
// only the confirmed delete tool removes one.

// This prompt's one read of both outboxes and of the drafts' markers.
function readPrivateDrafts(env) {
  const parked = new Map();
  const held = new Set();
  const offered = new Set();
  const directory = privateLearningLifecycleDirectory(env);
  if (organizationPrivateLessonAuthorized(env)) {
    try {
      assertSecureHookDirectory(lstatSync(directory));
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const match = entry.name.match(
          /^((?:pld|psd)_[A-Za-z0-9_-]{8,96})\.(parked|held-notice|release-offer)\.json$/,
        );
        if (!match || entry.isSymbolicLink() || !entry.isFile()) continue;
        if (match[2] === "held-notice") held.add(match[1]);
        if (match[2] === "release-offer") offered.add(match[1]);
        const marker =
          match[2] === "parked" && readPrivateParkedMarker(match[1], env);
        if (marker) parked.set(match[1], marker);
      }
    } catch {
      // No lifecycle directory yet: nothing is parked or noticed.
    }
  }
  return {
    lessons: scanPrivateLessonOutbox(env),
    skills: scanPrivateSkillOutbox(env),
    parked,
    held,
    offered,
  };
}

// The obligations due now; a private lesson's line names the exact tool its
// envelope allows when its outbox answers.
function duePendingActions(obligations, env, drafts) {
  return obligations
    .filter((obligation) => completionObligationIsDue(obligation, env, drafts))
    .map((obligation) => {
      const tool =
        obligation.kind === "private_lesson" &&
        drafts.lessons.drafts.get(obligation.draft_id)?.action?.tool;
      return tool && tool !== obligation.action_tool
        ? { ...obligation, action_tool: tool }
        : obligation;
    });
}

// A lesson hint whose readable envelope allows no agent action points at
// nothing to do, so it goes, and its draft stays. An earlier client's hints
// for such drafts (a classified safety hold kept asking for a submit) go on
// the first prompt that reads them.
function retireUnactionablePrivateLessonHints(hints, drafts, env) {
  const stale = new Set(
    hints
      .filter((hint) => {
        const entry = drafts.lessons.drafts.get(hint.draft_id);
        return hint.kind === "private_lesson" && entry?.envelope && !entry.action;
      })
      .map((hint) => hint.id),
  );
  if (stale.size > 0) {
    removeCompletionObligations(null, (item) => stale.has(item.id), env);
  }
  return stale;
}

function privateHintsOnMachine(sessionId, env) {
  return readCompletionObligations(sessionId, env, {
    pointers: false,
    ask: false,
    privateHints: "all",
  }).filter(isPrivateHint);
}

// This ledger's share of the lifecycle recovery for one prompt or stop: its
// silent lines count and name only drafts its own session tree holds an
// unparked hint for; a main thread of an attended run also gets the user
// decisions (privateDraftNotices), unless the host says it runs this session
// for a subagent (`notices: false`). `hints` are every private hint on the
// machine. Null when nothing is due.
function privateLearningSessionRecovery(
  sessionId,
  hints,
  drafts,
  env,
  { notices = true } = {},
) {
  const own = new Set(
    hints
      .filter(
        (hint) =>
          privateHintOwnedBy(hint, sessionId) && !drafts.parked.has(hint.draft_id),
      )
      .map((hint) => hint.draft_id),
  );
  const only = (scan) => ({
    readable: scan.readable,
    drafts: new Map([...scan.drafts].filter(([draftId]) => own.has(draftId))),
  });
  return (
    [
      privateLearningLifecycleText(
        readPrivateLessonLifecycleState(env, only(drafts.lessons)),
        readPrivateSkillLifecycleState(env, only(drafts.skills)),
        // In hint order (created_at, then id), the order of their lines.
        [...own].filter((draftId) => privateDraftDue(draftId, drafts)),
      ),
      ...(notices ? privateDraftNotices(sessionId, hints, drafts, env) : []),
    ]
      .filter(Boolean)
      .join("\n") || null
  );
}

// The draft ids each notice sentence this process composed for a ledger
// names, until a delivery of that exact sentence acknowledges it
// (acknowledgePrivateDraftNotices): a delivery marks and advances only what
// it showed. Composition and delivery run in one process on every host; two
// sessions of one long-lived process (OpenCode, OpenClaw) can compose the
// same sentence from different drafts, so each entry is the ledger's. At
// most 16, newest last.
const privateNoticesShown = new Map();

function rememberPrivateNotice(sessionId, text, shown) {
  const ledger = sessionHash(sessionId);
  const key = `${ledger}\n${text}`;
  privateNoticesShown.delete(key);
  privateNoticesShown.set(key, { ...shown, ledger, text });
  if (privateNoticesShown.size > 16) {
    privateNoticesShown.delete(privateNoticesShown.keys().next().value);
  }
  return text;
}

// The user decisions, each one bounded, content-free sentence: one
// directive unit, which the context allocator keeps whole or drops, so its
// exact text in the delivered context acknowledges it
// (acknowledgePrivateDraftNotices). Retained drafts awaiting the user
// (privateDraftsAwaitingUser), at most once per
// PRIVATE_ORPHAN_NOTICE_INTERVAL_MS on this machine, with the action_id that
// keeps them; lesson drafts a safety hold left with nothing to send, once
// per draft, with no reply asked; and held lesson drafts the current safety
// check would send, once per draft, to deliver, keep or delete. Main threads
// of attended runs only (unattendedRun).
function privateDraftNotices(sessionId, hints, drafts, env) {
  if (unattendedRun(env) || String(sessionId ?? "").includes(":agent:")) {
    return [];
  }
  const notices = [];
  const awaiting = privateDraftsAwaitingUser(sessionId, hints, drafts, env);
  if (awaiting.length > 0 && privateOrphanNoticeDue(env)) {
    const lessons = awaiting.filter((id) => id.startsWith("pld_")).length;
    const skills = awaiting.length - lessons;
    notices.push(
      rememberPrivateNotice(
        sessionId,
        `- Retained private drafts awaiting a user decision: ${lessons} lesson${lessons === 1 ? "" : "s"} and ${skills} skill${skills === 1 ? "" : "s"} that no active session is handling; do not submit them on your own, but ask the user once whether to deliver them (inspect_private_learning_outbox, then each draft's exact submit or retry action), keep them (local decline_pending_action with action_id ${PRIVATE_ORPHAN_NOTICE_ACTION_ID} and any reason), or delete them (the matching delete tool with confirm=true); if no user can answer in this run, leave them in the outbox.`,
        {
          awaiting,
          parked: awaiting.filter((draftId) => drafts.parked.has(draftId)),
        },
      ),
    );
  }
  const held = privateHeldDrafts(drafts, env);
  if (held.length > 0) {
    // Only a session of the draft's own destination can replace it.
    const them = held.length === 1 ? "it" : "them";
    notices.push(
      rememberPrivateNotice(
        sessionId,
        `- ${held.length} retained private lesson draft${held.length === 1 ? " was" : "s were"} held by the local safety check and will not be sent: ask the user once whether to keep ${them}, delete ${them} with delete_private_lesson_candidate and confirm=true, or re-capture a safe version with capture_learning and replacement_of naming the held draft_id in a session using the API base and organization key the draft was captured for (the held draft goes only once the organization accepts the new version; inspect_private_learning_outbox lists each draft_id), and never resubmit the held content; this notice is shown once and needs no reply, and if no user can answer in this run, leave the outbox as it is.`,
        { held },
      ),
    );
  }
  const offered = privateReleasableDrafts(drafts, env);
  if (offered.length > 0) {
    const one = offered.length === 1;
    notices.push(
      rememberPrivateNotice(
        sessionId,
        `- ${offered.length} retained private lesson draft${one ? " was" : "s were"} held by an earlier safety check that the current one would not apply: ask the user once whether to deliver ${one ? "it" : "each"} with retry_private_lesson_candidate and deliver_rechecked_hold=true, keep ${one ? "it" : "them"} held (nothing to do), or delete ${one ? "it" : "them"} with delete_private_lesson_candidate and confirm=true (inspect_private_learning_outbox marks each draft_id with safety_recheck passes_current_rule); send nothing without that choice, this notice is shown once, and if no user can answer in this run, leave the outbox as it is.`,
        { offered },
      ),
    );
  }
  return notices;
}

// Due drafts no session of the reader's tree holds a hint for: none or an
// earlier client's, another session's whose hint is idle
// (privateHintIdle), and parked drafts, whoever holds them, whose next
// notice is due. In draft id order, whatever order the file system lists
// them in.
function privateDraftsAwaitingUser(sessionId, hints, drafts, env) {
  const own = sessionHash(sessionId);
  const held = new Map(hints.map((hint) => [hint.draft_id, hint]));
  const idle = new Map();
  const isIdle = (ledger) => {
    if (!idle.has(ledger)) idle.set(ledger, privateSessionIdle(ledger, env));
    return idle.get(ledger);
  };
  const awaiting = [];
  for (const draftId of [...drafts.lessons.drafts.keys(), ...drafts.skills.drafts.keys()]) {
    if (!privateDraftDue(draftId, drafts)) continue;
    const parked = drafts.parked.get(draftId);
    const hint = held.get(draftId);
    const owner = hint?.owner_session;
    if (
      parked
        ? privateParkedNoticeDue(parked)
        : owner !== own && (!owner || privateHintIdle(hint, isIdle))
    ) {
      awaiting.push(draftId);
    }
  }
  return awaiting.sort();
}

// Whether a draft allows an agent action now (the native-context wait asks
// for none).
function privateDraftDue(draftId, drafts) {
  if (draftId.startsWith("pld_"))
    return Boolean(drafts.lessons.drafts.get(draftId)?.action?.due);
  const category = drafts.skills.drafts.get(draftId)?.category;
  return Boolean(category && category !== "native_context_needed");
}

// A hint's draft is still being handled while its owner's session or the
// ledger that captured it has had a user prompt within
// PRIVATE_ORPHAN_AFTER_MS: an OpenCode child's own prompts (its tree ledger)
// keep its drafts while its root is idle. A ledger with no count, such as a
// Claude Code subagent's, is idle, so there the owner decides as before.
// One more stat at most, only when the owner is idle.
function privateHintIdle(hint, isIdle) {
  return (
    isIdle(hint.owner_session) &&
    (hint.captured_by_ledger === hint.owner_session ||
      isIdle(hint.captured_by_ledger))
  );
}

function privateSessionIdle(owner, env) {
  try {
    return (
      lstatSync(join(usageDir(env), `${owner}.user-prompts`)).mtimeMs +
        PRIVATE_ORPHAN_AFTER_MS <=
      Date.now()
    );
  } catch {
    return true;
  }
}

// Lesson drafts a safety hold left with no agent action (classified, or
// health reporting off) that have not had their one notice; a draft known
// to be submitted, deleted or replaced never has one. A hold the current
// safety check would not keep has its own offer instead.
function privateHeldDrafts(drafts, env) {
  return [...drafts.lessons.drafts]
    .filter(
      ([draftId, { envelope, action }]) =>
        envelope?.state === "held_safety" &&
        !privateLessonHoldReleasable(envelope) &&
        !action &&
        !drafts.held.has(draftId) &&
        !privateAuthorizationTerminalIsKnown(draftId, env),
    )
    .map(([draftId]) => draftId);
}

// The outbox's content-free re-check of a held draft under the current
// safety check, written beside its encrypted payload. Only the user's
// choice sends such a draft; the server re-checks it before that.
function privateLessonHoldReleasable(envelope) {
  return envelope?.safety_recheck === "passes_current_rule";
}

// Held lesson drafts the current safety check would send, not offered yet,
// in draft id order; a draft known to be submitted or deleted is never
// offered.
function privateReleasableDrafts(drafts, env) {
  return [...drafts.lessons.drafts]
    .filter(
      ([draftId, { envelope }]) =>
        envelope?.state === "held_safety" &&
        privateLessonHoldReleasable(envelope) &&
        !drafts.offered.has(draftId) &&
        !privateAuthorizationTerminalIsKnown(draftId, env),
    )
    .map(([draftId]) => draftId)
    .sort();
}

function privateOrphanNoticePath(env) {
  return join(privateLearningLifecycleDirectory(env), "orphan-notice.json");
}

// The last delivered notice for drafts awaiting the user: when, and the
// draft ids it offered while they are at most PRIVATE_ORPHAN_NOTICE_DRAFT_LIMIT,
// so the record stays within the bytes read back; a longer offer is recorded
// without them. Content-free.
const PRIVATE_ORPHAN_NOTICE_DRAFT_LIMIT = 256;

function readPrivateOrphanNotice(env) {
  try {
    const value = JSON.parse(
      readSecureHookFile(privateOrphanNoticePath(env), 32 * 1024),
    );
    return {
      shown_at: Date.parse(value?.shown_at ?? ""),
      drafts: Array.isArray(value?.drafts)
        ? value.drafts.filter((draftId) =>
            /^(?:pld|psd)_[A-Za-z0-9_-]{8,96}$/.test(draftId ?? ""),
          )
        : null,
    };
  } catch {
    return null;
  }
}

function privateOrphanNoticeDue(env) {
  const shown = readPrivateOrphanNotice(env)?.shown_at;
  // A future time cannot strand the notice.
  return (
    !Number.isFinite(shown) ||
    shown > Date.now() ||
    shown + PRIVATE_ORPHAN_NOTICE_INTERVAL_MS <= Date.now()
  );
}

function readPrivateParkedMarker(draftId, env) {
  const path = privateDraftMarkerPath(draftId, "parked", env);
  if (!path) return null;
  try {
    const marker = JSON.parse(readSecureHookFile(path, 1024));
    return marker?.version === 1 &&
      Number.isFinite(Date.parse(marker.parked_at)) &&
      Number.isSafeInteger(marker.notices) &&
      marker.notices >= 0
      ? marker
      : null;
  } catch {
    return null;
  }
}

function writePrivateParkedMarker(draftId, marker, env) {
  const path = privateDraftMarkerPath(draftId, "parked", env);
  return Boolean(
    path &&
    writePrivateUsageMarker(path, `${JSON.stringify({ version: 1, ...marker })}\n`),
  );
}

// When a parked draft's notice is next due after `notices` deliveries: on
// the PRIVATE_PARKED_NOTICE_DELAYS_MS schedule, then never on its own.
function privateParkedNoticeAt(notices, now = Date.now()) {
  return notices < PRIVATE_PARKED_NOTICE_DELAYS_MS.length
    ? new Date(now + PRIVATE_PARKED_NOTICE_DELAYS_MS[notices]).toISOString()
    : null;
}

// A parked draft's notice is due on its schedule, and once after a client
// update.
function privateParkedNoticeDue(marker) {
  const next = Date.parse(marker.next_notice_at ?? "");
  const installed = installedClientVersion();
  return (
    (Number.isFinite(next) && next <= Date.now()) ||
    Boolean(
      installed &&
      marker.client_version &&
      compareStableClientVersions(installed, marker.client_version) > 0,
    )
  );
}

// The client version a parked marker records: the newest that showed or
// parked its draft. A host of an older version on the machine never moves
// it back, so a newer host does not take its notice or park for an update.
function newerClientVersion(recorded) {
  const installed = installedClientVersion();
  return compareStableClientVersions(recorded, installed) > 0
    ? recorded
    : (installed ?? recorded ?? null);
}

// Parks one draft: its line stops and it returns only in the user-decision
// notice, on its schedule. A repeated park keeps the count already shown.
// The parked marker now holds the draft, so its hint goes, whoever held it,
// and leaves room in the machine's bound; its authorization backoff stays,
// and an explicit submit or retry records a hint again.
function parkPrivateDraft(
  draftId,
  reason,
  env,
  prior = readPrivateParkedMarker(draftId, env),
) {
  const notices = prior?.notices ?? 0;
  const parked = writePrivateParkedMarker(
    draftId,
    {
      reason,
      parked_at: new Date().toISOString(),
      notices,
      next_notice_at: privateParkedNoticeAt(notices),
      client_version: newerClientVersion(prior?.client_version),
    },
    env,
  );
  if (parked) dropPrivateHint(draftId, env);
  return parked;
}

// Removes a draft's hint where any client kept it, and nothing else of it:
// not its draft, not its markers.
function dropPrivateHint(draftId, env) {
  const id = `${draftId.startsWith("pld_") ? "private_lesson" : "private_skill"}:${draftId}`;
  try {
    if (lifecycleDirectoryUsable(env)) {
      rmSync(completionObligationPath(null, id, env), { force: true });
    }
    rmSync(
      join(
        legacyPrivateCompletionObligationDir(env),
        completionObligationFileName(id),
      ),
      { force: true },
    );
  } catch {
    // A hint left behind is only a pointer; its parked draft stays parked.
  }
}

// An observed submit or retry the host let through allows its lane again:
// the lane-wide denial observations go, and each draft of that lane parked
// for a host denial returns once, as a user decision.
function allowPrivateLane(prefix, env) {
  clearPrivateLessonHostPolicyDenials(env);
  try {
    for (const name of readdirSync(privateLearningLifecycleDirectory(env))) {
      const draftId = name.match(/^((?:pld|psd)_[A-Za-z0-9_-]{8,96})\.parked\.json$/)?.[1];
      if (!draftId?.startsWith(prefix)) continue;
      const marker = readPrivateParkedMarker(draftId, env);
      if (marker?.reason !== PRIVATE_DECLINE_REASON || marker.lane_allowed_at)
        continue;
      const now = new Date().toISOString();
      writePrivateParkedMarker(
        draftId,
        { ...marker, next_notice_at: now, lane_allowed_at: now },
        env,
      );
    }
  } catch {
    // Nothing parked yet.
  }
}

// A notice counts as shown once its sentence reached the agent, as a retry
// reference does, and only for the drafts that sentence was composed from
// (privateNoticesShown): the delivering ledger's composition, or, where the
// host names none (one session per process), the newest. Nothing else is
// read. The orphan interval restarts with the drafts it offered recorded,
// each parked draft it named moves to its next wait, once: one another
// delivery already moved, or a park restarted, is no longer due. Each held
// draft it counted has had its one notice. An unattended run acknowledges
// none: a composition it delivers stays for an attended delivery.
function acknowledgePrivateDraftNotices(context, env, ledgerId) {
  if (unattendedRun(env)) return;
  const ledger = ledgerId == null ? null : sessionHash(ledgerId);
  const delivered = new Set();
  for (const [key, shown] of [...privateNoticesShown].reverse()) {
    if (
      !context.includes(shown.text) ||
      (ledger ? shown.ledger !== ledger : delivered.has(shown.text))
    ) {
      continue;
    }
    delivered.add(shown.text);
    privateNoticesShown.delete(key);
    const now = new Date().toISOString();
    for (const draftId of shown.held ?? []) {
      writePrivateUsageMarker(
        privateDraftMarkerPath(draftId, "held-notice", env),
        `${JSON.stringify({ version: 1, shown_at: now })}\n`,
      );
    }
    for (const draftId of shown.offered ?? []) {
      writePrivateUsageMarker(
        privateDraftMarkerPath(draftId, "release-offer", env),
        `${JSON.stringify({ version: 1, shown_at: now })}\n`,
      );
    }
    if (!shown.awaiting) continue;
    writePrivateUsageMarker(
      privateOrphanNoticePath(env),
      `${JSON.stringify({
        version: 1,
        shown_at: now,
        ...(shown.awaiting.length <= PRIVATE_ORPHAN_NOTICE_DRAFT_LIMIT
          ? { drafts: shown.awaiting }
          : {}),
      })}\n`,
    );
    for (const draftId of shown.parked) {
      const marker = readPrivateParkedMarker(draftId, env);
      if (!marker || !privateParkedNoticeDue(marker)) continue;
      const notices = marker.notices + 1;
      writePrivateParkedMarker(
        draftId,
        {
          ...marker,
          notices,
          next_notice_at: privateParkedNoticeAt(notices),
          client_version: newerClientVersion(marker.client_version),
        },
        env,
      );
    }
  }
}

// A decline of the notice for drafts awaiting the user parks the drafts it
// offered that still await the user; a draft that reached the user after it
// was delivered, or one the user had delivered meanwhile, is not parked.
// Without a recorded offer (none was delivered, or it offered more drafts
// than the record keeps), every draft awaiting the user now that is not
// parked yet is: one that began awaiting after the delivery then returns as
// a user decision a day later, about when the next notice would have
// offered it. A parked draft keeps its own schedule and comes with the next
// notice: a delivery moves on each parked draft it shows, so one due now has
// come due since (its wait ran out, the host let its lane through, or a
// client update brought it back), whether or not that offer showed it.
function parkPrivateDraftsAwaitingUser(sessionId, reason, env) {
  const drafts = readPrivateDrafts(env);
  const offered = readPrivateOrphanNotice(env)?.drafts;
  for (const draftId of privateDraftsAwaitingUser(
    sessionId,
    privateHintsOnMachine(sessionId, env),
    drafts,
    env,
  )) {
    if (offered ? !offered.includes(draftId) : drafts.parked.has(draftId)) continue;
    parkPrivateDraft(draftId, reason, env, drafts.parked.get(draftId));
  }
}

// The draft a host denied, when its event names the exact private submit or
// retry tool and that call's own draft_id.
function privateDeniedDraftId(toolName, value) {
  const prefix = {
    submit_private_lesson_candidate: "pld_",
    retry_private_lesson_candidate: "pld_",
    submit_private_skill_candidate: "psd_",
    retry_private_skill_candidate: "psd_",
  }[normalizedCompletionToolName(toolName)];
  if (!prefix || !value || typeof value !== "object") return null;
  let args =
    value.tool_input ??
    value.toolInput ??
    value.arguments ??
    value.args ??
    value.params;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const draftId =
    args && typeof args === "object" && !Array.isArray(args)
      ? args.draft_id
      : null;
  return typeof draftId === "string" &&
    draftId.startsWith(prefix) &&
    /^(?:pld|psd)_[A-Za-z0-9_-]{8,96}$/.test(draftId)
    ? draftId
    : null;
}

export function privateLessonLifecycleRecoveryInstruction(env = process.env) {
  return privateLearningLifecycleRecoveryInstruction(env);
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
    join(
      env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "remembrance",
      "agent-key.json",
    )
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

// Keys and values stay exact (core caps both at 96 characters): a required
// setting is fetched by its key. Required settings sort before the statement
// cap so a discretionary entry can never displace one.
function sanitizeEffectivePreferenceEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const key =
        typeof item.key === "string"
          ? safePreferenceIdentifier(item.key, 96)
          : null;
      const preferenceValue =
        typeof item.value === "string"
          ? safePreferenceIdentifier(item.value, 96)
          : null;
      return key &&
        preferenceValue &&
        EFFECTIVE_PREFERENCE_SOURCES.has(item.source) &&
        ["presentation", "workflow", "strategy_selection"].includes(
          item.effect ?? "presentation",
        ) &&
        ["prefer", "avoid"].includes(item.strength ?? "prefer")
        ? [{ item, key, value: preferenceValue }]
        : [];
    })
    .sort(
      (left, right) =>
        Number(right.item.source === "mandatory_org") -
        Number(left.item.source === "mandatory_org"),
    )
    .slice(0, MAX_EFFECTIVE_PREFERENCE_STATEMENTS)
    .map(({ item, key, value: preferenceValue }) => {
      const label = safeText(item.label ?? key, 96);
      const source = item.behavior ?? preferenceValue;
      const behavior = safeText(source, 320);
      const direction = item.strength === "avoid" ? "avoid" : "prefer";
      const authority =
        item.source === "mandatory_org" ? "required organization" : item.source;
      return {
        mandatory: item.source === "mandatory_org",
        key,
        value: preferenceValue,
        behavior,
        // Complete only when the shown text is the unredacted source: a cut,
        // or a redaction that swallows a word such as "never", can reverse it.
        behaviorComplete:
          behavior === String(source).replace(/\s+/g, " ").trim(),
        text: `${label} [${safeText(item.effect ?? "presentation", 24)}, ${safeText(authority ?? "preference", 32)}]: ${direction} ${behavior}`,
      };
    });
}

function effectivePreferencesContextLines(value) {
  const entries = sanitizeEffectivePreferenceEntries(value);
  if (entries.length === 0) return [];
  const mandatory = entries.filter((entry) => entry.mandatory);
  const discretionary = entries.filter((entry) => !entry.mandatory);
  const mandatoryLine = mandatoryPreferenceContextLine(mandatory);
  const discretionaryLine = discretionaryPreferenceContextLine(discretionary);
  return [mandatoryLine, discretionaryLine].filter(Boolean);
}

// A required setting is never shortened or shown redacted: a partial text
// presented as authoritative can drop the exception or restriction it states.
// Every setting appears complete when all fit the preview budget unaltered;
// otherwise the line makes the complete fetch a required step and names each
// exact key (an out-of-contract count above core's eight fetches every setting).
function mandatoryPreferenceContextLine(entries) {
  if (entries.length === 0) return null;
  const authority =
    "These remain authoritative and cannot be weakened by task or personal preferences.";
  const complete = `Required organization settings (apply all): ${entries
    .map((entry) => `${entry.key}=${entry.value}: ${entry.behavior}`)
    .join("; ")}. ${authority}`;
  if (
    complete.length <= MAX_MANDATORY_PREFERENCE_CONTEXT_CHARS &&
    entries.every((entry) => entry.behaviorComplete)
  ) {
    return complete;
  }
  const keyed = entries.length <= MAX_REQUIRED_SETTING_KEYS;
  const keys = keyed
    ? ` with ${JSON.stringify({ keys: entries.map((entry) => entry.key) })}`
    : "";
  const covered = keyed
    ? "a get_effective_preferences result covering every listed key"
    : "a complete get_effective_preferences result";
  return `Required organization settings (${entries.length}; complete text not shown here). Required next step before acting: call get_effective_preferences${keys} and apply every returned setting in full; skip the call only when this conversation already holds ${covered}, and hook-injected text never counts as that result. If the call is unavailable or omits a key, say the complete required settings could not be loaded, do not claim they were applied, and never read a key name as permission. ${authority}`;
}

// Installation and member preferences reach every agent runtime on that
// identity, so this mirrors REMEMBRANCE_CROSS_FAMILY_PREFERENCE_RULE in core.
const CROSS_FAMILY_PREFERENCE_RULE =
  "Follow the part of a preference written for this host. Unlike an outage, one naming a model, tool, or agent this host lacks, with no part for this host, was written for another agent family: apply the closest equivalent this host supports and say which. When none is safe to assume, ask the user; if you cannot ask, keep your default and say so.";

function discretionaryPreferenceContextLine(entries) {
  if (entries.length === 0) return null;
  const prefix = "Apply these persisted discretionary preferences silently: ";
  const suffix = `. Do not ask the user to reconfirm them. ${CROSS_FAMILY_PREFERENCE_RULE} Current-task instructions may override these preferences. Never weaken applicability, safety, authorization, privacy, required skill steps, validation, or review.`;
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

// Bounded GET for hook-time registry reads. Resolves to { status, body }, where
// body is the parsed JSON of a 2xx response of at most maxBytes and otherwise
// null, or to null when the request fails, times out, or returns invalid JSON.
async function getBoundedJson(
  fetchImpl,
  url,
  { headers, timeoutMs, maxBytes },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });
    if (!response?.ok) return { status: response?.status ?? null, body: null };
    const text = await response.text();
    return {
      status: response.status,
      body:
        Buffer.byteLength(text, "utf8") > maxBytes ? null : JSON.parse(text),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    const response = await getBoundedJson(
      fetchImpl,
      `${configuration.apiUrl.replace(/\/+$/, "")}/.well-known/remembrance-client-release.json`,
      {
        headers: { accept: "application/json" },
        timeoutMs,
        maxBytes: MAX_LOCAL_CLIENT_UPDATE_BYTES,
      },
    );
    try {
      manifest = parseClientReleaseManifest(response?.body);
    } catch {
      return null;
    }
    if (!manifest) return null;
    writeCachedClientRelease(path, manifest, now);
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

// --- Organization session skills --------------------------------------------
//
// Session-start adapters read the organization's session skills (slugs and
// version ids only) and tell the agent to load each one with invoke_skill
// before its first reply. The list is cached per native session in the usage
// directory, bound to the registry URL and credential by a digest, so a
// compaction repeats the directive with no network call and a resume falls
// back to it when the registry is unreachable. Every repeat carries the same
// idempotency key, so the server replays the first invocation.
const SESSION_SKILLS_CONTRACT_VERSION = "session-skills-v1";
const SESSION_SKILLS_TIMEOUT_MS = 1200;
const SESSION_SKILLS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Five entries of at most 200-character slugs and 128-character version ids
// keep the directive under 3,000 characters; the hook-core tests pin that, and
// formatSessionSkillsDirective drops trailing entries if it is ever exceeded.
const MAX_SESSION_SKILLS = 5;
const MAX_SESSION_SKILLS_DIRECTIVE_CHARS = 3000;
const MAX_SESSION_SKILLS_BYTES = 16 * 1024;
// Slugs and version ids are written verbatim into the directive, so only the
// server's strict identifier grammars are accepted.
const SESSION_SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_SKILL_VERSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function sessionSkillsAccess(env) {
  if (disabled(env?.REMEMBRANCE_SESSION_SKILLS)) return null;
  const access = resolveApiAccessSnapshot(env);
  return access.credential.apiKey &&
    !isUnusableConfigurationSource(access.credential.source)
    ? access
    : null;
}

function sanitizeSessionSkills(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SESSION_SKILLS).flatMap((entry) => {
    const slug = entry?.slug;
    const versionId = entry?.version_id ?? null;
    const pinned = entry?.pinned === true;
    const valid =
      typeof slug === "string" &&
      slug.length <= 200 &&
      SESSION_SKILL_SLUG_PATTERN.test(slug) &&
      (versionId === null ||
        (typeof versionId === "string" &&
          SESSION_SKILL_VERSION_ID_PATTERN.test(versionId))) &&
      // A pin names one exact version; without it the pin cannot be honored.
      (!pinned || versionId !== null);
    return valid ? [{ slug, version_id: versionId, pinned }] : [];
  });
}

// Returns the validated entries, the empty list when none apply or the
// registry refuses the credential (401 or 403), or null when the feature is
// off, the configuration is anonymous or unusable, or the request fails in any
// other way, including an older server's 404. Never throws.
export async function fetchSessionSkills(
  {
    fetchImpl = fetch,
    timeoutMs = SESSION_SKILLS_TIMEOUT_MS,
    apiAccess = null,
  } = {},
  env = process.env,
) {
  const access = apiAccess ?? sessionSkillsAccess(env);
  if (!access) return null;
  const response = await getBoundedJson(
    fetchImpl,
    `${access.apiConfiguration.apiUrl}/api/v1/agent/session-skills`,
    {
      headers: principalRequestHeaders(access),
      timeoutMs,
      maxBytes: MAX_SESSION_SKILLS_BYTES,
    },
  );
  if (response?.status === 401 || response?.status === 403) return [];
  const body = response?.body;
  if (body?.contract_version !== SESSION_SKILLS_CONTRACT_VERSION) return null;
  return body.available === true
    ? sanitizeSessionSkills(body.session_skills)
    : [];
}

function sessionSkillsCachePath(nativeSessionId, env) {
  return join(
    usageDir(env),
    `${sessionHash(nativeSessionId)}.session-skills.json`,
  );
}

// Binds a cache file to the registry and credential that filled it without
// storing either.
function sessionSkillsAccessDigest(access) {
  return createHash("sha256")
    .update(
      `${access.apiConfiguration.apiUrl}\n${access.credential.apiKey}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

function readSessionSkillsCache(path, digest, now) {
  try {
    const cached = JSON.parse(
      readSecureHookFile(path, MAX_SESSION_SKILLS_BYTES),
    );
    const age = now - Date.parse(cached?.fetched_at);
    return cached?.digest === digest &&
      age >= 0 &&
      age <= SESSION_SKILLS_CACHE_TTL_MS
      ? sanitizeSessionSkills(cached.session_skills)
      : null;
  } catch {
    return null;
  }
}

// Stable for one native session, slug, and version, so a repeat after a
// resume or compaction replays the first invocation.
function sessionSkillIdempotencyKey(nativeSessionId, slug, versionId) {
  return `rss_${createHash("sha256")
    .update([nativeSessionId, slug, versionId ?? ""].join("\n"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

// Keeps whole entries only: when the text would exceed the cap, entries are
// dropped from the end until it fits.
export function formatSessionSkillsDirective(nativeSessionId, skills) {
  const entries = skills.map(({ slug, version_id: versionId, pinned }) => {
    const args = {
      slug,
      ...(versionId ? { version_id: versionId } : {}),
      scope: "session",
      idempotency_key: sessionSkillIdempotencyKey(
        nativeSessionId,
        slug,
        versionId,
      ),
    };
    return `- ${JSON.stringify(args)}${pinned ? " (pinned)" : ""}`;
  });
  while (entries.length > 0) {
    const text = [
      "Remembrance organization session skills: before your first reply, call invoke_skill once per entry below with exactly these arguments, then follow each returned skill's instructions for the whole session.",
      ...entries,
      "When this list reappears after a resume or compaction, repeat the calls; the same idempotency_key returns the first invocation. Otherwise do not invoke or query these skills again, and send no per-task feedback or task outcome for them.",
      "If a pinned entry returns 409 skill_version_unavailable, say so in one line and continue without that skill; never load a substitute. If an unpinned entry returns it, retry once with the same arguments except version_id. If an entry still fails, continue without it.",
    ].join("\n");
    if (text.length <= MAX_SESSION_SKILLS_DIRECTIVE_CHARS) return text;
    entries.pop();
  }
  return null;
}

// Session-start adapters pass the host's own start source and native session
// id. compact reads the cache only; resume fetches and falls back to the
// cache; startup, clear, and a host without a source fetch and refresh the
// cache. With cache false, nothing is read or written and compact returns
// null. Returns the directive text or null, and never throws.
export async function sessionSkillsDirective(
  {
    source = null,
    nativeSessionId = null,
    fetchImpl = fetch,
    timeoutMs,
    now = Date.now(),
    cache = true,
  } = {},
  env = process.env,
) {
  const sessionId = normalizeNativeSessionId(nativeSessionId);
  const access = sessionId ? sessionSkillsAccess(env) : null;
  if (!access) return null;
  const path = cache ? sessionSkillsCachePath(sessionId, env) : null;
  const digest = sessionSkillsAccessDigest(access);
  const start = String(source ?? "")
    .trim()
    .toLowerCase();
  let skills = null;
  if (start !== "compact") {
    skills = await fetchSessionSkills(
      { fetchImpl, timeoutMs, apiAccess: access },
      env,
    );
    if (skills && path) {
      writePrivateUsageMarker(
        path,
        JSON.stringify({
          fetched_at: new Date(now).toISOString(),
          digest,
          session_skills: skills,
        }),
      );
    }
  }
  if (!skills && path && (start === "compact" || start === "resume")) {
    skills = readSessionSkillsCache(path, digest, now);
  }
  return skills ? formatSessionSkillsDirective(sessionId, skills) : null;
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
    normalized.endsWith("retry_private_lesson_candidate") ||
    normalized.endsWith("submit_private_skill_candidate") ||
    normalized.endsWith("retry_private_skill_candidate")
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
    normalized.endsWith("capture_learning") ||
    normalized.endsWith("delete_private_lesson_candidate") ||
    normalized.endsWith("delete_private_skill_candidate") ||
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
      "capture_learning",
      "inspect_private_learning_outbox",
      "inspect_private_lesson_outbox",
      "submit_private_lesson_candidate",
      "retry_private_lesson_candidate",
      "delete_private_lesson_candidate",
      "submit_private_skill_candidate",
      "retry_private_skill_candidate",
      "delete_private_skill_candidate",
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
  // The exact private submit or retry denied parks that one draft, by the
  // tool and its own draft_id rather than by wording: always for a host
  // permission denial, and for a generic failure the classifier accepted.
  const deniedDraft = privateDeniedDraftId(toolName, value);
  if (deniedDraft && (classification || eventType === "PermissionDenied")) {
    parkPrivateDraft(deniedDraft, PRIVATE_DECLINE_REASON, env);
  }
  if (!normalizedSurface || !classification) return null;
  // Hosts that expose denial events can acknowledge the exact receipt locally.
  // Other hosts use the explicit local tool; no transcript inference is needed.
  const feedbackTool = normalizedCompletionToolName(toolName);
  let feedbackIdentity = "";
  if (["submit_query_feedback", "submit_feedback"].includes(feedbackTool)) {
    const args =
      value?.tool_input ??
      value?.toolInput ??
      value?.arguments ??
      value?.args ??
      value?.params;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      try {
        acknowledgeFeedbackDenial(
          {
            tool: feedbackTool,
            query_id: args.query_id,
            ...(feedbackTool === "submit_feedback"
              ? { result_id: args.result_id }
              : {}),
            reason: "host_policy_denied",
          },
          env,
        );
        feedbackIdentity = createHash("sha256")
          .update(
            JSON.stringify([
              feedbackTool,
              args.query_id,
              feedbackTool === "submit_feedback" ? args.result_id : null,
            ]),
          )
          .digest("hex");
      } catch {
        // A failed local acknowledgement must not claim success or affect execution.
      }
    }
  }
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
        feedbackTool,
        feedbackIdentity,
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
// file on the caller's machine and authenticates separately. Co-located with
// the agent attestation key under the XDG config dir. General reads remain
// best-effort for diagnostics; credential resolution separately distinguishes
// an absent file from a present malformed file and blocks remote calls for the
// latter instead of silently changing scope.
export function remembranceConfigPath(env = process.env) {
  return join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "remembrance",
    "config.json",
  );
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

export function promptContainsUserCorrection(prompt) {
  return promptContainsFirstPartyCorrection(prompt, {
    hostNotification: isHostNotificationPrompt(prompt),
  });
}

export function userCorrectionCaptureDirective(prompt, env = process.env) {
  if (!promptContainsUserCorrection(prompt)) return null;
  return userCorrectionCaptureDirectiveText(
    organizationPrivateLessonAuthorized(env),
  );
}

function promptDisclaimsDurablePreference(prompt) {
  return /\b(?:(?:contrived|hypothetical|illustrative)\s+(?:example|scenario)|(?:example|scenario)\s+only|not\s+(?:a\s+)?(?:lasting\s+)?(?:preference|rule|default)|(?:do not|don't|no need to|please do not|please don't)\s+(?:save|remember|record|learn(?:\s+from)?|capture)(?:\s+(?:this|that|it|anything(?:\s+from\s+(?:this|that|it))?|as\s+(?:a\s+)?lesson))?|(?:one[- ]off|not a correction|never[-\s]*mind|nevermind))\b/i.test(
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
  const privateCapture = organizationPrivateLessonAuthorized(
    options.env ?? process.env,
  );
  return [
    "Remembrance durable-preference capture:",
    // The lexical gate that produced this notice cannot tell an instruction
    // about your working habits from a statement about what the code should
    // do, so it deliberately over-triggers rather than dropping real user
    // instructions. Make that judgment here, where the whole conversation is
    // available, and decline silently when it does not apply.
    privateCapture
      ? "The user's message may state a lasting or corrective working preference. Record it only if it constrains how YOU work: a presentation, workflow, or strategy choice you would otherwise make at your own discretion. A requirement, invariant, API contract, test expectation, or bug report about what the code must do is not a working preference. If it qualifies, call capture_learning once with preference and then call only the returned record_preference next_action. Otherwise take no action and do not mention this notice."
      : "The user's message may state a lasting or corrective working preference that is not one of the built-in controls. Record it only if it constrains how YOU work: a presentation, workflow, or strategy choice you would otherwise make at your own discretion. Do not record a statement about what the code should do; an expected value, an invariant, an API contract, a test expectation, or a bug report is not a working preference even when it is phrased with always, never, must, or should. If it qualifies, interpret only that preference and call record_preference once, and do not ask the user to classify it. Otherwise take no action and do not mention this notice.",
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

// REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS, else 3 s for the search and 2 s for the
// hook's other registry requests.
export function autoQueryTimeoutMs(
  env = process.env,
  fallback = DEFAULT_SEARCH_TIMEOUT_MS,
) {
  const parsed = Number.parseInt(
    String(env.REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 30_000
    ? parsed
    : fallback;
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
