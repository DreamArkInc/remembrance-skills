#!/usr/bin/env node
// Remembrance OpenClaw plugin entrypoint.
//
// OpenClaw plugins are IN-PROCESS JS modules, not stdin/stdout scripts: the
// plugin's default export is a definition object whose `register(api)` is called
// once at load, and it wires event handlers with `api.on(name, handler, opts?)`.
// Handlers are `async (event, ctx) => ...` and run sequentially in descending
// priority order; ctx carries sessionId/runId/sessionKey, and register() merges
// it into `event.context`, which the handlers below read.
// (See docs.openclaw.ai/plugins/hooks and /plugins/sdk-entrypoints.)
//
// This entrypoint ports the Remembrance prompt/completion loop and observes
// correlated detail opens:
//
//   PRE-prompt  (before_prompt_build): matches the user's prompt via the shared
//     heuristic, queries Remembrance, and injects the matching skills/resources
//     as extra system context (appendSystemContext). It records task eligibility
//     independently from completed query use, so a contextual follow-up or
//     failed query can be recovered at completion. Respects
//     REMEMBRANCE_AUTO_QUERY=0. Fail-open: query errors inject bounded recovery
//     context and never block the prompt.
//
//   COMPLETION  (before_agent_finalize): when the session used Remembrance or
//     contained eligible reusable work, it asks the agent to revise once. The
//     revision either recovers a missed full-context query or contributes what
//     it learned. Records the prompted count so it fires at most once per
//     engagement. Respects REMEMBRANCE_AUTO_CONTRIBUTE=0. Loop-safe and
//     fail-open: any error finalizes normally.
//
//   TOOL OBSERVER  (after_tool_call): correlates query_skills with the active
//     directive and clears a high-match completion marker only after the
//     matching get_skill/get_resource call succeeds with the same slug and
//     query/result IDs.
//
//   SUBAGENT END  (subagent_ended): hands an ended subagent run's pending
//     actions to the session that spawned it, from local ledger files only.
//
// All decision/query/format logic lives in hook-core.mjs (Node-builtins-only,
// runtime-agnostic, copied verbatim from packages/codex-plugin). This module is
// only the OpenClaw adapter: it reads the OpenClaw event shape, calls the core,
// and returns the OpenClaw result shape.
//
// UNVERIFIED (see README): OpenClaw's public docs confirm the hook NAMES, the
// api.on registration shape, the pre-prompt context-injection fields
// (prependContext/appendContext/systemPrompt/prependSystemContext/
// appendSystemContext), and the before_agent_finalize return shape
// ({ action: "revise", reason, retry }). The docs do NOT show a full worked
// example of reading the current prompt off a before_prompt_build event, so the
// exact event field name for the user's prompt is a best-effort guess and is
// probed defensively (event.prompt / event.userPrompt / event.input?.prompt /
// event.messages). The core still fails open if none match.

import { accessSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  agentLedgerIdFor,
  bindPrivateSkillNativeCapture,
  completionContinuationReason,
  checkForClientUpdate,
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  contributionReason,
  debugLog,
  decideStop,
  directSelectionFromResponse,
  foldTurnLedgerIntoSession,
  highMatchFromResponse,
  markHostPolicyAlertDelivered,
  observeSuccessfulCompletionTool,
  readPendingHostPolicyAlert,
  hostPolicyAlertTextForOperation,
  hostPolicyAlertWasReported,
  readRegistryUseCount,
  readTaskEligibilityCount,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionUse,
  recordDirectiveSurface,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordQueryFeedbackObligation,
  recordHostPolicyDenial,
  recordRegistryUse,
  queryResponseHasMatches,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  releaseCompletionForward,
  reportTaskOutcomesOnStop,
  responseRequestsRemembranceFollowup,
  resolveApiCredential,
  runPromptHook,
  runPrivateSkillNativeContextBridge,
  sessionIdFor,
  toolResponseIndicatesFailure,
  transferSubagentObligations,
  writePromptedCount,
  valueEpisodeFromResponse,
  warmPrincipalSession,
} from "./hook-core.mjs";
import {
  handlePrivateLessonSubmitApproval,
  persistPrivateLearningSubmitApproval,
  privateLearningSubmitApprovals,
} from "./private-lesson-approval.mjs";
import { nativeContextAuthorityEvent } from "./native-context-authority.mjs";

export { handlePrivateLessonSubmitApproval } from "./private-lesson-approval.mjs";

async function resolveNativeCommandAuthorization(input) {
  const sdk = await import("openclaw/plugin-sdk/command-auth");
  return sdk.resolveCommandAuthorization(input);
}

