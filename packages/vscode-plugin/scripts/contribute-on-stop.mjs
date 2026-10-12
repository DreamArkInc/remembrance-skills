#!/usr/bin/env node

// VS Code Stop adapter — the contribution mirror of query-on-prompt.mjs.
//
// The query hook automates CONSUMPTION for explicit prompts and records task
// ELIGIBILITY for explicit or context-dependent prompts.
// Contribution had no trigger, so agents reliably query but rarely submit what
// they learned. This Stop hook closes that asymmetry: when reusable work or an
// actual Remembrance use is about to end, it blocks the stop ONCE. It can first
// recover a missed full-context query, then request a redacted contribution.
//
// Shared vs Claude-specific:
// - The runtime-agnostic pieces (contributeDisabled, decideStop,
//   contributionReason) come from the shared hook-core.mjs, byte-identical across
//   the Codex / OpenClaw / Claude plugins (re-synced by `npm run sync:hook-core`).
// - The CONSUMPTION count is also derived from THE TRANSCRIPT here. The Stop
//   payload carries a transcript_path, so — unlike Codex/OpenClaw, which have
//   no transcript and drive the same decision off per-session usage markers —
//   this adapter parses the transcript's JSONL records (Claude Code's or VS
//   Code's format) and counts actual Remembrance tool calls and prompt-hook
//   injections (transcriptEvidence).
//   The per-session sentinel therefore lives under `remembrance-contribute` (a
//   single prompted-count file), not the marker directory the core's helpers use.
//
// Safety:
// - Env-flagged: disable with REMEMBRANCE_AUTO_CONTRIBUTE in {0,false,no}.
// - Loop-safe: VS Code sets stop_hook_active=true on the continuation a
//   Stop-block causes, so the second stop is always allowed. A per-session
//   sentinel is a second guard so the agent is prompted at most once per session.
// - Non-nagging: only blocks when transcript/marker evidence shows registry use
//   or an eligible reusable task. If engagement can't be determined, it allows
//   the stop.
// - Fail-open: any error allows the stop.
// - The agent can satisfy it by contributing OR by briefly declining; either way
//   it is not asked again.
//
// SubagentStop runs this script too. A subagent shares its parent's session_id;
// when the host also sends the subagent's agent_id with its tool hooks (Claude
// Code does), its debts are kept per agent (agentLedgerIdFor) and it is asked,
// once, for its own before it exits. Whatever it leaves unpaid then passes to
// its parent, marked second-hand (transferSubagentObligations). A host that
// names a subagent only at its start and stop also runs this script for
// SubagentStart, so that the subagent's task prompt is not taken for the
// user's (recordSubagentStart).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentLedgerIdFor,
  completionContinuationReason,
  contributeDisabled,
  contributionReason,
  decideStop,
  directSelectionFromResponse,
  markCompletionObligationsPrompted,
  markDirectSelectionSurfacesPrompted,
  readDirectSelectionSurfaces,
  readPromptedCount as readSharedPromptedCount,
  readRegistryUseCount,
  readTaskEligibilityCount,
  recordPluginLifecycleHealth,
  recordSubagentStart,
  reportTaskOutcomesOnStop,
  resolveApiCredential,
  transferSubagentObligations,
} from "./hook-core.mjs";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
// Claude Code names MCP tools mcp__<server>__<tool>; VS Code names them
// mcp_<server>_<tool>.
const REGISTRY_CONSUMPTION_TOOL =
  /^mcp_(?:_[a-z0-9_]*remembrance[a-z0-9_]*_|[a-z0-9.-]*remembrance[a-z0-9.-]*)_(query_skills|get_skill|get_resource|invoke_skill)$/i;
const TASK_ELIGIBILITY_CONTEXT =
  /Remembrance (?:task-continuation reminder|query-unavailable context)/;

// Re-export the shared helpers the plugin test imports from this module.
export { contributeDisabled, contributionReason };

// True when the session's transcript shows Remembrance was engaged — an
// auto-query context injection, a Remembrance MCP tool call, a REST agent
// endpoint, or the remembrancer skill. Boolean only; no transcript content is
// ever emitted by this hook. (Claude-specific: keyed off the transcript, which
// only the Claude Stop payload provides.)
export function sessionUsedRemembrance(transcript) {
  const text = String(transcript ?? "");
  if (!text) {
    return false;
  }
  return (
    /Remembrance auto-query context/i.test(text) ||
    /mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource|invoke_skill|submit_remembrance|submit_query_feedback|submit_feedback|submit_suggestion|submit_resource|propose_skill_idea|propose_private_skill|submit_private_lesson_candidate|retry_private_lesson_candidate)/i.test(
      text,
    ) ||
    /\/api\/v1\/agent\/(query|query-feedback|skill-invocations|remembrances|skill-ideas|suggestions|feedback)\b/i.test(
      text,
    ) ||
    /\bremembrancer\b/i.test(text)
  );
}

