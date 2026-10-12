import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_POLICY_ALERT_TEXT,
  readCompletionObligations,
  readDirectSelectionSurfaces,
  readRegistryUseCount,
} from "../scripts/hook-core.mjs";
import { handleStop, handleStopHook } from "../scripts/contribute-on-stop.mjs";
import { handleMcpUse } from "../scripts/record-mcp-use.mjs";

// Default hook paths must never reach the real profile: HOME and the XDG roots
// cover shared config and private-learning state, and TMPDIR covers the usage
// markers.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-cursor-stop-"));
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

const visibleEnv = {
  REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
  XDG_CONFIG_HOME: join(tmpdir(), "remembrance-cursor-test-config"),
  XDG_STATE_HOME: join(tmpdir(), "remembrance-cursor-test-state"),
};

describe("Cursor stop hook", () => {
  it("does not emit a follow-up message in the default recovery mode", () => {
    expect(
      handleStop(
        { status: "completed", loop_count: 0, conversation_id: "silent" },
        {
          env: {},
          readUseCount: () => 1,
          readEligibilityCount: () => 0,
          readPromptedCount: () => 0,
        },
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
  });

  it("does not create another warning prompt after the action was already reported", () => {
    const mark = vi.fn(() => true);
    expect(
      handleStop(
        {
          conversation_id: "reported",
          last_assistant_message: `Task done. ${HOST_POLICY_ALERT_TEXT}`,
        },
        {
          env: {},
          readPendingHostPolicyAlert: () => ({ id: "reported" }),
          markHostPolicyAlertDelivered: mark,
        },
      ),
    ).toEqual({ allow: true, why: "host_policy_alert_reported" });
    expect(mark).toHaveBeenCalledOnce();
  });

  it("surfaces a pending host-policy alert exactly once before normal completion logic", () => {
    const markDelivered = vi.fn(() => true);
    const options = {
      env: {},
      readPendingHostPolicyAlert: () => ({ id: "policy-1" }),
      markHostPolicyAlertDelivered: markDelivered,
      readUseCount: () => 0,
      readEligibilityCount: () => 0,
      readPromptedCount: () => 0,
    };
    expect(
      handleStop({ loop_count: 0, conversation_id: "conv-policy" }, options),
    ).toEqual({
      allow: false,
      why: "host_policy_denial",
      output: { followup_message: HOST_POLICY_ALERT_TEXT },
    });
    expect(markDelivered).toHaveBeenCalledWith(
      "cursor",
      "conv-policy",
      "policy-1",
      {},
    );
  });
  it("reports the native task outcome before applying the stop decision", async () => {
    const reportTaskOutcomes = vi.fn().mockResolvedValue(1);
    const recordHealth = vi.fn();
    const result = await handleStopHook(
      { loop_count: 1, conversation_id: "conv-outcome" },
      {
        env: {},
        reportTaskOutcomes,
        recordHealth,
        readUseCount: () => 0,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
      },
    );
    expect(reportTaskOutcomes).toHaveBeenCalledWith(
      "conv-outcome",
      expect.any(Object),
      expect.objectContaining({
        env: {},
        userAgent: "@remembrance/cursor-plugin",
      }),
    );
    expect(result).toMatchObject({ allow: true, why: "stop_hook_active" });
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cursor",
        component: "completion_hook",
        sessionId: "conv-outcome",
      }),
      {},
    );
  });

  it("returns a followup_message when Remembrance was used and no contribution was prompted", () => {
    const writePromptedCount = vi.fn();
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv_123" },
      {
        env: visibleEnv,
        readUseCount: () => 1,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result.allow).toBe(false);
    expect(result.output.followup_message).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(result.output.followup_message).toContain("submit_remembrance");
    expect(result.output.followup_message).toContain(
      "Do not mention routine Remembrance calls",
    );
    expect(result.output.followup_message).toContain(
      "provide the task's normal user-facing final answer",
    );
    expect(writePromptedCount).toHaveBeenCalledWith("conv_123", 1, visibleEnv);
  });

  it("routes organization learning through the exact private router", () => {
    const result = handleStop(
      {
        status: "completed",
        loop_count: 0,
        conversation_id: "conv-private-lesson",
      },
      {
        env: {
          REMEMBRANCE_API_KEY: "rk_cursor_private_lesson",
          ...visibleEnv,
        },
        readUseCount: () => 1,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount: vi.fn(),
      },
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
    expect(result.output.followup_message).toContain(
      "capture_learning once per new item",
    );
    expect(result.output.followup_message).toContain(
      "exact next_action or bounded agent_recovery",
    );
    expect(result.output.followup_message).toContain("submit_query_feedback");
    expect(result.output.followup_message).toContain("submit_feedback");
    expect(result.output.followup_message).not.toContain(
      "propose_private_skill",
    );
  });

  it("does not auto-follow-up when Cursor is already running a stop-loop follow-up", () => {
    const result = handleStop(
      { status: "completed", loop_count: 1, conversation_id: "conv_123" },
      {
        env: visibleEnv,
        readUseCount: () => 1,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
      },
    );

    expect(result).toEqual({ allow: true, why: "stop_hook_active" });
  });

  it("does not nudge when an explicit contribution already handled the use", () => {
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv_123" },
      {
        env: visibleEnv,
        readUseCount: () => 2,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 2,
      },
    );

    expect(result).toEqual({ allow: true, why: "no_new_usage" });
  });

  it("recovers a reusable prompt when Cursor never called Remembrance", () => {
    const result = handleStop(
      { status: "completed", loop_count: 0, conversation_id: "conv-context" },
      {
        env: visibleEnv,
        readUseCount: () => 0,
        readEligibilityCount: () => 1,
        readPromptedCount: () => 0,
        writePromptedCount: () => {},
      },
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
    expect(result.output.followup_message).toContain("full conversation");
  });

  it("recovers a later reusable prompt after an earlier query was handled", () => {
    expect(
      handleStop(
        {
          status: "completed",
          loop_count: 0,
          conversation_id: "conv-later-context",
        },
        {
          env: visibleEnv,
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readPromptedCount: () => 1,
          writePromptedCount: () => {},
        },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
    });
  });

  it("nudges on a high-value self-correction even without a registry marker", () => {
    const writePromptedCount = vi.fn();
    const result = handleStop(
      {
        status: "completed",
        loop_count: 0,
        conversation_id: "conv_version",
        last_assistant_message:
          "I missed the MCP package version bump after publish-impacting plugin changes.",
      },
      {
        env: visibleEnv,
        readUseCount: () => 0,
        readEligibilityCount: () => 0,
        readPromptedCount: () => 0,
        writePromptedCount,
      },
    );

    expect(result.allow).toBe(false);
    expect(result.why).toBe("prompt_high_value_lesson_contribution");
    expect(result.output.followup_message).toContain(
      "High-value lesson detected",
    );
    expect(result.output.followup_message).toContain(
      "preserve the task result in the user-facing final answer",
    );
    expect(writePromptedCount).toHaveBeenCalledWith(
      "conv_version",
      1,
      visibleEnv,
    );
  });
});

