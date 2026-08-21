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
// This entrypoint ports the Remembrance prompt/completion loop and observes
// correlated detail opens:
//
//   PRE-prompt  (before_prompt_build): matches the user's prompt via the shared
//     heuristic, queries Remembrance, and injects the matching skills/resources
//     as extra system context (appendSystemContext). It records task eligibility
//     independently from completed query use, so a contextual follow-up or
//     failed query can be recovered at completion. Respects
//     REMEMBRANCE_AUTO_QUERY=0. Fail-open: query errors inject bounded recovery
//     context and never block the prompt.
//
//   COMPLETION  (before_agent_finalize): when the session used Remembrance or
//     contained eligible reusable work, it asks the agent to revise once. The
//     revision either recovers a missed full-context query or contributes what
//     it learned. Records the prompted count so it fires at most once per
//     engagement. Respects REMEMBRANCE_AUTO_CONTRIBUTE=0. Loop-safe and
//     fail-open: any error finalizes normally.
//
//   TOOL OBSERVER  (after_tool_call): correlates query_skills with the active
//     directive and clears a high-match completion marker only after the
//     matching get_skill/get_resource call succeeds with the same slug and
//     query/result IDs.
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

import { accessSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  completionContinuationReason,
  HOST_POLICY_ALERT_TEXT,
  checkForClientUpdate,
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  contributionReason,
  debugLog,
  decideStop,
  directSelectionFromResponse,
  highMatchFromResponse,
  markHostPolicyAlertDelivered,
  observeSuccessfulCompletionTool,
  readPendingHostPolicyAlert,
  readRegistryUseCount,
  readTaskEligibilityCount,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionSurface,
  recordDirectiveSurface,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordQueryFeedbackObligation,
  recordHostPolicyDenial,
  recordRegistryUse,
  queryResponseHasMatches,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  reportTaskOutcomesOnStop,
  responseRequestsRemembranceFollowup,
  resolveApiCredential,
  runPromptHook,
  sessionIdFor,
  toolResponseIndicatesFailure,
  writePromptedCount,
  valueEpisodeFromResponse,
  warmPrincipalSession,
} from "./hook-core.mjs";
import {
  handlePrivateLessonSubmitApproval,
  persistPrivateLessonSubmitApproval,
  privateLessonSubmitApproved,
} from "./private-lesson-approval.mjs";

export { handlePrivateLessonSubmitApproval } from "./private-lesson-approval.mjs";

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
            .map((part) =>
              typeof part === "string" ? part : (part?.text ?? ""),
            )
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
  const sessionId = sessionIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "prompt_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  try {
    let updateNotice = null;
    if (
      options.clientUpdatePromise &&
      !options.updateDeliveredSessions?.has(sessionId)
    ) {
      const clientUpdate = await options.clientUpdatePromise.catch(() => null);
      if (clientUpdate?.notice) {
        updateNotice = clientUpdate.notice;
        options.updateDeliveredSessions?.add(sessionId);
        if (options.updateDeliveredSessions?.size > 512) {
          const oldest = options.updateDeliveredSessions.values().next().value;
          if (oldest) options.updateDeliveredSessions.delete(oldest);
        }
      }
    }
    const prompt = promptFromEvent(event);
    const result = await runPromptHook(prompt, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      stderr: options.stderr,
      // Report as OpenClaw, not the shared-core Codex default, so server-side
      // analytics/attribution are correct and the query validates.
      identity: { provider: "openclaw", model: "openclaw" },
      userAgent: "@remembrance/openclaw-plugin",
    });
    if (!result) {
      return updateNotice ? { appendSystemContext: updateNotice } : undefined;
    }
    if (result.eligible) {
      const recordEligibility =
        options.recordEligibility ?? recordTaskEligibility;
      recordEligibility(sessionId, env);
    }
    const recordDirective = options.recordDirective ?? recordDirectiveSurface;
    recordDirective(sessionId, result.directive ?? null, env);
    const recordQueryFeedback =
      options.recordQueryFeedback ?? recordQueryFeedbackObligation;
    recordQueryFeedback(sessionId, result.queryFeedback, env);
    if (result.consumed && result.matched) {
      const record = options.recordUse ?? recordRegistryUse;
      record(sessionId, env);
      const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
      recordHighMatch(sessionId, result.highMatch ?? null, env);
      const recordValueEpisode =
        options.recordValueEpisode ?? recordValueEpisodeSurface;
      recordValueEpisode(sessionId, result.valueEpisode ?? null, env);
    }
    // OpenClaw injects extra system context via appendSystemContext on the
    // before_prompt_build / before_model_resolve result.
    return {
      appendSystemContext: updateNotice
        ? `${updateNotice}\n\n${result.context}`
        : result.context,
    };
  } catch (error) {
    debugLog(env, "pre_prompt_error", { error: errorName(error) }, options);
    return undefined;
  }
}

