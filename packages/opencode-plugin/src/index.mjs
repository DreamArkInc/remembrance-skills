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
//     "opencode" surface, records a session created without a parent session
//     as a main session and a child session's parent (the child belongs to its
//     root session's tree), and logs the activation notice, so a user can see
//     the plugin loaded and knows to call run_connection_doctor.
//
//   PROMPT (chat.message -> experimental.chat.system.transform): queries from
//     the current user turn, then injects the bounded result into the system
//     context of every model request of that turn (the host rebuilds the
//     system prompt per request and asks its title model first). Legacy
//     message events remain a fallback for older builds and are deduplicated
//     by message id.
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
  bindPrivateSkillNativeCapture,
  HOST_POLICY_ALERT_TEXT,
  checkForClientUpdate,
  clearHighMatchSurfaceForExplicitSelection,
  clearHighMatchSurfaceIfOpened,
  debugLog,
  decideStop,
  acknowledgePrivateAuthorizationReminders,
  directSelectionFromResponse,
  highMatchFromResponse,
  isRecordedMainSession,
  markHostPolicyAlertDelivered,
  observeSuccessfulCompletionTool,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionUse,
  recordDirectiveSurface,
  recordHighMatchSurface,
  recordMainSession,
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
  recordSessionParent,
  runPromptHook,
  sessionTreeLedgerId,
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

