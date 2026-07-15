#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  clearHighMatchSurfaceIfOpened,
  recordDirectiveFollowThroughForTool,
  recordValueEpisodeSurface,
  sessionIdFor,
  valueEpisodeFromResponse,
} from "./hook-core.mjs";

export async function handlePostToolUse(input, options = {}) {
  if (toolFailed(input)) return { cleared: false, why: "tool_failed" };
  const env = options.env ?? process.env;
  const name = toolName(input);
  if (String(name).toLowerCase().endsWith("query_skills")) {
    const recordFollowThrough =
      options.recordDirectiveFollowThrough ??
      recordDirectiveFollowThroughForTool;
    const followed = await recordFollowThrough(
      sessionIdFor(input),
      name,
      toolResponse(input),
      {
        env,
        fetchImpl: options.fetchImpl ?? fetch,
        userAgent: options.userAgent,
      },
    );
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(
      sessionIdFor(input),
      valueEpisodeFromResponse(toolResponse(input)),
      env,
    );
    return {
      cleared: false,
      directive_followed: followed,
      why: followed ? "directive_followed" : "no_current_directive",
    };
  }
  const clear =
    options.clearHighMatchSurfaceIfOpened ?? clearHighMatchSurfaceIfOpened;
  const cleared = clear(sessionIdFor(input), name, toolArguments(input), env);
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
    input?.error ??
    input?.is_error ??
    input?.isError ??
    input?.tool_response?.isError ??
    input?.toolResponse?.isError,
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
