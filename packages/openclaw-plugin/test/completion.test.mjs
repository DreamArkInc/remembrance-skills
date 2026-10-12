import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAfterToolCall,
  handleCompletion,
  handleFinalize,
} from "../src/index.mjs";
import {
  contributionReason,
  HOST_POLICY_ALERT_TEXT,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  readDirectSelectionSurfaces,
  readRegistryUseCount,
  recordQueryFeedbackObligation,
} from "../src/hook-core.mjs";

// Default hook paths must never reach the real profile. This package reads
// shared config only under HOME, and TMPDIR covers the usage markers.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-openclaw-stop-"));
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

// A fake OpenClaw before_agent_finalize event.
function event(ctx = {}) {
  return { context: { sessionId: "s1", runId: "r1", ...ctx } };
}

// Injectable base: no FS, no network. useCount/promptedCount are stubbed.
function base(overrides = {}) {
  const { env: envOverrides = {}, ...rest } = overrides;
  return {
    env: {
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      XDG_CONFIG_HOME: join(tmpdir(), "remembrance-openclaw-test-config"),
      XDG_STATE_HOME: join(tmpdir(), "remembrance-openclaw-test-state"),
      ...envOverrides,
    },
    readUseCount: () => 1,
    readEligibilityCount: () => 0,
    readPromptedCount: () => 0,
    writePromptedCount: () => {},
    ...rest,
  };
}

