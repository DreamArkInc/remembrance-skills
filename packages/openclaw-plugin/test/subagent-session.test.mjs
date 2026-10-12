// OpenClaw runs a subagent (sessions_spawn) in its own session, keyed
// agent:<agent id>:subagent:<uuid>. OpenClaw 2026.7.1-2 drops a finalize
// revise once a run called a tool with possible side effects (every MCP tool,
// query_skills included) and does not call the hook again. So a subagent is
// not asked: at each of its finalizes, whatever it owes goes to the session
// that spawned it, marked second-hand, and that session's next prompt offers
// it. Master's other visible-mode prompts stay, and where master asks about
// the debts the hand-up records the prompted count that ask records, so a
// later run of the subagent's session (sessions_send) is decided as master
// decides it. A run that ends without a finalize hands its debts up when
// OpenClaw announces it in a new run. A thread-bound subagent (mode
// "session") gets prompts of its own: it keeps its debts and is decided like
// any session, asked in visible mode only. The hooks are called as OpenClaw
// calls them: handler(event, ctx), each finalize exactly once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, {
  handleAfterToolCall,
  handleCompletion,
  ledgerIdFromEvent,
} from "../src/index.mjs";
import {
  hostPolicyAlertTextForOperation,
  readCompletionObligations,
  readPromptedCount,
  recordQueryFeedbackObligation,
  recordRegistryUse,
  recordTaskEligibility,
} from "../src/hook-core.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const CHILD_KEY = "agent:main:subagent:7f1c2b4e-9a0d-4c55-8e21-3b6f0d9c1a77";
const child = {
  runId: "run-child",
  sessionId: "child-session",
  sessionKey: CHILD_KEY,
  agentId: "main",
};
// Two more subagents: one spawned to run once (mode "run"), and one whose
// spawn this process never saw.
const runChild = {
  runId: "run-child-b",
  sessionId: "child-session-b",
  sessionKey: "agent:main:subagent:2d9e4a61-5b3c-4f08-9c7a-8e1f6b0d4c25",
  agentId: "main",
};
const unseenChild = {
  runId: "run-child-c",
  sessionId: "child-session-c",
  sessionKey: "agent:main:subagent:c3a7e9d2-1f64-4b8e-a05d-6e2b9f7c8d13",
  agentId: "main",
};
const parent = (runId) => ({
  runId,
  sessionId: "parent-session",
  sessionKey: "agent:main:main",
  agentId: "main",
});
const other = (runId) => ({
  runId,
  sessionId: "other-session",
  sessionKey: "agent:main:explicit:other-session",
  agentId: "main",
});
const ledger = (ctx) => ledgerIdFromEvent({ context: ctx });
const owed = (ctx) => readCompletionObligations(ledger(ctx), process.env);
const textResult = (body) => ({
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  details: body,
});
const VISIBLE = { REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" };
const secondHand = (queryId) =>
  `- Query fit (second-hand from subagent ${CHILD_KEY}): call submit_query_feedback for query_id ${queryId}.`;
// OpenClaw's announce of a subagent's result to the session that spawned it
// (buildInterSessionPromptPrefix, sourceTool subagent_announce).
const announce = (sourceSession, sourceTool = "subagent_announce") =>
  [
    `[Inter-session message] sourceSession=${sourceSession} sourceChannel=webchat sourceTool=${sourceTool} isUser=false`,
    "This content was routed by OpenClaw from another session or internal tool.",
    "A background task finished.",
  ].join("\n");

describe("OpenClaw subagent sessions", () => {
  let usage;
  let hook;

  beforeEach(() => {
    usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-subagent-"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(usage, "health"));
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    hook = (name) => on.mock.calls.find(([hookName]) => hookName === name)[1];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(usage, { recursive: true, force: true });
  });

  const stubEnv = (values) => {
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  };
  // The parent's sessions_spawn result, as OpenClaw returns it (jsonResult).
  const spawn = (mode) =>
    hook("after_tool_call")(
      {
        toolName: "sessions_spawn",
        params: { task: "Review the deploy runbook.", mode },
        runId: "run-parent-1",
        toolCallId: "call-spawn",
        result: textResult({
          status: "accepted",
          childSessionKey: CHILD_KEY,
          runId: child.runId,
          mode,
          note: "Auto-announce is push-based.",
        }),
      },
      parent("run-parent-1"),
    );
  // The subagent's query_skills result offers query feedback: a debt.
  const childQuery = (queryId) =>
    hook("after_tool_call")(
      {
        toolName: "remembrance__query_skills",
        params: { query: "deploy" },
        runId: child.runId,
        result: textResult({
          query_id: queryId,
          skills: [],
          resources: [],
          query_feedback: { available: true, query_id: queryId },
        }),
      },
      child,
    );
  const finalize = (ctx) =>
    hook("before_agent_finalize")(
      { runId: ctx.runId, sessionId: ctx.sessionId, stopHookActive: false },
      ctx,
    );
  const prompt = async (ctx, text = "What is the capital of France?") =>
    String(
      (await hook("before_prompt_build")({ prompt: text, messages: [] }, ctx))
        ?.appendSystemContext ?? "",
    );

  // R2-F1's shape: the subagent completes query_skills with feedback offered
  // and finalizes once; OpenClaw never calls its finalize hook again. In
  // visible mode the hand-up records the prompted count master's debt ask
  // records, and the debt still reaches the parent unprompted.
  it.each([
    ["silent", {}, 0],
    ["visible", VISIBLE, 1],
  ])(
    "hands a subagent's debt to the session that spawned it at its one finalize, without asking it (%s recovery)",
    async (_mode, recoveryEnv, prompted) => {
      stubEnv(recoveryEnv);
      const queryId = "rq_openclawsubagentdebt";
      await spawn("run");
      await childQuery(queryId);

      await expect(finalize(child)).resolves.toEqual({
        action: "finalize",
        why: "subagent_session",
      });
      expect(readPromptedCount(ledger(child), process.env)).toBe(prompted);
      expect(owed(child)).toEqual([]);
      expect(owed(parent("run-parent-2"))).toEqual([
        expect.objectContaining({
          kind: "query_feedback",
          query_id: queryId,
          prompted_at: null,
          transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
        }),
      ]);

      // An unrelated session is never offered it, nor closes it.
      expect(await prompt(other("run-other"))).not.toContain(queryId);
      expect(owed(parent("run-parent-2"))).toHaveLength(1);

      expect(await prompt(parent("run-parent-2"))).toContain(
        secondHand(queryId),
      );

      // The parent closes it through the normal lifecycle.
      await hook("after_tool_call")(
        {
          toolName: "remembrance__submit_query_feedback",
          params: { query_id: queryId, overall_fit: "none" },
          runId: "run-parent-2",
          result: textResult({ ok: true, status: 201 }),
        },
        parent("run-parent-2"),
      );
      expect(owed(parent("run-parent-3"))).toEqual([]);
      expect(await prompt(parent("run-parent-3"))).not.toContain(queryId);
    },
  );

  // The same finalize for a main session keeps its debt unasked in silent mode
  // and, in visible mode, revises and records its prompted count. A
  // thread-bound subagent (mode "session") gets prompts of its own, so its
  // finalize is decided exactly as the main session's. Any other subagent is
  // asked in neither mode: its debt goes up, or waits for the session that
  // spawned it, and in visible mode it records the prompted count of the ask
  // it replaces.
  it.each([
    ["silent", {}, "finalize", []],
    ["visible", VISIBLE, "revise", [1]],
  ])(
    "decides a thread-bound subagent's finalize as a main session's and asks no other subagent (%s recovery)",
    async (_mode, recoveryEnv, action, counts) => {
      stubEnv(recoveryEnv);
      const queryId = "rq_openclawfinalizeask";
      const subagentRequesters = new Map();
      const spawned = (childSessionKey, mode) =>
        handleAfterToolCall(
          {
            toolName: "sessions_spawn",
            result: textResult({ status: "accepted", childSessionKey, mode }),
            context: parent("run-parent-1"),
          },
          { subagentRequesters, recordHealth: () => {} },
        );
      await spawned(CHILD_KEY, "session");
      await spawned(runChild.sessionKey, "run");
      const decide = (ctx) => {
        recordQueryFeedbackObligation(
          ledger(ctx),
          { available: true, query_id: queryId },
          process.env,
        );
        const writePromptedCount = vi.fn(() => true);
        const decision = handleCompletion(
          { context: ctx, lastAssistantMessage: "Runbook reviewed." },
          {
            subagentRequesters,
            writePromptedCount,
            readPendingHostPolicyAlert: () => null,
          },
        );
        const counts = writePromptedCount.mock.calls.map(([, count]) => count);
        return { decision, counts };
      };
      const notAsked = {
        decision: { action: "finalize", why: "subagent_session" },
        counts,
      };
      const kept = [
        expect.objectContaining({ query_id: queryId, transferred_from: null }),
      ];

      const main = decide(other("run-other"));
      expect(main.decision.action).toBe(action);
      expect(main.counts).toEqual(counts);
      expect(decide(child)).toEqual(main);
      expect(owed(child)).toEqual(kept);

      expect(decide(runChild)).toEqual(notAsked);
      expect(owed(runChild)).toEqual([]);
      expect(owed(parent("run-parent-2"))).toEqual([
        expect.objectContaining({
          query_id: queryId,
          transferred_from: {
            agent_id: runChild.sessionKey,
            transcript_path: null,
          },
        }),
      ]);

      expect(decide(unseenChild)).toEqual(notAsked);
      expect(owed(unseenChild)).toEqual(kept);
    },
  );

  // Besides the debt ask, master's decideStop has visible-mode prompts that
  // are not about debts: a contribution for registry use above the prompted
  // count, a high-value lesson in the final message, an eligible task left
  // unclosed. A subagent that is not thread-bound keeps them, decided exactly
  // as a main session in the same state; silent mode asks neither.
  const otherPrompts = {
    contribution: [
      (ctx) => recordRegistryUse(ledger(ctx), process.env),
      "Runbook reviewed.",
      "prompt_contribution",
    ],
    "high-value lesson": [
      () => {},
      "Runbook reviewed. I missed the migration step at first, so the deploy failed once.",
      "prompt_high_value_lesson_contribution",
    ],
    "task closure": [
      (ctx) => recordTaskEligibility(ledger(ctx), process.env),
      "Runbook reviewed.",
      "prompt_task_closure",
    ],
  };
  it.each(
    ["silent", "visible"].flatMap((mode) =>
      Object.keys(otherPrompts).map((name) => [mode, name]),
    ),
  )(
    "decides a subagent's %s-mode %s prompt as master decides a main session's",
    async (mode, name) => {
      if (mode === "visible") stubEnv(VISIBLE);
      const [seed, message, why] = otherPrompts[name];
      const subagentRequesters = new Map();
      await handleAfterToolCall(
        {
          toolName: "sessions_spawn",
          result: textResult({
            status: "accepted",
            childSessionKey: CHILD_KEY,
            mode: "run",
          }),
          context: parent("run-parent-1"),
        },
        { subagentRequesters, recordHealth: () => {} },
      );
      const decide = (ctx) => {
        seed(ctx);
        const writePromptedCount = vi.fn(() => true);
        const decision = handleCompletion(
          { context: ctx, lastAssistantMessage: message },
          {
            subagentRequesters,
            writePromptedCount,
            readPendingHostPolicyAlert: () => null,
          },
        );
        const counts = writePromptedCount.mock.calls.map(([, count]) => count);
        return { decision, counts };
      };

      const main = decide(other("run-other"));
      const subagent = decide(child);
      if (mode === "visible") {
        expect(main.decision).toEqual(
          expect.objectContaining({ action: "revise", why }),
        );
        expect(main.counts).toHaveLength(1);
        expect(subagent).toEqual(main);
      } else {
        expect(main).toEqual({
          decision: { action: "finalize", why: "silent_prompt_recovery" },
          counts: [],
        });
        expect(subagent).toEqual({
          decision: { action: "finalize", why: "subagent_session" },
          counts: [],
        });
      }
      expect(owed(parent("run-parent-2"))).toEqual([]);
    },
  );

  // Master asks first about what a session owes, whatever else it used. For
  // a subagent that is not thread-bound that ask alone becomes the hand-up:
  // decided on its ledger before the debts move, it gets no contribution
  // prompt for the registry use that came with them, and in visible mode it
  // records the prompted count master's ask records.
  it.each([
    ["silent", {}, { action: "finalize", why: "silent_prompt_recovery" }, []],
    [
      "visible",
      VISIBLE,
      expect.objectContaining({
        action: "revise",
        why: "prompt_pending_obligations",
      }),
      [1],
    ],
  ])(
    "hands up a subagent's debts in place of master's debt ask when it also used the registry (%s recovery)",
    async (_mode, recoveryEnv, mainDecision, counts) => {
      stubEnv(recoveryEnv);
      const queryId = "rq_openclawsubagentused";
      const subagentRequesters = new Map();
      await handleAfterToolCall(
        {
          toolName: "sessions_spawn",
          result: textResult({
            status: "accepted",
            childSessionKey: CHILD_KEY,
            mode: "run",
          }),
          context: parent("run-parent-1"),
        },
        { subagentRequesters, recordHealth: () => {} },
      );
      const decide = (ctx) => {
        recordRegistryUse(ledger(ctx), process.env);
        recordQueryFeedbackObligation(
          ledger(ctx),
          { available: true, query_id: queryId },
          process.env,
        );
        const writePromptedCount = vi.fn(() => true);
        const decision = handleCompletion(
          { context: ctx, lastAssistantMessage: "Runbook reviewed." },
          {
            subagentRequesters,
            writePromptedCount,
            readPendingHostPolicyAlert: () => null,
          },
        );
        const counts = writePromptedCount.mock.calls.map(([, count]) => count);
        return { decision, counts };
      };

      const main = decide(other("run-other"));
      expect(main.decision).toEqual(mainDecision);
      expect(main.counts).toEqual(counts);
      expect(decide(child)).toEqual({
        decision: { action: "finalize", why: "subagent_session" },
        counts,
      });
      expect(owed(child)).toEqual([]);
      expect(owed(parent("run-parent-2"))).toEqual([
        expect.objectContaining({
          query_id: queryId,
          transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
        }),
      ]);
    },
  );

  // A subagent's session can get later runs: OpenClaw's sessions_send, a wake
  // run, or the honored revise of a host-policy alert. Master decides each of
  // their finalizes from the prompted count its debt ask recorded. The
  // hand-up records the same count, so a later finalize asks nothing master
  // does not; a main session in the same states is decided as on master.
  const masterLater = {
    silent: {
      "a second run": [
        ["finalize", "silent_prompt_recovery"],
        ["finalize", "silent_prompt_recovery"],
      ],
      "an honored alert revise": [
        ["revise", "host_policy_denial"],
        ["finalize", "silent_prompt_recovery"],
      ],
    },
    visible: {
      "a second run": [
        ["revise", "prompt_pending_obligations"],
        ["finalize", "no_new_usage"],
      ],
      "an honored alert revise": [
        ["revise", "host_policy_denial"],
        ["revise", "prompt_pending_obligations"],
      ],
    },
  };
  // Each finalize of the sequence: its run, and whether a host-policy alert
  // is pending.
  const laterRuns = {
    "a second run": [
      ["run-1", false],
      ["run-2", false],
    ],
    "an honored alert revise": [
      ["run-1", true],
      ["run-1", false],
    ],
  };
  it.each(
    ["silent", "visible"].flatMap((mode) =>
      Object.keys(laterRuns).map((name) => [mode, name]),
    ),
  )(
    "decides each later finalize of a subagent's session as master does (%s recovery, %s)",
    async (mode, name) => {
      if (mode === "visible") stubEnv(VISIBLE);
      const queryId = "rq_openclawsubagentlater";
      const subagentRequesters = new Map();
      await handleAfterToolCall(
        {
          toolName: "sessions_spawn",
          result: textResult({
            status: "accepted",
            childSessionKey: CHILD_KEY,
            mode: "run",
          }),
          context: parent("run-parent-1"),
        },
        { subagentRequesters, recordHealth: () => {} },
      );
      const decisions = (session) => {
        // The first run used the registry and left a query-feedback debt.
        recordRegistryUse(ledger(session("run-1")), process.env);
        recordQueryFeedbackObligation(
          ledger(session("run-1")),
          { available: true, query_id: queryId },
          process.env,
        );
        return laterRuns[name].map(([runId, alert]) => {
          const decision = handleCompletion(
            {
              context: session(runId),
              lastAssistantMessage: "Runbook reviewed.",
            },
            {
              subagentRequesters,
              readPendingHostPolicyAlert: () =>
                alert
                  ? { id: "alert-1", operation_class: "private_egress" }
                  : null,
              markHostPolicyAlertDelivered: () => {},
            },
          );
          return [decision.action, decision.why];
        });
      };
      const master = masterLater[mode][name];
      const prompted = mode === "visible" ? 1 : 0;

      expect(decisions(other)).toEqual(master);
      expect(readPromptedCount(ledger(other("run-1")), process.env)).toBe(
        prompted,
      );
      expect(owed(other("run-1"))).toHaveLength(1);

      expect(decisions((runId) => ({ ...child, runId }))).toEqual(
        master.map(([action, why]) =>
          action === "finalize" || why === "prompt_pending_obligations"
            ? ["finalize", "subagent_session"]
            : [action, why],
        ),
      );
      expect(readPromptedCount(ledger(child), process.env)).toBe(prompted);
      expect(owed(child)).toEqual([]);
      expect(owed(parent("run-parent-2"))).toEqual([
        expect.objectContaining({
          query_id: queryId,
          prompted_at: null,
          transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
        }),
      ]);
      expect(await prompt(parent("run-parent-2"))).toContain(
        secondHand(queryId),
      );
    },
  );

  // A pending host-policy alert still revises a subagent's finalize exactly
  // as before, and its debts have already gone up.
  it("hands the debt up at a subagent finalize that revises for a host-policy alert", async () => {
    const subagentRequesters = new Map();
    await handleAfterToolCall(
      {
        toolName: "sessions_spawn",
        result: textResult({
          status: "accepted",
          childSessionKey: CHILD_KEY,
          mode: "run",
        }),
        context: parent("run-parent-1"),
      },
      { subagentRequesters, recordHealth: () => {} },
    );
    recordQueryFeedbackObligation(
      ledger(child),
      { available: true, query_id: "rq_openclawsubagentalert" },
      process.env,
    );
    const markHostPolicyAlertDelivered = vi.fn();
    const decision = handleCompletion(
      { context: child, lastAssistantMessage: "Runbook reviewed." },
      {
        subagentRequesters,
        readPendingHostPolicyAlert: () => ({
          id: "alert-1",
          operation_class: "private_egress",
        }),
        markHostPolicyAlertDelivered,
      },
    );
    const alert = hostPolicyAlertTextForOperation("private_egress");
    expect(decision).toEqual({
      action: "revise",
      reason: alert,
      retry: { instruction: alert, maxAttempts: 1 },
      why: "host_policy_denial",
    });
    expect(markHostPolicyAlertDelivered).toHaveBeenCalledTimes(1);
    expect(owed(child)).toEqual([]);
    expect(owed(parent("run-parent-2"))).toEqual([
      expect.objectContaining({
        query_id: "rq_openclawsubagentalert",
        transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
      }),
    ]);
  });

  // OpenClaw starts the subagent's run before sessions_spawn returns, and
  // its after_tool_call is not awaited: a subagent can finish first.
  it("hands a subagent's debt up when its spawn result arrives after it finished", async () => {
    const queryId = "rq_openclawsubagentfirst";
    await childQuery(queryId);
    await expect(finalize(child)).resolves.toEqual({
      action: "finalize",
      why: "subagent_session",
    });
    expect(owed(child)).toEqual([
      expect.objectContaining({ query_id: queryId }),
    ]);
    expect(owed(parent("run-parent-2"))).toEqual([]);

    await spawn("run");
    expect(owed(child)).toEqual([]);
    expect(await prompt(other("run-other"))).not.toContain(queryId);
    expect(await prompt(parent("run-parent-2"))).toContain(secondHand(queryId));
  });

  // A thread-bound subagent (mode "session") gets later prompts of its own:
  // it keeps its debt for them, and its finalize is decided as on master:
  // kept unasked in silent mode, asked once in visible mode. Until its spawn
  // result is seen, it counts as a subagent that is not thread-bound: not
  // asked, and in visible mode it records the prompted count of the ask it
  // replaces.
  const askedOnce = expect.objectContaining({
    action: "revise",
    why: "prompt_pending_obligations",
    retry: expect.objectContaining({ maxAttempts: 1 }),
  });
  const silentKeep = { action: "finalize", why: "silent_prompt_recovery" };
  const notAsked = { action: "finalize", why: "subagent_session" };
  it.each([
    ["silent, spawn result first", {}, true, silentKeep, 0],
    ["visible, spawn result first", VISIBLE, true, askedOnce, 1],
    ["silent, finalize first", {}, false, notAsked, 0],
    ["visible, finalize first", VISIBLE, false, notAsked, 1],
  ])(
    "keeps a thread-bound subagent's debt for its own next prompt (%s)",
    async (_case, recoveryEnv, spawnFirst, decision, prompted) => {
      stubEnv(recoveryEnv);
      const queryId = "rq_openclawsubagentkept";
      if (spawnFirst) await spawn("session");
      await childQuery(queryId);
      await expect(finalize(child)).resolves.toEqual(decision);
      if (!spawnFirst) await spawn("session");
      expect(readPromptedCount(ledger(child), process.env)).toBe(prompted);
      expect(owed(child)).toEqual([
        expect.objectContaining({ query_id: queryId, transferred_from: null }),
      ]);
      expect(owed(parent("run-parent-2"))).toEqual([]);
      expect(await prompt(parent("run-parent-2"))).not.toContain(queryId);
      // Not even OpenClaw's announce of its result moves it.
      expect(
        await prompt(parent("run-parent-3"), announce(CHILD_KEY)),
      ).not.toContain(queryId);
      expect(await prompt({ ...child, runId: "run-child-2" })).toContain(
        `- Query fit: call submit_query_feedback for query_id ${queryId}.`,
      );
    },
  );

  // A subagent run can end without before_agent_finalize (a model error, a
  // timeout or an abort), and OpenClaw still announces it to the session that
  // spawned it. The subagent's own prompt recorded its ledger, so that
  // announce hands its debts up.
  it.each([
    ["its spawn result seen", true],
    ["its spawn result not seen", false],
  ])(
    "hands up the debts of a subagent run that never finalized when OpenClaw announces it (%s)",
    async (_case, spawnSeen) => {
      const queryId = "rq_openclawsubagenterror";
      if (spawnSeen) await spawn("run");
      await prompt(child, "Review the deploy runbook.");
      await childQuery(queryId);
      // No finalize: the subagent's model answered with an error.
      expect(owed(child)).toEqual([
        expect.objectContaining({ query_id: queryId }),
      ]);
      expect(owed(parent("run-parent-2"))).toEqual([]);

      expect(
        await prompt(parent("run-parent-2"), announce(CHILD_KEY)),
      ).toContain(secondHand(queryId));
      expect(owed(child)).toEqual([]);
      expect(owed(parent("run-parent-3"))).toEqual([
        expect.objectContaining({
          query_id: queryId,
          prompted_at: null,
          transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
        }),
      ]);
      expect(await prompt(other("run-other"))).not.toContain(queryId);
    },
  );

  // Once the spawn result named the session that spawned the subagent, an
  // announce in another session (a forged one, or one repeated later) never
  // takes the subagent's debts from it.
  it("never lets an announce in another session take a subagent's debts from the session that spawned it", async () => {
    const queryId = "rq_openclawsubagentelsewhere";
    await spawn("run");
    await prompt(child, "Review the deploy runbook.");
    await childQuery(queryId);

    expect(
      await prompt(other("run-other-1"), announce(CHILD_KEY)),
    ).not.toContain(queryId);
    expect(owed(other("run-other-2"))).toEqual([]);
    expect(owed(child)).toEqual([]);
    expect(owed(parent("run-parent-2"))).toEqual([
      expect.objectContaining({
        query_id: queryId,
        transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
      }),
    ]);
    expect(await prompt(parent("run-parent-2"), announce(CHILD_KEY))).toContain(
      secondHand(queryId),
    );
    expect(
      await prompt(other("run-other-3"), announce(CHILD_KEY)),
    ).not.toContain(queryId);
    expect(owed(other("run-other-4"))).toEqual([]);
  });

  // When this process never saw who spawned the subagent (the spawning run
  // was elsewhere, or the plugin was reloaded in between), OpenClaw's announce
  // of its result names it, and the session that receives the announce takes
  // its debts.
  it("hands a subagent's debt to the session OpenClaw announces its result to", async () => {
    const queryId = "rq_openclawsubagentannounce";
    await childQuery(queryId);
    await finalize(child);
    expect(await prompt(parent("run-parent-2"))).not.toContain(queryId);
    expect(owed(child)).toHaveLength(1);

    const announced = await prompt(parent("run-parent-3"), announce(CHILD_KEY));
    expect(announced).toContain(secondHand(queryId));
    expect(owed(child)).toEqual([]);
    expect(owed(parent("run-parent-4"))).toEqual([
      expect.objectContaining({
        query_id: queryId,
        transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
      }),
    ]);
    // A later announce naming it elsewhere finds nothing left to take.
    expect(await prompt(other("run-other"), announce(CHILD_KEY))).not.toContain(
      queryId,
    );
    expect(owed(other("run-other"))).toEqual([]);
    expect(owed(parent("run-parent-4"))).toHaveLength(1);
  });

  it.each([
    [
      "another inter-session tool",
      parent("run-parent-3"),
      announce(CHILD_KEY, "sessions_send"),
    ],
    [
      "an announce quoted inside a prompt",
      parent("run-parent-3"),
      `Look at this: ${announce(CHILD_KEY)}`,
    ],
    [
      "the subagent's own wake run",
      { ...child, runId: "run-child-2" },
      announce(CHILD_KEY),
    ],
  ])("takes no subagent debt from %s", async (_case, ctx, text) => {
    const queryId = "rq_openclawsubagentnotannounced";
    await childQuery(queryId);
    await finalize(child);
    await prompt(ctx, text);
    expect(owed(parent("run-parent-4"))).toEqual([]);
    expect(owed(child)).toEqual([
      expect.objectContaining({ query_id: queryId, transferred_from: null }),
    ]);
  });
});
