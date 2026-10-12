import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  contributeDisabled,
  contributionReason,
  decideContribution,
  handleStopHook,
  sessionUsedRemembrance,
  transcriptEvidence,
} from "../scripts/contribute-on-stop.mjs";
import {
  HOST_POLICY_ALERT_TEXT,
  PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT,
  agentLedgerIdFor,
  markCompletionObligationsPrompted,
  markDirectSelectionSurfacesPrompted,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  readDirectSelectionSurfaces,
  readRegistryUseCount,
  readValueEpisodeSurfaces,
  recordPostUseFeedbackObligation,
  recordPrivateLessonObligation,
} from "../scripts/hook-core.mjs";
import { handleHookInput as handlePromptInput } from "../scripts/query-on-prompt.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

// Default hook paths must never reach the real profile: HOME and the XDG roots
// cover shared config and private-learning state, and TMPDIR covers the usage
// markers and this adapter's own prompted-count sentinel.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-claude-stop-"));
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

function testEnv(extra = {}) {
  envCounter += 1;
  const root = join(tempRoot, `env-${envCounter}`);
  return {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
    ...extra,
  };
}

// --- Transcript fixtures ------------------------------------------------------
// Synthetic records in the shape Claude Code 2.1 writes: one content block per
// assistant entry, prompt-hook context and deferred-tool listings as
// attachments, and saved Stop block reasons as a hook_blocking_error attachment
// plus a stop_hook_summary system entry.

const tool = (name) => `mcp__plugin_remembrance_remembrance__${name}`;
const LISTED_TOOLS = [
  tool("query_skills"),
  tool("get_skill"),
  tool("invoke_skill"),
  tool("submit_feedback"),
];
const AUTO_QUERY_CONTEXT =
  "Remembrance auto-query context:\nTrigger: external_service. Skills: vercel-build-debug.";
// Claude Code keeps the answer that triggered the Stop on screen.
const ANSWER_SHOWN_CLOSING =
  "The user already sees your answer. After the cleanup, do not restate it; report only Remembrance failures or required action.";

let entryCounter = 0;
function entry(fields) {
  entryCounter += 1;
  return {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    entrypoint: "cli",
    cwd: "/work/example-app",
    sessionId: "claude-stop-fixture",
    version: "2.1.277",
    gitBranch: "main",
    uuid: `fixture-entry-${entryCounter}`,
    timestamp: new Date(
      Date.UTC(2026, 8, 22, 12, 0, entryCounter),
    ).toISOString(),
    ...fields,
  };
}

const text = (value) => ({ type: "text", text: value });
const thinking = () => ({ type: "thinking", thinking: "", signature: "sig" });
const toolUse = (id, name, input = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const userPrompt = (value) =>
  entry({ type: "user", message: { role: "user", content: value } });
const assistantMessage = (id, ...blocks) =>
  blocks.map((block) =>
    entry({
      type: "assistant",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [block],
      },
    }),
  );
const toolResult = (toolUseId, content, extra = {}) =>
  entry({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    ...extra,
  });
const attachment = (value) => entry({ type: "attachment", attachment: value });
const promptHookContext = (context) =>
  attachment({
    type: "hook_additional_context",
    content: [context],
    hookName: "UserPromptSubmit",
    toolUseID: "fixture-prompt-hook",
    hookEvent: "UserPromptSubmit",
  });
// Host tool listings name the Remembrance tools without calling them.
const hostToolListings = () => [
  attachment({
    type: "deferred_tools_delta",
    addedNames: LISTED_TOOLS,
    addedLines: LISTED_TOOLS,
    removedNames: [],
    wireHiddenNames: [],
    readdedNames: [],
    pendingMcpServers: [],
    needsAuthMcpServers: [],
    failedMcpServers: [],
  }),
  ...assistantMessage(
    "msg_tool_search",
    toolUse("toolu_search", "ToolSearch", {
      query: `select:${LISTED_TOOLS.join(",")}`,
      max_results: 5,
    }),
  ),
  toolResult(
    "toolu_search",
    LISTED_TOOLS.map((name) => ({ type: "tool_reference", tool_name: name })),
    {
      toolUseResult: {
        matches: LISTED_TOOLS,
        query: `select:${LISTED_TOOLS.join(",")}`,
        total_deferred_tools: 120,
      },
    },
  ),
  attachment({
    type: "deferred_tools_record",
    entries: LISTED_TOOLS.map((name) => ({
      name,
      description: "Remembrance registry tool.",
      input_schema: { type: "object", properties: {} },
    })),
  }),
];
const savedStopBlock = (reason) => [
  attachment({
    type: "hook_blocking_error",
    hookName: "Stop",
    toolUseID: "fixture-stop-hook",
    hookEvent: "Stop",
    blockingError: {
      blockingError: reason,
      command: 'node "/plugins/remembrance/scripts/contribute-on-stop.mjs"',
    },
  }),
  entry({
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 1,
    hookInfos: [
      { command: 'node "/plugins/remembrance/scripts/contribute-on-stop.mjs"' },
    ],
    hookErrors: [reason],
    hookAdditionalContext: [],
    preventedContinuation: false,
    stopReason: "",
    hasOutput: true,
    level: "suggestion",
  }),
];
const jsonl = (...entries) =>
  `${entries
    .flat()
    .map((value) => JSON.stringify(value))
    .join("\n")}\n`;

const usedTranscript = jsonl(
  userPrompt("Fix the Vercel build error in CI."),
  promptHookContext(AUTO_QUERY_CONTEXT),
  assistantMessage("msg_used", text("Fixed the build configuration.")),
);
const unusedTranscript = jsonl(
  userPrompt("rename a local variable"),
  assistantMessage("msg_unused", text("done")),
);
// Two distinct uses: an auto-query injection plus a query_skills call.
const twoUsesTranscript = jsonl(
  userPrompt("Fix the Vercel build error in CI."),
  promptHookContext(AUTO_QUERY_CONTEXT),
  assistantMessage(
    "msg_query",
    toolUse("toolu_query", tool("query_skills"), { summary: "vercel build" }),
  ),
  toolResult("toolu_query", [text('{"query_id":"rq_fixture","skills":[]}')]),
  assistantMessage("msg_two_done", text("Fixed the build configuration.")),
);

function baseOptions(extra = {}) {
  return {
    env: testEnv(),
    readCount: () => 0,
    readUseCount: () => 0,
    readEligibilityCount: () => 0,
    readTranscript: () => usedTranscript,
    readCompletionObligations: () => [],
    readHighMatch: () => null,
    readDirectSelections: () => [],
    writeCount: () => {},
    ...extra,
  };
}