describe("OpenClaw completion hook (before_agent_finalize)", () => {
  it("does not revise an answer that already reported the host denial", () => {
    const mark = vi.fn(() => true);
    expect(
      handleCompletion(
        {
          ...event(),
          last_assistant_message: `Task done. ${HOST_POLICY_ALERT_TEXT}`,
        },
        base({
          readPendingHostPolicyAlert: () => ({ id: "reported" }),
          markHostPolicyAlertDelivered: mark,
        }),
      ),
    ).toEqual({ action: "finalize", why: "host_policy_alert_reported" });
    expect(mark).toHaveBeenCalledOnce();
  });
  it("finalizes without a revision prompt in the default recovery mode", () => {
    expect(
      handleCompletion(
        event(),
        base({ env: { REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" } }),
      ),
    ).toEqual({ action: "finalize", why: "silent_prompt_recovery" });
  });

  it("reports a pending local host-policy denial once", () => {
    const markDelivered = vi.fn(() => true);
    expect(
      handleCompletion(
        event(),
        base({
          readPendingHostPolicyAlert: () => ({ id: "policy-1" }),
          markHostPolicyAlertDelivered: markDelivered,
        }),
      ),
    ).toEqual({
      action: "revise",
      reason: HOST_POLICY_ALERT_TEXT,
      retry: { instruction: HOST_POLICY_ALERT_TEXT, maxAttempts: 1 },
      why: "host_policy_denial",
    });
    expect(markDelivered).toHaveBeenCalledWith(
      "openclaw",
      "r1",
      "policy-1",
      expect.objectContaining({
        REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      }),
    );
  });
  it("reports the native task outcome before applying the finalize decision", async () => {
    const calls = [];
    const recordHealth = vi.fn();
    const result = await handleFinalize(
      event(),
      base({
        reportTaskOutcomes: async (...args) => calls.push(args),
        recordHealth,
        readUseCount: () => 0,
      }),
    );
    expect(calls[0]?.[0]).toBe("r1");
    expect(calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({
        REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      }),
      userAgent: "@remembrance/openclaw-plugin",
    });
    expect(result).toMatchObject({
      action: "finalize",
      why: "registry_not_used",
    });
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "openclaw",
        component: "completion_hook",
      }),
      expect.objectContaining({
        REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
      }),
    );
  });

  it("routes organization use through the exact private-learning lane", () => {
    const written = [];
    const result = handleCompletion(
      event(),
      base({
        env: { REMEMBRANCE_API_KEY: "rk_openclaw_private_lesson" },
        writePromptedCount: (id, count) => written.push([id, count]),
      }),
    );
    expect(result.action).toBe("revise");
    expect(result.retry.instruction).toBe(result.reason);
    expect(result.retry.instruction).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(result.retry.instruction).toContain(
      "Do not mention routine calls, hooks, or receipts",
    );
    expect(result.retry.instruction).toContain(
      "capture_learning once per new item",
    );
    expect(result.retry.instruction).toContain(
      "exact next_action or bounded agent_recovery",
    );
    expect(result.retry.instruction).toContain("submit_query_feedback");
    expect(result.retry.instruction).toContain("submit_feedback");
    expect(result.retry.instruction).toContain("Never auto-delete a draft");
    expect(result.retry.instruction).toContain(
      "provide the task's normal user-facing final answer",
    );
    expect(result.reason).not.toBe(contributionReason());
    // It records the new prompted count in the session's ledger so it won't
    // re-revise the same use in a later run of that session.
    expect(written).toEqual([["s1", 1]]);
  });

  it("revises with a conditional high-match fetch instruction", () => {
    const result = handleCompletion(
      event(),
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

    expect(result.reason).toContain("High-confidence result surfaced");
    expect(result.reason).toContain("If you have not opened it");
  });

  it("re-prompts only when use increased since the last prompt", () => {
    // Already prompted at count 1, still 1 use → finalize.
    expect(
      handleCompletion(
        event(),
        base({ readUseCount: () => 1, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ action: "finalize", why: "no_new_usage" });
    // A second distinct use (2 > prior 1) → revise again.
    expect(
      handleCompletion(
        event(),
        base({ readUseCount: () => 2, readPromptedCount: () => 1 }),
      ),
    ).toMatchObject({ action: "revise", why: "prompt_contribution" });
  });

  it("finalizes when disabled via env", () => {
    expect(
      handleCompletion(
        event(),
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" } }),
      ),
    ).toMatchObject({ action: "finalize", why: "disabled" });
    expect(
      handleCompletion(
        event(),
        base({ env: { REMEMBRANCE_AUTO_CONTRIBUTE: "false" } }),
      ),
    ).toMatchObject({ action: "finalize", why: "disabled" });
  });

  it("does not nag when the session never used Remembrance", () => {
    expect(
      handleCompletion(event(), base({ readUseCount: () => 0 })),
    ).toMatchObject({ action: "finalize", why: "registry_not_used" });
  });

  it("revises an eligible reusable task even when no query completed", () => {
    const result = handleCompletion(
      event(),
      base({
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
      }),
    );

    expect(result).toMatchObject({
      action: "revise",
      why: "prompt_task_closure",
    });
    expect(result.reason).toContain(
      "no Remembrance query with the task's full context and no skill use was recorded for it",
    );
  });

  it("revises a later eligible task after an earlier query was handled", () => {
    expect(
      handleCompletion(
        event(),
        base({
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
        }),
      ),
    ).toMatchObject({
      action: "revise",
      why: "prompt_task_closure",
    });
  });

  it("revises on high-value self-corrections even without a registry marker", () => {
    const written = [];
    const result = handleCompletion(
      {
        context: { runId: "r-version" },
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
      action: "revise",
      why: "prompt_high_value_lesson_contribution",
    });
    expect(result.reason).toContain("High-value lesson detected");
    expect(written).toEqual([["r-version", 1]]);
  });

  it("fails open (finalizes) when the decision path throws", () => {
    // A reader that throws → the try/catch in handleCompletion finalizes.
    expect(
      handleCompletion(
        event(),
        base({
          readUseCount: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toMatchObject({ action: "finalize", why: "error" });
  });
});

describe("session-scoped explicit selections through the OpenClaw hooks", () => {
  // The Remembrance MCP result for invoke_skill: the server puts scope next to
  // selection_mode, skill, and query_id in the envelope's body.
  function invokeResult({ slug, queryId, resultId, scope }) {
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
  const SESSION_SKILL = invokeResult({
    slug: "pairing-mode",
    queryId: "rinv_session",
    resultId: "qres_session",
    scope: "session",
  });
  const TASK_SKILL = invokeResult({
    slug: "release-checklist",
    queryId: "rinv_task",
    resultId: "qres_task",
    scope: "task",
  });

  function testEnv() {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    return {
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    };
  }

  const observe = (runId, env, result) =>
    handleAfterToolCall(
      {
        toolName: "mcp__remembrance__invoke_skill",
        params: {},
        result,
        context: { runId },
      },
      { env, recordHealth: vi.fn() },
    );

  it("finalizes when the only engagement is a session-scoped skill", async () => {
    const env = testEnv();
    const runId = "openclaw-session-only";
    expect(await observe(runId, env, SESSION_SKILL)).toMatchObject({
      recorded: true,
      why: "direct_skill_invoked",
      count: 0,
    });
    expect(readRegistryUseCount(runId, env)).toBe(0);
    expect(readDirectSelectionSurfaces(runId, env)).toMatchObject([
      { slug: "pairing-mode", scope: "session", use_count: 0 },
    ]);

    const fetchImpl = vi.fn();
    const result = await handleFinalize(
      { context: { runId } },
      { env, fetchImpl, recordHealth: vi.fn() },
    );
    expect(result).toEqual({ action: "finalize", why: "registry_not_used" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCompletionObligations(runId, env)).toEqual([]);
  });

  it("revises for only the task-scoped selection when both kinds were used", async () => {
    const env = testEnv();
    const runId = "openclaw-session-and-task";
    await observe(runId, env, SESSION_SKILL);
    await observe(runId, env, TASK_SKILL);
    expect(readRegistryUseCount(runId, env)).toBe(1);

    const requests = [];
    const result = await handleFinalize(
      { context: { runId } },
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
      action: "revise",
      why: "prompt_pending_obligations",
    });
    expect(result.reason).toContain("rinv_task");
    expect(result.reason).not.toContain("rinv_session");
    expect(result.reason).not.toContain("pairing-mode");
    expect(
      requests.map((request) => [request.url, request.body.query_id]),
    ).toEqual([
      ["https://registry.example/api/v1/agent/task-outcomes", "rinv_task"],
    ]);
  });
});

describe("declining a pending action through the OpenClaw tool observer", () => {
  it("closes it in this run's ledger", async () => {
    envCounter += 1;
    const root = join(tempRoot, `env-${envCounter}`);
    const env = {
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    };
    const runId = "run-decline";
    recordQueryFeedbackObligation(
      runId,
      { available: true, query_id: "rq_openclaw_decline" },
      env,
    );
    const actionId = /\n {2}action_id ([a-f0-9]{16})\n/u.exec(
      pendingCompletionRecoveryInstruction(runId, env),
    )?.[1];
    expect(actionId).toMatch(/^[a-f0-9]{16}$/u);
    const args = { action_id: actionId, reason: "duplicate" };
    await handleAfterToolCall(
      {
        toolName: "mcp__remembrance__decline_pending_action",
        params: args,
        result: {
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
        context: { runId },
      },
      { env, recordHealth: vi.fn() },
    );
    expect(readCompletionObligations(runId, env)).toEqual([]);
  });
});
