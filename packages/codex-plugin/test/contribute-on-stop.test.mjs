import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleStop, handleStopHook } from "../scripts/contribute-on-stop.mjs";
import {
  agentLedgerIdFor,
  contributionReason,
  readCompletionObligations,
  readDirectSelectionSurfaces,
  readRegistryUseCount,
  readTaskEligibilityCount,
  readUserPromptCount,
  recordQueryFeedbackObligation,
} from "../scripts/hook-core.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";
import { handleQuery } from "../scripts/query-on-prompt.mjs";
import { readPendingActionPayload } from "../scripts/pending-action-payload.mjs";

// Default hook paths must never reach the real profile: HOME and the XDG roots
// cover shared config and private-learning state, and TMPDIR covers the usage
// markers.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-codex-stop-"));
let envCounter = 0;

beforeAll(() => {
  for (const [key, name] of [
    ["HOME", "home"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
    ["TMPDIR", "tmp"],
  ]) {
    mkdirSync(join(tempRoot, name), { recursive: true });
    vi.stubEnv(key, join(tempRoot, name));
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

// Injectable base: no FS, no network. useCount/promptedCount are stubbed.
function base(overrides = {}) {
  const { env: envOverrides = {}, ...rest } = overrides;
  return {
    env: {
      XDG_CONFIG_HOME: join(tmpdir(), "remembrance-codex-stop-no-config"),
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      ...envOverrides,
    },
    readUseCount: () => 1,
    readEligibilityCount: () => 0,
    readPromptedCount: () => 0,
    readCompletionObligations: () => [],
    readHighMatch: () => null,
    readDirectSelections: () => [],
    writePromptedCount: () => {},
    ...rest,
  };
}

describe("Codex contribute-on-stop adapter", () => {
  it("allows the normal final response by default and defers routine recovery", () => {
    const written = [];
    const result = handleStop(
      { turn_id: "t-silent-default", stop_hook_active: false },
      base({
        env: { REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" },
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );
    expect(result).toEqual({
      allow: true,
      why: "silent_prompt_recovery",
    });
    expect(written).toEqual([]);
  });

  it("reports the native task outcome before applying the stop decision", async () => {
    const calls = [];
    const result = await handleStopHook(
      { turn_id: "t-outcome", stop_hook_active: true },
      base({
        reportTaskOutcomes: async (...args) => calls.push(args),
      }),
    );
    expect(calls[0]?.[0]).toBe("t-outcome");
    expect(calls[0]?.[2]).toMatchObject({
      env: {},
      userAgent: "@remembrance/codex-plugin",
    });
    expect(result).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("supports an explicit visible diagnostic recovery mode", () => {
    const written = [];
    const result = handleStop(
      { turn_id: "t1", stop_hook_active: false },
      base({ writePromptedCount: (id, count) => written.push([id, count]) }),
    );
    expect(result.allow).toBe(false);
    expect(result.output.decision).toBe("block");
    expect(result.output.reason).toContain(contributionReason());
    expect(result.output.reason).toContain(
      "Use Remembrance MCP tools when available",
    );
    expect(result.output.reason).toContain("REMEMBRANCE_SUBMISSION_PAYLOAD");
    expect(result.output.reason).toContain(
      "Do not mention routine Remembrance calls, hooks, or receipt IDs",
    );
    expect(result.output.reason).toContain("submit_remembrance");
    expect(result.output.reason).toContain("propose_private_skill");
    expect(result.output.reason).toContain("propose_skill_idea");
    expect(result.output.reason).toContain(
      "provide the task's normal user-facing final answer",
    );
    expect(result.output.reason.length).toBeLessThan(1_500);
    // It records the new prompted count so it won't re-block the same use.
    expect(written).toEqual([["t1", 1]]);
  });

  it("replays the prior task answer after a necessary visible Stop fallback", () => {
    const prior =
      "Committed the feature as db0da1a and verified the release gate.";
    const result = handleStop(
      {
        turn_id: "t-preserve-final",
        stop_hook_active: false,
        last_assistant_message: prior,
      },
      base(),
    );

    expect(result.output.reason).toContain(
      "preserve the task result in the user-facing final answer",
    );
    expect(result.output.reason).not.toContain(prior);
  });

  it("routes organization learning through the private router", () => {
    const result = handleStop(
      { turn_id: "t-private-lesson", stop_hook_active: false },
      base({
        env: {
          XDG_CONFIG_HOME: join(
            tmpdir(),
            "remembrance-codex-stop-private-lesson",
          ),
          REMEMBRANCE_API_KEY: "rk_private_lesson_adapter",
        },
      }),
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
    expect(result.output.reason).toContain(
      "capture_learning once per new item",
    );
    expect(result.output.reason).toContain(
      "exact next_action or bounded agent_recovery",
    );
    expect(result.output.reason).toContain("submit_query_feedback");
    expect(result.output.reason).toContain("submit_feedback");
    expect(result.output.reason).not.toContain("propose_private_skill");
    expect(result.output.reason).toContain(
      "Do not mention routine calls, hooks, or receipts",
    );
  });

  it("repeats a high-match fetch-or-explain obligation once at completion", () => {
    const result = handleStop(
      { turn_id: "t-high", stop_hook_active: false },
      base({
        readHighMatch: () => ({
          query_id: "rq_high",
          result_id: "qres_high",
          target_type: "skill",
          slug: "web-ui-ux-qa",
          estimated_tokens: 420,
          verified_uses: 12,
          risk_level: "low",
        }),
      }),
    );

    expect(result.output.reason).toContain("High-confidence result surfaced");
    expect(result.output.reason).toContain("If you have not opened it");
    expect(result.output.reason).toContain('"query_id":"rq_high"');
    expect(result.output.reason).toContain("fit poor plus the reason");
  });

  it("re-prompts only when use increased since the last prompt", () => {
    // Already prompted at count 1, still 1 use → allow.
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ readUseCount: () => 1, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
    // A second distinct use (2 > prior 1) → block again.
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ readUseCount: () => 2, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ allow: false, why: "prompt_contribution" });
  });

  it("does not re-block when stop_hook_active is true (loop guard)", () => {
    expect(
      handleStop({ turn_id: "t1", stop_hook_active: true }, base()),
    ).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("allows the stop when disabled via env", () => {
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } }),
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
    expect(
      handleStop(
        { turn_id: "t1", stop_hook_active: false },
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "false" } }),
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
  });

  it("does not nag when the session never used Remembrance", () => {
    expect(
      handleStop(
        { turn_id: "t2", stop_hook_active: false },
        base({ readUseCount: () => 0 }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("recovers an eligible task even when no query use was recorded", () => {
    const written = [];
    const result = handleStop(
      { turn_id: "t-context", stop_hook_active: false },
      base({
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
    expect(result.output.reason).toContain(
      "no Remembrance query with the task's full context and no skill use was recorded for it",
    );
    expect(result.output.reason).toContain("full conversation");
    expect(written).toEqual([["t-context", 1]]);
  });

  it("recovers a later eligible task after an earlier query was already handled", () => {
    expect(
      handleStop(
        { turn_id: "t-later-context", stop_hook_active: false },
        base({
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
  });

  it("asks for contribution once the later eligible task also completed a query", () => {
    expect(
      handleStop(
        { turn_id: "t-later-query", stop_hook_active: false },
        base({
          readUseCount: () => 2,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
  });

  it("prompts on high-value self-corrections even without a new registry marker", () => {
    const written = [];
    const result = handleStop(
      {
        turn_id: "t-version-miss",
        stop_hook_active: false,
        last_assistant_message:
          "I missed the MCP package version bump after publish-impacting plugin changes.",
      },
      base({
        readUseCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_high_value_lesson_contribution",
    });
    expect(result.output.reason).toContain("High-value lesson detected");
    expect(result.output.reason).toContain("release versioning miss");
    expect(written).toEqual([["t-version-miss", 1]]);
  });

  it("does not prompt when the high-value lesson was already submitted", () => {
    expect(
      handleStop(
        {
          turn_id: "t-submitted",
          stop_hook_active: false,
          last_assistant_message:
            "I submitted it to Remembrance as rpub_769ded635ea04884a8.",
        },
        base({
          readUseCount: () => 0,
          readPromptedCount: () => 0,
        }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("fails open (allows) when the use marker cannot be read", () => {
    // A reader that returns 0 (its fail-open contract) → treated as not used.
    expect(
      handleStop(
        { turn_id: "t3", stop_hook_active: false },
        base({ readUseCount: () => 0 }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });
});

describe("session-scoped explicit selections through the Codex hooks", () => {
  // The Remembrance MCP result for invoke_skill: the server puts scope next to
  // selection_mode, skill, and query_id in the envelope's body.
  function invokeResponse({ slug, queryId, resultId, scope }) {
    const body = {
      scope,
      selection_mode: "explicit",
      invocation_id: queryId,
      query_id: queryId,
      result_id: resultId,
      skill: {
        slug,
        version: 1,
        version_id: `skv_${slug}`,
        skill_md: "# Instructions",
        task_outcome_eligible: true,
      },
      feedback: { available: true },
      task_outcome: { available: true, eligible_result_ids: [resultId] },
    };
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, status: 200, body }) },
      ],
    };
  }
  const SESSION_SKILL = invokeResponse({
    slug: "pairing-mode",
    queryId: "rinv_session",
    resultId: "qres_session",
    scope: "session",
  });
  const TASK_SKILL = invokeResponse({
    slug: "release-checklist",
    queryId: "rinv_task",
    resultId: "qres_task",
    scope: "task",
  });

  function testEnv() {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    };
  }

  const observe = (turnId, env, response) =>
    handlePostToolUse(
      {
        turn_id: turnId,
        tool_name: "mcp__remembrance__invoke_skill",
        tool_response: response,
      },
      { env, recordHealth: vi.fn() },
    );

  it("allows the stop when the only engagement is a session-scoped skill", async () => {
    const env = testEnv();
    const turnId = "codex-session-only";
    expect(await observe(turnId, env, SESSION_SKILL)).toMatchObject({
      recorded: true,
      why: "direct_skill_invoked",
      count: 0,
    });
    expect(readRegistryUseCount(turnId, env)).toBe(0);
    expect(readDirectSelectionSurfaces(turnId, env)).toMatchObject([
      { slug: "pairing-mode", scope: "session", use_count: 0 },
    ]);

    const fetchImpl = vi.fn();
    const result = await handleStopHook(
      { turn_id: turnId, stop_hook_active: false },
      { env, fetchImpl, recordHealth: vi.fn() },
    );
    expect(result).toEqual({ allow: true, why: "registry_not_used" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCompletionObligations(turnId, env)).toEqual([]);
  });

  it("closes only the task-scoped selection when both kinds were used", async () => {
    const env = testEnv();
    const turnId = "codex-session-and-task";
    await observe(turnId, env, SESSION_SKILL);
    await observe(turnId, env, TASK_SKILL);
    expect(readRegistryUseCount(turnId, env)).toBe(1);

    const requests = [];
    const result = await handleStopHook(
      { turn_id: turnId, stop_hook_active: false },
      {
        env,
        recordHealth: vi.fn(),
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(init.body) });
          return { ok: true };
        },
      },
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rinv_task");
    expect(result.output.reason).not.toContain("rinv_session");
    expect(result.output.reason).not.toContain("pairing-mode");
    expect(
      requests.map((request) => [request.url, request.body.query_id]),
    ).toEqual([
      ["https://registry.example/api/v1/agent/task-outcomes", "rinv_task"],
    ]);
  });
});

// Codex's hook schema gives a subagent's tool hooks and its SubagentStop the
// session_id and active turn_id plus the subagent's agent_id. When those ids
// are the parent's, only agent_id separates the subagent's debts.
describe("debts earned inside a Codex subagent", () => {
  const SESSION = "codex-session-parent";
  const TURN = "codex-turn-parent";
  const AGENT = "codex-agent-7f3a";
  const PAYLOAD = {
    schema_version: 1,
    type: "skill_use",
    lesson: "Pin the toolchain before bisecting a flaky build.",
    interaction: { query_id: "rq_codex_sub", result_id: "qres_codex_sub" },
  };
  const agentLedger = agentLedgerIdFor({
    session_id: SESSION,
    agent_id: AGENT,
  });
  const envelope = (body) => ({
    content: [
      { type: "text", text: JSON.stringify({ ok: true, status: 200, body }) },
    ],
  });
  function testEnv(extra = {}) {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0",
      ...extra,
    };
  }
  const hookBase = { session_id: SESSION, turn_id: TURN, cwd: "/work" };
  const observe = (env, fields) =>
    handlePostToolUse(
      { ...hookBase, hook_event_name: "PostToolUse", ...fields },
      { env, recordHealth: vi.fn() },
    );
  const parentQuery = (env) =>
    observe(env, {
      tool_name: "mcp__remembrance__query_skills",
      tool_input: { summary: "flaky build" },
      tool_response: envelope({
        query_id: "rq_codex_parent",
        query_feedback: { available: true, query_id: "rq_codex_parent" },
        skills: [{ result_id: "qres_codex_parent", slug: "bisect-builds" }],
      }),
    });
  const subagentFeedback = (env) =>
    observe(env, {
      agent_id: AGENT,
      agent_type: "worker",
      tool_name: "mcp__remembrance__submit_feedback",
      tool_input: { query_id: "rq_codex_sub", result_id: "qres_codex_sub" },
      tool_response: envelope({
        next_step: { submit_remembrance_payload: PAYLOAD },
      }),
    });
  const subagentStop = (extra = {}) => ({
    ...hookBase,
    hook_event_name: "SubagentStop",
    agent_id: AGENT,
    agent_type: "worker",
    agent_transcript_path: null,
    stop_hook_active: false,
    last_assistant_message: "Bisected to the toolchain bump.",
    ...extra,
  });
  const kinds = (ledgerId, env) =>
    readCompletionObligations(ledgerId, env).map((item) => [
      item.kind,
      item.prompted_at === null,
    ]);

  it("keeps a subagent's debt out of its parent's stop", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
    await parentQuery(env);
    await subagentFeedback(env);
    // The main thread's debts are kept under its session, never its turn.
    expect(kinds(SESSION, env)).toEqual([["query_feedback", true]]);
    expect(kinds(TURN, env)).toEqual([]);
    expect(kinds(agentLedger, env)).toEqual([["remembrance_followup", true]]);

    const result = await handleStopHook(
      { ...hookBase, hook_event_name: "Stop", stop_hook_active: false },
      { env, recordHealth: vi.fn(), reportTaskOutcomes: async () => 0 },
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rq_codex_parent");
    expect(result.output.reason).not.toContain("Reusable evidence");
    expect(kinds(agentLedger, env)).toEqual([["remembrance_followup", true]]);
  });

  it("asks the subagent once, at SubagentStop, for its own debts", async () => {
    const env = testEnv();
    await parentQuery(env);
    await subagentFeedback(env);
    const reportTaskOutcomes = vi.fn(async () => 0);
    const options = { env, recordHealth: vi.fn(), reportTaskOutcomes };
    const result = await handleStopHook(subagentStop(), options);
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
      output: { decision: "block" },
    });
    expect(result.output.reason).not.toContain("rq_codex_parent");
    const lines = result.output.reason.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        "- Reusable evidence for query_id rq_codex_sub and result_id qres_codex_sub:",
      ),
    );
    expect(lead).toBeGreaterThan(-1);
    expect(JSON.parse(lines[lead + 1])).toEqual(PAYLOAD);
    expect(result.output.reason.split("\n").at(-1)).toBe(
      "After the silent cleanup, make sure your caller still gets your complete final report, unchanged and without Remembrance status text. Deliver it again the way your task returns results, unless you already returned it through a tool meant to be called once.",
    );
    expect(reportTaskOutcomes).not.toHaveBeenCalled();
    expect(kinds(agentLedger, env)).toEqual([["remembrance_followup", false]]);
    expect(kinds(SESSION, env)).toEqual([["query_feedback", true]]);
    expect(
      await handleStopHook(subagentStop({ stop_hook_active: true }), options),
    ).toEqual({ allow: true, why: "stop_hook_active" });
    expect(await handleStopHook(subagentStop(), options)).toEqual({
      allow: true,
      why: "silent_prompt_recovery",
    });
  });

  // The transfer lands in the session's ledger, whichever turn_id the
  // SubagentStop carries.
  it("passes what the subagent leaves unpaid to the parent, marked second-hand", async () => {
    const env = testEnv();
    await parentQuery(env);
    await subagentFeedback(env);
    const options = {
      env,
      recordHealth: vi.fn(),
      reportTaskOutcomes: async () => 0,
    };
    // A Stop that carries an agent id is not a subagent's exit.
    expect(
      await handleStopHook(
        { ...subagentStop(), hook_event_name: "Stop" },
        options,
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
    expect(kinds(agentLedger, env)).toEqual([["remembrance_followup", true]]);
    expect((await handleStopHook(subagentStop(), options)).allow).toBe(false);
    expect(
      await handleStopHook(subagentStop({ stop_hook_active: true }), options),
    ).toEqual({ allow: true, why: "stop_hook_active" });
    expect(kinds(agentLedger, env)).toEqual([]);
    expect(kinds(TURN, env)).toEqual([]);
    expect(
      readCompletionObligations(SESSION, env).map((item) => [
        item.kind,
        item.prompted_at,
        item.transferred_from,
      ]),
    ).toEqual([
      ["query_feedback", null, null],
      [
        "remembrance_followup",
        null,
        { agent_id: AGENT, transcript_path: null },
      ],
    ]);

    // Visible recovery asks the parent at its own stop.
    const stop = await handleStopHook(
      { ...hookBase, hook_event_name: "Stop", stop_hook_active: false },
      {
        ...options,
        env: { ...env, REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" },
      },
    );
    expect(stop).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    const lines = stop.output.reason.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        `- Reusable evidence for query_id rq_codex_sub and result_id qres_codex_sub (second-hand from subagent ${AGENT}): call submit_remembrance`,
      ),
    );
    expect(lead).toBeGreaterThan(-1);
    expect(JSON.parse(lines[lead + 1])).toEqual(PAYLOAD);
    expect(stop.output.reason).toContain(
      "- Query fit: call submit_query_feedback for query_id rq_codex_parent.",
    );
  });

  it("lets the subagent decline its own debt, in its own ledger", async () => {
    const env = testEnv();
    await parentQuery(env);
    await subagentFeedback(env);
    const options = {
      env,
      recordHealth: vi.fn(),
      reportTaskOutcomes: async () => 0,
    };
    const ask = await handleStopHook(subagentStop(), options);
    const lines = ask.output.reason.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        "- Reusable evidence for query_id rq_codex_sub and result_id qres_codex_sub:",
      ),
    );
    const actionId = /^ {2}action_id ([a-f0-9]{16})$/u.exec(
      lines[lead + 2],
    )?.[1];
    expect(actionId).toMatch(/^[a-f0-9]{16}$/u);
    const args = { action_id: actionId, reason: "not_reusable" };
    await observe(env, {
      agent_id: AGENT,
      agent_type: "worker",
      tool_name: "mcp__remembrance__decline_pending_action",
      tool_input: args,
      tool_response: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "declined",
              ...args,
              submitted: false,
              local_only: true,
            }),
          },
        ],
      },
    });
    expect(kinds(agentLedger, env)).toEqual([]);
    expect(
      await handleStopHook(subagentStop({ stop_hook_active: true }), options),
    ).toEqual({ allow: true, why: "stop_hook_active" });
    // Nothing is left to pass to the parent.
    expect(kinds(SESSION, env)).toEqual([["query_feedback", true]]);
  });

  it("touches no ledger at a SubagentStop without an agent id", async () => {
    const env = testEnv();
    await parentQuery(env);
    await subagentFeedback(env);
    expect(
      await handleStopHook(subagentStop({ agent_id: "" }), {
        env,
        recordHealth: vi.fn(),
        reportTaskOutcomes: async () => 0,
      }),
    ).toEqual({ allow: true, why: "subagent_identity_unavailable" });
    expect(kinds(SESSION, env)).toEqual([["query_feedback", true]]);
    expect(kinds(agentLedger, env)).toEqual([["remembrance_followup", true]]);
  });
});

// The bundled server's local capture_learning answers a preference with the
// one call that can persist it: {capture_route "preference", persisted_locally
// false, next_action record_preference}. No query_id or draft_id marks it.
// Review F5 (Task 14): the hook keeps those exact arguments sealed with the
// private-learning key, as it keeps a follow-up's payload, and its demand
// names them by action id and ledger, so an agent that lost the capture
// response can complete the action without guessing.
describe("a capture_learning preference route through the Codex hooks", () => {
  const SESSION = "codex-session-preference";
  const TURN = "codex-turn-preference";
  const PREFERENCE = {
    key: "presentation.reply_length",
    value: "terse",
    strength: "prefer",
    scope: "installation",
    evidence: "user_stated",
  };
  const ledger = agentLedgerIdFor({ session_id: SESSION, turn_id: TURN });
  const hookBase = { session_id: SESSION, turn_id: TURN, cwd: "/work" };
  const sha256 = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  // The hook's digest, computed here independently: sorted-key JSON.
  const DIGEST = `sha256:${sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.keys(PREFERENCE)
          .sort()
          .map((key) => [key, PREFERENCE[key]]),
      ),
    ),
  )}`;
  const ACTION_ID = sha256(`capture_next_action:${DIGEST}`).slice(0, 16);
  const LEDGER = sha256(ledger).slice(0, 16);
  const localResult = (body) => ({
    content: [{ type: "text", text: JSON.stringify(body) }],
  });
  const CAPTURED = localResult({
    contract_version: "capture-learning-v1",
    capture_route: "preference",
    persisted_locally: false,
    next_action: { tool: "record_preference", arguments: PREFERENCE },
  });
  function testEnv() {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0",
    };
  }
  const observe = (env, fields) =>
    handlePostToolUse(
      { ...hookBase, hook_event_name: "PostToolUse", ...fields },
      { env, recordHealth: vi.fn() },
    );
  const capture = (env) =>
    observe(env, {
      tool_name: "mcp__remembrance__capture_learning",
      tool_input: { preference: PREFERENCE },
      tool_response: CAPTURED,
    });
  const record = (env, preference) =>
    observe(env, {
      tool_name: "mcp__remembrance__record_preference",
      tool_input: preference,
      tool_response: localResult({
        ok: true,
        status: 200,
        body: { recorded: true },
      }),
    });
  const prompt = async (env, turnId = TURN) => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await handleQuery(
      {
        ...hookBase,
        turn_id: turnId,
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      },
      { env, recordHealth: vi.fn(), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    return result?.hookSpecificOutput.additionalContext ?? "";
  };
  // Every file under the ledger directory, as text.
  // Every record of the ledger, in both of its homes: the durable one that
  // keeps sealed arguments, and the temporary usage directory.
  const ledgerText = (env) =>
    [
      join(
        env.XDG_STATE_HOME,
        "remembrance",
        "private-learning-lifecycle",
        "retained",
        `${LEDGER}.obligations`,
      ),
      join(env.REMEMBRANCE_USAGE_DIR, `${LEDGER}.obligations`),
    ]
      .flatMap((directory) =>
        existsSync(directory)
          ? readdirSync(directory).map((name) =>
              readFileSync(join(directory, name), "utf8"),
            )
          : [],
      )
      .join("\n");
  const key = (env) =>
    Buffer.from(
      readFileSync(
        join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key"),
        "utf8",
      ).trim(),
      "base64url",
    );
  const DEMAND = `- Durable preference: arguments kept on this machine (${Buffer.byteLength(JSON.stringify(PREFERENCE))} bytes, ${DIGEST}); call local get_pending_action_payload with action_id ${ACTION_ID} and ledger ${LEDGER}, then record_preference with exactly the arguments it returns.`;

  it("records the record_preference next action once, keeps its arguments sealed once, and demands it by handle once", async () => {
    const env = testEnv();
    await capture(env);
    const [first] = readCompletionObligations(ledger, env);
    // The host delivers the same PostToolUse twice.
    await capture(env);
    const held = readCompletionObligations(ledger, env);
    expect(
      held.map((item) => [item.kind, item.action_tool, item.prompted_at]),
    ).toEqual([["capture_next_action", "record_preference", null]]);
    expect(held[0]).toMatchObject({
      id: `capture_next_action:${DIGEST}`,
      payload_digest: DIGEST,
      local_resupply_payload: null,
      local_resupply_payload_omitted: null,
      local_resupply_envelope: {
        version: "completion-resupply-envelope-v1",
        algorithm: "aes-256-gcm",
        key_source: "mode_0600_file",
      },
    });
    // Retained once: the repeated callback kept the first envelope.
    expect(held[0].local_resupply_envelope).toEqual(
      first.local_resupply_envelope,
    );
    // Nothing of the arguments is on disk in the clear.
    for (const clear of ["reply_length", "terse", "user_stated"]) {
      expect(ledgerText(env)).not.toContain(clear);
    }

    const lines = (await prompt(env)).split("\n");
    expect(lines.filter((line) => line.includes("record_preference"))).toEqual([
      DEMAND,
    ]);
    expect(lines[lines.indexOf(DEMAND) + 1]).toBe(`  action_id ${ACTION_ID}`);
    expect(lines.join("\n")).not.toContain("terse");
  });

  it("hands the exact arguments back in a later turn, and only the exact record_preference call closes it", async () => {
    const env = testEnv();
    await capture(env);
    // A later turn of the same session, as after an interrupted turn or a
    // compacted context, names the same handle.
    expect((await prompt(env, "codex-turn-later")).split("\n")).toContain(
      DEMAND,
    );
    const retrieve = () =>
      readPendingActionPayload({ action_id: ACTION_ID, ledger: LEDGER }, env, {
        readKey: async () => key(env),
      });
    const retrieved = await retrieve();
    expect(retrieved).toMatchObject({
      status: "retrieved",
      kind: "capture_next_action",
      action_tool: "record_preference",
      provenance: "first_hand",
      transferred_from: null,
      payload_digest: DIGEST,
      payload_bytes: Buffer.byteLength(JSON.stringify(PREFERENCE)),
      submitted: false,
      local_only: true,
    });
    expect(retrieved).not.toHaveProperty("payload");
    expect(JSON.stringify(retrieved.arguments)).toBe(
      JSON.stringify(PREFERENCE),
    );
    // Retrieval itself closed nothing.
    expect(readCompletionObligations(ledger, env)).toHaveLength(1);

    await record(env, { ...retrieved.arguments, value: "verbose" });
    expect(readCompletionObligations(ledger, env)).toHaveLength(1);
    await record(env, retrieved.arguments);
    expect(readCompletionObligations(ledger, env)).toEqual([]);
    expect(await prompt(env)).not.toContain("Durable preference");
    expect(await retrieve()).toMatchObject({ status: "not_found" });
  });

  it("closes it only on the exact record_preference call", async () => {
    const env = testEnv();
    await capture(env);
    await record(env, { ...PREFERENCE, value: "verbose" });
    expect(readCompletionObligations(ledger, env)).toHaveLength(1);

    await record(env, PREFERENCE);
    expect(readCompletionObligations(ledger, env)).toEqual([]);
    expect(await prompt(env)).not.toContain("Durable preference");
  });
});

// Codex 0.145.0 sends every hook the session tree's session_id and the
// active turn_id, and each user prompt starts a new turn. The main thread's
// debts outlive the turn that earned them.
describe("a Codex main thread's debts across turns", () => {
  const SESSION = "codex-session-turns";
  const TURN_A = "codex-turn-a";
  const TURN_B = "codex-turn-b";
  const PAYLOAD = {
    schema_version: 1,
    type: "skill_use",
    lesson: "Pin the toolchain before bisecting a flaky build.",
    interaction: { query_id: "rq_codex_main", result_id: "qres_codex_main" },
  };
  const sha256 = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const envelope = (body) => ({
    content: [
      { type: "text", text: JSON.stringify({ ok: true, status: 200, body }) },
    ],
  });
  function testEnv(extra = {}) {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0",
      ...extra,
    };
  }
  const at = (turn, fields = {}) => ({
    session_id: SESSION,
    turn_id: turn,
    cwd: "/work",
    ...fields,
  });
  const observe = (env, turn, fields) =>
    handlePostToolUse(at(turn, { hook_event_name: "PostToolUse", ...fields }), {
      env,
      recordHealth: vi.fn(),
    });
  const feedback = (env, turn, payload = PAYLOAD, fields = {}) =>
    observe(env, turn, {
      tool_name: "mcp__remembrance__submit_feedback",
      tool_input: payload.interaction,
      tool_response: envelope({
        next_step: { submit_remembrance_payload: payload },
      }),
      ...fields,
    });
  const prompt = async (env, turn) => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await handleQuery(
      at(turn, {
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      }),
      { env, recordHealth: vi.fn(), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    return (result?.hookSpecificOutput.additionalContext ?? "").split("\n");
  };
  const kinds = (ledgerId, env) =>
    readCompletionObligations(ledgerId, env).map((item) => [
      item.kind,
      item.query_id,
    ]);
  const lead = (lines, queryId) =>
    lines.findIndex((line) =>
      line.startsWith(`- Reusable evidence for query_id ${queryId} `),
    );
  const ledgerDirectory = (env, ledgerId) =>
    join(
      env.REMEMBRANCE_USAGE_DIR,
      `${sha256(ledgerId).slice(0, 16)}.obligations`,
    );
  // A record as the installed 0.1.77 client wrote it for the main thread:
  // under the turn id, a digest instead of the payload, no agent stamp.
  const legacyRecord = (env, ledgerId, name, createdAt) => {
    const digest = `sha256:${sha256(`an older client's payload ${name}`)}`;
    const id = `remembrance_followup:${digest}`;
    const directory = ledgerDirectory(env, ledgerId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, `${sha256(id).slice(0, 32)}.json`),
      `${JSON.stringify({
        version: "completion-obligation-v1",
        id,
        kind: "remembrance_followup",
        engagement_count: 1,
        query_id: `rq_legacy_${name}`,
        result_id: `qres_legacy_${name}`,
        draft_id: null,
        skill_slug: null,
        payload_digest: digest,
        created_at: createdAt,
        prompted_at: null,
      })}\n`,
      { mode: 0o600 },
    );
    return id;
  };
  const legacyOverflow = (env, ledgerId, count) => {
    mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(
        env.REMEMBRANCE_USAGE_DIR,
        `${sha256(ledgerId).slice(0, 16)}.obligations-overflow.json`,
      ),
      `${JSON.stringify({
        version: "completion-obligation-overflow-v1",
        count,
        first_dropped_at: "2026-09-26T01:00:00.000Z",
        last_dropped_at: "2026-09-26T02:00:00.000Z",
        kinds: ["query_feedback"],
      })}\n`,
      { mode: 0o600 },
    );
  };

  it("demands turn A's debt at turn B's prompt, with its payload", async () => {
    const env = testEnv();
    await feedback(env, TURN_A);
    expect(kinds(SESSION, env)).toEqual([
      ["remembrance_followup", "rq_codex_main"],
    ]);
    expect(kinds(TURN_A, env)).toEqual([]);

    // Turn A ends silently; the debt stays.
    const stop = await handleStopHook(
      at(TURN_A, { hook_event_name: "Stop", stop_hook_active: false }),
      { env, recordHealth: vi.fn(), reportTaskOutcomes: async () => 0 },
    );
    expect(stop).toEqual({ allow: true, why: "silent_prompt_recovery" });

    // After compaction or a restart only the ledger remembers it.
    const lines = await prompt(env, TURN_B);
    const index = lead(lines, "rq_codex_main");
    expect(index).toBeGreaterThan(-1);
    expect(JSON.parse(lines[index + 1])).toEqual(PAYLOAD);

    // Submitting it in turn B closes it.
    await observe(env, TURN_B, {
      tool_name: "mcp__remembrance__submit_remembrance",
      tool_input: PAYLOAD,
      tool_response: envelope({ accepted: true }),
    });
    expect(kinds(SESSION, env)).toEqual([]);
    expect((await prompt(env, TURN_B)).join("\n")).not.toContain(
      "rq_codex_main",
    );
  });

  it("demands it from a fresh hook process", async () => {
    const env = testEnv();
    await feedback(env, TURN_A);
    const script = fileURLToPath(
      new URL("../scripts/query-on-prompt.mjs", import.meta.url),
    );
    const stdout = execFileSync(process.execPath, [script], {
      input: JSON.stringify(
        at(TURN_B, {
          hook_event_name: "UserPromptSubmit",
          prompt: "rename a local variable",
        }),
      ),
      env: {
        PATH: process.env.PATH,
        HOME: join(env.XDG_CONFIG_HOME, "..", "home"),
        TMPDIR: process.env.TMPDIR,
        REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
        ...env,
      },
      encoding: "utf8",
    });
    const lines =
      JSON.parse(stdout).hookSpecificOutput.additionalContext.split("\n");
    expect(JSON.parse(lines[lead(lines, "rq_codex_main") + 1])).toEqual(
      PAYLOAD,
    );
  });

  it("records a duplicate callback once", async () => {
    const env = testEnv();
    await feedback(env, TURN_A);
    await feedback(env, TURN_A);
    await feedback(env, TURN_B);
    expect(kinds(SESSION, env)).toEqual([
      ["remembrance_followup", "rq_codex_main"],
    ]);
  });

  it("keeps a payload too large to retain as a debt in the next turn", async () => {
    const env = testEnv();
    const oversized = {
      ...PAYLOAD,
      lesson: "w".repeat(9000),
      interaction: { query_id: "rq_codex_big", result_id: "qres_codex_big" },
    };
    await feedback(env, TURN_A, oversized);
    const [held] = readCompletionObligations(SESSION, env);
    expect(held.local_resupply_payload).toBeNull();
    expect(held.local_resupply_payload_omitted).toBe("too_large");
    expect(await prompt(env, TURN_B)).toContain(
      "- Reusable evidence for query_id rq_codex_big and result_id qres_codex_big: payload too large to retain; call submit_remembrance with the payload submit_feedback returned only if you still hold it verbatim.",
    );
  });

  it("folds what an older client kept under the current turn into the session, once", async () => {
    const env = testEnv();
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const id = legacyRecord(env, TURN_A, "a", createdAt);
    legacyOverflow(env, TURN_A, 3);
    // Any hook that names turn A folds it: here a query_skills PostToolUse.
    const fold = () =>
      observe(env, TURN_A, {
        tool_name: "mcp__remembrance__query_skills",
        tool_input: { summary: "rename" },
        tool_response: envelope({ query_id: "rq_fold", skills: [] }),
      });
    await fold();
    const [record] = readCompletionObligations(SESSION, env);
    expect(record).toMatchObject({
      id,
      query_id: "rq_legacy_a",
      created_at: createdAt,
      prompted_at: null,
      agent_keyed: false,
      local_resupply_payload: null,
    });
    expect(existsSync(ledgerDirectory(env, TURN_A))).toBe(false);
    // A second delivery neither duplicates the debt nor counts twice.
    await fold();
    expect(kinds(SESSION, env)).toEqual([
      ["remembrance_followup", "rq_legacy_a"],
    ]);

    // Turn B's prompt demands it, labelled as an older client's record, and
    // reports the older client's overflow once.
    const lines = await prompt(env, TURN_B);
    expect(lines).toContain(
      "- Reusable evidence for query_id rq_legacy_a and result_id qres_legacy_a [pre-agent-keying: this and every debt tagged so were recorded before per-agent keying and may be a subagent's; decline one with not_observed_by_this_agent if you did not receive it]: submit the exact next_step.submit_remembrance_payload returned by the preceding feedback call.",
    );
    expect(
      lines.filter((line) => line.includes("could not be recorded")),
    ).toEqual([
      "- 3 obligations could not be recorded since 2026-09-26T01:00:00.000Z (query_feedback): the pending list was full.",
    ]);
  });

  it("leaves a debt in the turn ledger while the session ledger cannot take it", async () => {
    const env = testEnv();
    const id = legacyRecord(env, TURN_A, "stuck", new Date().toISOString());
    legacyOverflow(env, TURN_A, 2);
    // The session ledger's directory is blocked by a file.
    writeFileSync(ledgerDirectory(env, SESSION), "", { mode: 0o600 });
    await prompt(env, TURN_A);
    expect(
      readCompletionObligations(TURN_A, env).map((item) => item.id),
    ).toEqual([id]);
    rmSync(ledgerDirectory(env, SESSION));
    await prompt(env, TURN_A);
    expect(readCompletionObligations(TURN_A, env)).toEqual([]);
    expect(
      readCompletionObligations(SESSION, env).map((item) => item.id),
    ).toEqual([id]);
    // The turn's overflow count moved once, not once per attempt.
    expect(
      (await prompt(env, TURN_B)).filter((line) =>
        line.includes("could not be recorded"),
      ),
    ).toEqual([
      "- 2 obligations could not be recorded since 2026-09-26T01:00:00.000Z (query_feedback): the pending list was full.",
    ]);
  });

  it("counts a folded debt a full session ledger cannot take", async () => {
    const env = testEnv();
    for (let index = 0; index < 64; index += 1) {
      recordQueryFeedbackObligation(
        SESSION,
        { available: true, query_id: `rq_full_${index}` },
        env,
      );
    }
    legacyRecord(env, TURN_A, "overflowing", new Date().toISOString());
    const lines = await prompt(env, TURN_A);
    expect(readdirSync(env.REMEMBRANCE_USAGE_DIR)).not.toContain(
      `${sha256(TURN_A).slice(0, 16)}.obligations`,
    );
    expect(
      lines.filter((line) => line.includes("could not be recorded")),
    ).toHaveLength(1);
    expect(lines.join("\n")).toMatch(
      /- 1 obligation could not be recorded since \S+ \(remembrance_followup\): the pending list was full\./u,
    );
  });

  it("keeps two subagents' debts apart and passes each on at its own stop", async () => {
    const env = testEnv();
    const AGENT_X = "codex-agent-x";
    const AGENT_Y = "codex-agent-y";
    const payloadOf = (id) => ({
      ...PAYLOAD,
      interaction: { query_id: `rq_${id}`, result_id: `qres_${id}` },
    });
    // Both subagents run while the parent is in turn A.
    await feedback(env, TURN_A, payloadOf("x"), {
      agent_id: AGENT_X,
      agent_type: "worker",
    });
    await feedback(env, TURN_A, payloadOf("y"), {
      agent_id: AGENT_Y,
      agent_type: "worker",
    });
    const ledgerOf = (agentId) =>
      agentLedgerIdFor({ session_id: SESSION, agent_id: agentId });
    expect(kinds(ledgerOf(AGENT_X), env)).toEqual([
      ["remembrance_followup", "rq_x"],
    ]);
    expect(kinds(ledgerOf(AGENT_Y), env)).toEqual([
      ["remembrance_followup", "rq_y"],
    ]);
    expect(kinds(SESSION, env)).toEqual([]);

    // X exits in a turn of its own; its debt reaches the session, second-hand.
    const options = {
      env,
      recordHealth: vi.fn(),
      reportTaskOutcomes: async () => 0,
    };
    const subagentStop = (agentId, turn) =>
      handleStopHook(
        at(turn, {
          hook_event_name: "SubagentStop",
          agent_id: agentId,
          agent_type: "worker",
          agent_transcript_path: null,
          stop_hook_active: true,
          last_assistant_message: "Done.",
        }),
        options,
      );
    await subagentStop(AGENT_X, "codex-turn-of-x");
    expect(kinds(ledgerOf(AGENT_X), env)).toEqual([]);
    expect(
      readCompletionObligations(SESSION, env).map((item) => [
        item.query_id,
        item.transferred_from,
      ]),
    ).toEqual([["rq_x", { agent_id: AGENT_X, transcript_path: null }]]);
    expect(kinds(ledgerOf(AGENT_Y), env)).toEqual([
      ["remembrance_followup", "rq_y"],
    ]);

    // The parent's next prompt names X's debt as second-hand and not Y's.
    const lines = await prompt(env, TURN_B);
    expect(
      lines.filter((line) => line.startsWith("- Reusable evidence")),
    ).toEqual([
      `- Reusable evidence for query_id rq_x and result_id qres_x (second-hand from subagent ${AGENT_X}): call submit_remembrance with exactly the payload on the next line, which submit_feedback returned and Remembrance keeps on this machine only to re-supply it.`,
    ]);

    await subagentStop(AGENT_Y, TURN_B);
    expect(kinds(SESSION, env)).toEqual([
      ["remembrance_followup", "rq_x"],
      ["remembrance_followup", "rq_y"],
    ]);
  });
});

// Task 12 Appendix C item 4: after a compaction the agent invoked two
// always-on skills again, and the hook asked for post-use feedback under the
// new receipts although it had just been paid under the first ones. A
// version invoked again while in use is the same use and owes one feedback.
describe("a skill version invoked again while it is in use", () => {
  const SESSION = "codex-reload-session";
  const CAVEMAN = "qres_direct_caveman_v1";
  const ledger = agentLedgerIdFor({ session_id: SESSION, turn_id: "t" });
  const envelope = (body) => ({
    content: [
      { type: "text", text: JSON.stringify({ ok: true, status: 200, body }) },
    ],
  });
  function testEnv(extra = {}) {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0",
      ...extra,
    };
  }
  const at = (turn, fields = {}) => ({
    session_id: SESSION,
    turn_id: turn,
    cwd: "/work",
    ...fields,
  });
  const observe = (env, turn, fields) =>
    handlePostToolUse(at(turn, { hook_event_name: "PostToolUse", ...fields }), {
      env,
      recordHealth: vi.fn(),
    });
  const invoke = (env, turn, queryId, { slug = "caveman", resultId } = {}) =>
    observe(env, turn, {
      tool_name: "mcp__remembrance__invoke_skill",
      tool_input: { slug },
      tool_response: envelope({
        scope: "task",
        selection_mode: "explicit",
        invocation_id: queryId,
        query_id: queryId,
        result_id: resultId ?? CAVEMAN,
        skill: {
          slug,
          version: 1,
          version_id: `skv_${slug}`,
          skill_md: "# Instructions",
        },
        feedback: { available: true },
      }),
    });
  const pay = (env, turn, queryId, resultId = CAVEMAN) =>
    observe(env, turn, {
      tool_name: "mcp__remembrance__submit_feedback",
      tool_input: { query_id: queryId, result_id: resultId, useful: true },
      tool_response: envelope({ recorded: true }),
    });
  // A prompt that starts a task (its query finds nothing); returns the
  // post-use lines of its context.
  const task = async (env, turn) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ skills: [], resources: [] }),
    );
    const result = await handleQuery(
      at(turn, {
        hook_event_name: "UserPromptSubmit",
        prompt: "Deploy the Next.js app to Vercel with GitHub Actions.",
      }),
      { env, recordHealth: vi.fn(), fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalled();
    return (result?.hookSpecificOutput.additionalContext ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- Post-use feedback"));
  };
  // The user's next prompt only names the skill: it neither queries nor
  // starts a task.
  const namesSkill = async (env, turn) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ skills: [], resources: [] }),
    );
    await handleQuery(
      at(turn, {
        hook_event_name: "UserPromptSubmit",
        prompt: "Use the remembrance skill named caveman.",
      }),
      { env, recordHealth: vi.fn(), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  };
  const demand = (queryId, slug = "caveman", resultId = CAVEMAN) =>
    `- Post-use feedback for ${slug}: call submit_feedback with query_id ${queryId} and result_id ${resultId}.`;
  const debts = (env) =>
    readCompletionObligations(ledger, env).map((item) => [
      item.query_id,
      item.result_id,
      item.alias_query_ids ?? [],
    ]);

  it("owes one feedback, payable under either receipt, for a reload before it is paid", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    // The context was compacted and the agent loaded the skill again.
    await invoke(env, "turn-1", "rinv_reload");
    expect(readRegistryUseCount(ledger, env)).toBe(1);
    expect(debts(env)).toEqual([["rinv_first", CAVEMAN, ["rinv_reload"]]]);
    expect(await task(env, "turn-2")).toEqual([demand("rinv_first")]);

    await pay(env, "turn-2", "rinv_reload");
    expect(debts(env)).toEqual([]);
    expect(await task(env, "turn-3")).toEqual([]);
  });

  it("owes nothing more for a reload after the payment, before the next prompt", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    expect(await task(env, "turn-2")).toEqual([demand("rinv_first")]);
    await pay(env, "turn-2", "rinv_first");
    await invoke(env, "turn-2", "rinv_reload");
    expect(debts(env)).toEqual([]);
    expect(readRegistryUseCount(ledger, env)).toBe(1);
    expect(await task(env, "turn-3")).toEqual([]);
  });

  it("owes feedback again for a use in a later task", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    await task(env, "turn-2");
    await pay(env, "turn-2", "rinv_first");
    await task(env, "turn-3");
    await invoke(env, "turn-3", "rinv_later");
    expect(readRegistryUseCount(ledger, env)).toBe(2);
    expect(await task(env, "turn-4")).toEqual([demand("rinv_later")]);
  });

  it("owes feedback again for a use after the next prompt, even one that only names the skill", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    await pay(env, "turn-1", "rinv_first");
    const tasks = readTaskEligibilityCount(ledger, env);
    const prompts = readUserPromptCount(ledger, env);
    await namesSkill(env, "turn-2");
    // No new task, but a new prompt: the paid use is over.
    expect(readTaskEligibilityCount(ledger, env)).toBe(tasks);
    expect(readUserPromptCount(ledger, env)).toBe(prompts + 1);
    await invoke(env, "turn-2", "rinv_named");
    expect(readRegistryUseCount(ledger, env)).toBe(2);
    expect(debts(env)).toEqual([["rinv_named", CAVEMAN, []]]);
    expect(await task(env, "turn-3")).toEqual([demand("rinv_named")]);
  });

  it("counts a skill used again while its feedback is pending as the later task's use", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
    const stop = (turn) =>
      handleStopHook(
        at(turn, { hook_event_name: "Stop", stop_hook_active: false }),
        { env, recordHealth: vi.fn(), fetchImpl: async () => ({ ok: true }) },
      );
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    expect(await stop("turn-1")).toMatchObject({
      why: "prompt_pending_obligations",
    });
    // The first task's feedback is still unpaid when the next task uses the
    // same skill version again: one debt, and the later task was served.
    expect(await task(env, "turn-2")).toEqual([demand("rinv_first")]);
    await invoke(env, "turn-2", "rinv_again");
    expect(debts(env)).toEqual([["rinv_first", CAVEMAN, ["rinv_again"]]]);
    const result = await stop("turn-2");
    expect(result.why).not.toBe("prompt_task_closure");
    expect(String(result.output?.reason ?? "")).not.toContain(
      "no skill use was recorded",
    );
  });

  it("keeps other skills and versions, and a repeated callback, as they are", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_a");
    // The host delivers the same PostToolUse twice.
    await invoke(env, "turn-1", "rinv_a");
    await invoke(env, "turn-1", "rinv_b", {
      resultId: "qres_direct_caveman_v2",
    });
    await invoke(env, "turn-1", "rinv_c", {
      slug: "ponytail",
      resultId: "qres_direct_ponytail_v1",
    });
    expect(readRegistryUseCount(ledger, env)).toBe(3);
    expect(debts(env)).toEqual([
      ["rinv_a", CAVEMAN, []],
      ["rinv_b", "qres_direct_caveman_v2", []],
      ["rinv_c", "qres_direct_ponytail_v1", []],
    ]);
    expect(await task(env, "turn-2")).toEqual([
      demand("rinv_a"),
      demand("rinv_b", "caveman", "qres_direct_caveman_v2"),
      demand("rinv_c", "ponytail", "qres_direct_ponytail_v1"),
    ]);
  });

  it("names a reloaded skill once in a visible stop and asks nothing after it is paid", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" });
    const stop = (turn) =>
      handleStopHook(
        at(turn, { hook_event_name: "Stop", stop_hook_active: false }),
        { env, recordHealth: vi.fn(), fetchImpl: async () => ({ ok: true }) },
      );
    await task(env, "turn-1");
    await invoke(env, "turn-1", "rinv_first");
    await invoke(env, "turn-1", "rinv_reload");
    const first = await stop("turn-1");
    expect(first).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(
      first.output.reason.split("\n").filter((line) => line.startsWith("- ")),
    ).toEqual([demand("rinv_first")]);

    await pay(env, "turn-1", "rinv_reload");
    await invoke(env, "turn-1", "rinv_again");
    expect(await stop("turn-1")).toEqual({ allow: true, why: "no_new_usage" });
  });
});