export function pluginVersion(readFile = readFileSync) {
  try {
    return JSON.parse(
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

// OpenCode marks the text it adds to a user message itself (a file it read in,
// an assistant-audience prompt) synthetic, and text shown only to the user
// ignored; its own prompt assembly keeps neither as what the user typed.
function hostAddedPart(part) {
  return part?.synthetic === true || part?.ignored === true;
}

// OpenCode's published SDK uses the properties.* fields first. Legacy probes
// keep older host builds compatible, and "not found" always means "skip".
export function promptFromMessageEvent(input, output) {
  const eventPartText = (part) => (hostAddedPart(part) ? null : part?.text);
  for (const candidate of [
    output?.parts,
    input?.parts,
    eventPartText(output?.properties?.part),
    eventPartText(input?.properties?.part),
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
        .filter((part) => !hostAddedPart(part))
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

export function nativeSessionIdFromEvent(input, output) {
  for (const candidate of [
    output?.properties?.sessionID,
    output?.properties?.info?.sessionID,
    output?.properties?.part?.sessionID,
    input?.properties?.sessionID,
    input?.properties?.info?.sessionID,
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
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
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
  if (!client?.app?.log) return false;
  try {
    await client.app.log({ body: { service: SERVICE, level, message } });
    return true;
  } catch {
    // Logging is best effort; never let it break the host.
    return false;
  }
}

async function notify(client, message, variant = "info") {
  try {
    if (client?.tui?.showToast) {
      await client.tui.showToast({
        body: { title: "Remembrance", message, variant },
      });
      return true;
    }
  } catch {
    // Fall through to structured logging when this host has no active TUI.
  }
  return log(client, variant === "error" ? "error" : "info", message);
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
  // An update notice belongs to the session, not to one turn: it waits
  // through session.idle (OpenCode publishes one after every turn) for a
  // later turn's hook, and is dropped only once delivered or when the session
  // is deleted.
  const pendingClientUpdates = new Map();
  // What the current turn delivered, repeated on each of its later requests.
  const turnContext = new Map();
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
    turnContext.delete(sessionId);
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
      // OpenCode runs a task subagent in a child session, created with its
      // parent's id (properties.info.parentID), and that session's
      // chat.message reads like a user prompt. Only a session created with no
      // parent is a main session. Any other one, a child or a session no
      // process of this plugin saw created, gets no user decision about
      // retained drafts; they wait, unacknowledged, for a main session. A
      // child's recorded parent puts it in its root session's tree
      // (sessionTreeLedgerId); a child whose link was never seen keeps its
      // drafts as its own, and they reach the user once it has been idle.
      const info = event?.properties?.info;
      if (info?.id === sessionId && !info.parentID) {
        recordMainSession(sessionId, env);
      } else if (info?.id === sessionId) {
        recordSessionParent(sessionId, info.parentID, env);
      }
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

  async function handlePrompt(prompt, sessionId, messageId, nativeSessionId) {
    const messageKey = messageId ?? `${sessionId}:${prompt}`;
    if (queriedMessages.has(messageKey)) return;
    queriedMessages.add(messageKey);
    messageSessions.set(messageKey, sessionId);
    turnContext.delete(sessionId);
    recordLifecycle("prompt_hook", sessionId);
    const ledgerId = sessionTreeLedgerId(sessionId, env);
    const result = await (context.runPromptHook ?? runPromptHook)(prompt, {
      env,
      contextAdditions: pendingClientUpdates.has(sessionId)
        ? [
            {
              id: "client_update",
              kind: "notice",
              text: pendingClientUpdates.get(sessionId),
            },
          ]
        : [],
      identity: { provider: SURFACE, model: "opencode" },
      reportDirectiveShown: false,
      deferReminderAcknowledgement: true,
      sessionId: ledgerId,
      subagentSession: !isRecordedMainSession(sessionId, env),
      nativeSessionId,
      nativeContextBridge: context.nativeContextBridge,
      userAgent: "@remembrance-ai/opencode-plugin",
    });
    if (result?.eligible) {
      recordTaskEligibility(ledgerId, env);
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
        ledgerId,
        directive: result?.directive ?? null,
        highMatch: result?.highMatch ?? null,
        text: guidance.trim(),
        deliveredContextAdditionIds: result?.deliveredContextAdditionIds ?? [],
        countsAsUse: Boolean(result?.consumed && result?.matched),
        queryFeedback: result?.queryFeedback ?? null,
        valueEpisode: result?.valueEpisode ?? null,
      });
    } else if (result?.consumed) {
      // An empty task-shape search delivers nothing (owner decision 34C);
      // like any completed search it still ends an earlier directive.
      recordDirectiveSurface(ledgerId, null, env);
    }
  }

  async function handleChatMessage(input, output) {
    try {
      if (!isUserMessageEvent(input, output)) return;
      const prompt = promptFromMessageEvent(input, output);
      if (!prompt) return;
      await handlePrompt(
        prompt,
        sessionIdFromEvent(input, output),
        messageIdFromEvent(input, output),
        nativeSessionIdFromEvent(input, output),
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
      // OpenCode builds the system prompt again for every model request of a
      // turn, and on a session's first turn its title request comes first:
      // what this turn delivered goes into each of them, recorded once.
      const delivered = turnContext.get(sessionId) ?? [];
      // The raw update notice is only for a turn that carries nothing else;
      // a notice the bounded hook withheld waits for a later turn's hook, as
      // does one still pending when the session went idle (handleSessionIdle).
      if (updateNotice && !guidance && !turnContext.has(sessionId)) {
        delivered.push(updateNotice);
        pendingClientUpdates.delete(sessionId);
      }
      if (guidance) delivered.push(guidance.text);
      if (delivered.length > 0) turnContext.set(sessionId, delivered);
      output.system.push(...delivered);
      if (!guidance) return;
      acknowledgePrivateAuthorizationReminders(
        guidance.text,
        env,
        guidance.ledgerId,
      );
      pendingGuidance.delete(sessionId);
      if (guidance.deliveredContextAdditionIds.includes("client_update")) {
        pendingClientUpdates.delete(sessionId);
      }
      // Delivery happened: only now is the guidance actually in the model's
      // context, so only now does it count as registry use.
      if (guidance.countsAsUse) {
        recordRegistryUse(guidance.ledgerId, env);
        recordHighMatchSurface(guidance.ledgerId, guidance.highMatch, env);
        recordValueEpisodeSurface(
          guidance.ledgerId,
          guidance.valueEpisode,
          env,
        );
      }
      recordQueryFeedbackObligation(
        guidance.ledgerId,
        guidance.queryFeedback,
        env,
      );
      recordDirectiveSurface(guidance.ledgerId, guidance.directive, env);
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
        await handlePrompt(
          pending.prompt,
          pending.sessionId,
          messageId,
          pending.nativeSessionId,
        );
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
      const nativeSessionId = nativeSessionIdFromEvent(event, event);
      if (!userMessages.has(messageId)) {
        pendingTextParts.set(messageId, {
          prompt,
          sessionId,
          nativeSessionId,
        });
        return;
      }
      await handlePrompt(prompt, sessionId, messageId, nativeSessionId);
    } catch (error) {
      debugLog(env, "opencode_prompt_hook_failed", { error: String(error) });
    }
  }

  async function handleSessionIdle(event) {
    let sessionId = "opencode-session";
    try {
      sessionId = sessionIdFromEvent(event, event);
      recordLifecycle("completion_hook", sessionId);
      const ledgerId = sessionTreeLedgerId(sessionId, env);
      await reportTaskOutcomesOnStop(ledgerId, event, {
        env,
        userAgent: "@remembrance-ai/opencode-plugin",
      });
      const decision = decideStop(
        { session_id: ledgerId },
        { env, subagentSession: !isRecordedMainSession(sessionId, env) },
      );
      if (decision?.allow !== false || !decision?.reason) return;
      const delivered = await notify(client, decision.reason);
      if (!delivered) return;
      writePromptedCount(ledgerId, decision.useCount ?? 1, env);
      acknowledgePrivateAuthorizationReminders(decision.reason, env, ledgerId);
    } catch (error) {
      debugLog(env, "opencode_completion_hook_failed", {
        error: String(error),
      });
    } finally {
      clearSessionState(sessionId);
      // Until the next user prompt a model request is no agent turn (OpenCode
      // runs one for a manual compaction), so it gets no pending notice.
      if (pendingClientUpdates.has(sessionId)) turnContext.set(sessionId, []);
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
          const sessionId = sessionIdFromEvent(event, event);
          pendingClientUpdates.delete(sessionId);
          clearSessionState(sessionId);
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
          // The call's own arguments let a denial park that exact draft.
          await observeHostPolicyDenial({
            eventType: "tool.execute.after",
            sessionId,
            toolName: tool,
            value: {
              ...(output && typeof output === "object" ? output : { output }),
              tool_input: toolArguments,
            },
          });
          return;
        }
        recordLifecycle("tool_observer", sessionId);
        const ledgerId = sessionTreeLedgerId(sessionId, env);
        if (normalizedTool.endsWith("query_skills")) {
          if (queryResponseHasMatches(output)) {
            recordRegistryUse(ledgerId, env);
          }
          recordHighMatchSurface(ledgerId, highMatchFromResponse(output), env);
          recordValueEpisodeSurface(
            ledgerId,
            valueEpisodeFromResponse(output),
            env,
          );
          observeSuccessfulCompletionTool(
            ledgerId,
            tool,
            toolArguments,
            output,
            env,
          );
          await recordDirectiveFollowThroughForTool(ledgerId, tool, output, {
            env,
          });
          return;
        }
        if (normalizedTool.endsWith("invoke_skill")) {
          const selection = directSelectionFromResponse(output);
          if (!selection) return;
          recordDirectSelectionUse(ledgerId, selection, env);
          recordValueEpisodeSurface(
            ledgerId,
            valueEpisodeFromResponse(output),
            env,
          );
          clearHighMatchSurfaceForExplicitSelection(
            ledgerId,
            selection.slug,
            env,
          );
          observeSuccessfulCompletionTool(
            ledgerId,
            tool,
            toolArguments,
            output,
            env,
          );
          return;
        }
        if (normalizedTool.endsWith("prepare_private_lesson_candidate")) {
          observeSuccessfulCompletionTool(
            ledgerId,
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
          await bindPrivateSkillNativeCapture(tool, toolArguments, output, {
            env,
            nativeContextBridge: context.nativeContextBridge,
            // Tool output is untrusted payload, not native provenance.
            nativeSessionId: nativeSessionIdFromEvent(input, null),
          });
          observeSuccessfulCompletionTool(
            ledgerId,
            tool,
            toolArguments,
            output,
            env,
          );
          return;
        }
        clearHighMatchSurfaceIfOpened(ledgerId, tool, toolArguments, env);
        observeSuccessfulCompletionTool(
          ledgerId,
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
