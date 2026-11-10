#!/usr/bin/env node
// Cursor afterMCPExecution adapter.
//
// Cursor's stop hook payload does not include a transcript. Record registry
// consumption when the Remembrance MCP tools are used, and mark the current use
// count as already handled when the agent contributes before stopping. Cursor
// hands the result over as `result_json`, a JSON string (`tool_output` in
// postToolUse). This module also keeps the conversation's preference
// snapshot state, which the sessionStart, postToolUse and preCompact hooks
// share.

import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  bindPrivateSkillNativeCapture,
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  directSelectionFromResponse,
  highMatchFromResponse,
  observeSuccessfulCompletionTool,
  parsePreferenceSnapshotHeader,
  preferenceContextIdFromToken,
  projectPreferenceSnapshot,
  readHookStateFile,
  readRegistryUseCount,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionUse,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordHostPolicyDenial,
  recordRegistryUse,
  recordValueEpisodeSurface,
  queryResponseHasMatches,
  responseRequestsRemembranceFollowup,
  resolveApiCredential,
  toolResponseIndicatesFailure,
  valueEpisodeFromResponse,
  writeHookStateFile,
} from "./hook-core.mjs";

const CONSUMPTION_TOOLS = new Set([
  "query_skills",
  "get_skill",
  "get_resource",
]);
const CONTRIBUTION_TOOLS = new Set([
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
const PREFERENCE_EVIDENCE_TOOLS = new Set([
  "submit_preference_compatibility_feedback",
]);

export function cursorSessionId(input, env = process.env) {
  return String(
    input?.conversation_id ??
      input?.session_id ??
      input?.generation_id ??
      input?.input?.conversation_id ??
      input?.input?.session_id ??
      env.CURSOR_TRANSCRIPT_PATH ??
      env.CURSOR_PROJECT_DIR ??
      "cursor",
  );
}

export function cursorNativeSessionId(input) {
  return (
    input?.conversation_id ??
    input?.session_id ??
    input?.input?.conversation_id ??
    input?.input?.session_id ??
    null
  );
}

// The workspace a hook reads project preferences for, as the prompt hook's
// preference writes name it; Cursor runs plugin hooks from the plugin's
// install directory, never from the workspace.
function cursorProjectPath(input) {
  return (
    input?.workspace_roots?.[0] ?? input?.workspaceRoot ?? input?.cwd ?? null
  );
}

// Node start, a session warm-up (1.2 s at most) and this read fit Cursor's
// 5-second hook timeout.
const CURSOR_PREFERENCE_READ_TIMEOUT_MS = 2_500;

// The hooks' project-context snapshot: the workspace's project key only,
// never task entries; renderer input, or null without an organization key
// or with REMEMBRANCE_AUTO_QUERY=0.
export function readCursorProjectSnapshot(input, { env, fetchImpl }) {
  return projectPreferenceSnapshot({
    runtime: "cursor",
    env,
    fetchImpl,
    projectPath: cursorProjectPath(input),
    userAgent: "@remembrance/cursor-plugin",
    deadline: Date.now() + CURSOR_PREFERENCE_READ_TIMEOUT_MS,
  });
}

// --- The conversation's preference snapshot (DESIGN 4.6) ---------------------
//
// Per conversation: `delivered`, the digest and context id of the last
// complete or unchanged project-context snapshot the conversation received
// (from sessionStart, a postToolUse injection or an MCP result); `latest`,
// those of the hooks' own latest project-context read; `compacted`, set by
// preCompact; and `last_refresh_at`, the time of the latest read.

function preferenceStateName(sessionId) {
  const ledger = createHash("sha256")
    .update(String(sessionId))
    .digest("hex")
    .slice(0, 16);
  return `${ledger}.cursor-preferences.json`;
}

// A profile digest and the context id of its token. A read without a token
// has the context id "unknown": comparable with the hooks' own reads of
// their one context, never with an MCP result.
function snapshotRef(value) {
  return /^pd1_[0-9a-f]{16}$/.test(value?.digest ?? "") &&
    /^(?:[0-9a-f]{8}|unknown)$/.test(value?.context_id ?? "")
    ? { digest: value.digest, context_id: value.context_id }
    : null;
}

export function sameSnapshot(a, b) {
  return a?.digest === b?.digest && a?.context_id === b?.context_id;
}

export function readCursorPreferenceState(sessionId, env = process.env) {
  const stored = readHookStateFile(preferenceStateName(sessionId), { env });
  return {
    delivered: snapshotRef(stored?.delivered),
    latest: snapshotRef(stored?.latest),
    compacted: stored?.compacted === true,
    last_refresh_at: Number.isFinite(stored?.last_refresh_at)
      ? stored.last_refresh_at
      : null,
  };
}

export function updateCursorPreferenceState(
  sessionId,
  change,
  env = process.env,
) {
  return writeHookStateFile(
    preferenceStateName(sessionId),
    { ...readCursorPreferenceState(sessionId, env), ...change },
    { env },
  );
}

// The digest and context id of a live project-context read; null for a
// failed read, a cached copy (freshness unverified) or an older server.
export function projectSnapshotRef(snapshot) {
  if (
    snapshot?.reasons?.some((reason) => reason?.code === "freshness_unverified")
  ) {
    return null;
  }
  return snapshotRef({
    digest: snapshot?.digest,
    context_id: preferenceContextIdFromToken(snapshot?.pageToken ?? null),
  });
}

// The digest, context id and status of a snapshot text, or null when its
// header names no digest (a failed read, an older server).
export function preferenceSnapshotRef(text) {
  const header =
    typeof text === "string" ? parsePreferenceSnapshotHeader(text) : null;
  const ref =
    header &&
    snapshotRef({ digest: header.digest, context_id: header.contextId });
  return ref ? { ...ref, status: header.status } : null;
}

// A get_effective_preferences result counts as delivered only for the hooks'
// own project context (equal context ids) and only when complete or
// unchanged. A query_skills or invoke_skill snapshot, or one from a server
// that derived another project key, describes another context and changes
// nothing.
export function observePreferenceSnapshot(sessionId, input, env = process.env) {
  if (toolName(input) !== "get_effective_preferences") return false;
  const response = mcpResponseFromHook(input);
  const body =
    response?.body && typeof response.body === "object"
      ? response.body
      : response;
  const ref = preferenceSnapshotRef(body?.preferences);
  if (
    !ref ||
    ref.status === "incomplete" ||
    ref.context_id === "unknown" ||
    ref.context_id !==
      readCursorPreferenceState(sessionId, env).latest?.context_id
  ) {
    return false;
  }
  return updateCursorPreferenceState(
    sessionId,
    { delivered: { digest: ref.digest, context_id: ref.context_id } },
    env,
  );
}

function toolName(input) {
  const raw =
    input?.tool_name ??
    input?.toolName ??
    input?.name ??
    input?.tool?.name ??
    "";
  const value = String(raw).trim();
  for (const prefix of [
    "mcp__remembrance",
    "mcp__plugin_remembrance_remembrance",
  ]) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length).replace(/^__/, "");
    }
  }
  if (value.includes("__")) {
    const pieces = value.split("__").filter(Boolean);
    return pieces[pieces.length - 1] ?? value;
  }
  const pieces = value.split(/[.:/]/);
  return pieces[pieces.length - 1] ?? value;
}