// Observe the host's canonical inbound text before model dispatch. This hook
// does not claim a reply was sent or suppress the normal dispatcher. Its only
// effect is a bounded local encrypted relation after host authorization.
export async function handleNativeContextAuthority(event, hookContext, options = {}) {
  const env = options.env ?? process.env;
  const withdrawalMatch = typeof event?.ctx?.RawBody === "string"
    ? /^\/remembrance-context-revoke psd_[A-Za-z0-9_-]{8,96}(?:\r?\n)?$/u.exec(event.ctx.RawBody) : null;
  const withdrawal = withdrawalMatch?.[0] === event?.ctx?.RawBody;
  if (/^(0|false|no)$/iu.test(env.REMEMBRANCE_AUTO_CONTRIBUTE ?? "") && !withdrawal) return;
  try {
    const qualified = await nativeContextAuthorityEvent(
      { ...event, cfg: hookContext?.cfg },
      { resolveCommandAuthorization: options.resolveCommandAuthorization ?? resolveNativeCommandAuthorization },
    );
    if (!qualified) return;
    await (options.nativeContextBridge ?? runPrivateSkillNativeContextBridge)(qualified, { env });
  } catch {
    // Provider text, actor identifiers, and OS exceptions remain local.
  }
}

const CONTRIBUTION_TOOLS = [
  "submit_query_feedback",
  "submit_feedback",
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
];
const PREFERENCE_EVIDENCE_TOOLS = ["submit_preference_compatibility_feedback"];

// --- definePluginEntry shim --------------------------------------------------
//
// The real helper is `import { definePluginEntry } from
// "openclaw/plugin-sdk/plugin-entry"`. We do NOT import it directly so this
// module stays Node-builtins-only and passes `node --check` / unit tests without
// the OpenClaw SDK installed. definePluginEntry is an identity-style helper
// (it returns the definition object it is given), so an inline fallback is
// behaviorally equivalent for a loaded plugin. When the SDK is present, OpenClaw
// still consumes the default-exported definition object the same way.
function definePluginEntry(definition) {
  return definition;
}

// --- Event field probing (defensive; see UNVERIFIED note above) --------------

// Extract the user's prompt text from a before_prompt_build event. The docs
// confirm the hook receives "the current prompt" but do not pin the field name,
// so we probe the plausible shapes and fall back to scanning a messages array
// for the latest user message. Returns "" when nothing is found (the core then
// no-ops via its length guard).
export function promptFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  if (typeof event.prompt === "string") {
    return event.prompt;
  }
  if (typeof event.userPrompt === "string") {
    return event.userPrompt;
  }
  if (event.input && typeof event.input.prompt === "string") {
    return event.input.prompt;
  }
  const messages = Array.isArray(event.messages)
    ? event.messages
    : Array.isArray(event.input?.messages)
      ? event.input.messages
      : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.role === "user") {
        if (typeof message.content === "string") {
          return message.content;
        }
        if (Array.isArray(message.content)) {
          return message.content
            .map((part) =>
              typeof part === "string" ? part : (part?.text ?? ""),
            )
            .join("\n");
        }
      }
    }
  }
  return "";
}

// Recovery accepts only the current prompt fields supplied by the native
// before_prompt_build event. The messages-array compatibility fallback remains
// useful for querying but is conversation context, not source provenance.
export function nativeUserPromptFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.prompt === "string") return event.prompt;
  if (typeof event.userPrompt === "string") return event.userPrompt;
  if (event.input && typeof event.input.prompt === "string") {
    return event.input.prompt;
  }
  return null;
}

// The ids OpenClaw gives a hook (its ctx, which register() copies onto the
// event) in the shape hook-core reads: the run (ctx.runId) is new for every
// turn, the session (ctx.sessionId, else ctx.sessionKey) is not.
function hookIdsFromEvent(event) {
  const ctx = event?.context ?? event?.ctx ?? {};
  return {
    turn_id: ctx.runId ?? ctx.turnId,
    session_id: ctx.sessionId ?? ctx.sessionKey,
  };
}

// OpenClaw runs a subagent (sessions_spawn) in its own session, keyed
// agent:<agent id>:subagent:<uuid> (its isSubagentSessionKey).
function subagentSessionKey(key) {
  return typeof key === "string" && /^(?:agent:[^:]+:)?subagent:/i.test(key)
    ? key
    : null;
}

function subagentKeyFromEvent(event) {
  return subagentSessionKey((event?.context ?? event?.ctx)?.sessionKey);
}

// What this process knows of a subagent, by its session key: the ledger of
// the session that spawned it (that session's sessions_spawn result), whether
// it is thread-bound, the ledger of its latest prompt, and its own ledger
// once it has finalized or ended. At most 512,
// oldest dropped.
function subagentRecord(records, key) {
  let record = records.get(key);
  if (!record) {
    record = { key };
    records.set(key, record);
    if (records.size > 512) records.delete(records.keys().next().value);
  }
  return record;
}

// The runs a subagent's own prompts started, newest last: at most
// SUBAGENT_PROMPTED_RUN_LIMIT run ids (of at most 256 characters) in its
// record, which the map above already bounds; nothing on disk.
// handleSubagentEnded reads them, and pullAnnouncedSubagentDebts counts
// them.
const SUBAGENT_PROMPTED_RUN_LIMIT = 4;

