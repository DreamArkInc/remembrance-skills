#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  agentLedgerIdFor,
  bindPrivateSkillNativeCapture,
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  directSelectionFromResponse,
  highMatchFromResponse,
  observeSuccessfulCompletionTool,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionUse,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordRegistryUse,
  queryResponseHasMatches,
  recordValueEpisodeSurface,
  responseRequestsRemembranceFollowup,
  resolveApiCredential,
  sessionIdFor,
  toolResponseIndicatesFailure,
  valueEpisodeFromResponse,
} from "./hook-core.mjs";

const CONTRIBUTION_TOOLS = [
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
];
const PREFERENCE_EVIDENCE_TOOLS = ["submit_preference_compatibility_feedback"];

export async function handlePostToolUse(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFor(input);
  // Debts and usage belong to the agent that made the call; health, directive
  // follow-through and task outcomes stay with the session.
  const ledgerId = agentLedgerIdFor(input);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "claude_code",
      component: "tool_observer",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  if (toolFailed(input)) return { cleared: false, why: "tool_failed" };
  const name = toolName(input);
  const normalizedName = String(name).toLowerCase();
  if (normalizedName.endsWith("query_skills")) {
    const response = toolResponse(input);
    if (queryResponseHasMatches(response)) {
      const recordUse = options.recordRegistryUse ?? recordRegistryUse;
      recordUse(ledgerId, env);
    }
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(ledgerId, name, toolArguments(input), response, env);
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(ledgerId, highMatchFromResponse(response), env);
    const recordFollowThrough =
      options.recordDirectiveFollowThrough ??
      recordDirectiveFollowThroughForTool;
    const followed = await recordFollowThrough(sessionId, name, response, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      userAgent: options.userAgent,
    });
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    return {
      cleared: false,
      directive_followed: followed,
      why: followed ? "directive_followed" : "no_current_directive",
    };
  }
  if (normalizedName.endsWith("invoke_skill")) {
    const selection = directSelectionFromResponse(toolResponse(input));
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
    recordValueEpisode(
      sessionId,
      valueEpisodeFromResponse(toolResponse(input)),
      env,
    );
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(ledgerId, name, toolArguments(input), toolResponse(input), env);
    const clearExplicit =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    const cleared = clearExplicit(ledgerId, selection.slug, env);
    return {
      recorded: true,
      cleared,
      why: "direct_skill_invoked",
      count: useCount,
    };
  }
  if (PREFERENCE_EVIDENCE_TOOLS.some((tool) => normalizedName.endsWith(tool))) {
    return {
      recorded: true,
      cleared: false,
      why: "preference_compatibility_feedback_recorded",
    };
  }
  if (normalizedName.endsWith("prepare_private_lesson_candidate")) {
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      ledgerId,
      name,
      toolArguments(input),
      toolResponse(input),
      env,
    );
    return {
      recorded: observation.opened.length > 0,
      cleared: false,
      why: "private_lesson_prepared",
    };
  }
  if (CONTRIBUTION_TOOLS.some((tool) => normalizedName.endsWith(tool))) {
    await bindPrivateSkillNativeCapture(
      name,
      toolArguments(input),
      toolResponse(input),
      {
        env,
        nativeContextBridge: options.nativeContextBridge,
        nativeSessionId: input?.session_id,
      },
    );
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      ledgerId,
      name,
      toolArguments(input),
      toolResponse(input),
      env,
    );
    if (responseRequestsRemembranceFollowup(toolResponse(input))) {
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
  const clear =
    options.clearHighMatchSurfaceIfOpened ?? clearHighMatchSurfaceIfOpened;
  const cleared = clear(ledgerId, name, toolArguments(input), env);
  if (
    normalizedName.endsWith("get_skill") ||
    normalizedName.endsWith("get_resource")
  ) {
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(ledgerId, name, toolArguments(input), toolResponse(input), env);
  }
  return {
    cleared,
    why: cleared ? "matched_detail_open" : "not_current_match",
  };
}

function toolResponse(input) {
  return (
    input?.tool_response ??
    input?.toolResponse ??
    input?.result ??
    input?.output ??
    input?.response ??
    null
  );
}

function toolName(input) {
  return (
    input?.tool_name ??
    input?.toolName ??
    input?.name ??
    input?.tool?.name ??
    ""
  );
}

function toolArguments(input) {
  const value =
    input?.tool_input ??
    input?.toolInput ??
    input?.arguments ??
    input?.args ??
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

function toolFailed(input) {
  return Boolean(
    input?.error ||
    input?.is_error ||
    input?.isError ||
    input?.tool_response?.isError ||
    input?.toolResponse?.isError ||
    toolResponseIndicatesFailure(toolResponse(input)),
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    await handlePostToolUse(raw.trim() ? JSON.parse(raw) : {});
  } catch {
    // Observation only. Never affect the completed tool call.
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