export async function handleMcpUse(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = cursorSessionId(input, env);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "cursor",
      component: "tool_observer",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  const tool = toolName(input);
  if (toolFailed(input)) {
    const recordDenial =
      options.recordHostPolicyDenial ?? recordHostPolicyDenial;
    recordDenial(
      {
        surface: "cursor",
        sessionId,
        eventType: "afterMCPExecution",
        toolName: tool,
        value: input,
      },
      env,
    );
    return { recorded: false, kind: "failed", tool };
  }
  observePreferenceSnapshot(sessionId, input, env);
  if (tool === "invoke_skill") {
    const response = mcpResponseFromHook(input);
    const selection = directSelectionFromResponse(response);
    if (!selection) {
      return { recorded: false, kind: "failed", tool };
    }
    const count = recordDirectSelectionUse(sessionId, selection, env, options);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const clearHighMatch =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    clearHighMatch(sessionId, selection.slug, env);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(sessionId, tool, toolArguments(input), response, env);
    return { recorded: true, kind: "direct_selection", tool, count };
  }
  if (CONSUMPTION_TOOLS.has(tool)) {
    if (tool === "query_skills") {
      const response = mcpResponseFromHook(input);
      const matched = queryResponseHasMatches(response);
      const count = matched
        ? (options.recordRegistryUse ?? recordRegistryUse)(sessionId, env)
        : readRegistryUseCount(sessionId, env);
      const observe =
        options.observeCompletionTool ?? observeSuccessfulCompletionTool;
      observe(sessionId, tool, toolArguments(input), response, env);
      const recordFollowThrough =
        options.recordDirectiveFollowThrough ??
        recordDirectiveFollowThroughForTool;
      await recordFollowThrough(sessionId, tool, response, {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: "@remembrance/cursor-plugin",
      });
      const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
      recordHighMatch(sessionId, highMatchFromResponse(response), env);
      const recordValueEpisode =
        options.recordValueEpisode ?? recordValueEpisodeSurface;
      recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
      return {
        recorded: matched,
        kind: matched ? "consumption" : "empty_query",
        tool,
        count,
      };
    } else {
      const record = options.recordRegistryUse ?? recordRegistryUse;
      const count = record(sessionId, env);
      const clearHighMatch =
        options.clearHighMatch ?? clearHighMatchSurfaceIfOpened;
      clearHighMatch(
        sessionId,
        `remembrance.${tool}`,
        toolArguments(input),
        env,
      );
      const observe =
        options.observeCompletionTool ?? observeSuccessfulCompletionTool;
      observe(
        sessionId,
        tool,
        toolArguments(input),
        mcpResponseFromHook(input),
        env,
      );
      return { recorded: true, kind: "consumption", tool, count };
    }
  }
  if (PREFERENCE_EVIDENCE_TOOLS.has(tool)) {
    return {
      recorded: true,
      kind: "preference_compatibility_feedback",
      tool,
    };
  }
  if (
    tool === "prepare_private_lesson_candidate" ||
    tool === "capture_learning"
  ) {
    await bindPrivateSkillNativeCapture(
      tool,
      toolArguments(input),
      mcpResponseFromHook(input),
      {
        env,
        nativeContextBridge: options.nativeContextBridge,
        nativeSessionId: cursorNativeSessionId(input),
      },
    );
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      sessionId,
      tool,
      toolArguments(input),
      mcpResponseFromHook(input),
      env,
    );
    return {
      recorded: observation.opened.length > 0,
      kind:
        tool === "capture_learning"
          ? "private_learning_captured"
          : "private_lesson_prepared",
      tool,
    };
  }
  if (CONTRIBUTION_TOOLS.has(tool)) {
    const response = mcpResponseFromHook(input);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      sessionId,
      tool,
      toolArguments(input),
      response,
      env,
    );
    if (responseRequestsRemembranceFollowup(response)) {
      return {
        recorded: true,
        kind: "remembrance_followup_pending",
        tool,
      };
    }
    return {
      recorded: true,
      kind:
        observation.pending.length > 0
          ? "contribution_recorded_pending"
          : "contribution",
      tool,
      count: observation.handled_count,
    };
  }
  return { recorded: false, kind: "ignored", tool };
}