function rememberPromptedRun(record, event) {
  const runId = hookIdsFromEvent(event).turn_id;
  if (typeof runId !== "string" || !runId || runId.length > 256) return;
  record.promptedRuns = [
    ...(record.promptedRuns ?? []).filter((run) => run !== runId),
    runId,
  ].slice(-SUBAGENT_PROMPTED_RUN_LIMIT);
}

// Once both ledgers are known, what the subagent leaves goes to the session
// that spawned it, marked second-hand, as hook-core passes a SubagentStop's
// leftovers up from <parent ledger>:agent:<agent id>
// (transferSubagentObligations); the subagent's own ledger moves there first,
// whole. Both leave forwarding markers (`forward`), also when they hold
// nothing: a nested subagent whose end comes after this one's hands into this
// one's ledger, and the session this one went to then reaches it, until this
// one's session runs again (handlePrePrompt). A thread-bound subagent (mode
// "session") gets prompts of its own later, so it keeps its debts.
// Fail-open: a debt that cannot move stays.
function passSubagentDebts(record, env) {
  if (!record.ledger || !record.requester || record.threadBound) return 0;
  const handoff = {
    hook_event_name: "SubagentStop",
    session_id: record.requester,
    agent_id: record.key,
  };
  try {
    foldTurnLedgerIntoSession(
      { session_id: agentLedgerIdFor(handoff), turn_id: record.ledger },
      env,
      { forward: true },
    );
    return transferSubagentObligations(handoff, env, { forward: true });
  } catch (error) {
    debugLog(env, "subagent_handoff_error", { error: errorName(error) });
    return 0;
  }
}

// A sessions_spawn result names the subagent's session, which this session
// (its key: requesterKey) spawned. OpenClaw starts the subagent's run before
// it returns that result and does not await this hook, so a subagent that
// already finished (finalized, or ended: subagent_ended) hands its debts up
// now.
function rememberSubagentRequester(
  records,
  response,
  ledgerId,
  env,
  requesterKey,
) {
  const spawn = response?.details;
  const key = subagentSessionKey(spawn?.childSessionKey);
  if (!records || !key || spawn.status !== "accepted") return;
  const record = subagentRecord(records, key);
  if (spawn.mode === "session") record.threadBound = true;
  else {
    record.requester = ledgerId;
    record.requesterKey = requesterKey;
  }
  passSubagentDebts(record, env);
}

// OpenClaw calls subagent_ended once for each ended run of a subagent that
// is not thread-bound (outcome ok, error, timeout or killed; a killed
// thread-bound run too), after it delivered the announce of that run to the
// spawning session, also when it steered that announce into a run of that
// session in progress, which no prompt hook sees. Its context names the
// subagent (childSessionKey; event.targetSessionKey too) and the spawning
// session (requesterSessionKey) from OpenClaw's own registry. It is not a
// conversation hook, so it also runs before the conversation-access grant.
// The subagent's debts go up as at its finalize: from the ledger of its
// latest prompt (OpenClaw gives its session key a new sessionId when a later
// run finds the entry stale, its daily or idle reset), else of its finalize,
// to the session its spawn result named; before that result arrives the
// record keeps that ledger, and the result hands them up
// (rememberSubagentRequester). A thread-bound subagent keeps its debts, as
// passSubagentDebts decides for every path. A subagent this process never
// saw is not remembered. Local ledger files only, no request. Where
// OpenClaw names another requester than the spawning session, nothing moves.
// OpenClaw may report a run's end only after a later run of the same
// subagent started (its prompt hook ran; OpenClaw 2026.7.1-2 passes the
// ended run's id, its subagent registry entry's, as event.runId and
// ctx.runId): that later run is still going and keeps the subagent's debts,
// so this end hands nothing over and the later run's end does. An end that
// names no run (OpenClaw's session reset or delete names none), or a run
// whose prompt this process never saw or no longer remembers (four later
// runs started, or the records above were empty after a Gateway restart),
// hands over as before.
export function handleSubagentEnded(event, ctx, options = {}) {
  const key = subagentSessionKey(
    ctx?.childSessionKey ?? event?.targetSessionKey,
  );
  const record = key ? options.subagentRequesters?.get(key) : null;
  if (!record) return 0;
  const named = ctx?.requesterSessionKey;
  if (
    record.requesterKey &&
    typeof named === "string" &&
    named !== record.requesterKey
  ) {
    options.logger?.warn?.(
      "Remembrance left an ended subagent's pending actions in its own session: OpenClaw named another requester for it than the session that spawned it.",
    );
    return 0;
  }
  const endedRun = ctx?.runId ?? event?.runId;
  const runs = record.promptedRuns ?? [];
  if (
    typeof endedRun === "string" &&
    runs.includes(endedRun) &&
    runs.at(-1) !== endedRun
  ) {
    return 0;
  }
  record.ledger = record.ownLedger ?? record.ledger;
  return passSubagentDebts(record, options.env ?? process.env);
}