// OpenClaw exposes completed tool calls through the observation-only
// after_tool_call hook. Correlate successful queries with task directives, and
// clear the completion nudge only when the exact high match was opened.
export async function handleAfterToolCall(event, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "tool_observer",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  const response = event?.result ?? event?.output ?? event?.response ?? null;
  if (
    event?.error ||
    event?.isError ||
    event?.result?.isError ||
    toolResponseIndicatesFailure(response)
  ) {
    const toolName = event?.toolName ?? event?.tool_name ?? "";
    const recordDenial =
      options.recordHostPolicyDenial ?? recordHostPolicyDenial;
    const observation = recordDenial(
      {
        surface: "openclaw",
        sessionId,
        eventType: "after_tool_call",
        toolName,
        value: event,
        pluginVersion: pluginVersion(),
      },
      env,
    );
    return {
      cleared: false,
      why: "tool_failed",
      ...(observation ? { host_policy_denial: true } : {}),
    };
  }
  const toolName = event?.toolName ?? event?.tool_name ?? "";
  const normalizedToolName = String(toolName).toLowerCase();
  const toolArguments =
    event?.params ?? event?.arguments ?? event?.tool_input ?? {};
  if (normalizedToolName.endsWith("query_skills")) {
    if (queryResponseHasMatches(response)) {
      const recordUse = options.recordRegistryUse ?? recordRegistryUse;
      recordUse(sessionId, env);
    }
    const recordHighMatch = options.recordHighMatch ?? recordHighMatchSurface;
    recordHighMatch(sessionId, highMatchFromResponse(response), env);
    const recordFollowThrough =
      options.recordDirectiveFollowThrough ??
      recordDirectiveFollowThroughForTool;
    const followed = await recordFollowThrough(sessionId, toolName, response, {
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      userAgent: "@remembrance/openclaw-plugin",
    });
    const recordValueEpisode =
      options.recordValueEpisode ?? recordValueEpisodeSurface;
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(sessionId, toolName, toolArguments, response, env);
    return {
      cleared: false,
      directive_followed: followed,
      why: followed ? "directive_followed" : "no_current_directive",
    };
  }
  if (normalizedToolName.endsWith("invoke_skill")) {
    const selection = directSelectionFromResponse(response);
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
    recordValueEpisode(sessionId, valueEpisodeFromResponse(response), env);
    const clearExplicit =
      options.clearHighMatchSurfaceForExplicitSelection ??
      clearHighMatchSurfaceForExplicitSelection;
    const cleared = clearExplicit(sessionId, selection.slug, env);
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    observe(sessionId, toolName, toolArguments, response, env);
    return {
      recorded: true,
      cleared,
      why: "direct_skill_invoked",
      count: useCount,
    };
  }
  if (
    PREFERENCE_EVIDENCE_TOOLS.some((tool) =>
      normalizedToolName.endsWith(tool),
    )
  ) {
    return {
      recorded: true,
      cleared: false,
      why: "preference_compatibility_feedback_recorded",
    };
  }
  if (normalizedToolName.endsWith("prepare_private_lesson_candidate")) {
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      sessionId,
      toolName,
      toolArguments,
      response,
      env,
    );
    return {
      recorded: observation.opened.length > 0,
      cleared: false,
      why: "private_lesson_prepared",
    };
  }
  if (CONTRIBUTION_TOOLS.some((tool) => normalizedToolName.endsWith(tool))) {
    const observe =
      options.observeCompletionTool ?? observeSuccessfulCompletionTool;
    const observation = observe(
      sessionId,
      toolName,
      toolArguments,
      response,
      env,
    );
    if (
      normalizedToolName.endsWith("submit_feedback") &&
      responseRequestsRemembranceFollowup(response)
    ) {
      return {
        recorded: true,
        cleared: false,
        why: "remembrance_followup_pending",
      };
    }
    return {
      recorded: true,
      cleared: false,
      why:
        observation.pending.length > 0
          ? "contribution_recorded_pending"
          : "contribution_handled",
      count: observation.handled_count,
    };
  }
  const clear =
    options.clearHighMatchSurfaceIfOpened ?? clearHighMatchSurfaceIfOpened;
  const cleared = clear(sessionId, toolName, toolArguments, env);
  const observe =
    options.observeCompletionTool ?? observeSuccessfulCompletionTool;
  observe(sessionId, toolName, toolArguments, response, env);
  return {
    cleared,
    why: cleared ? "matched_detail_open" : "not_current_match",
  };
}

