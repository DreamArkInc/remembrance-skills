// OpenClaw 2026.7.1-2 calls subagent_ended once for each ended subagent run
// that is not thread-bound (outcome ok, error, timeout or killed), after it
// has delivered the announce of that run to the session that spawned the
// subagent. Its context names the subagent (childSessionKey) and that
// session (requesterSessionKey) from OpenClaw's own registry. A subagent run
// that ends without before_agent_finalize (a model error, a timeout, an
// abort) while the spawning session still has a run in progress gets its
// announce steered into that run: no new run starts and no prompt hook sees
// it. subagent_ended then hands the subagent's debts up, so the spawning
// session's next prompt offers them second-hand, with no later message to
// the subagent. The hooks are called as OpenClaw calls them: handler(event,
// ctx). Transfer semantics (what moves when the parent's ledger is full or
// already holds a copy) are hook-core's (transferSubagentObligations); these
// tests only move debts the parent does not hold yet.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as adapter from "../src/index.mjs";
import {
  agentLedgerIdFor,
  decideStop,
  observeSuccessfulCompletionTool,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  readPendingHostPolicyAlert,
  recordHostPolicyDenial,
  recordQueryFeedbackObligation,
  transferSubagentObligations,
} from "../src/hook-core.mjs";
import {
  readPendingActionPayload,
  resupplyPayloadDigest,
} from "../src/pending-action-payload.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const CHILD_KEY = "agent:main:subagent:7f1c2b4e-9a0d-4c55-8e21-3b6f0d9c1a77";
const PARENT_KEY = "agent:main:main";
const child = (runId = "run-child", sessionId = "child-session") => ({
  runId,
  sessionId,
  sessionKey: CHILD_KEY,
  agentId: "main",
});
const sibling = {
  runId: "run-sibling",
  sessionId: "sibling-session",
  sessionKey: "agent:main:subagent:2d9e4a61-5b3c-4f08-9c7a-8e1f6b0d4c25",
  agentId: "main",
};
const parent = (runId) => ({
  runId,
  sessionId: "parent-session",
  sessionKey: PARENT_KEY,
  agentId: "main",
});
const other = (runId) => ({
  runId,
  sessionId: "other-session",
  sessionKey: "agent:main:explicit:other-session",
  agentId: "main",
});
const plugin = adapter.default;
const ledger = (ctx) => adapter.ledgerIdFromEvent({ context: ctx });
const owed = (ctx) => readCompletionObligations(ledger(ctx), process.env);
const textResult = (body) => ({
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  details: body,
});
const secondHand = (queryId, key = CHILD_KEY) =>
  `- Query fit (second-hand from subagent ${key}): call submit_query_feedback for query_id ${queryId}.`;
// What OpenClaw passes (subagent-registry emitSubagentEndedHookOnce).
const REASONS = {
  ok: "subagent-complete",
  error: "subagent-error",
  timeout: "subagent-complete",
  killed: "subagent-killed",
};
const endedEvent = (outcome, key = CHILD_KEY, runId = "run-child") => ({
  targetSessionKey: key,
  targetKind: "subagent",
  reason: REASONS[outcome],
  sendFarewell: true,
  runId,
  endedAt: Date.now(),
  outcome,
  ...(outcome === "error" ? { error: "model request failed" } : {}),
});
const endedCtx = (
  key = CHILD_KEY,
  runId = "run-child",
  requesterSessionKey = PARENT_KEY,
) => ({ runId, childSessionKey: key, requesterSessionKey });

