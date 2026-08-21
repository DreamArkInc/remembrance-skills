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
  recordExplicitPreferenceObservations,
  recordPluginLifecycleHealth,
  recordTaskEligibility,
  redactPrompt,
  resolveApiCredential,
  promptContainsUserCorrection,
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
  const sessionId = cursorSessionId(input, env);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "cursor",
      component: "prompt_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  if (disabled(env.REMEMBRANCE_AUTO_QUERY)) {
    return { eligible: false, reason: "disabled" };
  }
  const prompt = promptFromCursorInput(input);
  const redacted = redactPrompt(prompt);
  const recordPreferences =
    options.recordPreferences ?? recordExplicitPreferenceObservations;
  await recordPreferences(redacted, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    runtime: "cursor",
    userAgent: "@remembrance/cursor-plugin",
    projectPath:
      options.projectPath ??
      input?.workspace_roots?.[0] ??
      input?.workspaceRoot ??
      input?.cwd ??
      null,
  }).catch(() => 0);
  const decision = shouldQueryPrompt(redacted);
  const continuation = isContextualContinuationPrompt(redacted);
  const correction = promptContainsUserCorrection(redacted);
  if (!decision.likely_match && !continuation && !correction) {
    return { eligible: false, reason: decision.reason };
  }
  const record = options.recordEligibility ?? recordTaskEligibility;
  record(sessionId, env);
  if (correction && !decision.likely_match && !continuation) {
    return {
      eligible: true,
      reason: "user_correction",
      directive_id: null,
      sessionId,
    };
  }
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

/* c8 ignore start -- exercised by the packaged Cursor host smoke; the
 * behavior-bearing handler above has the unit coverage gate. */
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
/* c8 ignore stop */