// OpenClaw announces a subagent's result to the session that spawned it in a
// new run whose prompt starts with this line (its inter-session provenance),
// however the subagent's run ended: also after a model error, a timeout or an
// abort, when it calls no before_agent_finalize. While that session still has
// a run in progress, OpenClaw steers the announce into that run instead: no
// new run starts and no prompt hook sees it (subagent_ended hands the debts
// up then: handleSubagentEnded). The announce hands the
// subagent's debts up from the ledger its finalize or, failing that, its own
// prompt recorded: to the session its spawn result named, else to the session
// that receives the announce, which an announce names also when it pulls
// nothing (after a Gateway restart this process has no spawn result, and the
// latest run's end then hands the debts there). A later announce never
// redirects them. Once this process has seen a later run of that subagent
// start (it remembers more than one), an announce, which names no run, pulls
// nothing: the run that is going keeps the debts, and a run's finalize or its
// end hands them up. So a later run that ends without a finalize hands them
// up only when OpenClaw reports its end, even when its own announce comes
// first. After a Gateway restart this process remembers no earlier run, and
// an announce pulls as before until it has seen two runs of the subagent
// start.
const SUBAGENT_ANNOUNCE =
  /^\[Inter-session message\] sourceSession=(\S+) (?:sourceChannel=\S+ )?sourceTool=subagent_announce isUser=false\n/;

function pullAnnouncedSubagentDebts(records, event, ledgerId, env) {
  const key = subagentSessionKey(
    SUBAGENT_ANNOUNCE.exec(nativeUserPromptFromEvent(event) ?? "")?.[1],
  );
  const record =
    key && key !== subagentKeyFromEvent(event) ? records?.get(key) : null;
  if (!record) return;
  record.requester ??= ledgerId;
  if ((record.promptedRuns?.length ?? 0) > 1) return;
  record.ledger ??= record.ownLedger;
  if (!record.ledger) return;
  passSubagentDebts(record, env);
}

// The run's id (turn first, as hook-core sessionIdFor): lifecycle markers,
// directives, value episodes, host-policy alerts and task outcomes belong to
// one OpenClaw run.
export function sessionIdFromEvent(event) {
  return sessionIdFor(hookIdsFromEvent(event));
}

// Debts outlive a run, so usage, task eligibility, the prompted count and
// pending actions are kept per session, as Codex keeps them (hook-core
// agentLedgerIdFor): the session, else the run.
export function ledgerIdFromEvent(event) {
  return agentLedgerIdFor(hookIdsFromEvent(event));
}

export function nativeSessionIdFromEvent(event) {
  return hookIdsFromEvent(event).session_id ?? null;
}

// OpenClaw passes a typed hook's run identity as the handler's second
// argument, not on the event; without it every run shares one session.
function withHookContext(event, ctx) {
  return { ...event, context: { ...event?.context, ...ctx } };
}

// --- PRE-prompt hook: before_prompt_build ------------------------------------

