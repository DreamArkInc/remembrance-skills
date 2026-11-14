// Pi 1.5.2 adapter. Policy, storage and recovery remain in the canonical core.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as hookCore from "../scripts/hook-core.mjs";
import { handlePrivateLessonSubmitApproval } from "../scripts/private-lesson-approval.mjs";
import { PRIVATE_EGRESS_TOOL_LANES } from "../scripts/private-egress-lanes.mjs";

const SURFACE = "pi";
const USER_AGENT = "@remembrance-ai/pi-plugin";
const POLICY_HOLD =
  "Remembrance cannot confirm this organization's skill policy. Run run_connection_doctor, resolve the reported connection issue, then submit the task again. No private submission was authorized.";

export function createRemembranceExtension(options = {}) {
  const core = { ...hookCore, ...options.core };
  // Read live credentials without mutating the host process environment. The
  // overlay also follows credential rotation while child processes get the
  // complete current environment and only these two trusted host markers.
  const sourceEnv = options.env ?? process.env;
  const metadata = {
    REMEMBRANCE_PLUGIN_HOST: SURFACE,
    REMEMBRANCE_HOST_SURFACE: "cli",
  };
  const env = new Proxy(sourceEnv, {
    get: (target, key) =>
      Object.hasOwn(metadata, key) ? metadata[key] : Reflect.get(target, key),
    ownKeys: (target) => [
      ...new Set([...Reflect.ownKeys(target), ...Object.keys(metadata)]),
    ],
    getOwnPropertyDescriptor: (target, key) =>
      Object.hasOwn(metadata, key)
        ? { configurable: true, enumerable: true, value: metadata[key] }
        : Reflect.getOwnPropertyDescriptor(target, key),
  });
  const version =
    options.pluginVersion ??
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  return function remembranceExtension(pi) {
    let state = null;
    let approvalQueue = Promise.resolve();
    const sessionId = (ctx) => ctx?.sessionManager?.getSessionId?.() ?? null;
    const scope = () =>
      createHash("sha256")
        .update(
          JSON.stringify([
            core.resolveApiConfiguration(env)?.apiUrl ?? "",
            core.resolveApiCredential(env)?.apiKey ?? null,
          ]),
        )
        .digest("hex");
    const current = (ctx) => {
      if (state?.id !== sessionId(ctx)) return null;
      if (state.scope !== scope()) {
        state.blocked = true;
        state.scopeChanged = true;
        state.startup = "";
        state.prompt = null;
        state.recovery = null;
        // A running Pi request retains its already-built forced system head.
        // Abort instead of letting that head cross a changed identity.
        ctx.abort?.();
      }
      return state;
    };
    // An await releases the session boundary. Reacquire this predicate before
    // another scoped effect/return, and at every core transport attempt.
    const active = (local, ctx) =>
      Boolean(
        local && state === local && current(ctx) === local && !local.blocked,
      );
    const scopedFetch =
      (local, ctx) =>
      (...args) => {
        if (!active(local, ctx))
          return Promise.reject(
            new Error("Remembrance session scope changed."),
          );
        return (options.fetchImpl ?? fetch)(...args);
      };
    const notify = (ctx, text, severity = "info") => {
      if (ctx?.hasUI && text) ctx.ui.notify(text, severity);
    };
    function health(component, ctx) {
      core.recordPluginLifecycleHealth(
        {
          surface: SURFACE,
          component,
          pluginVersion: version,
          hostVersion: options.hostVersion ?? "",
          sessionId: sessionId(ctx),
          credentialSource: core.resolveApiCredential(env).source,
        },
        env,
      );
    }
    pi.registerMcpServer("remembrance", {
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../servers/remembrance-mcp.mjs", import.meta.url),
        ),
      ],
      env: {
        REMEMBRANCE_PLUGIN_HOST: SURFACE,
        REMEMBRANCE_HOST_SURFACE: "cli",
      },
      description:
        "Remembrance organization skills, preferences, feedback and protected learning",
      exposure: "codemode",
      toolExposure: { run_connection_doctor: "direct" },
    });
    pi.on("session_start", async (event, ctx) => {
      const local = {
        id: sessionId(ctx),
        scope: scope(),
        startup: "",
        prompt: null,
        blocked: false,
        delivered: false,
        observed: new Set(),
        completionRequested: false,
        completed: false,
      };
      state = local;
      local.fetchImpl = scopedFetch(local, ctx);
      try {
        health("session_start", ctx);
        await core.warmPrincipalSession(
          {
            runtime: SURFACE,
            hostSurface: "cli",
            clientVersion: version,
            hostVersion: options.hostVersion ?? "",
            fetchImpl: local.fetchImpl,
          },
          env,
        );
        if (!active(local, ctx)) return;
        const [skills, update, snapshot] = await Promise.all([
          core.sessionSkillsDirective(
            {
              source: event.reason,
              nativeSessionId: local.id,
              fetchImpl: local.fetchImpl,
            },
            env,
          ),
          core.checkForClientUpdate(
            {
              surface: SURFACE,
              currentVersion: version,
              fetchImpl: local.fetchImpl,
            },
            env,
          ),
          core.projectPreferenceSnapshot({
            runtime: SURFACE,
            env,
            projectPath: ctx.cwd,
            fetchImpl: local.fetchImpl,
            userAgent: USER_AGENT,
          }),
        ]);
        if (!active(local, ctx)) return;
        const budget =
          core.HOOK_CONTEXT_BUDGETS.pi ?? core.HOOK_CONTEXT_BUDGETS.opencode;
        const preferences = snapshot
          ? core.preferenceSnapshotText(snapshot, budget)
          : null;
        local.startup = core.composeBoundedHookContext(
          "",
          [
            skills && { id: "pi_session_skills", kind: "notice", text: skills },
            update?.notice && {
              id: "pi_client_update",
              kind: "notice",
              text: update.notice,
            },
            preferences && {
              id: "pi_preferences",
              kind: "preference",
              text: preferences,
            },
          ].filter(Boolean),
          budget,
        );
        notify(
          ctx,
          `Remembrance ${version} is active. Run run_connection_doctor to verify the connection.`,
        );
      } catch {
        if (!active(local, ctx)) return;
        local.blocked = Boolean(core.resolveApiCredential(env).apiKey);
        notify(ctx, POLICY_HOLD, "warning");
      }
    });
    pi.on("input", async (event, ctx) => {
      const local = current(ctx);
      if (!local) return { action: "handled" };
      if (local.scopeChanged) {
        notify(
          ctx,
          "Remembrance's organization or registry changed during this session. Start a new Pi session before continuing so earlier organization context and approvals cannot cross the new connection.",
          "warning",
        );
        return { action: "handled" };
      }
      // Custom continuations keep the current required context. They never
      // become a fresh user instruction or a private-source producer.
      if (!["interactive", "rpc"].includes(event.source))
        return { action: "continue" };
      local.prompt = null;
      local.delivered = false;
      local.completed = false;
      local.completionRequested = false;
      local.recovery = null;
      local.requestContext = Boolean(event.streamingBehavior);
      // Provenance labels are not authority. Synthetic input neither captures
      // preferences nor supplies native private source; RPC is discovery only.
      try {
        local.scope = scope();
        health("prompt_hook", ctx);
        const result = await core.runPromptHook(event.text, {
          ...(core.HOOK_CONTEXT_BUDGETS.pi ??
            core.HOOK_CONTEXT_BUDGETS.opencode),
          env,
          fetchImpl: local.fetchImpl,
          projectPath: ctx.cwd,
          identity: { provider: SURFACE, model: ctx.model?.id ?? SURFACE },
          sessionId: local.id,
          nativeSessionId: null,
          nativeContextBridge: options.nativeContextBridge,
          userAgent: USER_AGENT,
          reportDirectiveShown: false,
          deferReminderAcknowledgement: true,
          contextAdditions: local.startup
            ? [{ id: "pi_session_start", kind: "notice", text: local.startup }]
            : [],
        });
        if (!active(local, ctx)) return { action: "handled" };
        local.blocked =
          Boolean(core.resolveApiCredential(env).apiKey) &&
          result?.reason === "query_unavailable";
        local.prompt = result;
      } catch {
        if (!active(local, ctx)) return { action: "handled" };
        local.blocked = Boolean(core.resolveApiCredential(env).apiKey);
      }
      if (local.blocked) {
        notify(ctx, POLICY_HOLD, "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    });
    async function contextText(local, ctx) {
      const text = local.prompt?.context ?? local.startup;
      if (!text) return "";
      if (!local.delivered && local.prompt) {
        const result = local.prompt;
        local.delivered = true;
        try {
          if (result.eligible) core.recordTaskEligibility(local.id, env);
          if (!result.preferencesOnly) {
            if (result.consumed && result.matched) {
              core.recordRegistryUse(local.id, env);
              core.recordHighMatchSurface(
                local.id,
                result.highMatch ?? null,
                env,
              );
              core.recordValueEpisodeSurface(
                local.id,
                result.valueEpisode ?? null,
                env,
              );
            }
            core.recordQueryFeedbackObligation(
              local.id,
              result.queryFeedback,
              env,
            );
            core.recordDirectiveSurface(
              local.id,
              result.directive ?? null,
              env,
            );
            core.acknowledgePrivateAuthorizationReminders(
              result.context ?? "",
              env,
              local.id,
            );
            if (result.directive)
              await core.reportDirectiveEvent(
                {
                  event: "shown",
                  directive_id: result.directive.directive_id,
                  surface: "plugin_hook",
                  runtime: SURFACE,
                  trigger_reason: result.directive.trigger_reason,
                },
                { env, userAgent: USER_AGENT, fetchImpl: local.fetchImpl },
              );
          }
        } catch {
          // Reporting cannot erase a required context return: Pi catches hook
          // exceptions and otherwise proceeds without the returned prompt.
          if (active(local, ctx))
            notify(
              ctx,
              "Remembrance context is active; completion tracking needs recovery through run_connection_doctor.",
              "warning",
            );
        }
      }
      return text;
    }
    pi.on("before_agent_start", async (event, ctx) => {
      const local = current(ctx);
      if (!local) return;
      if (local.blocked)
        return { systemPrompt: `${event.systemPrompt}\n\n${POLICY_HOLD}` };
      local.requestContext = false;
      const text = await contextText(local, ctx);
      if (!active(local, ctx))
        return { systemPrompt: `${event.systemPrompt}\n\n${POLICY_HOLD}` };
      if (!text) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
    });
    pi.on("context", async (event, ctx) => {
      const local = current(ctx);
      if (!local || local.blocked || (!local.requestContext && !local.recovery))
        return;
      const text = [
        local.requestContext ? await contextText(local, ctx) : null,
        local.recovery,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!active(local, ctx)) return;
      if (!text) return;
      // Steering bypasses before_agent_start. This non-persisted request copy
      // carries its fresh context until the next normal run rebuilds the head.
      return {
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: "remembrance-steering-context",
            content: text,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });
    pi.on("tool_call", async (event, ctx) => {
      if (
        current(ctx)?.blocked &&
        event.toolName !== "mcp__remembrance__run_connection_doctor"
      ) {
        return { block: true, reason: POLICY_HOLD };
      }
      if (!event.toolName?.startsWith("mcp__remembrance__")) return;
      const tool = event.toolName.slice("mcp__remembrance__".length);
      if (!PRIVATE_EGRESS_TOOL_LANES[tool]) return;
      const local = current(ctx);
      const approve = async () => {
        if (!active(local, ctx)) return { block: true, reason: POLICY_HOLD };
        const binding = scope();
        const lane = PRIVATE_EGRESS_TOOL_LANES[tool];
        const receiptFile = `pi-egress-${binding}-${lane.replaceAll("_", "-")}.json`;
        const receipt = core.readHookStateFile(receiptFile, { env });
        const approved =
          receipt?.version === 1 &&
          receipt.scope === binding &&
          receipt.lane === lane &&
          receipt.approved === true;
        const descriptor = handlePrivateLessonSubmitApproval(
          { toolName: tool, input: event.input },
          {
            approvedLanes: new Set(approved ? [lane] : []),
          },
        )?.requireApproval;
        if (!descriptor) return;
        const unavailable = {
          block: true,
          reason:
            "Remembrance approval is required for this exact submission lane. This blocked call sent nothing and did not change any existing local draft. Retry the same action in an interactive Pi session and choose its native approval option; existing approval for another lane does not apply.",
        };
        if (!ctx.hasUI || typeof ctx.ui?.select !== "function")
          return unavailable;
        const labels = {
          "allow-once": "Allow this time",
          "allow-always": "Always allow this lane",
          deny: "Deny",
        };
        const originalArgs = JSON.stringify(event.input ?? {});
        let selected;
        try {
          selected = await ctx.ui.select(
            `${descriptor.title}\n\n${descriptor.description}\n\nAction: ${tool}\nArguments: ${originalArgs}`,
            descriptor.allowedDecisions.map((decision) => labels[decision]),
            { timeout: descriptor.timeoutMs },
          );
        } catch {
          active(local, ctx);
          return unavailable;
        }
        if (
          !active(local, ctx) ||
          JSON.stringify(event.input ?? {}) !== originalArgs
        )
          return unavailable;
        const decision = descriptor.allowedDecisions.find(
          (value) => labels[value] === selected,
        );
        if (decision !== "allow-once" && decision !== "allow-always") {
          return {
            block: true,
            reason:
              "Host policy denied this exact Remembrance action before transport. Do not retry through another transport.",
          };
        }
        if (decision === "allow-always") {
          const saved = core.writeHookStateFile(
            receiptFile,
            {
              version: 1,
              scope: binding,
              lane,
              approved: true,
              approved_at: new Date().toISOString(),
            },
            { env },
          );
          if (!saved)
            return {
              block: true,
              reason:
                "Remembrance could not safely save this lane approval. Retry the same action and choose Allow this time, or resolve local state storage before approving the lane again.",
            };
        }
      };
      // Sibling calls are preflighted in order by Pi. Keep dialogs serialized
      // for callers entering through concurrent nested tools as well.
      const pending = approvalQueue.then(approve, approve);
      approvalQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    });
    pi.on("tool_result", async (event, ctx) => {
      const local = current(ctx);
      if (
        !local ||
        local.blocked ||
        !event.toolName?.startsWith("mcp__remembrance__") ||
        !event.toolCallId
      )
        return;
      if (local.observed.has(event.toolCallId)) return;
      // Pi generates nested call IDs and parentToolCallId; payload claims do
      // not supply identity. Bound this in-memory window to the active run.
      local.observed.add(event.toolCallId);
      if (local.observed.size > 512)
        local.observed.delete(local.observed.values().next().value);
      const response = {
        content: event.content,
        structuredContent: event.structuredContent,
        details: event.details,
        isError: event.isError,
      };
      const args = event.input ?? {};
      try {
        health("tool_observer", ctx);
        if (core.toolResponseIndicatesFailure(response)) {
          const denial = core.recordHostPolicyDenial(
            {
              surface: SURFACE,
              sessionId: local.id,
              eventType: "tool_result",
              toolName: event.toolName,
              value: { ...response, tool_input: args },
              pluginVersion: version,
            },
            env,
          );
          if (denial) {
            notify(ctx, core.HOST_POLICY_ALERT_TEXT, "warning");
            core.markHostPolicyAlertDelivered(
              SURFACE,
              local.id,
              denial.id,
              env,
            );
          }
          return;
        }
        const tool = event.toolName.slice("mcp__remembrance__".length);
        if (tool === "query_skills") {
          if (core.queryResponseHasMatches(response))
            core.recordRegistryUse(local.id, env);
          core.recordHighMatchSurface(
            local.id,
            core.highMatchFromResponse(response),
            env,
          );
          core.recordValueEpisodeSurface(
            local.id,
            core.valueEpisodeFromResponse(response),
            env,
          );
          await core.recordDirectiveFollowThroughForTool(
            local.id,
            event.toolName,
            response,
            { env, fetchImpl: local.fetchImpl },
          );
        } else if (tool === "invoke_skill") {
          const selection = core.directSelectionFromResponse(response);
          if (selection) {
            core.recordDirectSelectionUse(local.id, selection, env);
            core.recordValueEpisodeSurface(
              local.id,
              core.valueEpisodeFromResponse(response),
              env,
            );
            core.clearHighMatchSurfaceForExplicitSelection(
              local.id,
              selection.slug,
              env,
            );
          }
        } else {
          core.clearHighMatchSurfaceIfOpened(
            local.id,
            event.toolName,
            args,
            env,
          );
        }
        if (!active(local, ctx)) return;
        await core.bindPrivateSkillNativeCapture(
          event.toolName,
          args,
          response,
          {
            env,
            nativeSessionId: local.id,
            nativeContextBridge: (...bridgeArgs) =>
              active(local, ctx)
                ? (
                    options.nativeContextBridge ??
                    core.runPrivateSkillNativeContextBridge
                  )(...bridgeArgs)
                : Promise.resolve({
                    status: "unavailable",
                    reason_code: "native_session_changed",
                  }),
          },
        );
        if (!active(local, ctx)) return;
        core.observeSuccessfulCompletionTool(
          local.id,
          event.toolName,
          args,
          response,
          env,
        );
      } catch {
        // Source, payloads and exception text never enter diagnostics.
        if (active(local, ctx))
          notify(
            ctx,
            "Remembrance could not record this tool's completion. Run run_connection_doctor before claiming the feedback or recovery loop is complete.",
            "warning",
          );
      }
    });
    pi.on("agent_before_settle", async (event, ctx) => {
      const local = current(ctx);
      if (
        !local ||
        local.blocked ||
        local.completed ||
        event.outcome !== "completed"
      )
        return;
      local.completed = true;
      try {
        health("completion_hook", ctx);
        const messages = event.context?.contextMessages ?? [];
        const last = [...messages]
          .reverse()
          .find((message) => message.role === "assistant");
        const answer = Array.isArray(last?.content)
          ? last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : "";
        const input = { session_id: local.id, last_assistant_message: answer };
        await core.reportTaskOutcomesOnStop(local.id, input, {
          env,
          userAgent: USER_AGENT,
          fetchImpl: local.fetchImpl,
        });
        if (!active(local, ctx)) return;
        const decision = core.decideStop(input, {
          env,
          visibleCompletionRecovery: true,
        });
        if (
          decision?.allow !== false ||
          !decision.reason ||
          local.completionRequested
        )
          return;
        local.completionRequested = true;
        core.writePromptedCount(local.id, decision.useCount ?? 1, env);
        core.acknowledgePrivateAuthorizationReminders(
          decision.reason,
          env,
          local.id,
        );
        local.recovery = core.completionContinuationReason(
          decision.reason,
          input,
          env,
          { answerShown: true },
        );
        // Boundary entries are persisted by Pi. Exact retained payloads stay
        // only in this scoped runtime and the next request's context copy.
        return {
          entries: [
            ...(event.entries ?? []),
            {
              type: "custom_message",
              customType: "remembrance-completion",
              content:
                "Complete the pending Remembrance actions supplied in the current request context, then preserve the task result.",
              display: false,
            },
          ],
          continue: true,
        };
      } catch {
        if (active(local, ctx))
          notify(
            ctx,
            "Remembrance completion tracking is incomplete. Run run_connection_doctor and resume the pending action through its normal recovery instructions.",
            "warning",
          );
      }
    });
    pi.on("agent_settled", async (_event, ctx) => {
      const local = current(ctx);
      if (!local) return;
      const alert = active(local, ctx)
        ? core.readPendingHostPolicyAlert(SURFACE, local.id, env)
        : null;
      if (alert) {
        notify(ctx, alert.text ?? core.HOST_POLICY_ALERT_TEXT, "warning");
        if (ctx.hasUI)
          core.markHostPolicyAlertDelivered(SURFACE, local.id, alert.id, env);
      }
      local.observed.clear();
      local.recovery = null;
    });
    pi.on("session_shutdown", () => {
      state = null;
    });
    pi.on("session_tree", () => {
      if (state) {
        state.prompt = null;
        state.delivered = false;
      }
    });
    pi.registerCommand("remembrance", {
      description: "Show Remembrance connection and recovery help",
      handler: async (_args, ctx) =>
        notify(
          ctx,
          "Run run_connection_doctor for connection health. Private submissions require the normal exact-action approval; command text does not approve them.",
        ),
    });
  };
}

export default createRemembranceExtension();
