import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePromptEligibility,
  promptFromCursorInput,
} from "../scripts/record-task-eligibility.mjs";
import { readUserPromptCount } from "../scripts/hook-core.mjs";
import { cursorSessionId } from "../scripts/record-mcp-use.mjs";
import {
  HOST_NOTIFICATION_SHAPES,
  ORDINARY_HUMAN_PROMPTS,
} from "../../codex-plugin/test/fixtures/host-notification-corpus.mjs";
import { STOPPED_PROMPT } from "../../codex-plugin/test/fixtures/search-hygiene.mjs";

const tempDirs = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Cursor beforeSubmitPrompt eligibility observer", () => {
  it("does not turn a host notification into retrieval or native recovery context", async () => {
    const nativeContextBridge = vi.fn();
    const recordEligibility = vi.fn();
    const recordPreferences = vi.fn();
    const fetchImpl = vi.fn();
    const result = await handlePromptEligibility(
      {
        prompt:
          '<task_notification task_id="synthetic-task">Background deployment completed.</task_notification>',
        conversation_id: "synthetic-notification-session",
      },
      {
        env: {},
        nativeContextBridge,
        recordEligibility,
        recordPreferences,
        fetchImpl,
        recordHealth: vi.fn(),
      },
    );
    expect(result).toEqual({ eligible: false, reason: "host_notification" });
    expect(nativeContextBridge).not.toHaveBeenCalled();
    expect(recordEligibility).not.toHaveBeenCalled();
    expect(recordPreferences).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Cursor sends beforeSubmitPrompt {prompt: request.prompt, ...}
  // (Cursor 3.22.7 cursor-agent-exec main.js 5:5074027, line:column from
  // 1) and adds <system_reminder> user messages of its own.
  it.each(
    HOST_NOTIFICATION_SHAPES.filter((item) => item.host === "cursor").map(
      (item) => [item.label, item],
    ),
  )("does not take Cursor's %s for the user's prompt", async (_label, item) => {
    const recordEligibility = vi.fn();
    const recordPreferences = vi.fn();
    const fetchImpl = vi.fn();
    const result = await handlePromptEligibility(
      { prompt: item.prompt, conversation_id: "cursor-host-text" },
      {
        env: {},
        recordEligibility,
        recordPreferences,
        fetchImpl,
        recordHealth: vi.fn(),
      },
    );
    expect(result).toEqual({ eligible: false, reason: "host_notification" });
    expect(recordEligibility).not.toHaveBeenCalled();
    expect(recordPreferences).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // A paid skill use lasts until the user's next prompt (hook-core's
  // repeatedResultUse); host text in its place is not one.
  it("counts each user prompt, whatever it asks, and not host text", async () => {
    const usage = await mkdtemp(join(tmpdir(), "cursor-user-prompts-"));
    tempDirs.push(usage);
    const env = { REMEMBRANCE_USAGE_DIR: usage };
    const input = (prompt) => ({ prompt, conversation_id: "cursor-prompts" });
    const options = {
      env,
      recordHealth: vi.fn(),
      recordPreferences: vi.fn(async () => 0),
      recordEligibility: vi.fn(),
      recordDirective: vi.fn(),
      fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
    };
    const sessionId = cursorSessionId(input(""), env);
    const [hostText] = HOST_NOTIFICATION_SHAPES.filter(
      (item) => item.host === "cursor",
    );
    await handlePromptEligibility(input(hostText.prompt), options);
    expect(readUserPromptCount(sessionId, env)).toBe(0);
    await handlePromptEligibility(
      input("Use the remembrance skill named caveman."),
      options,
    );
    await handlePromptEligibility(input(ORDINARY_HUMAN_PROMPTS[0]), options);
    expect(readUserPromptCount(sessionId, env)).toBe(2);
  });

  // A search hygiene stops (host text a trigger matched) is not a task the
  // agent should be told to query for; the override restores the old path.
  it.each([
    [{}, { eligible: false, reason: "hygiene_host_generation_prompt" }],
    [{ REMEMBRANCE_AUTO_QUERY_HYGIENE: "0" }, { eligible: true, reason: "external_service" }],
  ])("applies search hygiene to eligibility (env %j)", async (env, expected) => {
    const recordEligibility = vi.fn(() => 1);
    const fetchImpl = vi.fn(async () => Response.json({ directive_id: null }));
    const result = await handlePromptEligibility(
      { prompt: STOPPED_PROMPT, conversation_id: "cursor-hygiene" },
      {
        env,
        recordEligibility,
        recordPreferences: vi.fn(async () => 0),
        recordHealth: vi.fn(),
        recordDirective: vi.fn(),
        fetchImpl,
      },
    );
    expect(result).toMatchObject(expected);
    expect(recordEligibility).toHaveBeenCalledTimes(expected.eligible ? 1 : 0);
  });

  it.each(ORDINARY_HUMAN_PROMPTS)(
    "keeps an ordinary Cursor prompt the user's: %s",
    async (prompt) => {
      const recordEligibility = vi.fn(() => 1);
      const recordPreferences = vi.fn(async () => 0);
      const result = await handlePromptEligibility(
        { prompt, conversation_id: "cursor-human" },
        {
          env: {},
          recordEligibility,
          recordPreferences,
          recordHealth: vi.fn(),
          recordDirective: vi.fn(),
          fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
        },
      );
      expect(result).toMatchObject({ eligible: true });
      expect(recordEligibility).toHaveBeenCalledOnce();
      expect(recordPreferences).toHaveBeenCalledWith(
        prompt,
        expect.objectContaining({ runtime: "cursor" }),
      );
    },
  );

  it("records explicit reusable work without changing the prompt", async () => {
    const recordEligibility = vi.fn(() => 1);
    const recordPreferences = vi.fn(async () => 0);
    const recordHealth = vi.fn();
    const result = await handlePromptEligibility(
      {
        prompt: "Fix the responsive review-card workflow and run Playwright.",
        conversation_id: "conv-explicit",
      },
      {
        env: {},
        recordEligibility,
        recordPreferences,
        recordHealth,
        recordDirective: vi.fn(),
        fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "tool_or_framework",
      sessionId: "conv-explicit",
    });
    expect(recordEligibility).toHaveBeenCalledWith("conv-explicit", {});
    expect(recordPreferences).toHaveBeenCalledWith(
      "Fix the responsive review-card workflow and run Playwright.",
      expect.objectContaining({ runtime: "cursor" }),
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "cursor", component: "prompt_hook" }),
      {},
    );
  });

  it("captures an explicit preference even when the prompt does not trigger retrieval", async () => {
    const recordPreferences = vi.fn(async () => 1);
    const result = await handlePromptEligibility(
      {
        prompt: "For this project, keep explanations concise.",
        workspace_roots: ["/private/workspace"],
      },
      {
        env: {},
        recordPreferences,
        recordHealth: vi.fn(),
      },
    );

    expect(result).toMatchObject({ eligible: false });
    expect(recordPreferences).toHaveBeenCalledWith(
      "For this project, keep explanations concise.",
      expect.objectContaining({
        runtime: "cursor",
        projectPath: "/private/workspace",
      }),
    );
  });

  it("records a user correction immediately without a query or directive request", async () => {
    const recordEligibility = vi.fn();
    const fetchImpl = vi.fn();
    const result = await handlePromptEligibility(
      {
        prompt: "That completed approach is overkill; keep the fix focused.",
        session_id: "cursor-correction",
      },
      {
        env: {},
        fetchImpl,
        recordEligibility,
        recordHealth: vi.fn(),
        recordPreferences: vi.fn(async () => 0),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "user_correction",
      directive_id: null,
    });
    expect(recordEligibility).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records context-dependent follow-ups so Stop can recover a missed query", async () => {
    const recordEligibility = vi.fn(() => 1);
    const result = await handlePromptEligibility(
      { userPrompt: "fix these issues", session_id: "session-followup" },
      {
        env: {},
        recordEligibility,
        recordDirective: vi.fn(),
        fetchImpl: vi.fn(async () => Response.json({ recorded: true })),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "contextual_continuation",
      sessionId: "session-followup",
    });
    expect(recordEligibility).toHaveBeenCalledOnce();
  });

  it("uses the production eligibility, directive, and fetch defaults safely", async () => {
    const usageDir = await mkdtemp(join(tmpdir(), "cursor-preference-hook-"));
    tempDirs.push(usageDir);
    const fetchImpl = vi.fn(async () =>
      Response.json({
        directive_id: "dir_cursor_default",
        runtime: "cursor",
        trigger_reason: "tool_or_framework",
        shown_at: new Date().toISOString(),
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const result = await handlePromptEligibility(
      {
        prompt: "Review this responsive Cursor plugin workflow.",
        conversation_id: "cursor-defaults",
      },
      {
        env: { REMEMBRANCE_USAGE_DIR: usageDir },
        recordHealth: vi.fn(),
        recordPreferences: vi.fn(async () => 0),
      },
    );

    expect(result).toMatchObject({
      eligible: true,
      sessionId: "cursor-defaults",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("skips one-off facts and honors the disable flag", async () => {
    const recordEligibility = vi.fn();
    expect(
      await handlePromptEligibility(
        { prompt: "What is the capital of France?" },
        { env: {}, recordEligibility },
      ),
    ).toMatchObject({ eligible: false });
    expect(
      await handlePromptEligibility(
        { prompt: "Set up Vercel", session_id: "disabled" },
        { env: { REMEMBRANCE_AUTO_QUERY: "0" }, recordEligibility },
      ),
    ).toEqual({ eligible: false, reason: "disabled" });
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it("reads the documented prompt field variants", () => {
    expect(promptFromCursorInput({ prompt: "a" })).toBe("a");
    expect(promptFromCursorInput({ user_prompt: "b" })).toBe("b");
    expect(promptFromCursorInput({ userPrompt: "c" })).toBe("c");
    expect(promptFromCursorInput({ input: { prompt: "d" } })).toBe("d");
    expect(promptFromCursorInput({ message: "e" })).toBe("e");
    expect(promptFromCursorInput({})).toBe("");
  });

  it("uses the process environment when a caller does not inject one", async () => {
    const result = await handlePromptEligibility(
      { prompt: "What is the capital of France?" },
      {
        recordHealth: vi.fn(),
        recordPreferences: vi.fn(async () => 0),
      },
    );
    expect(result).toMatchObject({ eligible: false });
  });
});