export async function handleFinalize(event, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFromEvent(event);
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  recordHealth(
    {
      surface: "openclaw",
      component: "completion_hook",
      credentialSource: resolveApiCredential(env).source,
      sessionId,
    },
    env,
  );
  const report = options.reportTaskOutcomes ?? reportTaskOutcomesOnStop;
  await report(sessionId, event, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    userAgent: "@remembrance/openclaw-plugin",
  });
  return handleCompletion(event, options);
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
    const readPolicyAlert =
      options.readPendingHostPolicyAlert ?? readPendingHostPolicyAlert;
    const policyAlert = readPolicyAlert("openclaw", sessionId, env);
    if (policyAlert) {
      const markDelivered =
        options.markHostPolicyAlertDelivered ?? markHostPolicyAlertDelivered;
      markDelivered("openclaw", sessionId, policyAlert.id, env);
      return {
        action: "revise",
        reason: HOST_POLICY_ALERT_TEXT,
        retry: { instruction: HOST_POLICY_ALERT_TEXT, maxAttempts: 1 },
        why: "host_policy_denial",
      };
    }
    // Reuse the shared decideStop by mapping the OpenClaw event onto the input
    // shape the core expects. OpenClaw has no "stop_hook_active" flag; loop
    // safety comes from the prompted-count sentinel the core already applies
    // (it only revises when use > prompted), plus recording the new count here.
    const decision = decideStop(
      {
        turn_id: sessionId,
        stop_hook_active: false,
        last_assistant_message: completionMessageFromEvent(event),
      },
      {
        env,
        readUseCount: options.readUseCount ?? readRegistryUseCount,
        readEligibilityCount:
          options.readEligibilityCount ?? readTaskEligibilityCount,
        readPromptedCount: options.readPromptedCount,
        readCompletionObligations: options.readCompletionObligations,
        readHighMatch: options.readHighMatch,
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
    const continuationReason = completionContinuationReason(
      decision.reason ?? contributionReason(),
      { last_assistant_message: completionMessageFromEvent(event) },
    );
    return {
      action: "revise",
      reason: continuationReason,
      retry: {
        instruction: continuationReason,
        maxAttempts: 1,
      },
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

function completionMessageFromEvent(event) {
  return (
    event?.last_assistant_message ??
    event?.lastAssistantMessage ??
    event?.assistant_message ??
    event?.message ??
    event?.response?.content ??
    event?.result?.content ??
    event?.context?.last_assistant_message ??
    event?.context?.lastAssistantMessage
  );
}

function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function configureOpenClawRemembrance(draft, pluginRoot) {
  const root = String(pluginRoot ?? "").trim();
  if (!root) {
    throw new Error("OpenClaw did not provide the installed plugin root.");
  }
  const serverPath = resolve(root, "servers/remembrance-mcp.mjs");
  accessSync(serverPath);

  const plugins = record(draft.plugins);
  const entries = record(plugins.entries);
  const entry = record(entries.remembrance);
  const hooks = record(entry.hooks);
  entries.remembrance = {
    ...entry,
    enabled: true,
    hooks: {
      ...hooks,
      allowConversationAccess: true,
    },
  };
  plugins.entries = entries;
  draft.plugins = plugins;

  const mcp = record(draft.mcp);
  const servers = record(mcp.servers);
  const existingServer = record(servers.remembrance);
  const existingEnv = record(existingServer.env);
  servers.remembrance = {
    ...existingServer,
    command: "node",
    args: [serverPath],
    env: {
      ...existingEnv,
      REMEMBRANCE_PLUGIN_HOST: "openclaw",
    },
  };
  mcp.servers = servers;
  draft.mcp = mcp;
  return { serverPath };
}

function registerSetupCli(api) {
  if (typeof api?.registerCli !== "function") return;
  api.registerCli(
    ({ program }) => {
      const command = program
        .command("remembrance")
        .description("Configure and inspect the Remembrance plugin");
      command
        .command("setup")
        .description("Enable Remembrance hooks and its bundled local MCP")
        .option("--json", "Print machine-readable setup details")
        .action(async (options = {}) => {
          let serverPath = "";
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              ({ serverPath } = configureOpenClawRemembrance(
                draft,
                api.rootDir,
              ));
            },
          });
          const result = {
            ok: true,
            plugin: "remembrance",
            conversation_access: true,
            mcp_server: "remembrance",
            mcp_transport: "local_stdio",
            mcp_server_path: serverPath,
            credential_source: "shared_config_or_environment",
            next: "Restart OpenClaw, then run: openclaw mcp doctor remembrance --probe",
          };
          const output = options.json
            ? JSON.stringify(result)
            : [
                "Remembrance hooks and bundled local MCP are configured.",
                `Server: ${serverPath}`,
                result.next,
              ].join("\n");
          process.stdout.write(`${output}\n`);
        });
    },
    {
      descriptors: [
        {
          name: "remembrance",
          description: "Configure and inspect the Remembrance plugin",
          hasSubcommands: true,
        },
      ],
    },
  );
}