function sentinelPath(sessionId) {
  const digest = createHash("sha256")
    .update(String(sessionId ?? "unknown"))
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "remembrance-contribute", `${digest}.count`);
}

// The consumption count at which we last prompted this session (0 if never).
function readPromptedCount(sessionId) {
  try {
    const raw = readFileSync(sentinelPath(sessionId), "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writePromptedCount(sessionId, count) {
  try {
    mkdirSync(join(tmpdir(), "remembrance-contribute"), { recursive: true });
    writeFileSync(sentinelPath(sessionId), String(count));
  } catch {
    // Non-fatal: stop_hook_active still prevents an immediate loop.
  }
}

function readTranscriptSafe(path) {
  if (!path || typeof path !== "string") {
    return "";
  }
  try {
    if (!existsSync(path)) {
      return "";
    }
    const raw = readFileSync(path, "utf8");
    return raw.length > MAX_TRANSCRIPT_BYTES
      ? raw.slice(raw.length - MAX_TRANSCRIPT_BYTES)
      : raw;
  } catch {
    return "";
  }
}

function registryConsumptionTool(name) {
  return (
    REGISTRY_CONSUMPTION_TOOL.exec(String(name ?? ""))?.[1].toLowerCase() ??
    null
  );
}

// Reads the JSONL transcript by its record structure, in either host's format.
// Claude Code writes one content block per assistant entry, tool results as
// user entries, and prompt-hook context as attachments. VS Code writes
// assistant.message records (text in data.content) and tool.execution_start
// records (data.toolName), with no tool results or hook context.
// Consumption counts calls to a Remembrance query/get/invoke tool, plus
// "Remembrance auto-query context" injections by the prompt hook; eligibility
// counts that hook's continuation and query-unavailable injections. Tool names
// in host tool listings (ToolSearch results, deferred-tool records) and hook
// reasons the host saved into the transcript are text, not calls, so they never
// count. An invoke_skill call whose own result is scoped to the whole session
// is not counted either, because a turn's stop does not close it. A VS Code
// transcript has no results to show that scope, so its invoke_skill calls are
// left to the PostToolUse observer, which counts them from the result.
// lastAssistantMessage is the text of the final main-thread assistant message
// only.
export function transcriptEvidence(transcript) {
  let consumption = 0;
  let eligibility = 0;
  let lastMessageId = null;
  let lastMessageText = [];
  const invocations = new Set();
  for (const line of String(transcript ?? "").split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Blank, cut off by the tail window, or not JSON.
    }
    if (entry?.type === "assistant" && Array.isArray(entry.message?.content)) {
      const blocks = entry.message.content;
      for (const block of blocks) {
        const tool =
          block?.type === "tool_use"
            ? registryConsumptionTool(block.name)
            : null;
        if (!tool) continue;
        consumption += 1;
        if (tool === "invoke_skill") invocations.add(block.id);
      }
      if (entry.isSidechain === true) continue;
      // Claude Code writes one content block per entry; a message's entries
      // share its id.
      const messageId = entry.message.id ?? null;
      if (messageId === null || messageId !== lastMessageId) {
        lastMessageText = [];
      }
      lastMessageId = messageId;
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          lastMessageText.push(block.text);
        }
      }
    } else if (
      entry?.type === "user" &&
      Array.isArray(entry.message?.content)
    ) {
      for (const block of entry.message.content) {
        if (
          block?.type === "tool_result" &&
          invocations.delete(block.tool_use_id) &&
          directSelectionFromResponse(block.content)?.scope === "session"
        ) {
          consumption -= 1;
        }
      }
    } else if (
      entry?.type === "attachment" &&
      entry.attachment?.type === "hook_additional_context" &&
      entry.attachment.hookEvent === "UserPromptSubmit"
    ) {
      const context = [entry.attachment.content].flat().join("\n");
      if (context.includes("Remembrance auto-query context")) consumption += 1;
      if (TASK_ELIGIBILITY_CONTEXT.test(context)) eligibility += 1;
    } else if (entry?.type === "assistant.message") {
      lastMessageText =
        typeof entry.data?.content === "string" ? [entry.data.content] : [];
    } else if (entry?.type === "tool.execution_start") {
      const tool = registryConsumptionTool(entry.data?.toolName);
      if (tool && tool !== "invoke_skill") consumption += 1;
    }
  }
  return {
    consumption,
    eligibility,
    lastAssistantMessage: lastMessageText.join("\n"),
  };
}