// Task 12 Appendix C item 5: late in a long, compacted session the stop hook
// asked for a "recovered" query, saying none was recorded, although the
// session's queries and their feedback existed. A query the agent completes,
// whatever it finds, or a registry use closes the task it was made in.
describe("an eligible task closed by a query or a use", () => {
  const SESSION = "codex-closure-session";
  const AGENT = "019a0c1d-2e3f-7a4b-8c5d-6e7f8a9b0c1d";
  const CLOSURE = "silently recover the pending Remembrance query";
  const MATCH = {
    slug: "vercel-build-debug",
    description: "Debug Vercel build failures.",
    trust_tier: "tofu_verified",
    verified_uses: 7,
    total_uses: 9,
    result_id: "qres_vercel",
    match_tier: "high",
    match_reason: "Strong task and constraint coverage",
  };
  const envelope = (body) => ({
    content: [
      { type: "text", text: JSON.stringify({ ok: true, status: 200, body }) },
    ],
  });
  function testEnv() {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    };
  }
  const at = (turn, fields = {}) => ({
    session_id: SESSION,
    turn_id: turn,
    cwd: "/work",
    ...fields,
  });
  // A prompt that starts a task; its own query returns `skills`.
  const task = (env, turn, skills = [], fields = {}) =>
    handleQuery(
      at(turn, {
        hook_event_name: "UserPromptSubmit",
        prompt: "Deploy the Next.js app to Vercel with GitHub Actions.",
        ...fields,
      }),
      {
        env,
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () => Response.json({ skills, resources: [] })),
      },
    );
  // The agent's own query_skills call.
  const query = (env, turn, skills = [], fields = {}) =>
    handlePostToolUse(
      at(turn, {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__remembrance__query_skills",
        tool_input: { task: { summary: "Deploy Next.js to Vercel from CI" } },
        tool_response: envelope({
          query_id: `rq_${turn}`,
          skills,
          resources: [],
        }),
        ...fields,
      }),
      { env, recordHealth: vi.fn() },
    );
  const stop = (env, turn, fields = {}) =>
    handleStopHook(
      at(turn, { hook_event_name: "Stop", stop_hook_active: false, ...fields }),
      { env, recordHealth: vi.fn(), fetchImpl: async () => ({ ok: true }) },
    );
  const asked = (result) => String(result.output?.reason ?? "");

  it("does not call a task unqueried after a query matched in it", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    expect(await stop(env, "turn-1")).toMatchObject({
      why: "prompt_task_closure",
    });
    // An earlier task ended with nothing found; this one's query matched.
    await task(env, "turn-2", [MATCH]);
    const result = await stop(env, "turn-2");
    expect(result).toMatchObject({ allow: false, why: "prompt_contribution" });
    expect(asked(result)).not.toContain(CLOSURE);
  });

  it("counts the agent's own query that found nothing as the task's query", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await query(env, "turn-1");
    const result = await stop(env, "turn-1");
    expect(result.why).not.toBe("prompt_task_closure");
    expect(asked(result)).not.toContain(CLOSURE);
  });

  it("asks once for each task left unqueried, and not after its query", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    expect(await stop(env, "turn-1")).toMatchObject({
      why: "prompt_task_closure",
    });
    // The recovery query it asked for finds nothing.
    await query(env, "turn-1");
    expect(await stop(env, "turn-1")).toEqual({
      allow: true,
      why: "no_new_usage",
    });
    await task(env, "turn-2");
    await query(env, "turn-2");
    expect(asked(await stop(env, "turn-2"))).not.toContain(CLOSURE);
    // A later task the agent never queried is still asked about.
    await task(env, "turn-3");
    expect(await stop(env, "turn-3")).toMatchObject({
      why: "prompt_task_closure",
    });
  });

  it("does not count a query response that lists no results", async () => {
    const env = testEnv();
    await task(env, "turn-1");
    await handlePostToolUse(
      at("turn-1", {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__remembrance__query_skills",
        tool_input: { task: { summary: "Deploy Next.js to Vercel from CI" } },
        tool_response: envelope({ query_id: "rq_without_results" }),
      }),
      { env, recordHealth: vi.fn() },
    );
    expect(await stop(env, "turn-1")).toMatchObject({
      why: "prompt_task_closure",
    });
  });

  it("does not call a subagent's task unqueried after its own empty query", async () => {
    const env = testEnv();
    const agent = { agent_id: AGENT, agent_type: "worker" };
    await task(env, "turn-1", [], agent);
    await query(env, "turn-1", [], agent);
    const result = await stop(env, "turn-1", {
      hook_event_name: "SubagentStop",
      ...agent,
    });
    expect(result.why).not.toBe("prompt_task_closure");
    expect(asked(result)).not.toContain(CLOSURE);
  });
});
