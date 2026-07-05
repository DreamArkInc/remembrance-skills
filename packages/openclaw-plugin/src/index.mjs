#!/usr/bin/env node
// Remembrance OpenClaw plugin entrypoint.
//
// OpenClaw plugins are IN-PROCESS JS modules, not stdin/stdout scripts: the
// plugin's default export is a definition object whose `register(api)` is called
// once at load, and it wires event handlers with `api.on(name, handler, opts?)`.
// Handlers are `async (event) => ...` and run sequentially in descending
// priority order; `event.context` (aka ctx) carries sessionId/runId/pluginConfig.
// (See docs.openclaw.ai/plugins/hooks and /plugins/sdk-entrypoints.)
//
// This entrypoint ports the two Remembrance hooks the Claude/Codex plugins ship:
//
//   PRE-prompt  (before_prompt_build): matches the user's prompt via the shared
//     heuristic, queries Remembrance, and injects the matching skills/resources
//     as extra system context (appendSystemContext). On a real hit it records a
//     per-session usage marker so the completion hook can tell the registry was
//     used. Respects REMEMBRANCE_AUTO_QUERY=0. Fail-open: any error injects
//     nothing.
//
//   COMPLETION  (before_agent_finalize): when the session actually used
//     Remembrance and hasn't been nudged for this use yet, it asks the agent to
//     revise once and contribute what it learned (a remembrance / feedback /
//     skill idea). Records the prompted count so it fires at most once per
//     distinct use. Respects REMEMBRANCE_AUTO_CONTRIBUTE=0. Loop-safe and
//     fail-open: any error finalizes normally.
//
// All decision/query/format logic lives in hook-core.mjs (Node-builtins-only,
// runtime-agnostic, copied verbatim from packages/codex-plugin). This module is
// only the OpenClaw adapter: it reads the OpenClaw event shape, calls the core,
// and returns the OpenClaw result shape.
//
// UNVERIFIED (see README): OpenClaw's public docs confirm the hook NAMES, the
// api.on registration shape, the pre-prompt context-injection fields
// (prependContext/appendContext/systemPrompt/prependSystemContext/
// appendSystemContext), and the before_agent_finalize return shape
// ({ action: "revise", reason, retry }). The docs do NOT show a full worked
// example of reading the current prompt off a before_prompt_build event, so the
// exact event field name for the user's prompt is a best-effort guess and is
// probed defensively (event.prompt / event.userPrompt / event.input?.prompt /
// event.messages). The core still fails open if none match.

import process from "node:process";
import {
  contributionReason,
  debugLog,
  decideStop,
  readRegistryUseCount,
  recordRegistryUse,
  runQuery,
  sessionIdFor,
  writePromptedCount,
} from "./hook-core.mjs";

// --- definePluginEntry shim --------------------------------------------------
//
// The real helper is `import { definePluginEntry } from
// "openclaw/plugin-sdk/plugin-entry"`. We do NOT import it directly so this
// module stays Node-builtins-only and passes `node --check` / unit tests without
// the OpenClaw SDK installed. definePluginEntry is an identity-style helper
// (it returns the definition object it is given), so an inline fallback is
// behaviorally equivalent for a loaded plugin. When the SDK is present, OpenClaw
// still consumes the default-exported definition object the same way.
function definePluginEntry(definition) {
  return definition;
}

// --- Event field probing (defensive; see UNVERIFIED note above) --------------

// Extract the user's prompt text from a before_prompt_build event. The docs
// confirm the hook receives "the current prompt" but do not pin the field name,
// so we probe the plausible shapes and fall back to scanning a messages array
// for the latest user message. Returns "" when nothing is found (the core then
// no-ops via its length guard).
export function promptFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  if (typeof event.prompt === "string") {
    return event.prompt;
  }
  if (typeof event.userPrompt === "string") {
    return event.userPrompt;
  }
  if (event.input && typeof event.input.prompt === "string") {
    return event.input.prompt;
  }
  const messages = Array.isArray(event.messages)
    ? event.messages
    : Array.isArray(event.input?.messages)
      ? event.input.messages
      : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.role === "user") {
        if (typeof message.content === "string") {
          return message.content;
        }
        if (Array.isArray(message.content)) {
          return message.content
            .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
            .join("\n");
        }
      }
    }
  }
  return "";
}