describe("OpenClaw subagent_ended", () => {
  let usage;
  let hook;
  let warn;

  beforeEach(() => {
    usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-ended-"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(usage, "health"));
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
    const on = vi.fn();
    warn = vi.fn();
    plugin.register({
      on,
      logger: { info: vi.fn(), warn },
      registerCli: vi.fn(),
    });
    hook = (name) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(usage, { recursive: true, force: true });
  });

  // The spawning session's sessions_spawn result, as OpenClaw returns it.
  const spawn = (mode, ctx = child(), from = parent("run-parent-1")) =>
    hook("after_tool_call")(
      {
        toolName: "sessions_spawn",
        params: { task: "Review the deploy runbook.", mode },
        runId: from.runId,
        toolCallId: "call-spawn",
        result: textResult({
          status: "accepted",
          childSessionKey: ctx.sessionKey,
          runId: ctx.runId,
          mode,
        }),
      },
      from,
    );
  // The subagent's own prompt (records its ledger), then a query_skills
  // result offering query feedback: a debt.
  const prompt = async (ctx, text = "What is the capital of France?") =>
    String(
      (await hook("before_prompt_build")({ prompt: text, messages: [] }, ctx))
        ?.appendSystemContext ?? "",
    );
  const childWork = async (queryId, ctx = child()) => {
    await prompt(ctx, "Review the deploy runbook.");
    await hook("after_tool_call")(
      {
        toolName: "remembrance__query_skills",
        params: { query: "deploy" },
        runId: ctx.runId,
        result: textResult({
          query_id: queryId,
          skills: [],
          resources: [],
          query_feedback: { available: true, query_id: queryId },
        }),
      },
      ctx,
    );
  };
  const finalize = (ctx) =>
    hook("before_agent_finalize")(
      { runId: ctx.runId, sessionId: ctx.sessionId, stopHookActive: false },
      ctx,
    );
  // Absent on a plugin that does not register the hook: then nothing runs.
  const ended = (event, ctx) => hook("subagent_ended")?.(event, ctx);
  // Every file the plugin keeps under its usage directory, with its bytes
  // (lifecycle markers apart).
  const snapshot = () => {
    const files = {};
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (path === join(usage, "health")) continue;
        if (statSync(path).isDirectory()) walk(path);
        else files[relative(usage, path)] = readFileSync(path, "utf8");
      }
    };
    walk(usage);
    return files;
  };
  const handedUp = (queryId, key = CHILD_KEY) =>
    expect.objectContaining({
      kind: "query_feedback",
      query_id: queryId,
      prompted_at: null,
      transferred_from: { agent_id: key, transcript_path: null },
    });

  // R4's shape: the subagent's run ends without a finalize while the
  // spawning session's run is still in progress, so OpenClaw steers the
  // announce into that run and no prompt hook sees it.
  it.each(["error", "timeout", "killed", "ok"])(
    "hands a subagent's debts to the spawning session when its run ends without a finalize while that session is still running (%s)",
    async (outcome) => {
      const queryId = `rq_openclawended${outcome}`;
      await spawn("run");
      await childWork(queryId);
      expect(owed(child())).toEqual([
        expect.objectContaining({ query_id: queryId }),
      ]);
      expect(owed(parent("run-parent-1"))).toEqual([]);

      const fetchSpy = vi.fn(async () => {
        throw new TypeError("network disabled in tests");
      });
      vi.stubGlobal("fetch", fetchSpy);
      await ended(endedEvent(outcome), endedCtx());
      // Local ledger work only: no registry, catalog or revision request.
      expect(fetchSpy).not.toHaveBeenCalled();

      // Moved while the spawning session's run is still in progress: no new
      // prompt of it was needed, and no later message to the subagent.
      expect(owed(child())).toEqual([]);
      expect(owed(parent("run-parent-1"))).toEqual([handedUp(queryId)]);
      // No other session is offered it or holds it.
      expect(await prompt(other("run-other"))).not.toContain(queryId);
      expect(owed(other("run-other"))).toEqual([]);
      // The spawning session's next prompt offers it, second-hand.
      expect(await prompt(parent("run-parent-2"))).toContain(
        secondHand(queryId),
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("does nothing more after a normal finalize already handed the debts up", async () => {
    const queryId = "rq_openclawendedafterfinalize";
    await spawn("run");
    await childWork(queryId);
    await expect(finalize(child())).resolves.toEqual({
      action: "finalize",
      why: "subagent_session",
    });
    expect(owed(child())).toEqual([]);
    expect(owed(parent("run-parent-2"))).toEqual([handedUp(queryId)]);
    const before = snapshot();

    await ended(endedEvent("ok"), endedCtx());

    expect(snapshot()).toEqual(before);
  });

  it("moves the debts once however often OpenClaw reports the end", async () => {
    const queryId = "rq_openclawendedduplicate";
    await spawn("run");
    await childWork(queryId);
    await ended(endedEvent("error"), endedCtx());
    const once = snapshot();
    expect(owed(parent("run-parent-2"))).toEqual([handedUp(queryId)]);

    await ended(endedEvent("error"), endedCtx());
    await ended(endedEvent("killed"), endedCtx());

    expect(snapshot()).toEqual(once);
    expect(owed(child())).toEqual([]);
    expect(owed(parent("run-parent-2"))).toEqual([handedUp(queryId)]);
  });

  // OpenClaw starts the subagent's run before sessions_spawn returns, and
  // its after_tool_call is not awaited: the run can end first.
  it("hands the debts up when the spawn result arrives after the run ended", async () => {
    const queryId = "rq_openclawendedlatespawn";
    await childWork(queryId);
    await ended(endedEvent("error"), endedCtx());
    expect(owed(child())).toEqual([
      expect.objectContaining({ query_id: queryId, transferred_from: null }),
    ]);
    expect(owed(parent("run-parent-1"))).toEqual([]);

    await spawn("run");

    expect(owed(child())).toEqual([]);
    expect(owed(parent("run-parent-2"))).toEqual([handedUp(queryId)]);
    expect(await prompt(other("run-other"))).not.toContain(queryId);
    expect(await prompt(parent("run-parent-2"))).toContain(secondHand(queryId));
  });

  // The plugin remembers a subagent only in its bounded record map (at most
  // 512), which the subagent's own hooks or its spawn result fill: an end
  // reported for a subagent this process never saw adds nothing to it.
  it("remembers nothing for subagents this process never saw", () => {
    const subagentRequesters = new Map();
    for (let index = 0; index < 600; index += 1) {
      const key = `agent:main:subagent:unseen-${index}`;
      adapter.handleSubagentEnded(endedEvent("error", key), endedCtx(key), {
        subagentRequesters,
      });
    }
    expect(subagentRequesters.size).toBe(0);
  });

  it.each([
    ["the spawn result first", true],
    ["the end first", false],
  ])(
    "leaves a thread-bound subagent's debts with it (%s)",
    async (_case, spawnFirst) => {
      const queryId = "rq_openclawendedthreadbound";
      if (spawnFirst) await spawn("session");
      await childWork(queryId);
      // OpenClaw reports a killed thread-bound run too.
      await ended(endedEvent("killed"), endedCtx());
      if (!spawnFirst) await spawn("session");

      expect(owed(child())).toEqual([
        expect.objectContaining({ query_id: queryId, transferred_from: null }),
      ]);
      expect(owed(parent("run-parent-2"))).toEqual([]);
      expect(await prompt(parent("run-parent-2"))).not.toContain(queryId);
    },
  );

  // An announce that starts a new run of the spawning session names that
  // session as the subagent's requester, also for a thread-bound subagent
  // (pullAnnouncedSubagentDebts). Its end must still move nothing.
  it("leaves a thread-bound subagent's debts with it after an announce named its requester", async () => {
    const queryId = "rq_openclawendedthreadannounce";
    await spawn("session");
    await childWork(queryId);
    await prompt(
      parent("run-parent-announce"),
      [
        `[Inter-session message] sourceSession=${CHILD_KEY} sourceChannel=webchat sourceTool=subagent_announce isUser=false`,
        "This content was routed by OpenClaw from another session or internal tool.",
        "The thread-bound subagent finished its turn.",
      ].join("\n"),
    );
    await ended(endedEvent("killed"), endedCtx());

    expect(owed(child())).toEqual([
      expect.objectContaining({ query_id: queryId, transferred_from: null }),
    ]);
    expect(owed(parent("run-parent-2"))).toEqual([]);
    expect(await prompt(parent("run-parent-2"))).not.toContain(queryId);
  });

  // R4A-1 (round-4 adapter review): after a Gateway restart this process
  // has no spawn result, so an announce is how it learns the spawning
  // session. Once it has seen two runs of the subagent start, the announce
  // pulls nothing (R3A-2), but it must still name that session, so that the
  // later run's end hands the debts up.
  it("learns the spawning session from an announce after a Gateway restart, also once two runs of the subagent started: the later run's end hands up (R4A-1)", async () => {
    const queryId = "rq_openclawrestarttworuns";
    await prompt(parent("run-parent-1"));
    await spawn("run");
    await childWork(queryId);
    // The run errors (no finalize) and its announce is still pending when
    // the Gateway restarts: the plugin is registered again, memory empty.
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn(), warn }, registerCli: vi.fn() });
    hook = (name) => on.mock.calls.find(([hookName]) => hookName === name)?.[1];
    await prompt(child("run-child-2"), "Follow up.");
    await prompt(child("run-child-3"), "Follow up again.");
    await prompt(
      parent("run-parent-2"),
      [
        `[Inter-session message] sourceSession=${CHILD_KEY} sourceChannel=webchat sourceTool=subagent_announce isUser=false`,
        "This content was routed by OpenClaw from another session or internal tool.",
        "A background task finished.",
      ].join("\n"),
    );
    expect(owed(child())).toEqual([
      expect.objectContaining({ query_id: queryId }),
    ]);
    await ended(
      endedEvent("error", CHILD_KEY, "run-child-3"),
      endedCtx(CHILD_KEY, "run-child-3"),
    );
    expect(owed(child())).toEqual([]);
    expect(owed(parent("run-parent-3"))).toEqual([
      expect.objectContaining({
        query_id: queryId,
        transferred_from: expect.objectContaining({ agent_id: CHILD_KEY }),
      }),
    ]);
    expect(await prompt(parent("run-parent-3"))).toContain(secondHand(queryId));
  });

  // A later run of the subagent's session (OpenClaw's sessions_send) leaves
  // new debts, which its finalize hands up; nothing moves twice.
  it("moves each debt once across later runs of the subagent's session", async () => {
    await spawn("run");
    await childWork("rq_openclawendedfirstrun");
    await ended(endedEvent("error"), endedCtx());
    await childWork("rq_openclawendedlaterrun", child("run-child-2"));
    await finalize(child("run-child-2"));
    const handed = snapshot();
    await ended(endedEvent("ok", CHILD_KEY, "run-child-2"), {
      ...endedCtx(CHILD_KEY, "run-child-2"),
    });

    expect(snapshot()).toEqual(handed);
    expect(owed(child())).toEqual([]);
    expect(
      owed(parent("run-parent-2"))
        .map((debt) => debt.query_id)
        .sort(),
    ).toEqual(["rq_openclawendedfirstrun", "rq_openclawendedlaterrun"]);
  });

  // Every later run of the subagent's session ends with an event of its own.
  // Once the parent declined what moved up, a later end must not bring it
  // back: the hand-up moves debts, it does not copy them.
  it("does not offer a declined debt again when a later run of the subagent ends", async () => {
    const queryId = "rq_openclawendeddeclined";
    await spawn("run");
    await childWork(queryId);
    await ended(endedEvent("error"), endedCtx());
    const offered = await prompt(parent("run-parent-2"));
    expect(offered).toContain(secondHand(queryId));
    const actionId = /action_id ([a-f0-9]{16})/u.exec(offered)?.[1];
    expect(actionId).toMatch(/^[a-f0-9]{16}$/u);
    const decline = {
      action_id: actionId,
      reason: "not_observed_by_this_agent",
    };
    await hook("after_tool_call")(
      {
        toolName: "remembrance__decline_pending_action",
        params: decline,
        runId: "run-parent-2",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "declined",
                ...decline,
                submitted: false,
                local_only: true,
              }),
            },
          ],
        },
      },
      parent("run-parent-2"),
    );
    expect(owed(parent("run-parent-3"))).toEqual([]);
    const declined = snapshot();

    await ended(
      endedEvent("ok", CHILD_KEY, "run-child-2"),
      endedCtx(CHILD_KEY, "run-child-2"),
    );
    await ended(
      endedEvent("error", CHILD_KEY, "run-child-3"),
      endedCtx(CHILD_KEY, "run-child-3"),
    );

    expect(snapshot()).toEqual(declined);
    expect(owed(child())).toEqual([]);
    expect(owed(parent("run-parent-3"))).toEqual([]);
    expect(await prompt(parent("run-parent-3"))).not.toContain(queryId);
  });

  // A full parent ledger counts a moved debt in its overflow marker instead
  // of holding it, as at a finalize. Repeated and later ends must not count
  // it again.
  it("counts a debt a full parent ledger cannot take once, however often the end is reported", async () => {
    const parentLedger = ledger(parent("run-parent-1"));
    for (let index = 0; index < 64; index += 1) {
      recordQueryFeedbackObligation(
        parentLedger,
        { available: true, query_id: `rq_openclawendedfull${index}` },
        process.env,
      );
    }
    const overflowCount = () =>
      Number(
        /(\d+) obligations? could not be recorded/u.exec(
          pendingCompletionRecoveryInstruction(parentLedger, process.env),
        )?.[1] ?? 0,
      );
    expect(overflowCount()).toBe(0);
    await spawn("run");
    await childWork("rq_openclawendedoverflow");
    await ended(endedEvent("error"), endedCtx());
    expect(owed(child())).toEqual([]);
    expect(overflowCount()).toBe(1);
    const counted = snapshot();

    await ended(endedEvent("error"), endedCtx());
    await ended(
      endedEvent("ok", CHILD_KEY, "run-child-2"),
      endedCtx(CHILD_KEY, "run-child-2"),
    );

    expect(snapshot()).toEqual(counted);
    expect(overflowCount()).toBe(1);
    expect(
      owed(parent("run-parent-2")).map((debt) => debt.query_id),
    ).not.toContain("rq_openclawendedoverflow");
  });

  // OpenClaw gives a session key a new sessionId when a later run finds its
  // entry stale (its daily or idle reset), and the plugin keeps a session's
  // debts per sessionId: such a later run of the subagent leaves its debts
  // in a new ledger, and its end must hand those up too.
  it("hands up a later run's debts after OpenClaw reset the subagent's session", async () => {
    const afterReset = child("run-child-2", "child-session-after-reset");
    await spawn("run");
    await childWork("rq_openclawendedbeforereset");
    await ended(endedEvent("error"), endedCtx());
    await childWork("rq_openclawendedafterreset", afterReset);
    await ended(
      endedEvent("timeout", CHILD_KEY, afterReset.runId),
      endedCtx(CHILD_KEY, afterReset.runId),
    );

    expect(owed(child())).toEqual([]);
    expect(owed(afterReset)).toEqual([]);
    expect(
      owed(parent("run-parent-2"))
        .map((debt) => debt.query_id)
        .sort(),
    ).toEqual(["rq_openclawendedafterreset", "rq_openclawendedbeforereset"]);
    expect(await prompt(parent("run-parent-2"))).toContain(
      secondHand("rq_openclawendedafterreset"),
    );
  });

  // After such a reset OpenClaw may report the earlier run's end only after
  // the later run's prompt, or never: it reports no end for a run that a
  // newer run of the same subagent session superseded, or that a steer
  // restart replaced. What the earlier run left in its own ledger must still
  // reach the parent.
  it.each([
    ["never reported", false],
    ["reported after the later run's prompt", true],
  ])(
    "hands up an earlier run's debts after a reset when its end is %s",
    async (_case, endReportedLate) => {
      const beforeReset = child("run-child-1", "child-session-before-reset");
      const afterReset = child("run-child-2", "child-session-after-reset");
      await spawn("run");
      // The earlier run errors, with no finalize; the later one starts under
      // a new sessionId.
      await childWork("rq_openclawendedearlierrun", beforeReset);
      await childWork("rq_openclawendedlaterrun", afterReset);
      if (endReportedLate) {
        await ended(
          endedEvent("error", CHILD_KEY, beforeReset.runId),
          endedCtx(CHILD_KEY, beforeReset.runId),
        );
      }
      await ended(
        endedEvent("error", CHILD_KEY, afterReset.runId),
        endedCtx(CHILD_KEY, afterReset.runId),
      );

      expect(owed(beforeReset)).toEqual([]);
      expect(owed(afterReset)).toEqual([]);
      expect(
        owed(parent("run-parent-2"))
          .map((debt) => debt.query_id)
          .sort(),
      ).toEqual(["rq_openclawendedearlierrun", "rq_openclawendedlaterrun"]);
    },
  );

  it("touches no other subagent of the same session", async () => {
    await spawn("run");
    await spawn("run", sibling);
    await childWork("rq_openclawendedchild");
    await childWork("rq_openclawendedsibling", sibling);

    await ended(endedEvent("error"), endedCtx());

    expect(owed(sibling)).toEqual([
      expect.objectContaining({
        query_id: "rq_openclawendedsibling",
        transferred_from: null,
      }),
    ]);
    expect(owed(parent("run-parent-2"))).toEqual([
      handedUp("rq_openclawendedchild"),
    ]);
  });

  // The debts go only to the session whose sessions_spawn result named the
  // subagent. Where OpenClaw's registry names another requester, nothing
  // moves, and one log line without content says so.
  it("moves nothing when OpenClaw names another requester than the spawning session", async () => {
    const queryId = "rq_openclawendedmismatch";
    const intruder = "agent:main:explicit:intruder";
    await spawn("run");
    await childWork(queryId);
    const before = snapshot();

    await ended(
      endedEvent("error"),
      endedCtx(CHILD_KEY, "run-child", intruder),
    );

    expect(snapshot()).toEqual(before);
    expect(owed(child())).toEqual([
      expect.objectContaining({ query_id: queryId, transferred_from: null }),
    ]);
    expect(owed(parent("run-parent-2"))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0];
    for (const detail of [CHILD_KEY, PARENT_KEY, intruder, queryId]) {
      expect(line).not.toContain(detail);
    }
  });

  // A pending host-policy alert belongs to the subagent's own finalize,
  // which asks once; the end of its run neither delivers nor repeats it.
  it("leaves a pending host-policy alert of the subagent's run alone", async () => {
    const queryId = "rq_openclawendedalert";
    await spawn("run");
    await childWork(queryId);
    recordHostPolicyDenial(
      {
        surface: "openclaw",
        sessionId: "run-child",
        eventType: "after_tool_call",
        toolName: "remembrance__propose_private_skill",
        value: { error: "Blocked by organization data-export policy" },
        pluginVersion: "0.2.0",
      },
      process.env,
    );
    const pending = readPendingHostPolicyAlert(
      "openclaw",
      "run-child",
      process.env,
    );
    expect(pending).toEqual(
      expect.objectContaining({ id: expect.any(String) }),
    );

    await ended(endedEvent("error"), endedCtx());

    expect(
      readPendingHostPolicyAlert("openclaw", "run-child", process.env),
    ).toEqual(pending);
    expect(owed(parent("run-parent-2"))).toEqual([handedUp(queryId)]);
  });

  // Since the retained-payloads change (Task 15, W2), hook-core keeps a
  // subagent's debt that carries a sealed payload in the ledger holding it
  // when the parent cannot take an equal copy: the parent then gets a
  // content-free pointer to it, with no cap (F2, Task 16). A sealed debt is
  // never counted in an overflow marker, whose text asks to repeat the
  // original request. OpenClaw's hand-up first folds the subagent's own
  // ledger into its agent ledger, then transfers from there.
  describe("debts with a sealed payload", () => {
    let home;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "remembrance-openclaw-ended-sealed-"));
      // The OpenClaw build keeps its private-learning key file under HOME
      // (~/.config/remembrance); the Keychain is never used here.
      vi.stubEnv("HOME", join(home, "home"));
      vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
      vi.stubEnv("REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN", "0");
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    const parentLedger = () => ledger(parent("run-parent-1"));
    const shortHash = (id) =>
      createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);
    const overflowMarker = (ledgerId) =>
      join(usage, `${shortHash(ledgerId)}.obligations-overflow.json`);
    const pointers = (ledgerId) => {
      const directory = join(
        process.env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        "retained",
        `${shortHash(ledgerId)}.pointers`,
      );
      return existsSync(directory) ? readdirSync(directory) : [];
    };
    const readKey = async () =>
      Buffer.from(
        readFileSync(
          join(
            process.env.HOME,
            ".config",
            "remembrance",
            "private-lesson-outbox.key",
          ),
          "utf8",
        ).trim(),
        "base64url",
      );
    const preference = (value) => ({
      setting: {
        key: "workflow.changelog_first",
        value,
        label: "Changelog first",
        behavior: "Write the changelog entry before changing the code.",
        effect: "workflow",
      },
      scope: "member",
    });
    // A capture_learning result routed to a preference the user has not
    // recorded yet: the hook seals its record_preference arguments.
    const preferenceCapture = (value) => ({
      capture_route: "preference",
      persisted_locally: false,
      next_action: { tool: "record_preference", arguments: preference(value) },
    });
    const capture = (value, ctx) =>
      hook("after_tool_call")(
        {
          toolName: "remembrance__capture_learning",
          params: {},
          runId: ctx.runId,
          result: textResult(preferenceCapture(value)),
        },
        ctx,
      );
    const fillParent = () => {
      for (let index = 0; index < 64; index += 1) {
        recordQueryFeedbackObligation(
          parentLedger(),
          { available: true, query_id: `rq_openclawendedparent${index}` },
          process.env,
        );
      }
    };

    it("points the parent to a sealed debt it holds sealed differently, second-hand in its reminder and its retrieval", async () => {
      await spawn("run");
      await capture("before_code", parent("run-parent-1"));
      await prompt(child(), "Review the deploy runbook.");
      await capture("before_code", child());

      await ended(endedEvent("error"), endedCtx());

      const keptIn = shortHash(
        agentLedgerIdFor({
          hook_event_name: "SubagentStop",
          session_id: parentLedger(),
          agent_id: CHILD_KEY,
        }),
      );
      expect(owed(child())).toEqual([]);
      expect(pointers(parentLedger())).toHaveLength(1);
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
      const line = (await prompt(parent("run-parent-2")))
        .split("\n")
        .find((text) => text.includes(`and ledger ${keptIn},`));
      expect(line).toContain(
        `- Durable preference (second-hand from subagent ${CHILD_KEY}): arguments kept on this machine (`,
      );
      const actionId = /action_id ([a-f0-9]{16}) and ledger/u.exec(line)?.[1];
      expect(actionId).toMatch(/^[a-f0-9]{16}$/u);
      const digest = resupplyPayloadDigest(preference("before_code"));
      const retrieved = await readPendingActionPayload(
        { action_id: actionId, ledger: keptIn },
        process.env,
        { readKey },
      );
      expect(retrieved).toMatchObject({
        status: "retrieved",
        payload_digest: digest,
        provenance: "second_hand",
        transferred_from: { agent_id: CHILD_KEY, transcript_path: null },
      });
      expect(resupplyPayloadDigest(retrieved.arguments)).toBe(digest);
    });

    // Every file under the usage directory and the state root, with its
    // bytes (lifecycle markers apart).
    const stateSnapshot = () => {
      const files = {};
      for (const root of [usage, process.env.XDG_STATE_HOME]) {
        if (!existsSync(root)) continue;
        for (const name of readdirSync(root, { recursive: true })) {
          const path = join(root, String(name));
          if (path.startsWith(join(usage, "health"))) continue;
          if (statSync(path).isFile()) files[path] = readFileSync(path, "utf8");
        }
      }
      return files;
    };
    const agentLedger = (requester, key) =>
      agentLedgerIdFor({
        hook_event_name: "SubagentStop",
        session_id: requester,
        agent_id: key,
      });
    const resolveParentOwn = () => {
      for (let index = 0; index < 64; index += 1) {
        observeSuccessfulCompletionTool(
          parentLedger(),
          "submit_query_feedback",
          { query_id: `rq_openclawendedparent${index}` },
          { accepted: true },
          process.env,
        );
      }
    };
    const HANDLES = /action_id ([a-f0-9]{16}) and ledger ([a-f0-9]{16})/gu;
    // Declines the debts the parent's demand names until it names one kept
    // by `keeper`; a demand names at most 12, so `rounds` bounds the wait.
    const demandNaming = (keeper, rounds) => {
      let demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      for (let round = 0; !demand.includes(`and ledger ${keeper},`); round += 1) {
        expect(round).toBeLessThan(rounds);
        for (const [, actionId] of demand.matchAll(HANDLES)) {
          observeSuccessfulCompletionTool(
            parentLedger(),
            "decline_pending_action",
            { action_id: actionId, reason: "not_reusable" },
            { declined: true },
            process.env,
          );
        }
        demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      }
      return demand;
    };
    // Retrieves the one debt `keeper` keeps that the demand names, records
    // the preference, and checks nothing of it is left.
    const recoverFrom = async (demand, keeper, value, firstAgent) => {
      const line = demand
        .split("\n")
        .find((text) => text.includes(`and ledger ${keeper},`));
      expect(line).toContain(
        `- Durable preference (second-hand from subagent ${firstAgent}): arguments kept on this machine (`,
      );
      const actionId = /action_id ([a-f0-9]{16}) and ledger/u.exec(line)?.[1];
      const retrieved = await readPendingActionPayload(
        { action_id: actionId, ledger: keeper },
        process.env,
        { readKey },
      );
      expect(retrieved).toMatchObject({
        status: "retrieved",
        provenance: "second_hand",
        payload_digest: resupplyPayloadDigest(preference(value)),
        transferred_from: { agent_id: firstAgent },
        arguments: preference(value),
      });
      observeSuccessfulCompletionTool(
        parentLedger(),
        "record_preference",
        retrieved.arguments,
        { recorded: true },
        process.env,
      );
      expect(
        (await readPendingActionPayload({ action_id: actionId, ledger: keeper }, process.env, { readKey }))
          .status,
      ).toBe("not_found");
      expect(
        pendingCompletionRecoveryInstruction(parentLedger(), process.env) ?? "",
      ).not.toContain(`and ledger ${keeper},`);
    };

    it("counts only the never-kept markers in a full parent, points it at the kept preference, never asks to repeat it, and a repeated end changes nothing", async () => {
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await capture("before_code", child());
      // One sealed preference and 63 markers fill the subagent's ledger; the
      // 64th marker is counted in its own overflow marker.
      for (let index = 0; index < 64; index += 1) {
        recordQueryFeedbackObligation(
          ledger(child()),
          { available: true, query_id: `rq_openclawendedchild${index}` },
          process.env,
        );
      }
      expect(
        JSON.parse(readFileSync(overflowMarker(ledger(child())), "utf8")),
      ).toMatchObject({ count: 1, kinds: ["query_feedback"] });
      fillParent();

      await ended(endedEvent("error"), endedCtx());

      // The full parent counts each of the 63 markers, plus the subagent's
      // own count once, and only those; the preference stays kept, with one
      // pointer, and is never counted.
      const keptIn = shortHash(agentLedger(parentLedger(), CHILD_KEY));
      expect(
        JSON.parse(readFileSync(overflowMarker(parentLedger()), "utf8")),
      ).toMatchObject({ count: 64, kinds: ["query_feedback"] });
      expect(pointers(parentLedger())).toHaveLength(1);
      expect(existsSync(overflowMarker(ledger(child())))).toBe(false);
      const state = stateSnapshot();

      await ended(endedEvent("error"), endedCtx());

      expect(stateSnapshot()).toEqual(state);
      // The count's text asks to repeat nothing: no kept debt is in it.
      const full = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      expect(full).toContain("- 64 obligations could not be recorded since ");
      expect(full).not.toContain("repeat the original request");

      resolveParentOwn();
      const demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      expect(demand).toContain(`and ledger ${keptIn},`);
      expect(demand).toContain("(query_feedback): the pending list was full.");
      expect(demand).not.toContain("repeat the original request");
      await recoverFrom(demand, keptIn, "before_code", CHILD_KEY);
      // Nothing pointed remains, so the parent drains, count included.
      expect(pendingCompletionRecoveryInstruction(parentLedger(), process.env)).toBeNull();
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
      expect(pointers(parentLedger())).toEqual([]);
    });

    it("gives a full parent that holds 64 pointers a 65th for an ended subagent's sealed debt, counts nothing, a repeated end changes nothing, and the parent recovers it", async () => {
      fillParent();
      for (let index = 0; index < 64; index += 1) {
        const stop = {
          hook_event_name: "SubagentStop",
          session_id: parentLedger(),
          agent_id: `agent:main:subagent:filler-${index}`,
        };
        observeSuccessfulCompletionTool(
          agentLedgerIdFor(stop),
          "capture_learning",
          {},
          preferenceCapture(`value_${index}`),
          process.env,
        );
        transferSubagentObligations(stop, process.env);
      }
      expect(pointers(parentLedger())).toHaveLength(64);
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await capture("before_code", child());

      await ended(endedEvent("error"), endedCtx());

      const keptIn = shortHash(agentLedger(parentLedger(), CHILD_KEY));
      expect(pointers(parentLedger())).toHaveLength(65);
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
      const state = stateSnapshot();

      await ended(endedEvent("error"), endedCtx());

      expect(stateSnapshot()).toEqual(state);
      resolveParentOwn();
      // Paging delays, never loses: 65 pointed debts, at most 12 named per
      // demand, so the kept one is named within six.
      const demand = demandNaming(keptIn, 6);
      expect(demand).not.toContain("repeat the original request");
      await recoverFrom(demand, keptIn, "before_code", CHILD_KEY);
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
    });

    // A subagent spawned by a subagent: its sealed debt reaches the spawning
    // subagent's ledger, which may hold only a pointer to it when that
    // subagent ends. OpenClaw folds that ledger into the agent ledger, then
    // transfers: the debt reaches the top session either way.
    const GRAND_KEY = "agent:main:subagent:5a0c9e2d-3f71-4b86-a2d4-6c8e0b1f7d39";
    const grandchild = {
      runId: "run-grand",
      sessionId: "grand-session",
      sessionKey: GRAND_KEY,
      agentId: "main",
    };
    // The child is full when the grandchild ends, so the grandchild's
    // sealed preference stays kept and the child's ledger points to it;
    // the child then resolves its own debts, keeping only that pointer.
    const pointerOnlyChild = async () => {
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      for (let index = 0; index < 64; index += 1) {
        recordQueryFeedbackObligation(
          ledger(child()),
          { available: true, query_id: `rq_openclawendedchild${index}` },
          process.env,
        );
      }
      await spawn("run", grandchild, child());
      await prompt(grandchild, "Check the release notes.");
      await capture("nested", grandchild);
      await ended(
        endedEvent("ok", GRAND_KEY, "run-grand"),
        endedCtx(GRAND_KEY, "run-grand", CHILD_KEY),
      );
      const grandKeeper = agentLedger(ledger(child()), GRAND_KEY);
      expect(pointers(ledger(child()))).toHaveLength(1);
      expect(existsSync(overflowMarker(ledger(child())))).toBe(false);
      for (let index = 0; index < 64; index += 1) {
        observeSuccessfulCompletionTool(
          ledger(child()),
          "submit_query_feedback",
          { query_id: `rq_openclawendedchild${index}` },
          { accepted: true },
          process.env,
        );
      }
      expect(owed(child())).toEqual([
        expect.objectContaining({
          ledger: shortHash(grandKeeper),
          transferred_from: expect.objectContaining({ agent_id: GRAND_KEY }),
        }),
      ]);
      return grandKeeper;
    };

    it("hands a nested subagent's kept debt from a subagent ledger holding only its pointer up to a full parent, by pointer, keeping the first subagent's name", async () => {
      const grandKeeper = await pointerOnlyChild();
      fillParent();

      await ended(endedEvent("ok"), endedCtx());

      // Round 0 R0-3 (D2(i)): a record another ledger points to never moves
      // whole. The grandchild's keeper keeps it, named after the grandchild;
      // the fold and the transfer move only the pointer, so the full parent
      // points to the keeper, and neither the subagent ledger nor the agent
      // ledger holds anything of it.
      const keptIn = shortHash(grandKeeper);
      expect(owed(child())).toEqual([]);
      expect(pointers(ledger(child()))).toEqual([]);
      expect(pointers(agentLedger(parentLedger(), CHILD_KEY))).toEqual([]);
      expect(readCompletionObligations(grandKeeper, process.env)).toEqual([
        expect.objectContaining({ transferred_from: expect.objectContaining({ agent_id: GRAND_KEY }) }),
      ]);
      expect(pointers(parentLedger())).toHaveLength(1);
      expect(existsSync(overflowMarker(parentLedger()))).toBe(false);
      const state = stateSnapshot();
      await ended(endedEvent("ok"), endedCtx());
      expect(stateSnapshot()).toEqual(state);

      resolveParentOwn();
      const demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      expect(demand).not.toContain("repeat the original request");
      // A kept record keeps the first subagent's name.
      await recoverFrom(demand, keptIn, "nested", GRAND_KEY);
      expect(pendingCompletionRecoveryInstruction(parentLedger(), process.env)).toBeNull();
    });

    it("points a parent with room at a nested subagent's kept debt, where it is kept, named after the subagent that left it", async () => {
      const grandKeeper = await pointerOnlyChild();

      await ended(endedEvent("ok"), endedCtx());

      // Round 0 R0-3 (D2(i)): room in the parent changes nothing once another
      // ledger points to the record: it stays with the grandchild's keeper,
      // and the parent points to it there.
      expect(owed(child())).toEqual([]);
      expect(readCompletionObligations(grandKeeper, process.env)).toHaveLength(1);
      expect(pointers(parentLedger())).toHaveLength(1);
      const held = owed(parent("run-parent-2"));
      expect(held).toEqual([
        expect.objectContaining({
          kind: "capture_next_action",
          ledger: shortHash(grandKeeper),
          transferred_from: expect.objectContaining({ agent_id: GRAND_KEY }),
        }),
      ]);
      const demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
      await recoverFrom(demand, shortHash(grandKeeper), "nested", GRAND_KEY);
      expect(pendingCompletionRecoveryInstruction(parentLedger(), process.env)).toBeNull();
    });

    // Round 1 R1-1, R1-2: a subagent spawned by a subagent whose end comes
    // after the spawning subagent's run ended. Its debts go into the
    // spawning subagent's session ledger, the one it was started from, as on
    // master; that session settles them when it runs again, and the top
    // session reaches them only while it does not.
    const GRAND_QUERY = "rq_openclawendedgrand";
    const announce = (key) =>
      [
        `[Inter-session message] sourceSession=${key} sourceChannel=webchat sourceTool=subagent_announce isUser=false`,
        "This content was routed by OpenClaw from another session or internal tool.",
        "A background task finished.",
      ].join("\n");
    const toolResult = (ctx, toolName, params, body) =>
      hook("after_tool_call")(
        { toolName, params, runId: ctx.runId, result: textResult(body) },
        ctx,
      );
    // The parent spawns the child, which leaves a query-fit debt of its own
    // or nothing, and spawns the grandchild, which leaves a query-fit debt
    // and a kept preference.
    const nestedWork = async (childLeft, value, from = child()) => {
      await prompt(parent("run-parent-1"));
      await spawn("run");
      if (childLeft) await childWork("rq_openclawendedchildown");
      else await prompt(child(), "Review the deploy runbook.");
      await spawn("run", grandchild, from);
      await childWork(GRAND_QUERY, grandchild);
      await capture(value, grandchild);
    };
    const SECOND_GRAND_KEY =
      "agent:main:subagent:9e4b2c71-0d5a-4f3e-b8a6-1c7d2e9f0a54";
    const secondGrandchild = {
      runId: "run-second-grand",
      sessionId: "second-grand-session",
      sessionKey: SECOND_GRAND_KEY,
      agentId: "main",
    };
    const grandEnded = () =>
      ended(
        endedEvent("ok", GRAND_KEY, "run-grand"),
        endedCtx(GRAND_KEY, "run-grand", CHILD_KEY),
      );
    const grandDebts = (value, where = {}) => [
      expect.objectContaining({
        kind: "query_feedback",
        query_id: GRAND_QUERY,
        transferred_from: expect.objectContaining({ agent_id: GRAND_KEY }),
        ...where,
      }),
      expect.objectContaining({
        kind: "capture_next_action",
        id: `capture_next_action:${resupplyPayloadDigest(preference(value))}`,
        transferred_from: expect.objectContaining({ agent_id: GRAND_KEY }),
        ...where,
      }),
    ];
    const byKind = (debts) =>
      [...debts].sort((a, b) => b.kind.localeCompare(a.kind));
    const ownOf = (childLeft) =>
      childLeft ? [handedUp("rq_openclawendedchildown")] : [];
    const grandLine = `- Durable preference (second-hand from subagent ${GRAND_KEY}): arguments kept on this machine (`;

    it.each([
      ["left a debt", true],
      ["left nothing", false],
    ])(
      "lets a subagent whose run ended before its own subagent's name and settle that one's debts in the run OpenClaw starts for its result, when it %s; the top session owes only the subagent's own (R1-1)",
      async (_case, childLeft) => {
        await nestedWork(childLeft, "announced");
        // The child's run ends first; OpenClaw then announces the
        // grandchild's result in a new run of the child's session, and only
        // after that reports the grandchild's end.
        await ended(endedEvent("ok"), endedCtx());
        const announceRun = child("run-child-announce");
        const context = await prompt(announceRun, announce(GRAND_KEY));
        await grandEnded();

        expect(context).toContain(secondHand(GRAND_QUERY, GRAND_KEY));
        expect(context).toContain(grandLine);
        expect(byKind(owed(announceRun))).toEqual(grandDebts("announced"));
        expect(owed(parent("run-parent-2"))).toEqual(ownOf(childLeft));
        expect(pointers(parentLedger())).toEqual([]);

        // The announce run settles them, and ends.
        await toolResult(
          announceRun,
          "remembrance__submit_query_feedback",
          { query_id: GRAND_QUERY, fit: "good" },
          { accepted: true },
        );
        await toolResult(
          announceRun,
          "remembrance__record_preference",
          preference("announced"),
          { recorded: true },
        );
        expect(owed(announceRun)).toEqual([]);
        await ended(
          endedEvent("ok", CHILD_KEY, "run-child-announce"),
          endedCtx(CHILD_KEY, "run-child-announce"),
        );
        expect(owed(parent("run-parent-2"))).toEqual(ownOf(childLeft));
        const demand =
          pendingCompletionRecoveryInstruction(parentLedger(), process.env) ?? "";
        expect(demand).not.toContain(GRAND_QUERY);
        expect(demand).not.toContain(GRAND_KEY);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["left a debt", true],
      ["left nothing", false],
    ])(
      "lets a later run of a subagent's session whose earlier run %s name and settle what its own subagent leaves; the top session never owes it (R1-1)",
      async (_case, childLeft) => {
        const laterRun = child("run-child-2");
        await prompt(parent("run-parent-1"));
        await spawn("run");
        if (childLeft) await childWork("rq_openclawendedchildown");
        else await prompt(child(), "Review the deploy runbook.");
        await ended(endedEvent("ok"), endedCtx());
        // A later run of the child's session (sessions_send, a wake run)
        // spawns the grandchild, which ends while that run is in progress.
        await prompt(laterRun, "Follow up on the runbook.");
        await spawn("run", grandchild, laterRun);
        await childWork(GRAND_QUERY, grandchild);
        await capture("later", grandchild);
        await grandEnded();

        expect(byKind(owed(laterRun))).toEqual(grandDebts("later"));
        expect(
          pendingCompletionRecoveryInstruction(ledger(laterRun), process.env),
        ).toContain(grandLine);
        expect(owed(parent("run-parent-2"))).toEqual(ownOf(childLeft));
        expect(pointers(parentLedger())).toEqual([]);

        await toolResult(
          laterRun,
          "remembrance__submit_query_feedback",
          { query_id: GRAND_QUERY, fit: "good" },
          { accepted: true },
        );
        await toolResult(
          laterRun,
          "remembrance__record_preference",
          preference("later"),
          { recorded: true },
        );
        expect(owed(laterRun)).toEqual([]);
        expect(owed(parent("run-parent-2"))).toEqual(ownOf(childLeft));
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["left a debt", true],
      ["left nothing", false],
    ])(
      "names a nested subagent's debts to the top session when that subagent ends after its spawning subagent, which %s and whose session never runs again, and the top session settles them (R1-2)",
      async (_case, childLeft) => {
        await nestedWork(childLeft, "late");
        await ended(endedEvent("ok"), endedCtx());
        // The child's session ledger leaves a forwarding marker at its end,
        // also when it holds nothing.
        expect(
          existsSync(join(usage, `${shortHash(ledger(child()))}.forward.json`)),
        ).toBe(true);
        await grandEnded();

        // The debts stay where they were handed, in the child's session
        // ledger; the top session reaches them there.
        expect(byKind(owed(child()))).toEqual(grandDebts("late"));
        const context = await prompt(
          parent("run-parent-2"),
          "Continue the release review.",
        );
        expect(context).toContain(GRAND_QUERY);
        expect(context).toContain(grandLine);
        const keptIn = shortHash(ledger(child()));
        const held = owed(parent("run-parent-2"));
        expect(held.filter((debt) => !debt.ledger)).toEqual(ownOf(childLeft));
        expect(byKind(held.filter((debt) => debt.ledger))).toEqual(
          grandDebts("late", { ledger: keptIn }),
        );

        await toolResult(
          parent("run-parent-2"),
          "remembrance__submit_query_feedback",
          { query_id: GRAND_QUERY, fit: "good" },
          { accepted: true },
        );
        if (childLeft) {
          await toolResult(
            parent("run-parent-2"),
            "remembrance__submit_query_feedback",
            { query_id: "rq_openclawendedchildown", fit: "good" },
            { accepted: true },
          );
        }
        const demand = pendingCompletionRecoveryInstruction(parentLedger(), process.env);
        await recoverFrom(demand, keptIn, "late", GRAND_KEY);
        expect(pendingCompletionRecoveryInstruction(parentLedger(), process.env)).toBeNull();
        expect(owed(child())).toEqual([]);
        expect(pointers(parentLedger())).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    // R4C-2 (round 4): a finalize's read decides who is asked, as a
    // prompt's does (A2). The grandchild ends after the child, so the top
    // session holds an association to the child's session ledger, which the
    // child's next prompt leaves in place (R4C-1) and is asked through its
    // own records. The top session's finalize in visible mode then leaves
    // the debts to the child's session, removes the association and asks
    // nothing.
    it("leaves a nested subagent's debts to the subagent's session that runs again at the top session's finalize, which asks for nothing, in visible mode (R4C-2)", async () => {
      vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "1");
      const association = `${createHash("sha256").update(`association:${shortHash(ledger(child()))}`, "utf8").digest("hex").slice(0, 32)}.json`;
      await nestedWork(false, "finalized");
      await ended(endedEvent("ok"), endedCtx());
      await grandEnded();
      expect(pointers(parentLedger())).toEqual([association]);
      const laterRun = child("run-child-2");
      expect(await prompt(laterRun, "Follow up on the runbook.")).toContain(grandLine);
      expect(pointers(parentLedger())).toEqual([association]);
      await expect(finalize(parent("run-parent-2"))).resolves.toEqual({
        action: "finalize",
        why: "registry_not_used",
      });
      expect(pointers(parentLedger())).toEqual([]);
      expect(byKind(owed(laterRun))).toEqual(grandDebts("finalized"));
      expect(warn).not.toHaveBeenCalled();
    });

    // Helper DELTA-01 D2 (round 4): a finalize's prompted mark asks as its
    // decideStop read does, so after a move that failed it stamps only the
    // session's own debts. The child hands up a kept preference behind a
    // flagged pointer (its agent ledger and the top session are full), and
    // its session runs again, so it owns that debt. The top session's
    // pointer home then refuses writes: its visible-mode finalize can
    // neither remove nor move the pointer, and marks its own 64 debts
    // prompted. The kept preference stays unstamped, so the child's own stop
    // in visible mode still asks for it (R4C-M03oc stamped it too).
    it("leaves a subagent's kept preference unstamped when the top session's visible-mode finalize cannot remove its flagged pointer to it, so the subagent's session that runs again is still asked at its stop (helper D2, R4C-M03)", async () => {
      vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "1");
      const keeper = ledger(child());
      const agentLedger = agentLedgerIdFor({
        hook_event_name: "SubagentStop",
        session_id: parentLedger(),
        agent_id: CHILD_KEY,
      });
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await capture("kept", child());
      for (let index = 0; index < 64; index += 1) {
        recordQueryFeedbackObligation(
          agentLedger,
          { available: true, query_id: `rq_openclawendedagent${index}` },
          process.env,
        );
      }
      fillParent();
      await ended(endedEvent("ok"), endedCtx());
      const durable = join(
        process.env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        "retained",
        `${shortHash(parentLedger())}.pointers`,
      );
      const held = pointers(parentLedger());
      expect(held).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(durable, held[0]), "utf8")),
      ).toMatchObject({ ledger: shortHash(keeper), forwarded: true });
      await prompt(child("run-child-2"), "Follow up on the runbook.");
      const homes = [
        durable,
        join(usage, `${shortHash(parentLedger())}.pointers`),
      ].filter((directory) => existsSync(directory));
      for (const directory of homes) chmodSync(directory, 0o500);
      let topStop;
      try {
        topStop = await finalize(parent("run-parent-2"));
      } finally {
        for (const directory of homes) chmodSync(directory, 0o700);
      }
      expect(topStop).toMatchObject({
        action: "revise",
        why: "prompt_pending_obligations",
      });
      expect(pointers(parentLedger())).toEqual(held);
      const top = readCompletionObligations(parentLedger(), process.env, {
        ask: false,
      });
      expect(top.filter((debt) => !debt.ledger && debt.prompted_at)).toHaveLength(64);
      const kept = readCompletionObligations(keeper, process.env, {
        ask: false,
      }).filter((debt) => debt.kind === "capture_next_action");
      expect(kept).toHaveLength(1);
      expect(kept[0].prompted_at).toBeFalsy();
      expect(
        decideStop(
          { hook_event_name: "Stop", session_id: keeper },
          { env: process.env },
        ),
      ).toMatchObject({ allow: false, why: "prompt_pending_obligations" });
      expect(warn).not.toHaveBeenCalled();
    });

    // R-W2 round 2 R2-2, re-shaped in round 3 (R3A-2): an announce pulls
    // nothing once a later run of the announced subagent started, so the
    // announced subagent here is a second grandchild whose only run spans
    // the child's end and has not ended. The child's announce run owes its
    // kept debt, where that grandchild's agent ledger keeps it (the child's
    // ledger is full of kept debts), and the top session holds no
    // association to that ledger. R2-2's order itself (the release after
    // the pull, whose onward check would give the top session an
    // association to the grandchild's agent ledger) is pinned by R2-4's
    // test below: the pull follows the update await, so a release after the
    // pull is also a release after that await.
    it("lets the announce run of a subagent whose ledger is full of kept debts owe the kept debt of its second subagent, whose run has not ended, and gives the top session no association to it (R2-2, re-shaped for R3A-2)", async () => {
      const associationFile = (ledgerId) =>
        `${createHash("sha256").update(`association:${shortHash(ledgerId)}`, "utf8").digest("hex").slice(0, 32)}.json`;
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      // 64 subagents of the child each leave a kept preference, which moves
      // whole into the child's session ledger (its first hop).
      for (let index = 0; index < 64; index += 1) {
        const stop = {
          hook_event_name: "SubagentStop",
          session_id: ledger(child()),
          agent_id: `agent:main:subagent:filler-${index}`,
        };
        observeSuccessfulCompletionTool(
          agentLedgerIdFor(stop),
          "capture_learning",
          {},
          preferenceCapture(`value_${index}`),
          process.env,
        );
        transferSubagentObligations(stop, process.env, { forward: true });
      }
      expect(
        owed(child()).filter(
          (debt) => debt.kind === "capture_next_action" && !debt.ledger,
        ),
      ).toHaveLength(64);
      // The grandchild's first run ends during the child's run, leaving
      // nothing, and a second grandchild's run starts there; then the
      // child's run ends. Its kept debts stay in its session ledger (D2(i)),
      // and the top session points to them: 64 pointers, and the
      // association to the child's agent ledger that a page of 64 pointed
      // debts leaves (it is not known to be complete).
      await spawn("run", grandchild, child());
      await prompt(grandchild, "Check the release notes.");
      await grandEnded();
      await spawn("run", secondGrandchild, child());
      await prompt(secondGrandchild, "Follow up on the release notes.");
      await ended(endedEvent("ok"), endedCtx());
      expect(
        readCompletionObligations(ledger(child()), process.env, {
          pointers: false,
        }).filter((debt) => debt.kind === "capture_next_action"),
      ).toHaveLength(64);
      expect(pointers(parentLedger())).toHaveLength(65);
      expect(pointers(parentLedger())).toContain(
        associationFile(agentLedger(parentLedger(), CHILD_KEY)),
      );
      // The second grandchild, still going, keeps a preference; its run ends
      // with neither a finalize nor a reported end yet, and OpenClaw
      // announces its result in a new run of the child's session. (An
      // announce of a subagent's earlier run pulls nothing while a later run
      // of it goes: R3A-2 below.)
      await capture("second_run", secondGrandchild);
      const announceRun = child("run-child-announce");
      await prompt(announceRun, announce(SECOND_GRAND_KEY));

      const grandAgent = agentLedger(ledger(child()), SECOND_GRAND_KEY);
      const keeper = shortHash(grandAgent);
      const id = `capture_next_action:${resupplyPayloadDigest(preference("second_run"))}`;
      // The announce run owes it, where the grandchild's agent ledger keeps
      // it (the child's ledger is full); the top session does not, and holds
      // no association that reaches it.
      expect(owed(announceRun)).toContainEqual(
        expect.objectContaining({
          id,
          ledger: keeper,
          transferred_from: expect.objectContaining({
            agent_id: SECOND_GRAND_KEY,
          }),
        }),
      );
      expect(pointers(parentLedger())).not.toContain(associationFile(grandAgent));
      expect(
        owed(parent("run-parent-2")).filter((debt) => debt.id === id),
      ).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    // R-W2 round 2 R2-5, variant lc (probe-r2-res2.mjs): the child's
    // durable record home is a link while both subagents end, so the
    // grandchild's kept preference lands in the child's session ledger's
    // temporary home and stays there at the child's end (D2(i)). The child
    // never runs again; once the link is gone, the top session's read moves
    // the record to the durable home, and a temporary-directory cleanup
    // afterwards loses nothing.
    it("moves a nested kept preference that an ended subagent's session ledger keeps in its temporary home to the durable home on the top session's read, so a temporary-directory cleanup afterwards loses nothing (R2-5, variant lc)", async () => {
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await spawn("run", grandchild, child());
      await prompt(grandchild, "Check the release notes.");
      await capture("temporary", grandchild);
      const keptIn = shortHash(ledger(child()));
      const durable = join(
        process.env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        "retained",
        `${keptIn}.obligations`,
      );
      const temporary = join(usage, `${keptIn}.obligations`);
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
      symlinkSync(elsewhere, durable);
      await grandEnded();
      await ended(endedEvent("ok"), endedCtx());
      const name = `${createHash("sha256")
        .update(
          `capture_next_action:${resupplyPayloadDigest(preference("temporary"))}`,
          "utf8",
        )
        .digest("hex")
        .slice(0, 32)}.json`;
      expect(readdirSync(temporary)).toEqual([name]);
      expect(readdirSync(elsewhere)).toEqual([]);

      rmSync(durable);
      const context = await prompt(
        parent("run-parent-2"),
        "Continue the release review.",
      );
      expect(context).toContain(grandLine);
      expect(existsSync(join(temporary, name))).toBe(false);
      expect(readdirSync(durable)).toEqual([name]);

      // A temporary-directory cleanup (or a reboot).
      rmSync(usage, { recursive: true, force: true });
      mkdirSync(usage, { recursive: true, mode: 0o700 });
      const demand = pendingCompletionRecoveryInstruction(
        parentLedger(),
        process.env,
      );
      await recoverFrom(demand, keptIn, "temporary", GRAND_KEY);
      expect(
        pendingCompletionRecoveryInstruction(parentLedger(), process.env),
      ).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    // R-W2 round 2 R2-3 (design note r2-ownership.md, mechanism A): the
    // subagent's session ledger keeps 64 kept preferences after its run ends
    // (D2(i)), and the top session is pointed to them. While the subagent's
    // session runs again only it is asked for them; the top session is asked
    // again after that run's end.
    it("asks only a subagent's session that runs again for the 64 kept debts its ledger keeps, and the top session again after that run's end (R2-3, y13)", async () => {
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      for (let index = 0; index < 64; index += 1) {
        const stop = {
          hook_event_name: "SubagentStop",
          session_id: ledger(child()),
          agent_id: `agent:main:subagent:filler-${index}`,
        };
        observeSuccessfulCompletionTool(
          agentLedgerIdFor(stop),
          "capture_learning",
          {},
          preferenceCapture(`value_${index}`),
          process.env,
        );
        transferSubagentObligations(stop, process.env, { forward: true });
      }
      await ended(endedEvent("ok"), endedCtx());
      const kept = (debts) => debts.filter((debt) => debt.kind === "capture_next_action");
      expect(kept(readCompletionObligations(ledger(child()), process.env, { pointers: false }))).toHaveLength(64);
      expect(kept(owed(parent("run-parent-2")))).toHaveLength(64);
      // The subagent's session runs again: it alone is asked for them.
      const again = child("run-child-2");
      expect(await prompt(again, "Follow up on the release notes.")).toContain(
        "- Durable preference (second-hand from subagent agent:main:subagent:filler-",
      );
      expect(kept(owed(parent("run-parent-2")))).toEqual([]);
      expect(pointers(parentLedger())).toEqual([]);
      expect(await prompt(parent("run-parent-2"), "Continue.")).not.toContain("- Durable preference");
      expect(kept(owed(again))).toHaveLength(64);
      // Its run ends: the top session is asked again.
      await ended(endedEvent("ok", CHILD_KEY, again.runId), endedCtx(CHILD_KEY, again.runId));
      expect(kept(owed(parent("run-parent-3")))).toHaveLength(64);
      expect(await prompt(parent("run-parent-3"), "Continue.")).toContain(
        "- Durable preference (second-hand from subagent agent:main:subagent:filler-",
      );
      expect(warn).not.toHaveBeenCalled();
    });

    // R-W2 round 2, design note r2-ownership.md residual 2 (L1): OpenClaw may
    // report a subagent run's end only after a later run of the same subagent
    // started (its prompt hook ran). That later run is going and keeps the
    // subagent's debts, so the late end hands nothing over, and the later
    // run's end hands them up: one session is asked at a time.
    const named = (debts) => debts.map((debt) => debt.query_id ?? debt.id).sort();
    const grandNames = (value) =>
      [GRAND_QUERY, `capture_next_action:${resupplyPayloadDigest(preference(value))}`].sort();
    const lateWork = async (value) => {
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await spawn("run", grandchild, child());
      await childWork(GRAND_QUERY, grandchild);
      await capture(value, grandchild);
      // The grandchild ends during the child's run: its debts land in the
      // child's session ledger.
      await grandEnded();
    };
    it("hands nothing over at a run's end OpenClaw reports after a later run of the subagent started, and everything at that later run's end (L1)", async () => {
      await lateWork("late_end");
      const later = child("run-child-2");
      expect(await prompt(later, "Follow up on the release notes.")).toContain(grandLine);
      await ended(endedEvent("ok"), endedCtx());
      expect(owed(parent("run-parent-2"))).toEqual([]);
      expect(pointers(parentLedger())).toEqual([]);
      expect(await prompt(parent("run-parent-2"), "Continue.")).not.toContain(grandLine);
      expect(byKind(owed(later))).toEqual(grandDebts("late_end"));
      // The later run ends: its end hands up, and the top session is asked.
      await ended(endedEvent("ok", CHILD_KEY, later.runId), endedCtx(CHILD_KEY, later.runId));
      expect(await prompt(parent("run-parent-3"), "Continue.")).toContain(grandLine);
      expect(named(owed(parent("run-parent-3")))).toEqual(grandNames("late_end"));
      expect(warn).not.toHaveBeenCalled();
    });

    // Without the ended run's id, or for a run whose prompt this process
    // never saw, an end hands over as it would without L1.
    it.each([
      ["names no run, as OpenClaw's session reset or delete", null],
      ["names a run whose prompt this process never saw", "run-child-unseen"],
    ])("hands over at an end that %s, even after a later run's prompt (L1 inert)", async (_case, runId) => {
      await lateWork("inert");
      await prompt(child("run-child-2"), "Follow up on the release notes.");
      const event = { ...endedEvent("ok"), runId: runId ?? undefined };
      const ctx = { ...endedCtx(), runId: runId ?? undefined };
      if (runId === null) {
        delete event.runId;
        delete ctx.runId;
      }
      await ended(event, ctx);
      expect(named(owed(parent("run-parent-2")))).toEqual(grandNames("inert"));
    });

    // The memory is bounded: at most four run ids of at most 256 characters
    // per subagent record (and at most 512 records).
    it("remembers at most four runs a subagent's prompts started: a late end of a remembered earlier run hands nothing over, one of a run it no longer remembers hands over (L1 bound)", async () => {
      await lateWork("bound");
      for (const run of [2, 3, 4, 5]) {
        await prompt(child(`run-child-${run}`), "Follow up on the release notes.");
      }
      const before = stateSnapshot();
      await ended(endedEvent("ok", CHILD_KEY, "run-child-2"), endedCtx(CHILD_KEY, "run-child-2"));
      expect(stateSnapshot()).toEqual(before);
      expect(owed(parent("run-parent-2"))).toEqual([]);
      // run-child (the first run) is four runs back: no longer remembered.
      await ended(endedEvent("ok"), endedCtx());
      expect(named(owed(parent("run-parent-2")))).toEqual(grandNames("bound"));
    });

    it.each([
      [256, false],
      [257, true],
    ])("remembers a later run whose id has %i characters only within the bound: an earlier run's late end then hands over: %s (L1 bound)", async (length, handsOver) => {
      await lateWork(`length_${length}`);
      await prompt(child("r".repeat(length)), "Follow up on the release notes.");
      await ended(endedEvent("ok"), endedCtx());
      expect(named(owed(parent("run-parent-2")))).toEqual(
        handsOver ? grandNames(`length_${length}`) : [],
      );
    });

    // R3A-2 (round-3 adapter review): OpenClaw may start a later run of a
    // subagent (its prompt hook ran) before the session that spawned it
    // builds the prompt of the run that announces the earlier one. The later
    // run keeps the subagent's debts and is asked for them; the announce
    // pulls nothing, which would make that session's marker a forwarding one
    // again and ask the top session as well. The later run's end hands them
    // up.
    it.each([
      ["ended without a finalize, reported only later", false],
      ["finalized", true],
    ])("asks only a subagent's later run, never the top session, for a kept debt when the announce of its earlier run (%s) comes while that later run goes; its end hands up (R3A-2)", async (_case, finalized) => {
      const value = `pull_${finalized}`;
      const id = `capture_next_action:${resupplyPayloadDigest(preference(value))}`;
      const keptIds = (debts) =>
        debts.filter((debt) => debt.kind === "capture_next_action").map((debt) => debt.id);
      await lateWork(value);
      if (finalized) await finalize(child());
      const later = child("run-child-2");
      expect(await prompt(later, "Follow up on the release notes.")).toContain(grandLine);
      expect(
        await prompt(parent("run-parent-2"), announce(CHILD_KEY)),
      ).not.toContain(grandLine);
      expect(keptIds(owed(parent("run-parent-2")))).toEqual([]);
      expect(keptIds(owed(later))).toEqual([id]);
      // OpenClaw reports the earlier run's end late: nothing moves (L1).
      await ended(endedEvent("ok"), endedCtx());
      expect(keptIds(owed(parent("run-parent-3")))).toEqual([]);
      // The later run ends: its end hands up, and the top session is asked.
      await ended(endedEvent("ok", CHILD_KEY, later.runId), endedCtx(CHILD_KEY, later.runId));
      expect(await prompt(parent("run-parent-4"), "Continue.")).toContain(grandLine);
      expect(named(owed(parent("run-parent-4")))).toEqual(grandNames(value));
      expect(warn).not.toHaveBeenCalled();
    });

    // R3A-4: OpenClaw builds a run's prompt once per attempt of that run,
    // with the same run id; the run is remembered once, so five attempts of
    // a later run leave the earlier run remembered.
    it("remembers a run once however often OpenClaw builds its prompt: an earlier run's late end then hands nothing over (L1, one id per run)", async () => {
      await lateWork("attempts");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await prompt(child("run-child-2"), "Follow up on the release notes.");
      }
      await ended(endedEvent("ok"), endedCtx());
      expect(named(owed(parent("run-parent-2")))).toEqual([]);
    });

    // R3A-5: a prompt hook awaits the client-update check before it builds
    // the prompt; an earlier run's end OpenClaw reports meanwhile already
    // finds the later run remembered.
    it("remembers a later run before its prompt hook awaits anything: an earlier run's end reported meanwhile hands nothing over (L1)", async () => {
      await lateWork("await");
      const building = hook("before_prompt_build")(
        { prompt: "Follow up on the release notes.", messages: [] },
        child("run-child-2"),
      );
      await ended(endedEvent("ok"), endedCtx());
      expect(String((await building)?.appendSystemContext ?? "")).toContain(grandLine);
      expect(named(owed(parent("run-parent-2")))).toEqual([]);
    });

    // The release comes before anything is awaited too: a nested end that
    // OpenClaw reports while a later run's prompt hook awaits finds the
    // session's marker released, so nothing reaches the session above (R2-4).
    // The announce pull follows that await, so this test also pins the
    // release before the pull (R2-2's order; Y13 and R3A-M10 fail it).
    it("releases a subagent session's marker before its prompt hook awaits anything, and so before an announce pull: a nested end reported meanwhile reaches nothing above that session (R2-4, R2-2)", async () => {
      await prompt(parent("run-parent-1"));
      await spawn("run");
      await prompt(child(), "Review the deploy runbook.");
      await spawn("run", grandchild, child());
      await childWork(GRAND_QUERY, grandchild);
      await capture("await_release", grandchild);
      // The child's run finalizes: its marker forwards to the top session.
      await finalize(child());
      const later = child("run-child-2");
      const building = hook("before_prompt_build")(
        { prompt: "Follow up on the release notes.", messages: [] },
        later,
      );
      // The grandchild's end, reported (not awaited) while that hook awaits;
      // the top session reads in that window.
      grandEnded();
      expect(named(owed(parent("run-parent-2")))).toEqual([]);
      expect(String((await building)?.appendSystemContext ?? "")).toContain(grandLine);
      expect(named(owed(later))).toEqual(grandNames("await_release"));
      expect(named(owed(parent("run-parent-2")))).toEqual([]);
    });
  });

  // R3A-1: what this process knows of subagents is bounded, the bound L1's
  // memory rests on: at most 512 subagent records, the oldest forgotten. A
  // forgotten subagent's end hands nothing over (its debts wait in its own
  // session, as for a subagent this process never saw).
  it("keeps at most 512 subagents in mind: the 513th spawned forgets the first, whose end then hands nothing over", async () => {
    const subagentRequesters = new Map();
    const quiet = {
      subagentRequesters,
      recordHealth: () => {},
      clearHighMatchSurfaceIfOpened: () => false,
      observeCompletionTool: () => ({ opened: [], closed: [], pending: [] }),
    };
    const spawnOf = (ctx) =>
      adapter.handleAfterToolCall(
        {
          toolName: "sessions_spawn",
          params: { task: "Review the deploy runbook.", mode: "run" },
          result: textResult({
            status: "accepted",
            childSessionKey: ctx.sessionKey,
            runId: ctx.runId,
            mode: "run",
          }),
          context: parent("run-parent-1"),
        },
        quiet,
      );
    await spawnOf(child());
    await adapter.handlePrePrompt(
      { prompt: "Review the deploy runbook.", messages: [], context: child() },
      { subagentRequesters, recordHealth: () => {} },
    );
    recordQueryFeedbackObligation(
      ledger(child()),
      { available: true, query_id: "rq_openclawendedbound" },
      process.env,
    );
    for (let index = 1; index <= 512; index += 1) {
      await spawnOf({
        runId: `run-bound-${index}`,
        sessionKey: `agent:main:subagent:bound-${index}`,
      });
    }
    expect(subagentRequesters.size).toBe(512);
    expect(subagentRequesters.has(CHILD_KEY)).toBe(false);
    expect(
      adapter.handleSubagentEnded(endedEvent("ok"), endedCtx(), {
        subagentRequesters,
      }),
    ).toBe(0);
    expect(owed(parent("run-parent-2"))).toEqual([]);
    expect(owed(child())).toEqual([
      expect.objectContaining({ query_id: "rq_openclawendedbound" }),
    ]);
  });
});