function toolArguments(input) {
  const value =
    input?.arguments ??
    input?.args ??
    input?.tool_input ??
    input?.toolInput ??
    input?.params ??
    input?.tool?.input ??
    {};
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// The MCP result a hook input carries. Cursor documents `result_json` for
// afterMCPExecution and `tool_output` for postToolUse, each a JSON string
// of the tool's result; an MCP tools/call result yields its JSON text.
function mcpResponseFromHook(input) {
  for (let value of [
    input?.result,
    input?.output,
    input?.tool_result,
    input?.toolResult,
    input?.response,
    input?.result_json,
    input?.tool_output,
  ]) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    if (!value || typeof value !== "object") continue;
    if (value.body) return value;
    const text = Array.isArray(value.content)
      ? value.content.find((item) => item?.type === "text")?.text
      : null;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        continue;
      }
    }
    return value;
  }
  return null;
}

function toolFailed(input) {
  return Boolean(
    input?.error ||
    input?.is_error ||
    input?.isError ||
    input?.result?.isError ||
    input?.output?.isError ||
    input?.tool_result?.isError ||
    input?.toolResult?.isError ||
    toolResponseIndicatesFailure(mcpResponseFromHook(input)),
  );
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
    input = raw.trim() ? JSON.parse(raw) : {};
    await handleMcpUse(input);
  } catch {
    // Fail open; afterMCPExecution is observational.
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Never fail an MCP call because the recorder failed.
  });
}
