import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handlePromptEligibility } from "../scripts/record-task-eligibility.mjs";
import {
  promptContainsUserCorrection,
  shouldQueryPrompt,
} from "../scripts/hook-core.mjs";
import {
  KEYWORDS_ONLY,
  KEYWORD_PROMPT,
  TASK_SHAPE_CORRECTION,
  TASK_SHAPE_PROMPT,
} from "../../codex-plugin/test/fixtures/task-shape.mjs";

// Cursor's hook never searches, so it cannot tell an empty task-shape search
// from a useful one; its always-apply rule is its task-shaped path. It keeps
// deciding eligibility on the keyword triggers alone (owner decision 34C,
// coordinator 2026-09-29): exactly as before the task-shape default.

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../codex-plugin/test/fixtures/trigger-gap-benchmark.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

let usageDir;
beforeAll(async () => {
  usageDir = await mkdtemp(join(tmpdir(), "cursor-task-shape-"));
});
afterAll(async () => {
  await rm(usageDir, { recursive: true, force: true });
});

async function observe(prompt, extraEnv = {}) {
  const recordEligibility = vi.fn();
  const recordDirective = vi.fn();
  const fetchImpl = vi.fn(async () => Response.json({ recorded: true }));
  const result = await handlePromptEligibility(
    { prompt, conversation_id: "cursor-task-shape" },
    {
      env: { REMEMBRANCE_USAGE_DIR: usageDir, ...extraEnv },
      recordEligibility,
      recordDirective,
      fetchImpl,
      recordHealth: vi.fn(),
      recordPreferences: vi.fn(async () => 0),
      recordUserPrompt: vi.fn(),
    },
  );
  return {
    decision: { eligible: result.eligible, reason: result.reason },
    eligibility: recordEligibility.mock.calls.length,
    directiveRequests: fetchImpl.mock.calls.length,
    directives: recordDirective.mock.calls.length,
  };
}

describe("Cursor eligibility with the task-shape default", () => {
  it("decides every 40+ character benchmark prompt as the keyword triggers alone do", async () => {
    let taskShaped = 0;
    for (const query of fixture.queries) {
      expect(query.summary.trim().length, query.id).toBeGreaterThanOrEqual(40);
      const observed = await observe(query.summary);
      expect(observed, query.id).toEqual(await observe(query.summary, KEYWORDS_ONLY));
      if (shouldQueryPrompt(query.summary, {}).reason !== "task_shape") continue;
      taskShaped += 1;
      // No directive for a task-shaped prompt; only a correction in it makes
      // the turn eligible, as before the default.
      const correction = promptContainsUserCorrection(query.summary);
      expect(observed, query.id).toEqual({
        decision: correction
          ? { eligible: true, reason: "user_correction" }
          : { eligible: false, reason: "no_trigger_match" },
        eligibility: correction ? 1 : 0,
        directiveRequests: 0,
        directives: 0,
      });
    }
    expect(taskShaped).toBe(45);
  });

  it("records nothing for a task-shaped prompt, and a correction or keyword prompt as before", async () => {
    expect(await observe(TASK_SHAPE_PROMPT)).toEqual({
      decision: { eligible: false, reason: "no_trigger_match" },
      eligibility: 0,
      directiveRequests: 0,
      directives: 0,
    });
    expect(await observe(TASK_SHAPE_CORRECTION)).toEqual({
      decision: { eligible: true, reason: "user_correction" },
      eligibility: 1,
      directiveRequests: 0,
      directives: 0,
    });
    expect(await observe(KEYWORD_PROMPT)).toEqual({
      decision: { eligible: true, reason: "ui_or_dashboard_work" },
      eligibility: 1,
      directiveRequests: 1,
      directives: 1,
    });
  });
});