// Given an OpenClaw before_prompt_build event, decide/query/format via the core
// and return the OpenClaw injection result, or undefined to inject nothing.
// `env`/`fetchImpl`/`record` are injectable so tests need no network or FS.
// Fail-open: any thrown error resolves to undefined (inject nothing).
export async function handlePrePrompt(event, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFromEvent(event);
  const ledgerId = ledgerIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "prompt_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  try {
    // A run of a session that handed its debts up starts: they are its own
    // again (an announce run for its subagent's result, a later run).
    releaseCompletionForward(ledgerId, env);
    // A subagent's own prompt names its current ledger, for the announce and
    // subagent_ended: a later run after OpenClaw reset the session has a new
    // one. What the previous ledger still holds goes up first, since OpenClaw
    // may report the earlier run's end late, or never (a newer run of the
    // session superseded it, or a steer restart replaced it). It is done
    // before anything is awaited, so an end of an earlier run that OpenClaw
    // reports meanwhile already finds this run (L1).
    const ownKey = subagentKeyFromEvent(event);
    if (ownKey && options.subagentRequesters) {
      const ownRecord = subagentRecord(options.subagentRequesters, ownKey);
      if (ownRecord.ownLedger && ownRecord.ownLedger !== ledgerId) {
        ownRecord.ledger = ownRecord.ownLedger;
        passSubagentDebts(ownRecord, env);
      }
      ownRecord.ownLedger = ledgerId;
      rememberPromptedRun(ownRecord, event);
    }
    let updateNotice = null;
    // Once per OpenClaw session, like the debts.
    if (
      options.clientUpdatePromise &&
      !options.updateDeliveredSessions?.has(ledgerId)
    ) {
      const clientUpdate = await options.clientUpdatePromise.catch(() => null);
      if (clientUpdate?.notice) {
        updateNotice = clientUpdate.notice;
      }
    }
    pullAnnouncedSubagentDebts(
      options.subagentRequesters,
      event,
      ledgerId,
      env,
    );
    const prompt = promptFromEvent(event);
    const nativePrompt = nativeUserPromptFromEvent(event);
    const result = await runPromptHook(prompt, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      stderr: options.stderr,
      // Report as OpenClaw, not the shared-core Codex default, so server-side
      // analytics/attribution are correct and the query validates.
      identity: { provider: "openclaw", model: "openclaw" },
      contextAdditions: updateNotice
        ? [
            {
              id: "client_update",
              kind: "notice",
              text: updateNotice,
            },
          ]
        : [],
      sessionId: ledgerId,
      // A subagent's session names no agent in its ledger: the user
      // decisions about retained drafts are for main sessions only.
      subagentSession: Boolean(ownKey),
      nativeSessionId:
        nativePrompt === null ? null : nativeSessionIdFromEvent(event),
      nativeContextBridge: options.nativeContextBridge,
      userAgent: "@remembrance/openclaw-plugin",
    });
    if (!result) {
      if (!updateNotice) return undefined;
      markClientUpdateDelivered(options.updateDeliveredSessions, ledgerId);
      return { appendSystemContext: updateNotice };
    }
    if (result.deliveredContextAdditionIds?.includes("client_update")) {
      markClientUpdateDelivered(options.updateDeliveredSessions, ledgerId);
    }
    if (result.eligible) {
      const recordEligibility =
        options.recordEligibility ?? recordTaskEligibility;
      recordEligibility(ledgerId, env);
    }
    const recordDirective = options.recordDirective ?? recordDirectiveSurface;
    recordDirective(sessionId, result.directive ?? null, env);
    const recordQueryFeedback =
      options.recordQueryFeedback ?? recordQueryFeedbackObligation;
    recordQueryFeedback(ledgerId, result.queryFeedback, env);
    if (result.consumed && result.matched) {
      const record = options.recordUse ?? recordRegistryUse;
      record(ledgerId, env);
      const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
      recordHighMatch(ledgerId, result.highMatch ?? null, env);
      const recordValueEpisode =
        options.recordValueEpisode ?? recordValueEpisodeSurface;
      recordValueEpisode(sessionId, result.valueEpisode ?? null, env);
    }
    // An empty task-shape search with nothing to deliver (owner decision 34C).
    if (!result.context) return undefined;
    // OpenClaw injects extra system context via appendSystemContext on the
    // before_prompt_build / before_model_resolve result.
    return {
      appendSystemContext: result.context,
    };
  } catch (error) {
    debugLog(env, "pre_prompt_error", { error: errorName(error) }, options);
    return undefined;
  }
}

function markClientUpdateDelivered(deliveredSessions, sessionId) {
  deliveredSessions?.add(sessionId);
  if ((deliveredSessions?.size ?? 0) <= 512) return;
  const oldest = deliveredSessions.values().next().value;
  if (oldest) deliveredSessions.delete(oldest);
}