// Pure decision function (unit-tested): returns whether to allow the stop, and
// the block reason when it should prompt. Prompts when registry consumption has
// INCREASED since the last prompt this session — so it fires on the first use
// and again on each later distinct use, but never nags when nothing new was
// consumed and never re-fires just because the agent contributed.
// `readTranscript` / `readCount` are injectable so tests don't touch the FS.
// The transcript is read only when the decision needs it.
export function decideContribution(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = agentLedgerIdFor(input);
  const read = options.readTranscript ?? readTranscriptSafe;
  let evidence;
  // A subagent's own calls are in its transcript; transcript_path names the
  // parent's.
  const transcriptPath =
    input?.hook_event_name === "SubagentStop"
      ? input?.agent_transcript_path
      : input?.transcript_path;
  const transcript = () =>
    (evidence ??= transcriptEvidence(read(transcriptPath)));
  const readUse = options.readUseCount ?? readRegistryUseCount;
  const readEligibility =
    options.readEligibilityCount ?? readTaskEligibilityCount;
  const readCount =
    options.readCount ??
    ((id) => Math.max(readPromptedCount(id), readSharedPromptedCount(id, env)));
  const decision = decideStop(
    {
      session_id: input?.session_id ?? "unknown",
      agent_id: input?.agent_id,
      hook_event_name: input?.hook_event_name,
      stop_hook_active: input?.stop_hook_active,
      // Alert and lesson detection must see only the final answer. Current
      // hosts send it; older ones leave it to the transcript.
      last_assistant_message:
        typeof input?.last_assistant_message === "string"
          ? input.last_assistant_message
          : transcript().lastAssistantMessage,
    },
    {
      env,
      readUseCount: () =>
        Math.max(transcript().consumption, readUse(sessionId, env)),
      readEligibilityCount: () =>
        Math.max(transcript().eligibility, readEligibility(sessionId, env)),
      readPromptedCount: () => readCount(sessionId),
      readCompletionObligations: options.readCompletionObligations,
      readHighMatch: options.readHighMatch,
      readDirectSelections:
        options.readDirectSelections ?? readDirectSelectionSurfaces,
    },
  );
  return decision.allow
    ? { allow: true, why: decision.why }
    : {
        allow: false,
        why: decision.why,
        reason: decision.reason,
        consumption: decision.useCount,
        obligationIds: decision.obligationIds ?? [],
      };
}

export async function handleStopHook(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = input?.session_id ?? "unknown";
  const subagent = input?.hook_event_name === "SubagentStop";
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "vs_code",
      component: "completion_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  if (input?.hook_event_name === "SubagentStart") {
    recordSubagentStart(input, env);
    return { allow: true, why: "subagent_started" };
  }
  // A subagent that an API error ends fires StopFailure instead of
  // SubagentStop, and the host ignores this hook's output. Its unpaid debts
  // still move to the parent; nothing is asked or reported.
  if (input?.hook_event_name === "StopFailure") {
    transferSubagentObligations(input, env);
    return { allow: true, why: "stop_failure" };
  }
  // Task outcomes stay session-scoped; the parent's stop reports them.
  if (!subagent) {
    await (options.reportTaskOutcomes ?? reportTaskOutcomesOnStop)(
      sessionId,
      input,
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: "@remembrance/vscode-plugin",
      },
    );
  }
  const decision = decideContribution(input, options);
  if (decision.allow) {
    transferSubagentObligations(input, env);
    return { allow: true, why: decision.why };
  }
  const ledgerId = agentLedgerIdFor(input);
  const writeCount = options.writeCount ?? writePromptedCount;
  writeCount(ledgerId, decision.consumption);
  const markObligations =
    options.markCompletionObligationsPrompted ??
    markCompletionObligationsPrompted;
  markObligations(ledgerId, decision.obligationIds, env, decision.consumption);
  const markDirectSelections =
    options.markDirectSelectionsPrompted ?? markDirectSelectionSurfacesPrompted;
  markDirectSelections(ledgerId, decision.consumption, env);
  return {
    allow: false,
    why: decision.why,
    output: {
      decision: "block",
      // The host keeps the answer that triggered this Stop on screen; a
      // subagent's report must still reach its caller after the cleanup.
      reason: completionContinuationReason(
        decision.reason,
        input,
        env,
        subagent ? { subagent: true } : { answerShown: true },
      ),
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

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed input → allow the stop.
    return;
  }
  let result;
  try {
    result = await handleStopHook(input);
  } catch {
    // Fail open.
    return;
  }
  if (result && result.allow === false && result.output) {
    process.stdout.write(JSON.stringify(result.output));
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(() => {
    // Never block a stop on an unexpected error.
  });
}
