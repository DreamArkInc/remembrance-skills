#!/usr/bin/env node
// Cursor beforeSubmitPrompt observer.
//
// Cursor does not let this hook inject agent context, so the always-apply rule
// remains the consumption instruction. This observer records that a reusable
// task (including a context-dependent follow-up) occurred. The Stop hook can
// then recover when the agent ignored the rule and never called query_skills.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createContinuationDirective,
  disabled,
  isContextualContinuationPrompt,
  recordDirectiveSurface,
  recordTaskEligibility,
  shouldQueryPrompt,
} from "./hook-core.mjs";
import { cursorSessionId } from "./record-mcp-use.mjs";

export function promptFromCursorInput(input) {
  return String(
    input?.prompt ??
      input?.user_prompt ??
      input?.userPrompt ??
      input?.input?.prompt ??
      input?.message ??
      "",
  );
}

export async function handlePromptEligibility(input, options = {}) {
  const env = options.env ?? process.env;
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    return { eligible: false, reason: "disabled" };
  }
  const prompt = promptFromCursorInput(input);
  const decision = shouldQueryPrompt(prompt);
  const continuation = isContextualContinuationPrompt(prompt);
  if (!decision.likely_match && !continuation) {
    return { eligible: false, reason: decision.reason };
  }
  const sessionId = cursorSessionId(input, env);
  const record = options.recordEligibility ?? recordTaskEligibility;
  record(sessionId, env);
  const reason = continuation ? "contextual_continuation" : decision.reason;
  const directive = await createContinuationDirective({
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: "cursor",
    triggerReason: reason,
    userAgent: "@remembrance/cursor-plugin",
  });
  const recordDirective = options.recordDirective ?? recordDirectiveSurface;
  recordDirective(sessionId, directive, env);
  return {
    eligible: true,
    reason,
    directive_id: directive.directive_id,
    sessionId,
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
  try {
    const raw = await readStdin();
    await handlePromptEligibility(raw.trim() ? JSON.parse(raw) : {});
  } catch {
    // Fail open; this observer must never block the user's prompt.
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Never fail a Cursor prompt because eligibility recording failed.
  });
}
