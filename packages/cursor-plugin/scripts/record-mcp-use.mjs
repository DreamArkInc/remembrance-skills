#!/usr/bin/env node
// Cursor afterMCPExecution adapter.
//
// Cursor's stop hook payload does not include a transcript. Record registry
// consumption when the Remembrance MCP tools are used, and mark the current use
// count as already handled when the agent contributes before stopping.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  readRegistryUseCount,
  recordRegistryUse,
  writePromptedCount,
} from "./hook-core.mjs";

const CONSUMPTION_TOOLS = new Set(["query_skills", "get_skill", "get_resource"]);
const CONTRIBUTION_TOOLS = new Set([
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

export function handleMcpUse(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = cursorSessionId(input, env);
  const tool = toolName(input);
  if (CONSUMPTION_TOOLS.has(tool)) {
    const record = options.recordRegistryUse ?? recordRegistryUse;
    const count = record(sessionId, env);
    return { recorded: true, kind: "consumption", tool, count };
  }
  if (CONTRIBUTION_TOOLS.has(tool)) {
    const readUse = options.readRegistryUseCount ?? readRegistryUseCount;
    const writePrompted = options.writePromptedCount ?? writePromptedCount;
    const count = readUse(sessionId, env);
    if (count > 0) {
      writePrompted(sessionId, count, env);
    }
    return { recorded: count > 0, kind: "contribution", tool, count };
  }
  return { recorded: false, kind: "ignored", tool };
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
    handleMcpUse(input);
  } catch {
    // Fail open; afterMCPExecution is observational.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never fail an MCP call because the recorder failed.
  });
}
