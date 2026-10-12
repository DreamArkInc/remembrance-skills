import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  contributionReason,
  decideContribution,
  handleStopHook,
  sessionUsedRemembrance,
  transcriptEvidence,
} from "../scripts/contribute-on-stop.mjs";
import {
  HOST_POLICY_ALERT_TEXT,
  readCompletionObligations,
  readDirectSelectionSurfaces,
  readRegistryUseCount,
  readUserPromptCount,
} from "../scripts/hook-core.mjs";
import { handleHookInput } from "../scripts/query-on-prompt.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";
import { SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED } from "../../codex-plugin/test/fixtures/preference-boundaries.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-vscode-stop-"));
let counter = 0;

// Default hook paths (HOME, the XDG roots, and TMPDIR for usage markers and the
// adapter's prompted-count sentinel) must stay inside this suite's temp root.
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

// VS Code keeps the answer that triggered the Stop on screen.
const ANSWER_SHOWN_CLOSING =
  "The user already sees your answer. After the cleanup, do not restate it; report only Remembrance failures or required action.";

// Synthetic records in the shape VS Code 1.133 (Copilot Chat 0.61) writes:
// each line has type, data, id, timestamp, and parentId. Assistant text is in
// assistant.message data.content, tool calls are tool.execution_start records
// named mcp_<server>_<tool>, and tool results and hook context are not
// recorded. The Stop payload carries no last_assistant_message.
const vsTool = (name) => `mcp_remembrance_${name}`;
function vscodeTranscript(...records) {
  let parentId = null;
  const lines = records.flat().map((record, index) => {
    const id = `vscode-record-${index + 1}`;
    const line = JSON.stringify({
      ...record,
      id,
      timestamp: new Date(Date.UTC(2026, 8, 22, 12, 0, index)).toISOString(),
      parentId,
    });
    parentId = id;
    return line;
  });
  return `${lines.join("\n")}\n`;
}
const vsSessionStart = () => ({
  type: "session.start",
  data: {
    sessionId: "vscode-fixture",
    version: 1,
    producer: "copilot-agent",
    copilotVersion: "0.61.0",
    vscodeVersion: "1.133.0",
    startTime: "2026-09-22T12:00:00.000Z",
    context: {},
  },
});
const vsUser = (content) => ({
  type: "user.message",
  data: { content, attachments: [] },
});
// One agent round: the assistant message with its tool requests, then each
// requested tool's start and completion records.
function vsRound(turnId, content, calls = []) {
  return [
    { type: "assistant.turn_start", data: { turnId } },
    {
      type: "assistant.message",
      data: {
        messageId: `message-${turnId}`,
        content,
        toolRequests: calls.map(([toolCallId, name, args = {}]) => ({
          toolCallId,
          name,
          arguments: JSON.stringify(args),
          type: "function",
        })),
      },
    },
    ...calls.flatMap(([toolCallId, toolName, args = {}]) => [
      {
        type: "tool.execution_start",
        data: { toolCallId, toolName, arguments: args },
      },
      { type: "tool.execution_complete", data: { toolCallId, success: true } },
    ]),
    { type: "assistant.turn_end", data: { turnId } },
  ];
}

function testEnv(env = {}) {
  counter += 1;
  return {
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(tempRoot, `cache-${counter}.json`),
    REMEMBRANCE_USAGE_DIR: resolve(tempRoot, `usage-${counter}`),
    REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    XDG_CONFIG_HOME: resolve(tempRoot, `config-${counter}`),
    XDG_STATE_HOME: resolve(tempRoot, `state-${counter}`),
    ...env,
  };
}