// OpenClaw exposes completed tool calls through the observation-only
// after_tool_call hook. Correlate successful queries with task directives, and
// clear the completion nudge only when the exact high match was opened.
export async function handleAfterToolCall(event, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFromEvent(event);
  const ledgerId = ledgerIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "tool_observer",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  const response = event?.result ?? event?.output ?? event?.response ?? null;
  if (
    event?.error ||
    event?.isError ||
    event?.result?.isError ||
    toolResponseIndicatesFailure(response)
  ) {
    const toolName = event?.toolName ?? event?.tool_name ?? "";
    const recordDenial =
      options.recordHostPolicyDenial ?? recordHostPolicyDenial;
    const observation = recordDenial(
      {
        surface: "openclaw",
        sessionId,
        eventType: "after_tool_call",
        toolName,
        value: event,
        pluginVersion: pluginVersion(),
      },
      env,
    );
    return {
      cleared: false,
      why: "tool_failed",
      ...(observation ? { host_policy_denial: true } : {}),
    };
  }
  const toolName = event?.toolName ?? event?.tool_name ?? "";
  const normalizedToolName = String(toolName).toLowerCase();
  const toolArguments =
    event?.params ?? event?.arguments ?? event?.tool_input ?? {};
  if (normalizedToolName.endsWith("query_skills")) {
    if (queryResponseHasMatches(response)) {
      const recordUse = options.recordRegistryUse ?? recordRegistryUse;
      recordUse(ledgerId, env);
    }
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(ledgerId, highMatchFromResponse(response), env);
    const recordFollowThrough =
      options.recordDirectiveFollowThrough ??
      recordDirectiveFollowThroughForTool;
    const followed = await recordFollowThrough(sessionId, toolName, response, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      userAgent: "@remembrance/openclaw-plugin",
    });
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(ledgerId, toolName, toolArguments, response, env);
    return {
      cleared: false,
      directive_followed: followed,
      why: followed ? "directive_followed" : "no_current_directive",
    };
  }
  if (normalizedToolName.endsWith("invoke_skill")) {
    const selection = directSelectionFromResponse(response);
    if (!selection) {
      return { recorded: false, cleared: false, why: "invocation_not_loaded" };
    }
    const useCount = recordDirectSelectionUse(
      ledgerId,
      selection,
      env,
      options,
    );
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const clearExplicit =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    const cleared = clearExplicit(ledgerId, selection.slug, env);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(ledgerId, toolName, toolArguments, response, env);
    return {
      recorded: true,
      cleared,
      why: "direct_skill_invoked",
      count: useCount,
    };
  }
  if (
    PREFERENCE_EVIDENCE_TOOLS.some((tool) => normalizedToolName.endsWith(tool))
  ) {
    return {
      recorded: true,
      cleared: false,
      why: "preference_compatibility_feedback_recorded",
    };
  }
  if (normalizedToolName.endsWith("prepare_private_lesson_candidate")) {
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      ledgerId,
      toolName,
      toolArguments,
      response,
      env,
    );
    return {
      recorded: observation.opened.length > 0,
      cleared: false,
      why: "private_lesson_prepared",
    };
  }
  if (CONTRIBUTION_TOOLS.some((tool) => normalizedToolName.endsWith(tool))) {
    await bindPrivateSkillNativeCapture(toolName, toolArguments, response, {
      env,
      nativeContextBridge: options.nativeContextBridge,
      nativeSessionId: nativeSessionIdFromEvent(event),
    });
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      ledgerId,
      toolName,
      toolArguments,
      response,
      env,
    );
    if (
      normalizedToolName.endsWith("submit_feedback") &&
      responseRequestsRemembranceFollowup(response)
    ) {
      return {
        recorded: true,
        cleared: false,
        why: "remembrance_followup_pending",
      };
    }
    return {
      recorded: true,
      cleared: false,
      why:
        observation.pending.length > 0
          ? "contribution_recorded_pending"
          : "contribution_handled",
      count: observation.handled_count,
    };
  }
  if (normalizedToolName === "sessions_spawn") {
    rememberSubagentRequester(
      options.subagentRequesters,
      response,
      ledgerId,
      env,
      (event?.context ?? event?.ctx)?.sessionKey,
    );
  }
  const clear =
    options.clearHighMatchSurfaceIfOpened ?? clearHighMatchSurfaceIfOpened;
  const cleared = clear(ledgerId, toolName, toolArguments, env);
  const observe =
    options.observeCompletionTool ?? observeSuccessfulCompletionTool;
  observe(ledgerId, toolName, toolArguments, response, env);
  return {
    cleared,
    why: cleared ? "matched_detail_open" : "not_current_match",
  };
}

export async function handleFinalize(event, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "completion_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  const report = options.reportTaskOutcomes ?? reportTaskOutcomesOnStop;
  await report(sessionId, event, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    userAgent: "@remembrance/openclaw-plugin",
  });
  return handleCompletion(event, options);
}

// --- COMPLETION hook: before_agent_finalize ----------------------------------

