#!/usr/bin/env node
// Cursor afterMCPExecution adapter.
//
// Cursor's stop hook payload does not include a transcript. Record registry
// consumption when the Remembrance MCP tools are used, and mark the current use
// count as already handled when the agent contributes before stopping.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  directSelectionFromResponse,
  highMatchFromResponse,
  readRegistryUseCount,
  readTaskEligibilityCount,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionSurface,
  recordHighMatchSurface,
  recordRegistryUse,
  recordValueEpisodeSurface,
  responseRequestsRemembranceFollowup,
  toolResponseIndicatesFailure,
  valueEpisodeFromResponse,
  writePromptedCount,
} from "./hook-core.mjs";

const CONSUMPTION_TOOLS = new Set([
  "query_skills",
  "get_skill",
  "get_resource",
]);
const CONTRIBUTION_TOOLS = new Set([
  "submit_query_feedback",
  "submit_feedback",
  "submit_remembrance",
  "propose_skill_idea",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
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

function toolName(input) {
  const raw =
    input?.tool_name ??
    input?.toolName ??
    input?.name ??
    input?.tool?.name ??
    "";
  const value = String(raw).trim();
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
  const tool = toolName(input);
  if (toolFailed(input)) {
    return { recorded: false, kind: "failed", tool };
  }
  if (tool === "invoke_skill") {
    const response = mcpResponseFromHook(input);
    const selection = directSelectionFromResponse(response);
    if (!selection) {
      return { recorded: false, kind: "failed", tool };
    }
    const record = options.recordRegistryUse ?? recordRegistryUse;
    const count = record(sessionId, env);
    const recordSelection =
      options.recordDirectSelection ?? recordDirectSelectionSurface;
    recordSelection(sessionId, { ...selection, use_count: count }, env);
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const clearHighMatch =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    clearHighMatch(sessionId, selection.slug, env);
    return { recorded: true, kind: "direct_selection", tool, count };
  }
  if (CONSUMPTION_TOOLS.has(tool)) {
    const record = options.recordRegistryUse ?? recordRegistryUse;
    const count = record(sessionId, env);
    if (tool === "query_skills") {
      const recordFollowThrough =
        options.recordDirectiveFollowThrough ??
        recordDirectiveFollowThroughForTool;
      await recordFollowThrough(sessionId, tool, mcpResponseFromHook(input), {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: "@remembrance/cursor-plugin",
      });
      const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
      recordHighMatch(
        sessionId,
        highMatchFromResponse(mcpResponseFromHook(input)),
        env,
      );
      const recordValueEpisode =
        options.recordValueEpisode ?? recordValueEpisodeSurface;
      recordValueEpisode(
        sessionId,
        valueEpisodeFromResponse(mcpResponseFromHook(input)),
        env,
      );
    } else {
      const clearHighMatch =
        options.clearHighMatch ?? clearHighMatchSurfaceIfOpened;
      clearHighMatch(
        sessionId,
        `remembrance.${tool}`,
        toolArguments(input),
        env,
      );
    }
    return { recorded: true, kind: "consumption", tool, count };
  }
  if (CONTRIBUTION_TOOLS.has(tool)) {
    if (
      tool === "submit_feedback" &&
      responseRequestsRemembranceFollowup(mcpResponseFromHook(input))
    ) {
      return {
        recorded: false,
        kind: "remembrance_followup_pending",
        tool,
      };
    }
    const readUse = options.readRegistryUseCount ?? readRegistryUseCount;
    const readEligibility =
      options.readTaskEligibilityCount ?? readTaskEligibilityCount;
    const writePrompted = options.writePromptedCount ?? writePromptedCount;
    const count = Math.max(
      readUse(sessionId, env),
      readEligibility(sessionId, env),
    );
    if (count > 0) {
      writePrompted(sessionId, count, env);
    }
    return { recorded: count > 0, kind: "contribution", tool, count };
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

function mcpResponseFromHook(input) {
  for (const value of [
    input?.result,
    input?.output,
    input?.tool_result,
    input?.toolResult,
    input?.response,
  ]) {
    if (!value) continue;
    if (typeof value === "object") {
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
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        continue;
      }
    }
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