describe("VS Code completion hook", () => {
  it("does not block completion in the default recovery mode", () => {
    expect(
      decideContribution(
        { session_id: "s-silent-default" },
        {
          env: testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" }),
          readUseCount: () => 1,
          readCount: () => 0,
        },
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
  });

  it("blocks the stop to prompt contribution on first registry use", async () => {
    const result = await handleStopHook(
      { session_id: "s-used" },
      {
        env: testEnv(),
        readUseCount: () => 1,
        readCount: () => 0,
        recordHealth: vi.fn(),
        // Keep the prompted-count write off the real usage dir.
        writeCount: vi.fn(),
        markDirectSelectionsPrompted: vi.fn(),
        reportTaskOutcomes: vi.fn(),
      },
    );
    expect(result.allow).toBe(false);
    expect(result.output).toMatchObject({ decision: "block" });
    expect(String(result.output.reason ?? "")).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(String(result.output.reason ?? "")).toContain(
      "Do not mention routine Remembrance calls",
    );
    expect(String(result.output.reason ?? "")).toContain("submit_remembrance");
    expect(
      String(result.output.reason ?? "")
        .split("\n")
        .at(-1),
    ).toBe(ANSWER_SHOWN_CLOSING);
  });

  it("marks only the exact completion obligations included in the stop prompt", async () => {
    const env = testEnv();
    const obligation = {
      id: "query_feedback:rq_vscode_pending",
      kind: "query_feedback",
      engagement_count: 1,
      query_id: "rq_vscode_pending",
      prompted_at: null,
    };
    const writeCount = vi.fn();
    const markCompletionObligationsPrompted = vi.fn();
    const result = await handleStopHook(
      { session_id: "s-exact-obligation" },
      {
        env,
        readUseCount: () => 1,
        readCount: () => 0,
        readCompletionObligations: () => [obligation],
        recordHealth: vi.fn(),
        writeCount,
        markCompletionObligationsPrompted,
        markDirectSelectionsPrompted: vi.fn(),
        reportTaskOutcomes: vi.fn(),
      },
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rq_vscode_pending");
    expect(writeCount).toHaveBeenCalledWith("s-exact-obligation", 1);
    expect(markCompletionObligationsPrompted).toHaveBeenCalledWith(
      "s-exact-obligation",
      [obligation.id],
      env,
      1,
    );
  });

  it("routes organization learning through the exact private router", async () => {
    const result = await handleStopHook(
      { session_id: "s-private-lesson" },
      {
        env: testEnv({
          REMEMBRANCE_API_KEY: "rk_vscode_private_lesson",
        }),
        readUseCount: () => 1,
        readCount: () => 0,
        recordHealth: vi.fn(),
        writeCount: vi.fn(),
        markDirectSelectionsPrompted: vi.fn(),
        reportTaskOutcomes: vi.fn(),
      },
    );
    const reason = String(result.output.reason ?? "");
    expect(result).toMatchObject({ allow: false, why: "prompt_contribution" });
    expect(reason).toContain("capture_learning once per new item");
    expect(reason).toContain("exact next_action or bounded agent_recovery");
    expect(reason).toContain("submit_query_feedback");
    expect(reason).toContain("submit_feedback");
    expect(reason).not.toContain("propose_private_skill");
  });

  it("records completion health under the VS Code surface", async () => {
    const recordHealth = vi.fn();
    await handleStopHook(
      { session_id: "s-health" },
      {
        env: testEnv(),
        readUseCount: () => 1,
        readCount: () => 0,
        recordHealth,
        writeCount: vi.fn(),
        markDirectSelectionsPrompted: vi.fn(),
        reportTaskOutcomes: vi.fn(),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "vs_code",
        component: "completion_hook",
      }),
      expect.any(Object),
    );
  });

  it("never loops: allows the stop when stop_hook_active is set", () => {
    expect(
      decideContribution(
        { session_id: "s-loop", stop_hook_active: true },
        { env: testEnv(), readUseCount: () => 5, readCount: () => 0 },
      ),
    ).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("allows the stop when disabled via env", () => {
    expect(
      decideContribution(
        { session_id: "s-disabled" },
        {
          env: testEnv({ REMEMBRANCE_AUTO_CONTRIBUTE: "0" }),
          readUseCount: () => 3,
          readCount: () => 0,
        },
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
  });

  it("does not nag when the session never touched Remembrance", () => {
    expect(
      decideContribution(
        { session_id: "s-untouched" },
        {
          env: testEnv(),
          readUseCount: () => 0,
          readCount: () => 0,
          readEligibilityCount: () => 0,
        },
      ),
    ).toMatchObject({ allow: true });
  });

  it("re-prompts only when consumption increased since the last prompt", () => {
    const env = testEnv();
    // Already prompted at the current consumption level -> stay quiet.
    const stable = decideContribution(
      { session_id: "s-stable" },
      { env, readUseCount: () => 2, readCount: () => 2 },
    );
    expect(stable).toMatchObject({ allow: true, why: "no_new_usage" });
    // Consumption grew past what was prompted -> prompt again.
    const grew = decideContribution(
      { session_id: "s-grew" },
      { env, readUseCount: () => 3, readCount: () => 2 },
    );
    expect(grew.allow).toBe(false);
    expect(grew.consumption).toBe(3);
  });

  it("counts only consumption calls, not the agent's own submissions", () => {
    // Mirrors the Claude/Codex rule: a session that only submitted should not be
    // re-prompted to submit again.
    const assistantCall = (id, name) =>
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: {
          id: `msg_${id}`,
          role: "assistant",
          content: [{ type: "tool_use", id, name, input: {} }],
        },
      });
    const consumed = transcriptEvidence(
      [
        assistantCall("toolu_query", "mcp__remembrance__query_skills"),
        assistantCall("toolu_get", "mcp__remembrance__get_skill"),
        assistantCall("toolu_feedback", "mcp__remembrance__submit_feedback"),
      ].join("\n"),
    ).consumption;
    expect(consumed).toBe(2);
    const submittedOnly = transcriptEvidence(
      assistantCall("toolu_submit", "mcp__remembrance__submit_remembrance"),
    ).consumption;
    expect(submittedOnly).toBe(0);
  });

  it("detects registry engagement from transcript markers", () => {
    expect(
      sessionUsedRemembrance(
        JSON.stringify({ tool_name: "mcp__remembrance__query_skills" }),
      ),
    ).toBe(true);
    expect(sessionUsedRemembrance("no remembrance tools here")).toBe(false);
  });

  it("fails open when the transcript cannot be read", async () => {
    await expect(
      handleStopHook(
        { session_id: "s-broken", transcript_path: "/nonexistent/path.jsonl" },
        { env: testEnv(), recordHealth: vi.fn() },
      ),
    ).resolves.not.toThrow();
  });

  it("reads the final answer and Remembrance tool calls from a VS Code transcript", () => {
    const transcript = vscodeTranscript(
      vsSessionStart(),
      vsUser("Fix the Vercel build error in CI."),
      vsRound("0.0", "Checking Remembrance first.", [
        ["call_query", vsTool("query_skills"), { summary: "vercel build" }],
        ["call_read", "read_file", { filePath: "vercel.json" }],
      ]),
      vsRound("0.1", "", [
        ["call_feedback", vsTool("submit_feedback"), { useful: true }],
      ]),
      vsRound("0.2", "Fixed the build configuration."),
    );
    expect(transcriptEvidence(transcript)).toEqual({
      consumption: 1,
      eligibility: 0,
      lastAssistantMessage: "Fixed the build configuration.",
    });
  });

  it("judges host-policy alerts by the final VS Code message, not an earlier one", async () => {
    const env = testEnv();
    const obligations = [
      {
        id: "query_feedback:rq_vscode_turn_two",
        kind: "query_feedback",
        engagement_count: 1,
        query_id: "rq_vscode_turn_two",
        prompted_at: null,
      },
    ];
    const stop = (finalAnswer) =>
      handleStopHook(
        {
          hook_event_name: "Stop",
          session_id: "s-vscode-alert",
          transcript_path: "/fixture/vscode.jsonl",
          stop_hook_active: false,
        },
        {
          env,
          readTranscript: () =>
            vscodeTranscript(
              vsSessionStart(),
              vsUser("Deploy the preview build."),
              vsRound(
                "0.0",
                `The deploy was blocked. ${HOST_POLICY_ALERT_TEXT}`,
              ),
              vsUser("Now add retries to the deploy step."),
              vsRound("1.0", "", [["call_query", vsTool("query_skills"), {}]]),
              vsRound("1.1", finalAnswer),
            ),
          readUseCount: () => 0,
          readCount: () => 0,
          readCompletionObligations: () => obligations,
          recordHealth: vi.fn(),
          writeCount: vi.fn(),
          markCompletionObligationsPrompted: vi.fn(),
          markDirectSelectionsPrompted: vi.fn(),
          reportTaskOutcomes: vi.fn(),
        },
      );

    const prompted = await stop("Added retries to the deploy step.");
    expect(prompted).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(prompted.output.reason).toContain("rq_vscode_turn_two");
    expect(
      await stop(`Retries are in place. ${HOST_POLICY_ALERT_TEXT}`),
    ).toEqual({ allow: true, why: "host_policy_alert_reported" });
  });

  it("detects a high-value lesson in the final VS Code message", () => {
    expect(
      decideContribution(
        { session_id: "s-vscode-lesson", stop_hook_active: false },
        {
          env: testEnv(),
          readTranscript: () =>
            vscodeTranscript(
              vsSessionStart(),
              vsUser("Publish the plugin release."),
              vsRound(
                "0.0",
                "I missed the MCP package version bump after publish-impacting plugin changes.",
              ),
            ),
          readUseCount: () => 0,
          readCount: () => 0,
          readEligibilityCount: () => 0,
          readCompletionObligations: () => [],
          readHighMatch: () => null,
          readDirectSelections: () => [],
        },
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_high_value_lesson_contribution",
    });
  });

  it("keeps a session-scoped skill out of the stop through the real VS Code hooks", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "vscode-session-scope";
    const invokeBody = (slug, queryId, resultId, scope) => ({
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
    });
    const observe = (toolCallId, body) =>
      handlePostToolUse(
        {
          hook_event_name: "PostToolUse",
          session_id: sessionId,
          tool_name: vsTool("invoke_skill"),
          tool_input: { slug: body.skill.slug },
          // VS Code passes the tool's text parts joined into one string.
          tool_response: JSON.stringify({ ok: true, status: 200, body }),
          tool_use_id: `${toolCallId}__vscode-1`,
        },
        { env, recordHealth: vi.fn() },
      );
    const invokeCall = (toolCallId, slug) => [
      toolCallId,
      vsTool("invoke_skill"),
      { slug },
    ];
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const stop = (calls, finalAnswer) =>
      handleStopHook(
        {
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: "/fixture/vscode.jsonl",
          stop_hook_active: false,
        },
        {
          env,
          readTranscript: () =>
            vscodeTranscript(
              vsSessionStart(),
              vsUser("Use pairing-mode, then run the release checklist."),
              vsRound("0.0", "", calls),
              vsRound("0.1", finalAnswer),
            ),
          recordHealth: vi.fn(),
          fetchImpl,
        },
      );

    await observe(
      "call_session",
      invokeBody(
        "pairing-mode",
        "rinv_vs_session",
        "qres_vs_session",
        "session",
      ),
    );
    expect(readDirectSelectionSurfaces(sessionId, env)).toMatchObject([
      { slug: "pairing-mode", scope: "session" },
    ]);
    expect(readRegistryUseCount(sessionId, env)).toBe(0);
    expect(readCompletionObligations(sessionId, env)).toEqual([]);
    expect(
      await stop(
        [invokeCall("call_session", "pairing-mode")],
        "Pairing is on.",
      ),
    ).toEqual({ allow: true, why: "registry_not_used" });
    expect(fetchImpl).not.toHaveBeenCalled();

    await observe(
      "call_task",
      invokeBody("release-checklist", "rinv_vs_task", "qres_vs_task", "task"),
    );
    const result = await stop(
      [
        invokeCall("call_session", "pairing-mode"),
        invokeCall("call_task", "release-checklist"),
      ],
      "The release checklist passed.",
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rinv_vs_task");
    expect(result.output.reason).not.toContain("pairing-mode");
    expect(result.output.reason.split("\n").at(-1)).toBe(ANSWER_SHOWN_CLOSING);
    expect(
      fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body).query_id),
    ).toEqual(["rinv_vs_task"]);
  });

  // VS Code 1.133 (Copilot Chat 0.61) runs a subagent under its parent's
  // session_id and sends agent_id only with SubagentStart and SubagentStop,
  // not with the subagent's tool hooks, and no transcript of its own
  // (Copilot extension.js:1586, 1713, 6680). A subagent's debts therefore
  // stay in the session ledger, marked as possibly a subagent's, for the
  // parent.
  it("leaves a VS Code subagent's session debts to the parent, marked as possibly a subagent's", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    const sessionId = "vscode-session-parent";
    await observeSubagentFollowup(sessionId, env);
    const readTranscript = vi.fn(() => "");
    const reportTaskOutcomes = vi.fn(async () => 0);
    expect(
      await handleStopHook(
        {
          hook_event_name: "SubagentStop",
          session_id: sessionId,
          transcript_path: "/fixture/vscode.jsonl",
          agent_id: "call_subagent_1",
          agent_type: "default",
          stop_hook_active: false,
        },
        { env, readTranscript, recordHealth: vi.fn(), reportTaskOutcomes },
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
    // It reads neither the parent's transcript nor the parent's ledger.
    expect(readTranscript.mock.calls).toEqual([[undefined]]);
    expect(reportTaskOutcomes).not.toHaveBeenCalled();
    // Its stop has nothing to pass on and labels nothing second-hand, and
    // the debt says that the host did not name the agent that owes it.
    expect(readCompletionObligations(sessionId, env)).toMatchObject([
      {
        kind: "remembrance_followup",
        prompted_at: null,
        transferred_from: null,
        subagent_identity: "unavailable",
      },
    ]);
    // The parent's next prompt asks for it without calling it the parent's.
    const context = await promptContext(sessionId, "thanks", env);
    expect(context).toContain(
      `- Reusable evidence for query_id rq_vs_sub and result_id qres_vs_sub${SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED}: call submit_remembrance with exactly the payload on the next line`,
    );
    expect(context).not.toContain(
      "- Reusable evidence for query_id rq_vs_sub and result_id qres_vs_sub:",
    );
  });

  it("labels a VS Code debt as possibly a subagent's at a visible parent stop", async () => {
    const env = testEnv();
    const sessionId = "vscode-session-visible";
    await observeSubagentFollowup(sessionId, env);
    const result = await handleStopHook(
      {
        hook_event_name: "Stop",
        session_id: sessionId,
        last_assistant_message: "Done.",
        stop_hook_active: false,
      },
      {
        env,
        readTranscript: () => "",
        recordHealth: vi.fn(),
        reportTaskOutcomes: vi.fn(async () => 0),
      },
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason.split("\n")).toContain(
      `- Reusable evidence for query_id rq_vs_sub and result_id qres_vs_sub${SUBAGENT_IDENTITY_UNAVAILABLE_EXPLAINED}: call submit_remembrance with exactly the payload on the next line, which submit_feedback returned and Remembrance keeps on this machine only to re-supply it.`,
    );
  });

  // VS Code sends a subagent's task through UserPromptSubmit right after its
  // SubagentStart, under the parent's session_id (extension.js:1713, 2815).
  it("keeps a VS Code subagent's task prompt from being taken for the user's", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    const sessionId = "vscode-session-prompt";
    await observeSubagentFollowup(sessionId, env);
    const lifecycle = (hook_event_name, agent_id) =>
      handleStopHook(
        {
          hook_event_name,
          session_id: sessionId,
          agent_id,
          agent_type: "default",
        },
        {
          env,
          readTranscript: () => "",
          recordHealth: vi.fn(),
          reportTaskOutcomes: vi.fn(async () => 0),
        },
      );
    // Two subagents start side by side; each task prompt is theirs.
    expect(await lifecycle("SubagentStart", "call_subagent_a")).toEqual({
      allow: true,
      why: "subagent_started",
    });
    expect(await lifecycle("SubagentStart", "call_subagent_b")).toEqual({
      allow: true,
      why: "subagent_started",
    });
    const fetchImpl = vi.fn(async () => Response.json({ skills: [] }));
    for (const task of ["Debug the failing Vercel build", "thanks"]) {
      expect(
        await handleHookInput(
          {
            hook_event_name: "UserPromptSubmit",
            session_id: sessionId,
            prompt: task,
          },
          { env, fetchImpl, recordHealth: vi.fn() },
        ),
      ).toBeNull();
    }
    // Neither was queried, and neither was shown the parent's debt or
    // counted as a prompt of the user's.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCompletionObligations(sessionId, env)).toMatchObject([
      { kind: "remembrance_followup", prompted_at: null },
    ]);
    expect(readUserPromptCount(sessionId, env)).toBe(0);
    // The user's next prompt is the user's again.
    const context = await promptContext(sessionId, "thanks", env);
    expect(context).toContain("rq_vs_sub");
    expect(readUserPromptCount(sessionId, env)).toBe(1);
  });

  it("claims a VS Code subagent start only once and only while fresh", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    const sessionId = "vscode-session-stale";
    await observeSubagentFollowup(sessionId, env);
    await handleStopHook(
      {
        hook_event_name: "SubagentStart",
        session_id: sessionId,
        agent_id: "call_subagent_stale",
      },
      { env, recordHealth: vi.fn() },
    );
    // A start no prompt claimed within the claim window (the host cancelled
    // the subagent first) does not swallow the user's later prompt.
    const directory = readdirSync(env.REMEMBRANCE_USAGE_DIR).find((name) =>
      name.endsWith(".subagent-starts"),
    );
    const [marker] = readdirSync(join(env.REMEMBRANCE_USAGE_DIR, directory));
    const past = new Date(Date.now() - 61_000);
    utimesSync(join(env.REMEMBRANCE_USAGE_DIR, directory, marker), past, past);
    expect(await promptContext(sessionId, "thanks", env)).toContain(
      "rq_vs_sub",
    );
    expect(readdirSync(join(env.REMEMBRANCE_USAGE_DIR, directory))).toEqual([]);
  });

  // Copilot Chat stamps each hook input with its clock as the hook starts
  // (extension.js:6677) and runs a subagent request's UserPromptSubmit
  // right after its SubagentStart hooks (extension.js:2815). A start whose
  // prompt never came, the request cancelled between the two, must not
  // swallow a user prompt the host stamped later than that.
  it("claims a VS Code subagent start only for a prompt the host stamped within 10 s of it", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    const sessionId = "vscode-session-stamped";
    await observeSubagentFollowup(sessionId, env);
    const start = (agentId) =>
      handleStopHook(
        {
          hook_event_name: "SubagentStart",
          session_id: sessionId,
          agent_id: agentId,
          agent_type: "default",
        },
        { env, recordHealth: vi.fn() },
      );
    const markerDirectory = () =>
      join(
        env.REMEMBRANCE_USAGE_DIR,
        readdirSync(env.REMEMBRANCE_USAGE_DIR).find((name) =>
          name.endsWith(".subagent-starts"),
        ),
      );
    const markers = () => readdirSync(markerDirectory());
    const writtenAt = (marker) =>
      statSync(join(markerDirectory(), marker)).mtimeMs;
    const stamped = (written, offsetMs) =>
      new Date(written + offsetMs).toISOString();

    await start("call_subagent_cancelled");
    const [cancelled] = markers();
    // Stamped 11 s after the start was recorded: its own prompt would have
    // come long before, so this one is the user's, and the start is stale.
    expect(
      await promptContext(
        sessionId,
        "continue",
        env,
        stamped(writtenAt(cancelled), 11_000),
      ),
    ).toContain("rq_vs_sub");
    expect(readUserPromptCount(sessionId, env)).toBe(1);
    expect(markers()).toEqual([]);

    await start("call_subagent_next");
    const [next] = markers();
    // Stamped before the start was recorded, a prompt is not its task and
    // leaves it for its own.
    await promptContext(
      sessionId,
      "thanks",
      env,
      stamped(writtenAt(next), -5_000),
    );
    expect(readUserPromptCount(sessionId, env)).toBe(2);
    expect(markers()).toEqual([next]);
    // Stamped 9 s after it, the prompt is the subagent's task.
    expect(
      await promptContext(
        sessionId,
        "Debug the failing Vercel build",
        env,
        stamped(writtenAt(next), 9_000),
      ),
    ).toBe("");
    expect(readUserPromptCount(sessionId, env)).toBe(2);
    expect(markers()).toEqual([]);
  });
});

// A VS Code tool hook names no agent, so this debt may be a subagent's.
async function observeSubagentFollowup(sessionId, env) {
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: vsTool("submit_feedback"),
      tool_input: { query_id: "rq_vs_sub", result_id: "qres_vs_sub" },
      tool_response: JSON.stringify({
        ok: true,
        status: 200,
        body: {
          next_step: {
            submit_remembrance_payload: {
              type: "skill_use",
              lesson: "Clear the extension cache after a host update.",
              interaction: {
                query_id: "rq_vs_sub",
                result_id: "qres_vs_sub",
              },
            },
          },
        },
      }),
      tool_use_id: "call_feedback__vscode-1",
    },
    { env, recordHealth: vi.fn() },
  );
}

async function promptContext(sessionId, prompt, env, timestamp) {
  const output = await handleHookInput(
    {
      ...(timestamp ? { timestamp } : {}),
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt,
    },
    {
      env,
      fetchImpl: vi.fn(async () => Response.json({ skills: [] })),
      recordHealth: vi.fn(),
    },
  );
  return output?.hookSpecificOutput?.additionalContext ?? "";
}
