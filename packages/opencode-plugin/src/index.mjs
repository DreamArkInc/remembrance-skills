// Remembrance opencode plugin entrypoint.
//
// opencode plugins are IN-PROCESS JS/TS modules, not stdin/stdout scripts. The
// default export is the current versioned plugin-module object; its `server`
// function receives
// `{ project, client, $, directory, worktree }` and returns an object whose
// `event` callback receives the host's discriminated lifecycle-event union.
// Specialized mutable hooks such as tool.execute.after remain direct keys.
// (See opencode.ai/docs/plugins.)
//
// This entrypoint ports as much of the Remembrance prompt/completion loop as the
// host's event surface allows:
//
//   SESSION START  (event -> session.created): records lifecycle health under the
//     "opencode" surface and logs the activation notice, so a user can see the
//     plugin loaded and knows to call run_connection_doctor.
//
//   PROMPT (chat.message -> experimental.chat.system.transform): queries from
//     the current user turn, then injects the bounded result into the model's
//     system context before dispatch. Legacy message events remain a fallback
//     for older builds and are deduplicated by message id.
//
//   TOOL OBSERVER (tool.execute.after): correlates Remembrance tool calls with
//     the active directive exactly like the other hosts.
//
//   COMPLETION (event -> session.idle): when the session used Remembrance or contained
//     eligible reusable work, logs the contribution nudge once per engagement.
//     Respects REMEMBRANCE_AUTO_CONTRIBUTE=0.
//
// All decision/query/format logic lives in scripts/hook-core.mjs (Node-builtins
// only, runtime-agnostic, copied verbatim from packages/codex-plugin). This
// module is only the opencode adapter.
//
// The event callback and message/session shapes follow OpenCode's published SDK
// union. Defensive probes retain compatibility with older builds.

import { readFileSync } from "node:fs";
import process from "node:process";
import {
  HOST_POLICY_ALERT_TEXT,
  checkForClientUpdate,
  clearHighMatchSurfaceForExplicitSelection,
  clearHighMatchSurfaceIfOpened,
  debugLog,
  decideStop,
  directSelectionFromResponse,
  highMatchFromResponse,
  markHostPolicyAlertDelivered,
  observeSuccessfulCompletionTool,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionSurface,
  recordDirectiveSurface,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordHostPolicyDenial,
  recordQueryFeedbackObligation,
  recordRegistryUse,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  queryResponseHasMatches,
  reportDirectiveEvent,
  reportTaskOutcomesOnStop,
  resolveApiCredential,
  runPromptHook,
  toolResponseIndicatesFailure,
  valueEpisodeFromResponse,
  writePromptedCount,
  warmPrincipalSession,
} from "../scripts/hook-core.mjs";

const SURFACE = "opencode";
const SERVICE = "remembrance";
const CONTRIBUTION_TOOLS = [
  "submit_query_feedback",
  "submit_feedback",
  "submit_remembrance",
  "propose_skill_idea",
  "propose_private_skill",
  "submit_private_lesson_candidate",
  "retry_private_lesson_candidate",
  "submit_suggestion",
  "submit_resource",
  "submit_resource_review",
];
const PREFERENCE_EVIDENCE_TOOLS = [
  "submit_preference_compatibility_feedback",
];