// Given an OpenClaw before_agent_finalize event, decide whether to nudge a
// contribution. Returns the OpenClaw finalize result: `{ action: "revise", ... }`
// to ask the agent to contribute once, or `{ action: "finalize" }` to let it
// finish. `env` and the count fns are injectable. Fail-open: any error
// finalizes.
export function handleCompletion(event, options = {}) {
  const env = options.env ?? process.env;
  try {
    // Reuse the shared decideStop by mapping the OpenClaw event onto the input
    // shape the core expects, both ids as Codex passes them; it reads the
    // session's ledger. Loop safety comes from the prompted-count sentinel the
    // core applies (it only revises when use > prompted), the count recorded
    // below and the retry's maxAttempts 1; OpenClaw's stopHookActive is not
    // read.
    const decide = () =>
      decideStop(
        {
          ...hookIdsFromEvent(event),
          stop_hook_active: false,
          last_assistant_message: completionMessageFromEvent(event),
        },
        {
          env,
          readUseCount: options.readUseCount ?? readRegistryUseCount,
          readEligibilityCount:
            options.readEligibilityCount ?? readTaskEligibilityCount,
          readPromptedCount: options.readPromptedCount,
          readCompletionObligations: options.readCompletionObligations,
          readHighMatch: options.readHighMatch,
          subagentSession: Boolean(subagentKeyFromEvent(event)),
        },
      );
    // A subagent that is not thread-bound is decided as master decides it,
    // on its ledger before its debts move. Then its debts go up, at each of
    // its finalizes, whatever is decided below: OpenClaw drops a finalize
    // revise after a tool call with possible side effects (every MCP tool) and
    // does not call this hook again.
    const subagent = subagentKeyFromEvent(event);
    const record =
      subagent && options.subagentRequesters
        ? subagentRecord(options.subagentRequesters, subagent)
        : null;
    if (record) record.ledger = ledgerIdFromEvent(event);
    const subagentDecision = subagent && !record?.threadBound ? decide() : null;
    if (record) passSubagentDebts(record, env);
    // Master records the prompted count when it asks about debts. Where the
    // hand-up takes that ask's place, it records the same count: master's
    // accounting, with no ask. The moved copies still reach the session that
    // spawned the subagent unprompted (transferSubagentObligations resets
    // their prompted_at). A later run of the subagent's session
    // (sessions_send, a wake run, an honored alert revise) then finds that use
    // already prompted for, as on master.
    if (subagentDecision?.why === "prompt_pending_obligations") {
      const writeSentinel = options.writePromptedCount ?? writePromptedCount;
      writeSentinel(ledgerIdFromEvent(event), subagentDecision.useCount, env);
    }
    const sessionId = sessionIdFromEvent(event);
    const readPolicyAlert =
      options.readPendingHostPolicyAlert ?? readPendingHostPolicyAlert;
    const policyAlert = readPolicyAlert("openclaw", sessionId, env);
    if (policyAlert) {
      const markDelivered =
        options.markHostPolicyAlertDelivered ?? markHostPolicyAlertDelivered;
      markDelivered("openclaw", sessionId, policyAlert.id, env);
      if (
        hostPolicyAlertWasReported({
          last_assistant_message: completionMessageFromEvent(event),
        })
      ) {
        return { action: "finalize", why: "host_policy_alert_reported" };
      }
      const alert = hostPolicyAlertTextForOperation(
        policyAlert.operation_class,
      );
      return {
        action: "revise",
        reason: alert,
        retry: { instruction: alert, maxAttempts: 1 },
        why: "host_policy_denial",
      };
    }
    // Such a subagent is never asked about its debts: they went up above or
    // wait for the session that spawned it, and an honored revise would rerun
    // its whole task. Master's other prompts stay. A thread-bound subagent
    // (mode "session") gets prompts of its own and is decided like any
    // session: kept in silent mode, asked in visible mode.
    if (
      subagentDecision?.allow ||
      subagentDecision?.why === "prompt_pending_obligations"
    ) {
      return { action: "finalize", why: "subagent_session" };
    }
    const decision = subagentDecision ?? decide();
    if (decision.allow) {
      return { action: "finalize", why: decision.why };
    }
    // Record that we prompted at this use count so we never nag twice for the
    // same use.
    const writePrompted = options.writePromptedCount ?? writePromptedCount;
    writePrompted(ledgerIdFromEvent(event), decision.useCount, env);
    const continuationReason = completionContinuationReason(
      decision.reason ?? contributionReason(),
      { last_assistant_message: completionMessageFromEvent(event) },
      env,
    );
    return {
      action: "revise",
      reason: continuationReason,
      retry: {
        instruction: continuationReason,
        maxAttempts: 1,
      },
      why: decision.why,
    };
  } catch (error) {
    debugLog(env, "completion_error", { error: errorName(error) }, options);
    return { action: "finalize", why: "error" };
  }
}

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

function completionMessageFromEvent(event) {
  return (
    event?.last_assistant_message ??
    event?.lastAssistantMessage ??
    event?.assistant_message ??
    event?.message ??
    event?.response?.content ??
    event?.result?.content ??
    event?.context?.last_assistant_message ??
    event?.context?.lastAssistantMessage
  );
}

function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function configureOpenClawRemembrance(draft, pluginRoot) {
  const root = String(pluginRoot ?? "").trim();
  if (!root) {
    throw new Error("OpenClaw did not provide the installed plugin root.");
  }
  const serverPath = resolve(root, "servers/remembrance-mcp.mjs");
  accessSync(serverPath);

  const plugins = record(draft.plugins);
  const entries = record(plugins.entries);
  const entry = record(entries.remembrance);
  const hooks = record(entry.hooks);
  entries.remembrance = {
    ...entry,
    enabled: true,
    hooks: {
      ...hooks,
      allowConversationAccess: true,
    },
  };
  plugins.entries = entries;
  draft.plugins = plugins;

  const mcp = record(draft.mcp);
  const servers = record(mcp.servers);
  const existingServer = record(servers.remembrance);
  const existingEnv = record(existingServer.env);
  servers.remembrance = {
    ...existingServer,
    // The Node.js running OpenClaw now: a gateway started by a service manager
    // or desktop app may not have the shell's PATH, where `node` can be missing.
    command: process.execPath,
    args: [serverPath],
    env: {
      ...existingEnv,
      REMEMBRANCE_PLUGIN_HOST: "openclaw",
    },
  };
  mcp.servers = servers;
  draft.mcp = mcp;
  return { serverPath };
}