describe("session-scoped explicit selections through the Cursor hooks", () => {
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
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    };
  }

  const observe = (conversationId, env, result) =>
    handleMcpUse(
      {
        tool_name: "invoke_skill",
        conversation_id: conversationId,
        result,
      },
      { env, recordHealth: vi.fn() },
    );

  it("allows the stop when the only engagement is a session-scoped skill", async () => {
    const env = testEnv();
    const conversationId = "cursor-session-only";
    expect(await observe(conversationId, env, SESSION_SKILL)).toMatchObject({
      recorded: true,
      kind: "direct_selection",
      count: 0,
    });
    expect(readRegistryUseCount(conversationId, env)).toBe(0);
    expect(readDirectSelectionSurfaces(conversationId, env)).toMatchObject([
      { slug: "pairing-mode", scope: "session", use_count: 0 },
    ]);

    const fetchImpl = vi.fn();
    const result = await handleStopHook(
      { conversation_id: conversationId, loop_count: 0 },
      { env, fetchImpl, recordHealth: vi.fn() },
    );
    expect(result).toEqual({ allow: true, why: "registry_not_used" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCompletionObligations(conversationId, env)).toEqual([]);
  });

  it("closes only the task-scoped selection when both kinds were used", async () => {
    const env = testEnv();
    const conversationId = "cursor-session-and-task";
    await observe(conversationId, env, SESSION_SKILL);
    await observe(conversationId, env, TASK_SKILL);
    expect(readRegistryUseCount(conversationId, env)).toBe(1);

    const requests = [];
    const result = await handleStopHook(
      { conversation_id: conversationId, loop_count: 0 },
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
    expect(result.output.followup_message).toContain("rinv_task");
    expect(result.output.followup_message).not.toContain("rinv_session");
    expect(result.output.followup_message).not.toContain("pairing-mode");
    expect(
      requests.map((request) => [request.url, request.body.query_id]),
    ).toEqual([
      ["https://registry.example/api/v1/agent/task-outcomes", "rinv_task"],
    ]);
  });
});