export function pluginVersion(readFile = readFileSync) {
  try {
    return JSON.parse(
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

// OpenCode's published SDK uses the properties.* fields first. Legacy probes
// keep older host builds compatible, and "not found" always means "skip".
export function promptFromMessageEvent(input, output) {
  for (const candidate of [
    output?.parts,
    input?.parts,
    output?.properties?.part?.text,
    input?.properties?.part?.text,
    output?.message?.content,
    output?.message?.text,
    output?.content,
    output?.text,
    input?.message?.content,
    input?.message?.text,
    input?.content,
    input?.text,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((part) =>
          typeof part === "string" ? part : (part?.text ?? part?.content ?? ""),
        )
        .filter((part) => typeof part === "string")
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return null;
}

export function isUserMessageEvent(input, output) {
  const role =
    output?.properties?.info?.role ??
    input?.properties?.info?.role ??
    output?.message?.role ??
    output?.role ??
    input?.message?.role ??
    input?.role ??
    null;
  return role === "user";
}

export function sessionIdFromEvent(input, output) {
  for (const candidate of [
    output?.properties?.sessionID,
    output?.properties?.info?.sessionID,
    output?.properties?.info?.id,
    output?.properties?.part?.sessionID,
    input?.properties?.sessionID,
    input?.properties?.info?.sessionID,
    input?.properties?.info?.id,
    input?.properties?.part?.sessionID,
    output?.sessionID,
    output?.sessionId,
    output?.session?.id,
    output?.message?.sessionID,
    output?.message?.sessionId,
    input?.sessionID,
    input?.sessionId,
    input?.session?.id,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return "opencode-session";
}

export function messageIdFromEvent(input, output) {
  for (const candidate of [
    output?.properties?.info?.id,
    output?.properties?.part?.messageID,
    input?.properties?.info?.id,
    input?.properties?.part?.messageID,
    output?.message?.id,
    output?.messageID,
    input?.message?.id,
    input?.messageID,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

export function toolNameFromEvent(input, output) {
  for (const candidate of [
    input?.tool,
    input?.toolName,
    output?.tool,
    output?.toolName,
    input?.properties?.tool,
    input?.properties?.toolName,
    input?.properties?.permission,
    output?.properties?.tool,
    output?.properties?.toolName,
    output?.properties?.permission,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return "";
}

async function log(client, level, message) {
  try {
    await client?.app?.log?.({ body: { service: SERVICE, level, message } });
  } catch {
    // Logging is best effort; never let it break the host.
  }
}

async function notify(client, message, variant = "info") {
  try {
    if (client?.tui?.showToast) {
      await client.tui.showToast({
        body: { title: "Remembrance", message, variant },
      });
      return;
    }
  } catch {
    // Fall through to structured logging when this host has no active TUI.
  }
  await log(client, variant === "error" ? "error" : "info", message);
}

export const Remembrance = async (context = {}) => {
  const { client } = context;
  const env = process.env;
  const version = pluginVersion();
  // OpenCode emits message metadata and message text separately. Track both
  // sides so either delivery order works, then query exactly once.
  const queriedMessages = new Set();
  const messageSessions = new Map();
  const pendingGuidance = new Map();
  const pendingClientUpdates = new Map();
  const userMessages = new Map();
  const pendingTextParts = new Map();

  async function observeHostPolicyDenial({
    eventType,
    sessionId,
    toolName,
    value,
  }) {
    const observation = recordHostPolicyDenial(
      {
        surface: SURFACE,
        sessionId,
        eventType,
        toolName,
        value,
        pluginVersion: version,
      },
      env,
    );
    if (!observation) return false;
    await notify(client, HOST_POLICY_ALERT_TEXT, "error");
    markHostPolicyAlertDelivered(SURFACE, sessionId, observation.id, env);
    return true;
  }

  function clearSessionState(sessionId) {
    pendingGuidance.delete(sessionId);
    pendingClientUpdates.delete(sessionId);
    for (const [messageId, trackedSessionId] of messageSessions) {
      if (trackedSessionId !== sessionId) continue;
      messageSessions.delete(messageId);
      queriedMessages.delete(messageId);
    }
    for (const [messageId, trackedSessionId] of userMessages) {
      if (trackedSessionId === sessionId) userMessages.delete(messageId);
    }
    for (const [messageId, pending] of pendingTextParts) {
      if (pending.sessionId === sessionId) pendingTextParts.delete(messageId);
    }
  }

  function recordLifecycle(component, sessionId) {
    try {
      const credential = resolveApiCredential(env);
      recordPluginLifecycleHealth(
        {
          surface: SURFACE,
          component,
          pluginVersion: version,
          hostVersion: "",
          credentialSource: credential.source,
          sessionId,
        },
        env,
      );
    } catch (error) {
      debugLog(env, "opencode_lifecycle_health_failed", {
        component,
        error: String(error),
      });
    }
  }

  async function handleSessionCreated(event) {
    try {
      const sessionId = sessionIdFromEvent(event, event);
      recordLifecycle("session_start", sessionId);
      const [, clientUpdate] = await Promise.all([
        (context.warmSession ?? warmPrincipalSession)(
          {
            runtime: SURFACE,
            hostSurface: "cli",
            clientVersion: version,
            hostVersion: "",
          },
          env,
        ).catch(() => null),
        (context.clientUpdateCheck ?? checkForClientUpdate)(
          {
            surface: SURFACE,
            currentVersion: version,
          },
          env,
        ).catch(() => null),
      ]);
      if (clientUpdate?.notice) {
        pendingClientUpdates.set(sessionId, clientUpdate.notice);
      }
      await notify(
        client,
        clientUpdate?.latest_version
          ? `Remembrance ${version} is active; ${clientUpdate.latest_version} is available. The agent will ask before updating, and the host must be restarted afterward.`
          : `Remembrance ${version} is active. Relevant memory is added before eligible turns; ` +
              "run_connection_doctor verifies the active connection and gives one exact next step without exposing the key.",
      );
    } catch (error) {
      debugLog(env, "opencode_session_created_failed", {
        error: String(error),
      });
    }
  }

  async function handlePrompt(prompt, sessionId, messageId) {
    const messageKey = messageId ?? `${sessionId}:${prompt}`;
    if (queriedMessages.has(messageKey)) return;
    queriedMessages.add(messageKey);
    messageSessions.set(messageKey, sessionId);
    recordLifecycle("prompt_hook", sessionId);
    const result = await runPromptHook(prompt, {
      env,
      identity: { provider: SURFACE, model: "opencode" },
      reportDirectiveShown: false,
      userAgent: "@remembrance-ai/opencode-plugin",
    });
    if (result?.eligible) {
      recordTaskEligibility(sessionId, env);
    }
    const guidance = result?.context ?? "";
    if (guidance.trim()) {
      // Registry use is recorded on DELIVERY (handleSystemTransform), not here.
      // Every other host returns guidance from the prompt hook itself, so for
      // them querying and delivering are the same instant. OpenCode delivers in
      // a separate later callback riding an `experimental.*` host API, so
      // counting use at query time would keep reporting consumption — and keep
      // firing the completion nudge — even if that API stopped injecting and the
      // model never saw a single line. Recording at delivery keeps the counter
      // meaning the same thing here as everywhere else, and makes a broken
      // injection observable as an absence of use rather than as silent
      // over-reporting.
      pendingGuidance.set(sessionId, {
        directive: result?.directive ?? null,
        highMatch: result?.highMatch ?? null,
        text: guidance.trim(),
        countsAsUse: Boolean(result?.consumed && result?.matched),
        queryFeedback: result?.queryFeedback ?? null,
        valueEpisode: result?.valueEpisode ?? null,
      });
    }
  }

  async function handleChatMessage(input, output) {
    try {
      const prompt = promptFromMessageEvent(input, output);
      if (!prompt) return;
      await handlePrompt(
        prompt,
        sessionIdFromEvent(input, output),
        messageIdFromEvent(input, output),
      );
    } catch (error) {
      debugLog(env, "opencode_chat_message_failed", {
        error: String(error),
      });
    }
  }

  async function handleSystemTransform(input, output) {
    try {
      const sessionId = sessionIdFromEvent(input, output);
      const guidance = pendingGuidance.get(sessionId);
      const updateNotice = pendingClientUpdates.get(sessionId);
      if (!Array.isArray(output?.system)) return;
      if (updateNotice) {
        output.system.push(updateNotice);
        pendingClientUpdates.delete(sessionId);
      }
      if (!guidance) return;
      output.system.push(guidance.text);
      pendingGuidance.delete(sessionId);
      // Delivery happened: only now is the guidance actually in the model's
      // context, so only now does it count as registry use.
      if (guidance.countsAsUse) {
        recordRegistryUse(sessionId, env);
        recordHighMatchSurface(sessionId, guidance.highMatch, env);
        recordValueEpisodeSurface(sessionId, guidance.valueEpisode, env);
      }
      recordQueryFeedbackObligation(
        sessionId,
        guidance.queryFeedback,
        env,
      );
      recordDirectiveSurface(sessionId, guidance.directive, env);
      if (guidance.directive) {
        await reportDirectiveEvent(
          {
            event: "shown",
            directive_id: guidance.directive.directive_id,
            surface: "plugin_hook",
            runtime: guidance.directive.runtime,
            trigger_reason: guidance.directive.trigger_reason,
          },
          {
            env,
            userAgent: "@remembrance-ai/opencode-plugin",
          },
        );
      }
      await log(
        client,
        "debug",
        "Added Remembrance context to the current model turn.",
      );
    } catch (error) {
      debugLog(env, "opencode_system_transform_failed", {
        error: String(error),
      });
    }
  }

  async function handleMessageUpdated(event) {
    try {
      if (!isUserMessageEvent(event, event)) return;
      const sessionId = sessionIdFromEvent(event, event);
      const messageId = messageIdFromEvent(event, event);
      if (!messageId) return;
      userMessages.set(messageId, sessionId);
      const pending = pendingTextParts.get(messageId);
      if (pending) {
        pendingTextParts.delete(messageId);
        await handlePrompt(pending.prompt, pending.sessionId, messageId);
      }
    } catch (error) {
      debugLog(env, "opencode_message_updated_failed", {
        error: String(error),
      });
    }
  }

  async function handleMessagePartUpdated(event) {
    try {
      const prompt = promptFromMessageEvent(event, event);
      const messageId = messageIdFromEvent(event, event);
      if (!prompt || !messageId) return;
      const sessionId =
        userMessages.get(messageId) ?? sessionIdFromEvent(event, event);
      if (!userMessages.has(messageId)) {
        pendingTextParts.set(messageId, { prompt, sessionId });
        return;
      }
      await handlePrompt(prompt, sessionId, messageId);
    } catch (error) {
      debugLog(env, "opencode_prompt_hook_failed", { error: String(error) });
    }
  }

  async function handleSessionIdle(event) {
    let sessionId = "opencode-session";
    try {
      sessionId = sessionIdFromEvent(event, event);
      recordLifecycle("completion_hook", sessionId);
      await reportTaskOutcomesOnStop(sessionId, event, {
        env,
        userAgent: "@remembrance-ai/opencode-plugin",
      });
      const decision = decideStop({ session_id: sessionId }, { env });
      if (decision?.allow !== false || !decision?.reason) return;
      writePromptedCount(sessionId, decision.useCount ?? 1, env);
      await notify(client, decision.reason);
    } catch (error) {
      debugLog(env, "opencode_completion_hook_failed", {
        error: String(error),
      });
    } finally {
      clearSessionState(sessionId);
    }
  }

  return {
    "chat.message": handleChatMessage,

    event: async ({ event } = {}) => {
      try {
        if (!event || typeof event.type !== "string") return;
        if (event.type === "session.created") {
          await handleSessionCreated(event);
          return;
        }
        if (event.type === "message.updated") {
          await handleMessageUpdated(event);
          return;
        }
        if (event.type === "message.part.updated") {
          await handleMessagePartUpdated(event);
          return;
        }
        if (event.type === "session.idle") {
          await handleSessionIdle(event);
          return;
        }
        if (
          event.type === "permission.replied" ||
          event.type === "session.error"
        ) {
          const serialized = JSON.stringify(event);
          const inferredTool = /remembrance/i.test(serialized)
            ? toolNameFromEvent(event, event) || "remembrance"
            : toolNameFromEvent(event, event);
          await observeHostPolicyDenial({
            eventType: event.type,
            sessionId: sessionIdFromEvent(event, event),
            toolName: inferredTool,
            value: event,
          });
          return;
        }
        if (event.type === "session.deleted") {
          clearSessionState(sessionIdFromEvent(event, event));
        }
      } catch (error) {
        debugLog(env, "opencode_event_dispatch_failed", {
          error: String(error),
        });
      }
    },

    "experimental.chat.system.transform": handleSystemTransform,

    "tool.execute.after": async (input, output) => {
      try {
        const sessionId = sessionIdFromEvent(input, output);
        const tool = toolNameFromEvent(input, output);
        if (!tool) return;
        const normalizedTool = tool.toLowerCase();
        const toolArguments = toolArgumentsFromEvent(input);
        if (toolResponseIndicatesFailure(output)) {
          await observeHostPolicyDenial({
            eventType: "tool.execute.after",
            sessionId,
            toolName: tool,
            value: output,
          });
          return;
        }
        recordLifecycle("tool_observer", sessionId);
        if (normalizedTool.endsWith("query_skills")) {
          if (queryResponseHasMatches(output)) {
            recordRegistryUse(sessionId, env);
          }
          recordHighMatchSurface(sessionId, highMatchFromResponse(output), env);
          recordValueEpisodeSurface(
            sessionId,
            valueEpisodeFromResponse(output),
            env,
          );
          observeSuccessfulCompletionTool(
            sessionId,
            tool,
            toolArguments,
            output,
            env,
          );
          await recordDirectiveFollowThroughForTool(sessionId, tool, output, {
            env,
          });
          return;
        }
        if (normalizedTool.endsWith("invoke_skill")) {
          const selection = directSelectionFromResponse(output);
          if (!selection) return;
          const useCount = recordRegistryUse(sessionId, env);
          recordDirectSelectionSurface(
            sessionId,
            { ...selection, use_count: useCount },
            env,
          );
          recordValueEpisodeSurface(
            sessionId,
            valueEpisodeFromResponse(output),
            env,
          );
          clearHighMatchSurfaceForExplicitSelection(
            sessionId,
            selection.slug,
            env,
          );
          observeSuccessfulCompletionTool(
            sessionId,
            tool,
            toolArguments,
            output,
            env,
          );
          return;
        }
        if (normalizedTool.endsWith("prepare_private_lesson_candidate")) {
          observeSuccessfulCompletionTool(
            sessionId,
            tool,
            toolArguments,
            output,
            env,
          );
          return;
        }
        if (
          PREFERENCE_EVIDENCE_TOOLS.some((candidate) =>
            normalizedTool.endsWith(candidate),
          )
        ) {
          return;
        }
        if (
          CONTRIBUTION_TOOLS.some((candidate) =>
            normalizedTool.endsWith(candidate),
          )
        ) {
          observeSuccessfulCompletionTool(
            sessionId,
            tool,
            toolArguments,
            output,
            env,
          );
          return;
        }
        clearHighMatchSurfaceIfOpened(
          sessionId,
          tool,
          toolArguments,
          env,
        );
        observeSuccessfulCompletionTool(
          sessionId,
          tool,
          toolArguments,
          output,
          env,
        );
      } catch (error) {
        debugLog(env, "opencode_tool_observer_failed", {
          error: String(error),
        });
      }
    },
  };
};

function toolArgumentsFromEvent(input) {
  const value =
    input?.args ??
    input?.arguments ??
    input?.params ??
    input?.tool_input ??
    input?.toolInput ??
    {};
  return value && typeof value === "object" ? value : {};
}

export default Object.freeze({
  id: "@remembrance-ai/opencode-plugin",
  server: Remembrance,
});
