#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  directSelectionFromResponse,
  highMatchFromResponse,
  markCurrentEngagementHandled,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionSurface,
  recordHighMatchSurface,
  recordRegistryUse,
  recordValueEpisodeSurface,
  responseRequestsRemembranceFollowup,
  sessionIdFor,
  toolResponseIndicatesFailure,
  valueEpisodeFromResponse,
} from "./hook-core.mjs";

const CONTRIBUTION_TOOLS = [
  "submit_query_feedback",
  "submit_feedback",
  "submit_remembrance",
  "propose_skill_idea",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
];

export async function handlePostToolUse(input, options = {}) {
  if (toolFailed(input)) return { cleared: false, why: "tool_failed" };
  const env = options.env ?? process.env;
  const name = toolName(input);
  const normalizedName = String(name).toLowerCase();
  const sessionId = sessionIdFor(input);
  if (normalizedName.endsWith("query_skills")) {
    const response = toolResponse(input);
    const recordUse = options.recordRegistryUse ?? recordRegistryUse;
    recordUse(sessionId, env);
    const recordHighMatch =
      options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(sessionId, highMatchFromResponse(response), env);
    const recordFollowThrough =
      options.recordDirectiveFollowThrough ??
      recordDirectiveFollowThroughForTool;
    const followed = await recordFollowThrough(
      sessionId,
      name,
      response,
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: options.userAgent,
      },
    );
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(
      sessionId,
      valueEpisodeFromResponse(response),
      env,
    );
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
    const recordUse = options.recordRegistryUse ?? recordRegistryUse;
    const useCount = recordUse(sessionId, env);
    const recordSelection =
      options.recordDirectSelection ?? recordDirectSelectionSurface;
    recordSelection(sessionId, { ...selection, use_count: useCount }, env);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(
      sessionId,
      valueEpisodeFromResponse(toolResponse(input)),
      env,
    );
    const clearExplicit =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    const cleared = clearExplicit(sessionId, selection.slug, env);
    return {
      recorded: true,
      cleared,
      why: "direct_skill_invoked",
      count: useCount,
    };
  }
  if (CONTRIBUTION_TOOLS.some((tool) => normalizedName.endsWith(tool))) {
    if (
      normalizedName.endsWith("submit_feedback") &&
      responseRequestsRemembranceFollowup(toolResponse(input))
    ) {
      return {
        recorded: false,
        cleared: false,
        why: "remembrance_followup_pending",
      };
    }
    const markHandled =
      options.markCurrentEngagementHandled ?? markCurrentEngagementHandled;
    const count = markHandled(sessionId, env);
    return {
      recorded: count > 0,
      cleared: false,
      why: "contribution_handled",
      count,
    };
  }
  const clear =
    options.clearHighMatchSurfaceIfOpened ?? clearHighMatchSurfaceIfOpened;
  const cleared = clear(sessionId, name, toolArguments(input), env);
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
