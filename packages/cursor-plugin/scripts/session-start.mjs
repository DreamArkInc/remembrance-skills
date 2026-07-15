#!/usr/bin/env node
// Cursor sessionStart adapter.
//
// Cursor plugins cannot inject prompt-specific context from beforeSubmitPrompt;
// Cursor's documented injection point is sessionStart.additional_context, and
// the plugin's always-apply rule handles per-task behavior. This hook gives the
// agent one compact reminder that the plugin's MCP server is available.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { disabled } from "./hook-core.mjs";

export const CURSOR_REMEMBRANCE_CONTEXT = [
  "Remembrance is installed in Cursor.",
  "Before reusable service/API/tool/workflow/UI/review tasks, call the Remembrance MCP tool query_skills, then use get_skill/get_resource when a result fits.",
  "For short follow-ups such as 'fix these issues', 'continue', or 'try again', infer the concrete task from the full conversation and still query before acting; do not wait for the current prompt to repeat trigger keywords.",
  "After using Remembrance guidance, submit redacted feedback, a remembrance, a suggestion, a resource review, or a missing-skill idea when something reusable was learned.",
  "Before finishing a reusable task, self-check for a missed query and for user-caught, CI/deploy, security, or release lessons even when no skill was used.",
  "Do not paste secrets, private URLs, credentials, raw logs, or proprietary code into Remembrance; use summaries, hashes, and reproduction detail.",
].join("\n");

export function handleSessionStart(input, options = {}) {
  const env = options.env ?? process.env;
  void input;
  if (disabled(env.REMEMBRANCE_CURSOR_SESSION_CONTEXT)) {
    return {};
  }
  return { additional_context: CURSOR_REMEMBRANCE_CONTEXT };
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
  } catch {
    input = {};
  }
  process.stdout.write(`${JSON.stringify(handleSessionStart(input))}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Fail open. Session context is helpful, not required.
  });
}