// --- Plugin definition -------------------------------------------------------

const plugin = definePluginEntry({
  id: "remembrance",
  name: "Remembrance",
  description:
    "Auto-query Remembrance before relevant tasks and nudge contribution at completion.",
  register(api) {
    const credential = resolveApiCredential(process.env);
    const activatesRuntime =
      !api?.registrationMode || api.registrationMode === "full";
    if (activatesRuntime) {
      recordPluginLifecycleHealth(
        {
          surface: "openclaw",
          component: "session_start",
          pluginVersion: pluginVersion(),
          hostVersion: String(api?.version ?? api?.hostVersion ?? "").trim(),
          credentialSource: credential.source,
        },
        process.env,
      );
    }
    const clientUpdatePromise = activatesRuntime
      ? (api?.clientUpdateCheck ?? checkForClientUpdate)(
          {
            surface: "openclaw",
            currentVersion: pluginVersion(),
          },
          process.env,
        ).catch(() => null)
      : Promise.resolve(null);
    if (activatesRuntime) {
      void warmPrincipalSession(
        {
          runtime: "openclaw",
          hostSurface: "gateway",
          clientVersion: pluginVersion(),
          hostVersion: String(api?.version ?? api?.hostVersion ?? "").trim(),
        },
        process.env,
      ).catch(() => null);
    }
    const updateDeliveredSessions = new Set();
    let privateLessonApprovalPersisted = privateLessonSubmitApproved(api);
    const auth =
      credential.source === "none"
        ? "public registry access"
        : `${credential.source.replace("_", " ")} organization credential`;
    if (activatesRuntime) {
      api?.logger?.info?.(
        `Remembrance lifecycle hooks registered; run_connection_doctor should verify the same ${auth}.`,
      );
    }
    registerSetupCli(api);
    api.on(
      "before_tool_call",
      async (event) =>
        handlePrivateLessonSubmitApproval(event, {
          approved: privateLessonApprovalPersisted,
          onAllowAlways() {
            privateLessonApprovalPersisted = true;
            void persistPrivateLessonSubmitApproval(api).catch((error) => {
              api?.logger?.warn?.(
                `Remembrance could not persist private lesson approval: ${errorName(error)}`,
              );
            });
          },
        }),
      { priority: 60 },
    );
    // PRE-prompt: inject matching skills/resources before the model turn.
    api.on(
      "before_prompt_build",
      async (event) =>
        handlePrePrompt(event, {
          clientUpdatePromise,
          updateDeliveredSessions,
        }),
      { priority: 50 },
    );
    api.on("after_tool_call", async (event) => handleAfterToolCall(event), {
      priority: 50,
    });
    // COMPLETION: nudge the agent to contribute what it learned, once.
    api.on("before_agent_finalize", async (event) => handleFinalize(event), {
      priority: 50,
    });
  },
});

export default plugin;