function registerSetupCli(api) {
  if (typeof api?.registerCli !== "function") return;
  api.registerCli(
    ({ program }) => {
      const command = program
        .command("remembrance")
        .description("Configure and inspect the Remembrance plugin");
      command
        .command("setup")
        .description("Grant Remembrance conversation access and register its bundled local MCP")
        .option("--json", "Print machine-readable setup details")
        .action(async (options = {}) => {
          let serverPath = "";
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              ({ serverPath } = configureOpenClawRemembrance(
                draft,
                api.rootDir,
              ));
            },
          });
          const result = {
            ok: true,
            plugin: "remembrance",
            conversation_access: true,
            mcp_server: "remembrance",
            mcp_transport: "local_stdio",
            mcp_server_path: serverPath,
            credential_source: "shared_config_or_environment",
            next: "Restart OpenClaw, then run: openclaw mcp doctor remembrance --probe",
          };
          const output = options.json
            ? JSON.stringify(result)
            : [
                "Remembrance hooks and bundled local MCP are configured.",
                `Server: ${serverPath}`,
                result.next,
              ].join("\n");
          process.stdout.write(`${output}\n`);
        });
    },
    {
      descriptors: [
        {
          name: "remembrance",
          description: "Configure and inspect the Remembrance plugin",
          hasSubcommands: true,
        },
      ],
    },
  );
}

// --- Plugin definition -------------------------------------------------------

const plugin = definePluginEntry({
  id: "remembrance",
  name: "Remembrance",
  description:
    "Auto-query Remembrance before relevant tasks and nudge contribution at completion.",
  register(api) {
    const credential = resolveApiCredential(process.env);
    const activatesRuntime =
      !api?.registrationMode || api.registrationMode === "full";
    if (activatesRuntime) {
      recordPluginLifecycleHealth(
        {
          surface: "openclaw",
          component: "session_start",
          pluginVersion: pluginVersion(),
          hostVersion: String(api?.version ?? api?.hostVersion ?? "").trim(),
          credentialSource: credential.source,
        },
        process.env,
      );
    }
    const clientUpdatePromise = activatesRuntime
      ? (api?.clientUpdateCheck ?? checkForClientUpdate)(
          {
            surface: "openclaw",
            currentVersion: pluginVersion(),
          },
          process.env,
        ).catch(() => null)
      : Promise.resolve(null);
    if (activatesRuntime) {
      void warmPrincipalSession(
        {
          runtime: "openclaw",
          hostSurface: "gateway",
          clientVersion: pluginVersion(),
          hostVersion: String(api?.version ?? api?.hostVersion ?? "").trim(),
        },
        process.env,
      ).catch(() => null);
    }
    const updateDeliveredSessions = new Set();
    // Subagent session key -> what this process knows of that subagent.
    const subagentRequesters = new Map();
    const privateLearningApprovals = privateLearningSubmitApprovals(api);
    const auth =
      credential.source === "none"
        ? "public registry access"
        : `${credential.source.replace("_", " ")} organization credential`;
    if (activatesRuntime) {
      api?.logger?.info?.(
        `Remembrance lifecycle hooks registered; run_connection_doctor should verify the same ${auth}.`,
      );
    }
    registerSetupCli(api);
    api.on(
      "reply_dispatch",
      async (event, ctx) => handleNativeContextAuthority(event, ctx),
      { priority: 60 },
    );
    api.on(
      "before_tool_call",
      async (event) =>
        handlePrivateLessonSubmitApproval(event, {
          approvedLanes: privateLearningApprovals,
          onAllowAlways(lane) {
            privateLearningApprovals.add(lane);
            void persistPrivateLearningSubmitApproval(api, lane).catch(
              (error) => {
                api?.logger?.warn?.(
                  `Remembrance could not persist exact private submission approval: ${errorName(error)}`,
                );
              },
            );
          },
        }),
      { priority: 60 },
    );
    // PRE-prompt: inject matching skills/resources before the model turn.
    api.on(
      "before_prompt_build",
      async (event, ctx) =>
        handlePrePrompt(withHookContext(event, ctx), {
          clientUpdatePromise,
          updateDeliveredSessions,
          subagentRequesters,
        }),
      { priority: 50 },
    );
    api.on(
      "after_tool_call",
      async (event, ctx) =>
        handleAfterToolCall(withHookContext(event, ctx), {
          subagentRequesters,
        }),
      { priority: 50 },
    );
    // COMPLETION: nudge the agent to contribute what it learned, once.
    api.on(
      "before_agent_finalize",
      async (event, ctx) =>
        handleFinalize(withHookContext(event, ctx), { subagentRequesters }),
      { priority: 50 },
    );
    // SUBAGENT END: hand an ended subagent run's debts to the session that
    // spawned it, also when OpenClaw steered its announce into a run there.
    api.on(
      "subagent_ended",
      async (event, ctx) =>
        handleSubagentEnded(event, ctx, {
          subagentRequesters,
          logger: api?.logger,
        }),
      { priority: 50 },
    );
  },
});

export default plugin;