// Resolve the per-session id OpenClaw exposes on the hook context. ctx.sessionId
// / ctx.runId are documented context fields; sessionIdFor() then normalizes to a
// stable string (falling back to "unknown").
export function sessionIdFromEvent(event) {
  const ctx = event?.context ?? event?.ctx ?? {};
  return sessionIdFor({
    turn_id: ctx.runId ?? ctx.turnId,
    session_id: ctx.sessionId ?? ctx.sessionKey,
  });
}

// --- PRE-prompt hook: before_prompt_build ------------------------------------

// Given an OpenClaw before_prompt_build event, decide/query/format via the core
// and return the OpenClaw injection result, or undefined to inject nothing.
// `env`/`fetchImpl`/`record` are injectable so tests need no network or FS.
// Fail-open: any thrown error resolves to undefined (inject nothing).
export async function handlePrePrompt(event, options = {}) {
  const env = options.env ?? process.env;
  try {
    const prompt = promptFromEvent(event);
    const context = await runQuery(prompt, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      stderr: options.stderr,
      // Report as OpenClaw, not the shared-core Codex default, so server-side
      // analytics/attribution are correct and the query validates.
      identity: { provider: "openclaw", model: "openclaw" },
      userAgent: "@remembrance/openclaw-plugin",
    });
    if (!context) {
      return undefined;
    }
    // A real injection happened — record it so the completion hook can detect
    // that this session consumed the registry.
    const record = options.recordUse ?? recordRegistryUse;
    record(sessionIdFromEvent(event), env);
    // OpenClaw injects extra system context via appendSystemContext on the
    // before_prompt_build / before_model_resolve result.
    return { appendSystemContext: context };
  } catch (error) {
    debugLog(env, "pre_prompt_error", { error: errorName(error) }, options);
    return undefined;
  }
}

// --- COMPLETION hook: before_agent_finalize ----------------------------------

// Given an OpenClaw before_agent_finalize event, decide whether to nudge a
// contribution. Returns the OpenClaw finalize result: `{ action: "revise", ... }`
// to ask the agent to contribute once, or `{ action: "finalize" }` to let it
// finish. `env` and the count fns are injectable. Fail-open: any error
// finalizes.
export function handleCompletion(event, options = {}) {
  const env = options.env ?? process.env;
  try {
    const sessionId = sessionIdFromEvent(event);
    // Reuse the shared decideStop by mapping the OpenClaw event onto the input
    // shape the core expects. OpenClaw has no "stop_hook_active" flag; loop
    // safety comes from the prompted-count sentinel the core already applies
    // (it only revises when use > prompted), plus recording the new count here.
    const decision = decideStop(
      { turn_id: sessionId, stop_hook_active: false },
      {
        env,
        readUseCount: options.readUseCount ?? readRegistryUseCount,
        readPromptedCount: options.readPromptedCount,
      },
    );
    if (decision.allow) {
      return { action: "finalize", why: decision.why };
    }
    // Record that we prompted at this use count so we never nag twice for the
    // same use (this is the loop guard OpenClaw needs since it has no
    // stop_hook_active flag).
    const writePrompted = options.writePromptedCount ?? writePromptedCount;
    writePrompted(sessionId, decision.useCount, env);
    return {
      action: "revise",
      reason: decision.reason ?? contributionReason(),
      retry: { instruction: decision.reason ?? contributionReason(), maxAttempts: 1 },
      why: decision.why,
    };
  } catch (error) {
    debugLog(env, "completion_error", { error: errorName(error) }, options);
    return { action: "finalize", why: "error" };
  }
}

function errorName(error) {
  return error instanceof Error ? error.name || error.message : "Error";
}

// --- Plugin definition -------------------------------------------------------

const plugin = definePluginEntry({
  id: "remembrance",
  name: "Remembrance",
  description:
    "Auto-query Remembrance before relevant tasks and nudge contribution at completion.",
  register(api) {
    // PRE-prompt: inject matching skills/resources before the model turn.
    api.on(
      "before_prompt_build",
      async (event) => handlePrePrompt(event),
      { priority: 50 },
    );
    // COMPLETION: nudge the agent to contribute what it learned, once.
    api.on(
      "before_agent_finalize",
      async (event) => handleCompletion(event),
      { priority: 50 },
    );
  },
});

export default plugin;
