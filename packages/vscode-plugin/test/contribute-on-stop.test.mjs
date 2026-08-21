import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  countRegistryConsumption,
  decideContribution,
  handleStopHook,
  sessionUsedRemembrance,
} from "../scripts/contribute-on-stop.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-vscode-stop-"));
let counter = 0;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv(env = {}) {
  counter += 1;
  return {
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(tempRoot, `cache-${counter}.json`),
    REMEMBRANCE_USAGE_DIR: resolve(tempRoot, `usage-${counter}`),
    ...env,
  };
}

describe("VS Code completion hook", () => {
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
    expect(String(result.output.reason ?? "")).toContain(
      "provide the task's normal user-facing final answer",
    );
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

  it("routes organization lessons through local prepare and the exact visible submit action", async () => {
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
    expect(reason).toContain("prepare_private_lesson_candidate");
    expect(reason).toContain("submit_private_lesson_candidate");
    expect(reason).toContain(
      "do not substitute submit_remembrance, REST, or another transport",
    );
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

  it("counts only consumption, not the agent's own submissions", () => {
    // Mirrors the Claude/Codex rule: a session that only submitted should not be
    // re-prompted to submit again.
    const consumed = countRegistryConsumption(
      [
        { tool_name: "mcp__remembrance__query_skills" },
        { tool_name: "mcp__remembrance__get_skill" },
        { tool_name: "mcp__remembrance__submit_feedback" },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect(consumed).toBeGreaterThan(0);
    const submittedOnly = countRegistryConsumption(
      JSON.stringify({ tool_name: "mcp__remembrance__submit_remembrance" }),
    );
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
});