describe("Remembrance contribute-on-stop hook", () => {
  it("does not replace the final response in the default recovery mode", () => {
    const readTranscript = vi.fn(() => usedTranscript);
    expect(
      decideContribution(
        {
          session_id: "s-silent-default",
          stop_hook_active: false,
          last_assistant_message: "Fixed the build configuration.",
        },
        baseOptions({
          env: testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" }),
          readTranscript,
        }),
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
    // The host supplied the final message, so nothing needed the transcript.
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("detects registry engagement from transcript markers", () => {
    expect(
      sessionUsedRemembrance(
        '{"content":"Remembrance auto-query context: Trigger: external_service."}',
      ),
    ).toBe(true);
    expect(
      sessionUsedRemembrance(
        "call mcp__plugin_remembrance_remembrance__submit_remembrance",
      ),
    ).toBe(true);
    expect(
      sessionUsedRemembrance(
        "call mcp__plugin_remembrance_remembrance__submit_query_feedback",
      ),
    ).toBe(true);
    expect(
      sessionUsedRemembrance(
        '{"role":"user","content":"rename a local variable"}\n{"role":"assistant","content":"done"}\n',
      ),
    ).toBe(false);
  });

  it("counts only CONSUMPTION calls and injections, not submissions or mentions", () => {
    expect(transcriptEvidence(usedTranscript).consumption).toBe(1);
    expect(transcriptEvidence(twoUsesTranscript).consumption).toBe(2);
    expect(transcriptEvidence(unusedTranscript).consumption).toBe(0);
    const submissionsAndMentions = jsonl(
      userPrompt("Close the Remembrance loop."),
      assistantMessage(
        "msg_submit",
        toolUse("toolu_qf", tool("submit_query_feedback"), {
          query_id: "rq_fixture",
        }),
        toolUse("toolu_fb", tool("submit_feedback"), { useful: true }),
      ),
      assistantMessage(
        "msg_mentions",
        text(
          "Nothing worth capturing from remembrancer. POST /api/v1/agent/query was not needed, and mcp__remembrance__query_skills stays available.",
        ),
      ),
    );
    // A submission does not count as consumption (so contributing never re-prompts).
    expect(transcriptEvidence(submissionsAndMentions)).toEqual({
      consumption: 0,
      eligibility: 0,
      lastAssistantMessage:
        "Nothing worth capturing from remembrancer. POST /api/v1/agent/query was not needed, and mcp__remembrance__query_skills stays available.",
    });
  });

  it("ignores Remembrance tool names that appear only in host tool listings", () => {
    const transcript = jsonl(
      userPrompt("Rename the helper and update its callers."),
      hostToolListings(),
      assistantMessage("msg_listing_done", text("Renamed the helper.")),
    );
    // The raw text names every tool; none of them was called.
    for (const name of LISTED_TOOLS) expect(transcript).toContain(name);
    expect(transcriptEvidence(transcript).consumption).toBe(0);
    expect(
      decideContribution(
        {
          session_id: "s-listings-only",
          stop_hook_active: false,
          last_assistant_message: "Renamed the helper.",
        },
        baseOptions({ readTranscript: () => transcript }),
      ),
    ).toEqual({ allow: true, why: "registry_not_used" });
  });

  it("counts real invoke_skill calls but not the listings around them", () => {
    const transcript = jsonl(
      userPrompt("Use the release-checklist and changelog-style skills."),
      hostToolListings(),
      assistantMessage(
        "msg_invoke_one",
        thinking(),
        toolUse("toolu_invoke_one", tool("invoke_skill"), {
          slug: "release-checklist",
        }),
      ),
      toolResult("toolu_invoke_one", [text('{"selection_mode":"explicit"}')]),
      assistantMessage(
        "msg_invoke_two",
        toolUse("toolu_invoke_two", tool("invoke_skill"), {
          slug: "changelog-style",
        }),
      ),
      toolResult("toolu_invoke_two", [text('{"selection_mode":"explicit"}')]),
      assistantMessage("msg_invoke_done", text("Both checklists passed.")),
    );
    expect(transcriptEvidence(transcript)).toMatchObject({
      consumption: 2,
      lastAssistantMessage: "Both checklists passed.",
    });
    expect(
      decideContribution(
        {
          session_id: "s-real-invokes",
          stop_hook_active: false,
          last_assistant_message: "Both checklists passed.",
        },
        baseOptions({ readTranscript: () => transcript }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
      consumption: 2,
    });
  });

  it("derives the final answer from the last main-thread assistant message", () => {
    const transcript = jsonl(
      userPrompt("Ship it."),
      assistantMessage("msg_earlier", text("Earlier answer.")),
      userPrompt("And the notes?"),
      assistantMessage(
        "msg_final",
        thinking(),
        text("Release notes updated."),
        text("All checks pass."),
      ),
      entry({
        type: "assistant",
        isSidechain: true,
        message: {
          id: "msg_subagent",
          role: "assistant",
          content: [text("Subagent report.")],
        },
      }),
    );
    expect(transcriptEvidence(transcript).lastAssistantMessage).toBe(
      "Release notes updated.\nAll checks pass.",
    );
  });

  it("blocks the stop to prompt contribution on first registry use", async () => {
    const recordHealth = vi.fn();
    const options = baseOptions({ recordHealth });
    const result = await handleStopHook(
      {
        session_id: "s1",
        transcript_path: "/x",
        stop_hook_active: false,
        last_assistant_message: "Fixed the build configuration.",
      },
      options,
    );
    expect(result.allow).toBe(false);
    expect(result.output.decision).toBe("block");
    expect(result.output.reason).toContain(
      contributionReason(null, null, null, {
        privateLessonAuthorized: false,
        env: options.env,
      }),
    );
    expect(result.output.reason).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(result.output.reason).toContain(
      "Do not mention routine Remembrance calls",
    );
    expect(result.output.reason).toContain("submit_remembrance");
    expect(result.output.reason.split("\n").at(-1)).toBe(ANSWER_SHOWN_CLOSING);
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "claude_code",
        component: "completion_hook",
      }),
      options.env,
    );
  });

  it("never asks Claude Code to repeat or restate the answer already shown", async () => {
    const prior =
      "Committed the feature as db0da1a and verified the release gate.";
    const result = await handleStopHook(
      {
        session_id: "s-no-repeat",
        transcript_path: "/x",
        stop_hook_active: false,
        last_assistant_message: prior,
      },
      baseOptions({
        readTranscript: () =>
          jsonl(
            userPrompt("Commit the feature and run the release gate."),
            promptHookContext(AUTO_QUERY_CONTEXT),
            assistantMessage("msg_prior", text(prior)),
          ),
        recordHealth: vi.fn(),
      }),
    );
    expect(result.allow).toBe(false);
    // The closing line is exactly the no-restatement instruction, whether or
    // not the host sent the answer it already shows.
    expect(result.output.reason.split("\n").at(-1)).toBe(ANSWER_SHOWN_CLOSING);
    expect(result.output.reason).not.toContain("preserve the task result");
    expect(result.output.reason).not.toContain("final answer");
    expect(result.output.reason).not.toContain(prior);
  });

  it("judges host-policy alerts by the final answer, not by an earlier saved block reason", async () => {
    const env = testEnv();
    const savedReason = contributionReason(null, null, null, {
      privateLessonAuthorized: true,
      includeLifecycleRecovery: false,
      env,
    });
    expect(savedReason).toContain(HOST_POLICY_ALERT_TEXT);
    expect(savedReason).toContain(PRIVATE_LESSON_HOST_POLICY_ALERT_TEXT);
    const finalAnswer = "Implemented the retry change and the tests pass.";
    const transcript = jsonl(
      userPrompt("Deploy the preview build to Vercel."),
      promptHookContext(AUTO_QUERY_CONTEXT),
      assistantMessage("msg_turn_one", text("Deployed the preview build.")),
      savedStopBlock(savedReason),
      assistantMessage(
        "msg_cleanup",
        toolUse("toolu_cleanup", tool("submit_query_feedback"), {
          query_id: "rq_turn_one",
        }),
      ),
      toolResult("toolu_cleanup", [text('{"accepted":true}')]),
      assistantMessage(
        "msg_turn_one_again",
        text("Deployed the preview build."),
      ),
      userPrompt("Now add retries to the deploy step."),
      assistantMessage("msg_turn_two", text(finalAnswer)),
    );
    const obligations = [
      {
        id: "query_feedback:rq_turn_two",
        kind: "query_feedback",
        engagement_count: 2,
        query_id: "rq_turn_two",
        prompted_at: null,
      },
      {
        id: "post_use_feedback:rinv_turn_two:qres_turn_two",
        kind: "post_use_feedback",
        engagement_count: 2,
        query_id: "rinv_turn_two",
        result_id: "qres_turn_two",
        skill_slug: "deploy-retries",
        prompted_at: null,
      },
    ];
    const run = (input) => {
      const markCompletionObligationsPrompted = vi.fn();
      return handleStopHook(
        { session_id: "s-saved-alert", transcript_path: "/x", ...input },
        baseOptions({
          env,
          readTranscript: () => transcript,
          readCount: () => 1,
          readCompletionObligations: () => obligations,
          recordHealth: vi.fn(),
          reportTaskOutcomes: async () => 0,
          markCompletionObligationsPrompted,
          markDirectSelectionsPrompted: vi.fn(),
        }),
      ).then((result) => ({ result, markCompletionObligationsPrompted }));
    };

    // With the host's final message, and with the message derived from the
    // transcript when an older host omits it, both obligations are prompted.
    for (const input of [{ last_assistant_message: finalAnswer }, {}]) {
      const { result, markCompletionObligationsPrompted } = await run(input);
      expect(result).toMatchObject({
        allow: false,
        why: "prompt_pending_obligations",
      });
      expect(result.output.reason).toContain("query_id rq_turn_two");
      expect(result.output.reason).toContain(
        "query_id rinv_turn_two and result_id qres_turn_two",
      );
      expect(markCompletionObligationsPrompted).toHaveBeenCalledWith(
        "s-saved-alert",
        obligations.map((obligation) => obligation.id),
        env,
        2,
      );
    }

    // A final answer that actually reports the host block still ends the turn.
    const reported = await run({
      last_assistant_message: `The deploy step is done. ${HOST_POLICY_ALERT_TEXT}`,
    });
    expect(reported.result).toEqual({
      allow: true,
      why: "host_policy_alert_reported",
    });
  });

  it("marks only the exact completion obligations included in the stop prompt", async () => {
    const obligation = {
      id: "query_feedback:rq_claude_pending",
      kind: "query_feedback",
      engagement_count: 1,
      query_id: "rq_claude_pending",
      prompted_at: null,
    };
    const writeCount = vi.fn();
    const markCompletionObligationsPrompted = vi.fn();
    const options = baseOptions({
      readCompletionObligations: () => [obligation],
      writeCount,
      markCompletionObligationsPrompted,
    });
    const result = await handleStopHook(
      {
        session_id: "s-exact-obligation",
        transcript_path: "/x",
        stop_hook_active: false,
      },
      options,
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rq_claude_pending");
    expect(writeCount).toHaveBeenCalledWith("s-exact-obligation", 1);
    expect(markCompletionObligationsPrompted).toHaveBeenCalledWith(
      "s-exact-obligation",
      [obligation.id],
      options.env,
      1,
    );
  });

  it("routes organization learning through the exact private router", () => {
    const result = decideContribution(
      { session_id: "s-private-lesson", stop_hook_active: false },
      baseOptions({
        env: testEnv({ REMEMBRANCE_API_KEY: "rk_claude_private_lesson" }),
      }),
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_contribution",
    });
    expect(result.reason).toContain("capture_learning once per new item");
    expect(result.reason).toContain(
      "exact next_action or bounded agent_recovery",
    );
    expect(result.reason).toContain("submit_query_feedback");
    expect(result.reason).toContain("submit_feedback");
    expect(result.reason).not.toContain("propose_private_skill");
  });

  it("re-prompts only when consumption increased since the last prompt", () => {
    // Prompted at count 1 already; still only 1 use → no re-prompt.
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        baseOptions({
          readCount: () => 1,
          readTranscript: () => usedTranscript,
        }),
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
    // A second distinct use (count 2 > prior 1) → prompt again.
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        baseOptions({
          readCount: () => 1,
          readTranscript: () => twoUsesTranscript,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
      consumption: 2,
    });
  });

  it("does not let an earlier low-value capture suppress a later user correction", () => {
    const correction =
      "The user caught that the completed approach was overkill, so the implementation was revised.";
    const result = decideContribution(
      {
        session_id: "s-marginal-lesson",
        stop_hook_active: false,
        last_assistant_message: correction,
      },
      baseOptions({
        readTranscript: () =>
          jsonl(
            userPrompt("Add caching to the settings page."),
            promptHookContext(AUTO_QUERY_CONTEXT),
            assistantMessage(
              "msg_low_value",
              toolUse("toolu_low_value", tool("submit_feedback"), {
                useful: true,
              }),
            ),
            toolResult("toolu_low_value", [text('{"accepted":true}')]),
            userPrompt("That is overkill; use the existing cache."),
            assistantMessage("msg_correction", text(correction)),
          ),
        readCount: () => 1,
        readUseCount: () => 1,
        readEligibilityCount: () => 2,
      }),
    );

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_high_value_lesson_contribution",
      consumption: 2,
    });
    expect(result.reason).toContain("most valuable reusable lesson");
    expect(result.reason).toContain(
      "A lower-value earlier capture does not satisfy this obligation",
    );
  });

  it("prompts once for every newly invoked skill and marks the batch prompted", async () => {
    const selections = [
      {
        slug: "first-skill",
        query_id: "rinv_first",
        result_id: "qres_first",
        feedback_available: true,
        use_count: 1,
        prompted_at: null,
      },
      {
        slug: "second-skill",
        query_id: "rinv_second",
        result_id: "qres_second",
        feedback_available: true,
        use_count: 2,
        prompted_at: null,
      },
    ];
    const writeCount = vi.fn();
    const markDirectSelectionsPrompted = vi.fn();
    const options = baseOptions({
      readTranscript: () => twoUsesTranscript,
      readUseCount: () => 2,
      readDirectSelections: () => selections,
      reportTaskOutcomes: async () => 2,
      writeCount,
      markDirectSelectionsPrompted,
    });
    const result = await handleStopHook(
      {
        session_id: "s-direct-batch",
        transcript_path: "/x",
        stop_hook_active: false,
      },
      options,
    );
    expect(result.allow).toBe(false);
    expect(result.output.reason).toContain("2 Remembrance skills");
    expect(result.output.reason).toContain("first-skill");
    expect(result.output.reason).toContain("second-skill");
    expect(writeCount).toHaveBeenCalledWith("s-direct-batch", 2);
    expect(markDirectSelectionsPrompted).toHaveBeenCalledWith(
      "s-direct-batch",
      2,
      options.env,
    );
  });

  it("does not re-prompt after a decline when only free-text remembrancer is mentioned", () => {
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        baseOptions({
          readCount: () => 1,
          readTranscript: () =>
            jsonl(
              userPrompt("Fix the Vercel build error in CI."),
              promptHookContext(AUTO_QUERY_CONTEXT),
              assistantMessage(
                "msg_decline",
                text("Nothing worth capturing from remembrancer."),
              ),
            ),
        }),
      ),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
  });

  it("allows the stop when disabled via env", () => {
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: false },
        baseOptions({ env: testEnv({ REMEMBRANCE_AUTO_CONTRIBUTE: "0" }) }),
      ),
    ).toMatchObject({ allow: true, why: "disabled" });
    expect(contributeDisabled("0")).toBe(true);
    expect(contributeDisabled("false")).toBe(true);
    expect(contributeDisabled("1")).toBe(false);
    expect(contributeDisabled(undefined)).toBe(false);
  });

  it("never loops: allows the stop when stop_hook_active is set", () => {
    expect(
      decideContribution(
        { session_id: "s1", stop_hook_active: true },
        baseOptions(),
      ),
    ).toMatchObject({ allow: true, why: "stop_hook_active" });
  });

  it("does not nag when the session never touched Remembrance", () => {
    expect(
      decideContribution(
        { session_id: "s2", stop_hook_active: false },
        baseOptions({ readTranscript: () => unusedTranscript }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("recovers a contextual task even when no query completed", () => {
    const transcript = jsonl(
      userPrompt("continue"),
      promptHookContext(
        "Remembrance task-continuation reminder:\nThis prompt depends on earlier conversation.",
      ),
      assistantMessage("msg_context", text("Continued the migration.")),
    );
    expect(transcriptEvidence(transcript)).toMatchObject({
      consumption: 0,
      eligibility: 1,
    });
    expect(
      decideContribution(
        { session_id: "s-context", stop_hook_active: false },
        baseOptions({ readTranscript: () => transcript }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
      consumption: 1,
    });
  });

  it("recovers a later contextual task in a session with an earlier handled query", () => {
    expect(
      decideContribution(
        { session_id: "s-later-context", stop_hook_active: false },
        baseOptions({
          readTranscript: () => unusedTranscript,
          readUseCount: () => 1,
          readEligibilityCount: () => 2,
          readCount: () => 1,
        }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
      consumption: 2,
    });
  });

  it("prompts on a high-value self-correction in the transcript's final answer", () => {
    const transcript = jsonl(
      userPrompt("Publish the plugin release."),
      assistantMessage(
        "msg_version_miss",
        text(
          "I missed the MCP package version bump after publish-impacting plugin changes.",
        ),
      ),
    );
    expect(
      decideContribution(
        { session_id: "s-version-miss", stop_hook_active: false },
        baseOptions({ readTranscript: () => transcript }),
      ),
    ).toMatchObject({
      allow: false,
      why: "prompt_high_value_lesson_contribution",
      consumption: 1,
    });
  });

  it("does not prompt when the high-value lesson was already submitted", () => {
    const transcript = jsonl(
      userPrompt("Capture the release lesson."),
      assistantMessage(
        "msg_submitted",
        text("I submitted it to Remembrance as rpub_769ded635ea04884a8."),
      ),
    );
    expect(
      decideContribution(
        { session_id: "s-submitted", stop_hook_active: false },
        baseOptions({ readTranscript: () => transcript }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });

  it("fails open (allows stop) when the transcript can't be read", () => {
    expect(
      decideContribution(
        { session_id: "s3", stop_hook_active: false },
        baseOptions({ readTranscript: () => "" }),
      ),
    ).toMatchObject({ allow: true, why: "registry_not_used" });
  });
});

describe("session-scoped explicit selections", () => {
  // An invoke_skill response body; the server puts scope next to
  // selection_mode, skill, and query_id.
  function invokeBody({ slug, queryId, resultId, scope }) {
    return {
      ...(scope ? { scope } : {}),
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
  }
  const SESSION_SKILL = invokeBody({
    slug: "pairing-mode",
    queryId: "rinv_session",
    resultId: "qres_session",
    scope: "session",
  });
  const TASK_SKILL = invokeBody({
    slug: "release-checklist",
    queryId: "rinv_task",
    resultId: "qres_task",
    scope: "task",
  });

  // The text content the Remembrance MCP server returns for a tool call.
  const mcpText = (body) =>
    text(JSON.stringify({ ok: true, status: 200, body }));

  function observeInvocation(
    sessionId,
    env,
    toolUseId,
    body,
    toolResponse = { content: [mcpText(body)] },
  ) {
    return handlePostToolUse(
      {
        session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: tool("invoke_skill"),
        tool_input: { slug: body.skill.slug },
        tool_response: toolResponse,
      },
      { env, recordHealth: vi.fn() },
    );
  }

  // One call as Claude Code records it: the assistant tool_use, then the user
  // tool_result carrying the server's envelope.
  const invocationEntries = (toolUseId, body) => [
    ...assistantMessage(
      `msg_${toolUseId}`,
      toolUse(toolUseId, tool("invoke_skill"), { slug: body.skill.slug }),
    ),
    toolResult(toolUseId, [mcpText(body)], { toolUseResult: [mcpText(body)] }),
  ];

  function invocationTranscript(invocations, finalAnswer) {
    return jsonl(
      userPrompt("Use pairing-mode for this session."),
      invocations.flatMap(([toolUseId, body]) =>
        invocationEntries(toolUseId, body),
      ),
      assistantMessage("msg_session_final", text(finalAnswer)),
    );
  }

  const stopInput = (sessionId, finalAnswer) => ({
    session_id: sessionId,
    transcript_path: "/fixture/transcript.jsonl",
    stop_hook_active: false,
    last_assistant_message: finalAnswer,
  });

  it("keeps a session-long skill out of the turn's feedback, obligations, and outcomes", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "claude-session-scope";
    await observeInvocation(sessionId, env, "toolu_session", SESSION_SKILL);
    await observeInvocation(sessionId, env, "toolu_task", TASK_SKILL);

    // Both selections persist with their scope; only the task invocation
    // counts as registry use and owes post-use feedback.
    expect(
      readDirectSelectionSurfaces(sessionId, env).map((selection) => [
        selection.slug,
        selection.scope,
      ]),
    ).toEqual([
      ["pairing-mode", "session"],
      ["release-checklist", "task"],
    ]);
    expect(readRegistryUseCount(sessionId, env)).toBe(1);
    expect(
      readCompletionObligations(sessionId, env).map((item) => item.id),
    ).toEqual(["post_use_feedback:rinv_task:qres_task"]);
    const nextPromptRecovery = pendingCompletionRecoveryInstruction(
      sessionId,
      env,
    );
    expect(nextPromptRecovery).toContain("rinv_task");
    expect(nextPromptRecovery).not.toContain("rinv_session");

    const requests = [];
    const finalAnswer = "The release checklist passed.";
    const transcript = invocationTranscript(
      [
        ["toolu_session", SESSION_SKILL],
        ["toolu_task", TASK_SKILL],
      ],
      finalAnswer,
    );
    // The transcript pairs each call with its own result, so only the task
    // call counts.
    expect(transcriptEvidence(transcript).consumption).toBe(1);
    const result = await handleStopHook(stopInput(sessionId, finalAnswer), {
      env,
      readTranscript: () => transcript,
      recordHealth: vi.fn(),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true };
      },
    });

    expect(result).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(result.output.reason).toContain("rinv_task");
    expect(result.output.reason).not.toContain("rinv_session");
    expect(result.output.reason).not.toContain("pairing-mode");
    // Only the task-scoped episode is reported complete at this stop.
    expect(
      requests.map((request) => [
        request.url,
        request.body.query_id,
        request.body.status,
      ]),
    ).toEqual([
      [
        "https://registry.example/api/v1/agent/task-outcomes",
        "rinv_task",
        "completed",
      ],
    ]);
    expect(
      readValueEpisodeSurfaces(sessionId, env).map((episode) => [
        episode.query_id,
        episode.scope,
        episode.reported_at === null,
      ]),
    ).toEqual([
      ["rinv_session", "session", true],
      ["rinv_task", "task", false],
    ]);
    expect(
      readDirectSelectionSurfaces(sessionId, env).map((selection) => [
        selection.slug,
        selection.prompted_at === null,
      ]),
    ).toEqual([
      ["pairing-mode", true],
      ["release-checklist", false],
    ]);
  });

  it("allows the stop when the only engagement is a session-scoped skill", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "claude-session-only";
    await observeInvocation(sessionId, env, "toolu_only", SESSION_SKILL);
    const fetchImpl = vi.fn();
    const finalAnswer = "Pairing mode is active for this session.";
    const transcript = invocationTranscript(
      [["toolu_only", SESSION_SKILL]],
      finalAnswer,
    );
    // The call is in the transcript, but its own result says it lasts the
    // whole session.
    expect(transcript).toContain(tool("invoke_skill"));
    expect(transcriptEvidence(transcript).consumption).toBe(0);
    const result = await handleStopHook(stopInput(sessionId, finalAnswer), {
      env,
      readTranscript: () => transcript,
      recordHealth: vi.fn(),
      fetchImpl,
    });

    expect(result).toEqual({ allow: true, why: "registry_not_used" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readCompletionObligations(sessionId, env)).toEqual([]);
    expect(readValueEpisodeSurfaces(sessionId, env)).toMatchObject([
      { query_id: "rinv_session", scope: "session", reported_at: null },
    ]);
  });

  it("reads the scope from the invoke_skill MCP envelope", async () => {
    // As the MCP result object, and as the bare content list Claude Code also
    // records for MCP tools.
    for (const [index, toolResponse] of [
      { content: [mcpText(SESSION_SKILL)] },
      [mcpText(SESSION_SKILL)],
    ].entries()) {
      const env = testEnv();
      const sessionId = `claude-session-envelope-${index}`;
      expect(
        await observeInvocation(
          sessionId,
          env,
          "toolu_envelope",
          SESSION_SKILL,
          toolResponse,
        ),
      ).toMatchObject({
        recorded: true,
        why: "direct_skill_invoked",
        count: 0,
      });
      expect(readDirectSelectionSurfaces(sessionId, env)).toMatchObject([
        { slug: "pairing-mode", scope: "session", use_count: 0 },
      ]);
      expect(readRegistryUseCount(sessionId, env)).toBe(0);
      expect(readCompletionObligations(sessionId, env)).toEqual([]);
    }
  });

  // The stop reads each call's scope from the transcript, so the selection
  // store's own limits (a 24-hour expiry, the newest 20 records, one record
  // per query and result id) cannot turn a session call into turn engagement.
  it("does not prompt after the session skill's selection record expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-22T09:00:00.000Z"));
      const env = testEnv();
      const sessionId = "claude-session-expired";
      await observeInvocation(sessionId, env, "toolu_expired", SESSION_SKILL);
      vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
      expect(readDirectSelectionSurfaces(sessionId, env)).toEqual([]);

      const finalAnswer = "Pairing mode is still on.";
      const result = await handleStopHook(stopInput(sessionId, finalAnswer), {
        env,
        readTranscript: () =>
          invocationTranscript([["toolu_expired", SESSION_SKILL]], finalAnswer),
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(),
      });
      expect(result).toEqual({ allow: true, why: "registry_not_used" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not prompt after later selections evict the session skill's record", async () => {
    const env = testEnv();
    const sessionId = "claude-session-evicted";
    const calls = [["toolu_session", SESSION_SKILL]];
    await observeInvocation(sessionId, env, "toolu_session", SESSION_SKILL);
    for (let index = 1; index <= 20; index += 1) {
      const body = invokeBody({
        slug: `task-skill-${index}`,
        queryId: `rinv_task_${index}`,
        resultId: `qres_task_${index}`,
        scope: "task",
      });
      calls.push([`toolu_task_${index}`, body]);
      await observeInvocation(sessionId, env, `toolu_task_${index}`, body);
    }
    expect(
      readDirectSelectionSurfaces(sessionId, env).map(
        (selection) => selection.scope,
      ),
    ).toEqual(Array(20).fill("task"));
    expect(readRegistryUseCount(sessionId, env)).toBe(20);
    // An earlier stop already prompted for all 20 task calls.
    markCompletionObligationsPrompted(sessionId, null, env);
    markDirectSelectionSurfacesPrompted(sessionId, 20, env);

    const finalAnswer = "All task checklists passed.";
    const result = await handleStopHook(stopInput(sessionId, finalAnswer), {
      env,
      readTranscript: () => invocationTranscript(calls, finalAnswer),
      readCount: () => 20,
      recordHealth: vi.fn(),
      reportTaskOutcomes: async () => 0,
    });
    expect(result).toEqual({ allow: true, why: "no_new_usage" });
  });

  it("does not prompt when two session calls share query and result ids", async () => {
    const env = testEnv();
    const sessionId = "claude-session-duplicate";
    await observeInvocation(sessionId, env, "toolu_first", SESSION_SKILL);
    await observeInvocation(sessionId, env, "toolu_again", SESSION_SKILL);
    // The store keeps one record for both calls.
    expect(readDirectSelectionSurfaces(sessionId, env)).toHaveLength(1);

    const finalAnswer = "Pairing mode is on.";
    const result = await handleStopHook(stopInput(sessionId, finalAnswer), {
      env,
      readTranscript: () =>
        invocationTranscript(
          [
            ["toolu_first", SESSION_SKILL],
            ["toolu_again", SESSION_SKILL],
          ],
          finalAnswer,
        ),
      recordHealth: vi.fn(),
      fetchImpl: vi.fn(),
    });
    expect(result).toEqual({ allow: true, why: "registry_not_used" });
  });

  it("still counts a task call when a subagent's session call is not in the main transcript", async () => {
    const env = testEnv();
    const sessionId = "claude-session-subagent";
    // A subagent invoked the session skill; its call is recorded in the
    // subagent's own transcript. The main thread's task call reached only the
    // transcript, which is what catches calls the observer missed.
    await observeInvocation(sessionId, env, "toolu_subagent", SESSION_SKILL);
    const finalAnswer = "The release checklist passed.";
    expect(
      decideContribution(stopInput(sessionId, finalAnswer), {
        env,
        readTranscript: () =>
          invocationTranscript([["toolu_task", TASK_SKILL]], finalAnswer),
        readCount: () => 0,
      }),
    ).toMatchObject({
      allow: false,
      why: "prompt_contribution",
      consumption: 1,
    });
  });

  it("does not subtract a session result whose call is before the transcript window", () => {
    // The hook reads only the transcript's tail, which can start between a
    // call and its result.
    const transcript = jsonl(
      invocationEntries("toolu_cut", SESSION_SKILL).at(-1),
      invocationEntries("toolu_task", TASK_SKILL),
    );
    expect(transcriptEvidence(transcript).consumption).toBe(1);
  });

  it("names only task-scoped selections in the direct feedback prompt", () => {
    const result = decideContribution(
      stopInput("s-direct-mixed", "Done."),
      baseOptions({
        readTranscript: () =>
          invocationTranscript(
            [
              ["toolu_mixed_session", SESSION_SKILL],
              ["toolu_mixed_task", TASK_SKILL],
            ],
            "Done.",
          ),
        readDirectSelections: () => [
          {
            slug: "pairing-mode",
            scope: "session",
            feedback_available: true,
            use_count: 0,
            prompted_at: null,
          },
          {
            slug: "release-checklist",
            scope: "task",
            feedback_available: true,
            use_count: 1,
            prompted_at: null,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_contribution",
      consumption: 1,
    });
    expect(result.reason).toContain("release-checklist");
    expect(result.reason).not.toContain("pairing-mode");
  });

  it("keeps the task-closure prompt without asking to invoke or query the session skill again", () => {
    // The only Remembrance action this turn was the session-scoped invoke, so
    // the eligible task is closed like a turn with no Remembrance action.
    const transcript = jsonl(
      userPrompt("continue"),
      promptHookContext(
        "Remembrance task-continuation reminder:\nThis prompt depends on earlier conversation.",
      ),
      invocationEntries("toolu_closure", SESSION_SKILL),
      assistantMessage("msg_closure", text("Continued the migration.")),
    );
    const result = decideContribution(
      stopInput("s-session-closure", "Continued the migration."),
      baseOptions({
        readTranscript: () => transcript,
        readDirectSelections: () => [
          {
            slug: "pairing-mode",
            scope: "session",
            feedback_available: true,
            use_count: 0,
            prompted_at: null,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      allow: false,
      why: "prompt_task_closure",
      consumption: 1,
    });
    expect(result.reason).toContain(
      "Skills already selected for this session (pairing-mode) stay active; do not invoke or query them again.",
    );
    expect(result.reason).not.toContain("invoke_skill");
  });

  // Task 12 Appendix C item 4: after a compaction the agent loads its
  // always-on skills again (task scope, since no session-start directive
  // named them), under new receipts for the same versions.
  it("owes one post-use feedback for a task skill loaded again after a compaction", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "claude-reload-after-compaction";
    const result = "qres_direct_caveman_v1";
    const loads = [
      ["toolu_first", "rinv_first"],
      ["toolu_reload", "rinv_reload"],
    ];
    for (const [toolUseId, queryId] of loads) {
      await observeInvocation(
        sessionId,
        env,
        toolUseId,
        invokeBody({ slug: "caveman", queryId, resultId: result }),
      );
    }
    expect(readRegistryUseCount(sessionId, env)).toBe(1);
    expect(
      readCompletionObligations(sessionId, env).map((item) => [
        item.query_id,
        item.alias_query_ids,
      ]),
    ).toEqual([["rinv_first", ["rinv_reload"]]]);
    const demands = () =>
      String(pendingCompletionRecoveryInstruction(sessionId, env) ?? "")
        .split("\n")
        .filter((line) => line.startsWith("- Post-use feedback"));
    expect(demands()).toEqual([
      `- Post-use feedback for caveman: call submit_feedback with query_id rinv_first and result_id ${result}.`,
    ]);

    // Paid under the receipt the compacted context still holds.
    await handlePostToolUse(
      {
        session_id: sessionId,
        tool_use_id: "toolu_feedback",
        tool_name: tool("submit_feedback"),
        tool_input: {
          query_id: "rinv_reload",
          result_id: result,
          useful: true,
        },
        tool_response: { content: [mcpText({ recorded: true })] },
      },
      { env, recordHealth: vi.fn() },
    );
    expect(readCompletionObligations(sessionId, env)).toEqual([]);
    expect(demands()).toEqual([]);
  });

  // A paid use lasts until the user's next prompt, whatever it asks; host
  // text in the prompt's place is not one.
  it("owes feedback again for a use after the user's next prompt, not after host text", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "claude-use-after-prompt";
    const result = "qres_direct_caveman_v1";
    const invokeCaveman = (toolUseId, queryId) =>
      observeInvocation(
        sessionId,
        env,
        toolUseId,
        invokeBody({ slug: "caveman", queryId, resultId: result }),
      );
    const prompt = (text) =>
      handlePromptInput(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: sessionId,
          prompt: text,
        },
        {
          env,
          recordHealth: vi.fn(),
          fetchImpl: vi.fn(async () =>
            Response.json({ skills: [], resources: [] }),
          ),
        },
      );
    const debts = () =>
      readCompletionObligations(sessionId, env).map((item) => item.query_id);

    await invokeCaveman("toolu_first", "rinv_first");
    await handlePostToolUse(
      {
        session_id: sessionId,
        tool_use_id: "toolu_feedback",
        tool_name: tool("submit_feedback"),
        tool_input: { query_id: "rinv_first", result_id: result, useful: true },
        tool_response: { content: [mcpText({ recorded: true })] },
      },
      { env, recordHealth: vi.fn() },
    );
    await prompt(
      '<task-notification>\n<status>completed</status>\n<summary>Background command "npm test" completed</summary>\n</task-notification>',
    );
    await invokeCaveman("toolu_reload", "rinv_reload");
    expect(readRegistryUseCount(sessionId, env)).toBe(1);
    expect(debts()).toEqual([]);

    await prompt("Use the remembrance skill named caveman.");
    await invokeCaveman("toolu_named", "rinv_named");
    expect(readRegistryUseCount(sessionId, env)).toBe(2);
    expect(debts()).toEqual(["rinv_named"]);
  });
});

// Claude Code runs a subagent under its parent's session_id and derives
// transcript_path from that id, so both carry the parent's values inside a
// subagent. Only agent_id, on the subagent's own hooks, and SubagentStop's
// agent_transcript_path tell the two agents apart.
describe("debts earned inside a subagent", () => {
  const SESSION = "claude-session-parent";
  const AGENT = "a0c1d2e3f4a5b6c7d";
  const OTHER_AGENT = "a9e8d7c6b5a4f3e2d";
  const PARENT_TRANSCRIPT = "/fixture/claude-session-parent.jsonl";
  const AGENT_TRANSCRIPT =
    "/fixture/claude-session-parent/subagents/agent-a0c1d2e3f4a5b6c7d.jsonl";
  const PAYLOAD = {
    schema_version: 1,
    type: "skill_use",
    skill: { slug: "release-checklist" },
    outcome: "success",
    lesson: "Run the release checklist before tagging a build.",
    interaction: { query_id: "rq_subagent", result_id: "qres_subagent" },
  };
  const agentLedger = agentLedgerIdFor({
    session_id: SESSION,
    agent_id: AGENT,
  });
  const envelope = (body) => ({
    content: [text(JSON.stringify({ ok: true, status: 200, body }))],
  });

  // The parent's own task-scoped skill call owes post-use feedback.
  const parentInvocation = (env) =>
    handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_parent_invoke",
        tool_name: tool("invoke_skill"),
        tool_input: { slug: "deploy-preview" },
        tool_response: envelope({
          scope: "task",
          selection_mode: "explicit",
          invocation_id: "rinv_parent",
          query_id: "rinv_parent",
          result_id: "qres_parent",
          skill: {
            slug: "deploy-preview",
            version: 1,
            version_id: "skv_deploy-preview",
            skill_md: "# Instructions",
            task_outcome_eligible: true,
          },
          feedback: { available: true },
          task_outcome: {
            available: true,
            eligible_result_ids: ["qres_parent"],
          },
        }),
      },
      { env, recordHealth: vi.fn() },
    );
  // The subagent's submit_feedback call; the server returns the remembrance
  // it should submit next.
  const subagentFeedback = (env) =>
    handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        agent_id: AGENT,
        agent_type: "general-purpose",
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_subagent_feedback",
        tool_name: tool("submit_feedback"),
        tool_input: {
          query_id: "rq_subagent",
          result_id: "qres_subagent",
          outcome: "success",
        },
        tool_response: envelope({
          accepted: true,
          next_step: { submit_remembrance_payload: PAYLOAD },
        }),
      },
      { env, recordHealth: vi.fn() },
    );
  const parentStop = () => ({
    session_id: SESSION,
    transcript_path: PARENT_TRANSCRIPT,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Deployed the preview.",
  });
  const subagentStop = (extra = {}) => ({
    session_id: SESSION,
    transcript_path: PARENT_TRANSCRIPT,
    hook_event_name: "SubagentStop",
    agent_id: AGENT,
    agent_type: "general-purpose",
    agent_transcript_path: AGENT_TRANSCRIPT,
    stop_hook_active: false,
    last_assistant_message: "Release checklist verified.",
    ...extra,
  });
  const stopOptions = (env, readTranscript = vi.fn(() => "")) => ({
    env,
    readTranscript,
    recordHealth: vi.fn(),
    reportTaskOutcomes: vi.fn(async () => 0),
  });
  const pendingIds = (ledgerId, env) =>
    readCompletionObligations(ledgerId, env).map((item) => [
      item.kind,
      item.prompted_at === null,
    ]);
  // The line a demand shows for a payload it keeps but does not show.
  const handleFor = (env, id, payload) => {
    const hash = (value) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const obligation = readCompletionObligations(SESSION, env).find(
      (item) => item.query_id === `rq_${id}`,
    );
    return `- Reusable evidence for query_id rq_${id} and result_id qres_${id}: payload kept on this machine (${Buffer.byteLength(JSON.stringify(payload))} bytes, ${obligation.payload_digest}); call local get_pending_action_payload with action_id ${hash(obligation.id).slice(0, 16)} and ledger ${hash(SESSION).slice(0, 16)}, then submit_remembrance with exactly the payload it returns.`;
  };

  it("keeps a subagent's debt out of its parent's stop and next prompt", async () => {
    const env = testEnv();
    await parentInvocation(env);
    await subagentFeedback(env);
    expect(pendingIds(SESSION, env)).toEqual([["post_use_feedback", true]]);
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", true],
    ]);

    const stop = await handleStopHook(
      parentStop(),
      stopOptions(
        env,
        vi.fn(() => unusedTranscript),
      ),
    );
    expect(stop).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(stop.output.reason).toContain("rinv_parent");
    expect(stop.output.reason).not.toContain("Reusable evidence");
    expect(stop.output.reason).not.toContain("rq_subagent");
    // The subagent's debt is still unprompted, for the subagent to close.
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", true],
    ]);

    // The default silent mode asks at the parent's next prompt instead.
    const silentEnv = { ...env, REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" };
    const next = await handlePromptInput(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      },
      {
        env: silentEnv,
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    );
    expect(next.hookSpecificOutput.additionalContext).toContain("rinv_parent");
    expect(next.hookSpecificOutput.additionalContext).not.toContain(
      "Reusable evidence",
    );
  });

  it("asks the subagent once, at SubagentStop, for its own debts", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    await parentInvocation(env);
    await subagentFeedback(env);
    // The parent's stop leaves recovery to its next prompt.
    expect(await handleStopHook(parentStop(), stopOptions(env))).toEqual({
      allow: true,
      why: "silent_prompt_recovery",
    });

    const readTranscript = vi.fn(() => "");
    const options = stopOptions(env, readTranscript);
    const stop = await handleStopHook(subagentStop(), options);
    expect(stop).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
      output: { decision: "block" },
    });
    expect(stop.output.reason).not.toContain("rinv_parent");
    // It is handed the exact payload it received, on the line after the
    // instruction.
    const lines = stop.output.reason.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        "- Reusable evidence for query_id rq_subagent and result_id qres_subagent:",
      ),
    );
    expect(lead).toBeGreaterThan(-1);
    expect(JSON.parse(lines[lead + 1])).toEqual(PAYLOAD);
    // Its report must still reach its caller, by whatever channel.
    expect(stop.output.reason.split("\n").at(-1)).toBe(
      "After the silent cleanup, make sure your caller still gets your complete final report, unchanged and without Remembrance status text. Deliver it again the way your task returns results, unless you already returned it through a tool meant to be called once.",
    );
    // Its own calls are in its own transcript; task outcomes stay with the
    // parent's stop.
    expect(readTranscript.mock.calls.map(([path]) => path)).toEqual([
      AGENT_TRANSCRIPT,
    ]);
    expect(options.reportTaskOutcomes).not.toHaveBeenCalled();
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", false],
    ]);
    expect(pendingIds(SESSION, env)).toEqual([["post_use_feedback", true]]);

    // The continuation's stop and any later stop are not asked again.
    expect(
      await handleStopHook(subagentStop({ stop_hook_active: true }), options),
    ).toEqual({ allow: true, why: "stop_hook_active" });
    expect(await handleStopHook(subagentStop(), options)).toEqual({
      allow: true,
      why: "silent_prompt_recovery",
    });
  });

  it("re-supplies the exact payload in the next prompt after compaction", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    // Sentences, and words such as outbox or authorization that would file a
    // loose line under another context kind, must neither split the payload
    // line nor move it away from its instruction.
    const payload = {
      ...PAYLOAD,
      lesson:
        "Check the outbox before retrying. Authorization errors need a fresh key! Does the retry still fail?",
      interaction: { query_id: "rq_main", result_id: "qres_main" },
    };
    await handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_main_feedback",
        tool_name: tool("submit_feedback"),
        tool_input: {
          query_id: "rq_main",
          result_id: "qres_main",
          outcome: "success",
        },
        tool_response: envelope({
          accepted: true,
          next_step: { submit_remembrance_payload: payload },
        }),
      },
      { env, recordHealth: vi.fn() },
    );
    // The agent's context no longer holds the feedback result; the hook
    // does.
    const next = await handlePromptInput(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      },
      {
        env,
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    );
    const lines = next.hookSpecificOutput.additionalContext.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        "- Reusable evidence for query_id rq_main and result_id qres_main:",
      ),
    );
    expect(lead).toBeGreaterThan(-1);
    expect(JSON.parse(lines[lead + 1])).toEqual(payload);
  });

  it("re-supplies the oldest payload that fits the prompt, and a handle for each other one", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    const payloads = {};
    // Oldest first: a payload over the prompt cap, three older debts with
    // long ids, a payload under the cap, and a small one.
    const older = [0, 1, 2].map((index) => ({
      query_id: `rq_older_${index}_${"q".repeat(140)}`,
      result_id: `qres_older_${index}_${"r".repeat(140)}`,
    }));
    const feedback = (interaction, response) =>
      handlePostToolUse(
        {
          session_id: SESSION,
          transcript_path: PARENT_TRANSCRIPT,
          hook_event_name: "PostToolUse",
          tool_use_id: `toolu_${interaction.query_id.slice(0, 16)}_feedback`,
          tool_name: tool("submit_feedback"),
          tool_input: { ...interaction, outcome: "success" },
          tool_response: envelope(response),
        },
        { env, recordHealth: vi.fn() },
      );
    const retain = async (id, length) => {
      const interaction = { query_id: `rq_${id}`, result_id: `qres_${id}` };
      payloads[id] = {
        ...PAYLOAD,
        lesson: `Lesson ${id}. ${"w".repeat(length)}`,
        interaction,
      };
      await feedback(interaction, {
        accepted: true,
        next_step: { submit_remembrance_payload: payloads[id] },
      });
    };
    const start = Date.now() - 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      await retain("capped", 2500);
      older.forEach((ids, index) => {
        vi.setSystemTime(start + 1000 + index);
        recordPostUseFeedbackObligation(
          SESSION,
          { ...ids, skill_slug: "release-checklist" },
          env,
          1,
        );
      });
      vi.setSystemTime(start + 2000);
      await retain("medium", 1600);
      vi.setSystemTime(start + 3000);
      await retain("small", 400);
    } finally {
      vi.useRealTimers();
    }
    // A correction prompt's capture directive leaves the recovery less room
    // than it has alone.
    const correctionPrompt = async () =>
      (
        await handlePromptInput(
          {
            session_id: SESSION,
            transcript_path: PARENT_TRANSCRIPT,
            hook_event_name: "UserPromptSubmit",
            prompt:
              "That approach is the wrong direction; preserve the existing behavior.",
          },
          {
            env,
            recordHealth: vi.fn(),
            fetchImpl: vi.fn(async () => {
              throw new Error("offline");
            }),
          },
        )
      ).hookSpecificOutput.additionalContext.split("\n");
    const lead = (lines, id) =>
      lines.findIndex((line) =>
        line.startsWith(
          `- Reusable evidence for query_id rq_${id} and result_id qres_${id}:`,
        ),
      );

    // Alone the medium payload fits beside the older debts; this prompt has
    // no room for it, so it gets its handle and the small one is shown.
    expect(pendingCompletionRecoveryInstruction(SESSION, env)).toContain(
      '"lesson":"Lesson medium.',
    );
    let lines = await correctionPrompt();
    expect(lines).toContain(handleFor(env, "capped", payloads.capped));
    expect(lines[lead(lines, "medium")]).toBe(
      handleFor(env, "medium", payloads.medium),
    );
    expect(JSON.parse(lines[lead(lines, "small") + 1])).toEqual(payloads.small);
    expect(lines.filter((line) => line.includes('"lesson"'))).toHaveLength(1);
    // Debts this version records carry no pre-agent-keying tag.
    expect(lines.join("\n")).not.toContain("pre-agent-keying");

    // Once the older debts close, the same prompt shows the medium payload.
    for (const ids of older) await feedback(ids, { accepted: true });
    lines = await correctionPrompt();
    expect(JSON.parse(lines[lead(lines, "medium") + 1])).toEqual(
      payloads.medium,
    );
  });

  it("shows a payload whose line is exactly the cap, and a handle for one a character longer in either mode", async () => {
    const env = testEnv();
    // No sentence punctuation before whitespace, so a payload's line is its
    // JSON.
    const payloadOf = (id, length) => {
      const base = {
        ...PAYLOAD,
        lesson: "",
        interaction: { query_id: `rq_${id}`, result_id: `qres_${id}` },
      };
      return {
        ...base,
        lesson: "w".repeat(length - JSON.stringify(base).length),
      };
    };
    const payloads = {
      over: payloadOf("over", 2001),
      at: payloadOf("at", 2000),
    };
    expect(JSON.stringify(payloads.over)).toHaveLength(2001);
    expect(JSON.stringify(payloads.at)).toHaveLength(2000);
    const start = Date.now() - 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [index, id] of ["over", "at"].entries()) {
        vi.setSystemTime(start + index * 1000);
        await handlePostToolUse(
          {
            session_id: SESSION,
            transcript_path: PARENT_TRANSCRIPT,
            hook_event_name: "PostToolUse",
            tool_use_id: `toolu_${id}_feedback`,
            tool_name: tool("submit_feedback"),
            tool_input: { ...payloads[id].interaction, outcome: "success" },
            tool_response: envelope({
              accepted: true,
              next_step: { submit_remembrance_payload: payloads[id] },
            }),
          },
          { env, recordHealth: vi.fn() },
        );
      }
    } finally {
      vi.useRealTimers();
    }

    // The handle is the same whether or not a stop would show the payload.
    for (const mode of ["0", "1"]) {
      const lines = (
        await handlePromptInput(
          {
            session_id: SESSION,
            transcript_path: PARENT_TRANSCRIPT,
            hook_event_name: "UserPromptSubmit",
            prompt: "rename a local variable",
          },
          {
            env: { ...env, REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: mode },
            recordHealth: vi.fn(),
            fetchImpl: vi.fn(async () => {
              throw new Error("offline");
            }),
          },
        )
      ).hookSpecificOutput.additionalContext.split("\n");
      expect(lines).toContain(handleFor(env, "over", payloads.over));
      const shown = lines
        .filter((line) => line.includes('"lesson"'))
        .map((line) => line.trim());
      expect(shown).toEqual([JSON.stringify(payloads.at)]);
      expect(shown[0]).toHaveLength(2000);
    }
  });

  it("passes what it leaves unpaid to the parent, marked second-hand", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    await parentInvocation(env);
    await subagentFeedback(env);
    // The subagent also opens the skill the parent invoked, so both owe its
    // post-use feedback.
    await handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        agent_id: AGENT,
        agent_type: "general-purpose",
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_subagent_get",
        tool_name: tool("get_skill"),
        tool_input: {
          slug: "deploy-preview",
          query_id: "rinv_parent",
          result_id: "qres_parent",
        },
        tool_response: envelope({ slug: "deploy-preview" }),
      },
      { env, recordHealth: vi.fn() },
    );
    // A private-learning hint is held per machine, not per agent.
    recordPrivateLessonObligation(
      agentLedger,
      { body: { draft_id: "pld_subagentlesson", state: "ready" } },
      env,
    );
    expect(pendingIds(agentLedger, env).sort()).toEqual([
      ["post_use_feedback", true],
      ["private_lesson", true],
      ["remembrance_followup", true],
    ]);

    // It is asked once and exits without paying.
    const options = stopOptions(env);
    expect(await handleStopHook(subagentStop(), options)).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    expect(
      await handleStopHook(subagentStop({ stop_hook_active: true }), options),
    ).toEqual({ allow: true, why: "stop_hook_active" });

    // The parent now owes the follow-up, unprompted, with its payload and the
    // subagent it came from. The feedback both owed stays the parent's own,
    // and the private hint is untouched.
    expect(pendingIds(agentLedger, env)).toEqual([["private_lesson", true]]);
    const held = readCompletionObligations(SESSION, env);
    expect(
      held.map((item) => [item.kind, item.prompted_at, item.transferred_from]),
    ).toEqual([
      ["post_use_feedback", null, null],
      [
        "remembrance_followup",
        null,
        { agent_id: AGENT, transcript_path: AGENT_TRANSCRIPT },
      ],
      ["private_lesson", null, null],
    ]);
    // Sealed as the subagent's hook kept it; nothing is converted on the way.
    expect(held[1].local_resupply_payload).toBeNull();
    expect(held[1].local_resupply_envelope).toEqual(
      expect.objectContaining({ key_source: "mode_0600_file" }),
    );

    // Its next prompt names where the debt came from and repeats the payload.
    const next = await handlePromptInput(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      },
      {
        env,
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    );
    const context = next.hookSpecificOutput.additionalContext;
    const lines = context.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        `- Reusable evidence for query_id rq_subagent and result_id qres_subagent (second-hand from subagent ${AGENT} (${AGENT_TRANSCRIPT})): call submit_remembrance`,
      ),
    );
    expect(lead).toBeGreaterThan(-1);
    expect(JSON.parse(lines[lead + 1])).toEqual(PAYLOAD);
    expect(context).toContain(
      "- Post-use feedback for deploy-preview: call submit_feedback with query_id rinv_parent and result_id qres_parent",
    );

    // Submitting it as given closes it in the parent's ledger.
    await handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_parent_remembrance",
        tool_name: tool("submit_remembrance"),
        tool_input: JSON.parse(lines[lead + 1]),
        tool_response: envelope({ accepted: true }),
      },
      { env, recordHealth: vi.fn() },
    );
    expect(
      readCompletionObligations(SESSION, env).map((item) => item.kind),
    ).toEqual(["post_use_feedback", "private_lesson"]);
  });

  it("lets the parent decline a second-hand debt by its action id, never by message text", async () => {
    const env = testEnv();
    await subagentFeedback(env);
    const options = stopOptions(env);
    await handleStopHook(subagentStop(), options);
    await handleStopHook(subagentStop({ stop_hook_active: true }), options);

    const stop = await handleStopHook(parentStop(), stopOptions(env));
    expect(stop).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    const lines = stop.output.reason.split("\n");
    const lead = lines.findIndex((line) =>
      line.startsWith(
        `- Reusable evidence for query_id rq_subagent and result_id qres_subagent (second-hand from subagent ${AGENT} (${AGENT_TRANSCRIPT})):`,
      ),
    );
    expect(JSON.parse(lines[lead + 1])).toEqual(PAYLOAD);
    const actionId = /^ {2}action_id ([a-f0-9]{16})$/u.exec(
      lines[lead + 2],
    )?.[1];
    expect(actionId).toMatch(/^[a-f0-9]{16}$/u);

    // Saying so closes nothing.
    await handleStopHook(
      {
        ...parentStop(),
        last_assistant_message: `Declined: decline_pending_action action_id ${actionId} reason agent_exited.`,
      },
      stopOptions(env),
    );
    expect(pendingIds(SESSION, env)).toEqual([["remembrance_followup", false]]);

    // The observed call closes it in the parent's own ledger.
    const args = { action_id: actionId, reason: "agent_exited" };
    await handlePostToolUse(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_parent_decline",
        tool_name: tool("decline_pending_action"),
        tool_input: args,
        tool_response: {
          content: [
            text(
              JSON.stringify({
                status: "declined",
                ...args,
                submitted: false,
                local_only: true,
              }),
            ),
          ],
        },
      },
      { env, recordHealth: vi.fn() },
    );
    expect(pendingIds(SESSION, env)).toEqual([]);
  });

  it("labels a debt an older client recorded under the session alone, at the prompt and at the stop", async () => {
    const env = testEnv();
    // Two records 0.1.77 wrote for a subagent's submit_feedback: under the
    // session alone, a digest instead of the payload, and no agent stamp.
    const sha256 = (value) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const directory = join(
      env.REMEMBRANCE_USAGE_DIR,
      `${sha256(SESSION).slice(0, 16)}.obligations`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const start = Date.now() - 60_000;
    const ids = ["a", "b"].map((name, index) => {
      const digest = `sha256:${sha256(`an older client's payload ${name}`)}`;
      const id = `remembrance_followup:${digest}`;
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
          created_at: new Date(start + index * 1000).toISOString(),
          prompted_at: null,
        })}\n`,
        { mode: 0o600 },
      );
      return id;
    });
    // Each such line is tagged, and the first one explains the tag, so the
    // two stay together.
    const tagged = [
      "- Reusable evidence for query_id rq_legacy_a and result_id qres_legacy_a [pre-agent-keying: this and every debt tagged so were recorded before per-agent keying and may be a subagent's; decline one with not_observed_by_this_agent if you did not receive it]: submit the exact next_step.submit_remembrance_payload returned by the preceding feedback call.",
      "- Reusable evidence for query_id rq_legacy_b and result_id qres_legacy_b [pre-agent-keying]: submit the exact next_step.submit_remembrance_payload returned by the preceding feedback call.",
    ];
    const once = (text) =>
      expect(
        text.split("\n").filter((line) => line.includes("pre-agent-keying")),
      ).toEqual(tagged);

    const next = await handlePromptInput(
      {
        session_id: SESSION,
        transcript_path: PARENT_TRANSCRIPT,
        hook_event_name: "UserPromptSubmit",
        prompt: "rename a local variable",
      },
      {
        env: { ...env, REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" },
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    );
    once(next.hookSpecificOutput.additionalContext);

    const stop = await handleStopHook(parentStop(), stopOptions(env));
    expect(stop).toMatchObject({
      allow: false,
      why: "prompt_pending_obligations",
    });
    once(stop.output.reason);
    // Marking them prompted rewrites the records without stamping them, so
    // the next demand still tags them.
    expect(
      readCompletionObligations(SESSION, env).map((item) => [
        item.id,
        item.agent_keyed,
        Boolean(item.prompted_at),
      ]),
    ).toEqual(ids.map((id) => [id, false, true]));
    once(pendingCompletionRecoveryInstruction(SESSION, env));
    // A debt this version records is its own and carries no label.
    await parentInvocation(env);
    const [own] = readCompletionObligations(SESSION, env).filter(
      (item) => item.kind === "post_use_feedback",
    );
    expect(own.agent_keyed).toBe(true);
    expect(pendingCompletionRecoveryInstruction(SESSION, env)).toContain(
      "- Post-use feedback for deploy-preview: call submit_feedback with query_id rinv_parent and result_id qres_parent",
    );
  });

  it("moves the debts of a subagent an API error ended to its parent at StopFailure", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    await parentInvocation(env);
    await subagentFeedback(env);
    const options = stopOptions(env);
    const failure = {
      session_id: SESSION,
      transcript_path: PARENT_TRANSCRIPT,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "API Error: Rate limit reached",
    };
    // The main thread's own failure touches no ledger.
    expect(await handleStopHook(failure, options)).toEqual({
      allow: true,
      why: "stop_failure",
    });
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", true],
    ]);

    // A subagent's failure carries its agent id but no transcript path.
    expect(
      await handleStopHook(
        { ...failure, agent_id: AGENT, agent_type: "general-purpose" },
        options,
      ),
    ).toEqual({ allow: true, why: "stop_failure" });
    expect(options.readTranscript).not.toHaveBeenCalled();
    expect(options.reportTaskOutcomes).not.toHaveBeenCalled();
    expect(pendingIds(agentLedger, env)).toEqual([]);
    expect(pendingIds(SESSION, env)).toEqual([
      ["post_use_feedback", true],
      ["remembrance_followup", true],
    ]);
    expect(pendingCompletionRecoveryInstruction(SESSION, env)).toContain(
      `- Reusable evidence for query_id rq_subagent and result_id qres_subagent (second-hand from subagent ${AGENT}): call submit_remembrance with exactly the payload on the next line`,
    );
  });

  it("touches no ledger at a SubagentStop without an agent id", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    await parentInvocation(env);
    await subagentFeedback(env);
    const readTranscript = vi.fn(() => "");
    const result = await handleStopHook(
      subagentStop({ agent_id: undefined }),
      stopOptions(env, readTranscript),
    );
    expect(result).toEqual({
      allow: true,
      why: "subagent_identity_unavailable",
    });
    expect(readTranscript).not.toHaveBeenCalled();
    expect(pendingIds(SESSION, env)).toEqual([["post_use_feedback", true]]);
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", true],
    ]);
  });

  it("lets a subagent with no pending actions stop", async () => {
    const env = testEnv({ REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "0" });
    await parentInvocation(env);
    await subagentFeedback(env);
    expect(
      await handleStopHook(
        subagentStop({ agent_id: OTHER_AGENT }),
        stopOptions(env),
      ),
    ).toEqual({ allow: true, why: "silent_prompt_recovery" });
    expect(pendingIds(SESSION, env)).toEqual([["post_use_feedback", true]]);
    expect(pendingIds(agentLedger, env)).toEqual([
      ["remembrance_followup", true],
    ]);
  });
});

// Task 12 Appendix C item 5, on the host it happened on: late in a long,
// compacted session the stop hook said no query was recorded. It reads only
// the transcript's last 4 MiB, and an agent's query that found nothing was
// never registry use, so nothing showed the query any more.
describe("a task queried before the transcript's tail", () => {
  it("is not called unqueried", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://registry.example" });
    const sessionId = "claude-closure-long-session";
    const prompt = "Deploy the Next.js app to Vercel with GitHub Actions.";
    await handlePromptInput(
      { hook_event_name: "UserPromptSubmit", prompt, session_id: sessionId },
      {
        env,
        recordHealth: vi.fn(),
        fetchImpl: vi.fn(async () =>
          Response.json({ skills: [], resources: [] }),
        ),
      },
    );
    const summary = { task: { summary: "Deploy Next.js to Vercel from CI" } };
    const found = [
      text(
        JSON.stringify({
          ok: true,
          status: 200,
          body: { query_id: "rq_own", skills: [], resources: [] },
        }),
      ),
    ];
    await handlePostToolUse(
      {
        session_id: sessionId,
        tool_use_id: "toolu_query",
        tool_name: tool("query_skills"),
        tool_input: summary,
        tool_response: { content: found },
      },
      { env, recordHealth: vi.fn() },
    );
    const transcriptPath = join(tempRoot, `long-session-${envCounter}.jsonl`);
    const work = text("x".repeat(64 * 1024));
    writeFileSync(
      transcriptPath,
      jsonl(
        userPrompt(prompt),
        assistantMessage(
          "msg_query",
          toolUse("toolu_query", tool("query_skills"), summary),
        ),
        toolResult("toolu_query", found),
        // 4.5 MiB of later work.
        Array.from({ length: 72 }, (_, index) =>
          assistantMessage(`msg_work_${index}`, work),
        ),
        assistantMessage("msg_final", text("Deployed.")),
      ),
    );

    const result = await handleStopHook(
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        stop_hook_active: false,
        last_assistant_message: "Deployed.",
      },
      { env, recordHealth: vi.fn(), fetchImpl: async () => ({ ok: true }) },
    );
    expect(result.why).not.toBe("prompt_task_closure");
    expect(String(result.output?.reason ?? "")).not.toContain(
      "silently recover the pending Remembrance query",
    );
  });
});
