import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handlePromptEligibility,
  promptFromCursorInput,
} from "../scripts/record-task-eligibility.mjs";

const tempDirs = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Cursor beforeSubmitPrompt eligibility observer", () => {
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
