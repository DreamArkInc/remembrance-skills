import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handlePrePrompt } from "../src/index.mjs";
import {
  readCompletionObligations,
  readDirectiveSurface,
  readRegistryUseCount,
  readTaskEligibilityCount,
  recordDirectiveSurface,
  userCorrectionCaptureDirective,
} from "../src/hook-core.mjs";
import {
  ANONYMOUS_ACCESS,
  registry,
} from "../../codex-plugin/test/fixtures/search-hygiene.mjs";
import {
  EMPTY_QUERY_ID,
  KEYWORDS_ONLY,
  KEYWORD_PROMPT,
  TASK_SHAPE_CORRECTION,
  TASK_SHAPE_PROMPT,
  emptyBody,
} from "../../codex-plugin/test/fixtures/task-shape.mjs";

// Owner decision 34C: an empty task-shape search appends nothing of its own,
// makes no completion eligibility and owes no query feedback; like any
// completed search it ends an earlier continuation directive.

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-openclaw-task-shape-"));
let counter = 0;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv(extra = {}) {
  counter += 1;
  const root = join(tempRoot, `run-${counter}`);
  return {
    REMEMBRANCE_API_URL: "https://remembrance.dev",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    REMEMBRANCE_AGENT_KEY_PATH: join(root, "agent-key.json"),
    REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(root, "sessions"),
    REMEMBRANCE_HEALTH_REPORTING: "0",
    ...extra,
  };
}

// Each prompt is its own OpenClaw session here: usage, eligibility and debts
// are the session's (ctx.sessionId), directives the run's (ctx.runId).
const event = (prompt, runId) => ({
  prompt,
  context: { sessionId: `s-${runId}`, runId },
});

const earlierDirective = () => ({
  directive_id: `dir_${"a1".repeat(16)}`,
  runtime: "openclaw",
  trigger_reason: "contextual_continuation",
  shown_at: new Date().toISOString(),
});

describe("OpenClaw pre-prompt hook with the task-shape default", () => {
  it("appends nothing for an empty task-shape search, owes no feedback, and still ends an earlier directive", async () => {
    const env = testEnv();
    for (const runId of ["r-keyword", "r-shape"]) {
      recordDirectiveSurface(runId, earlierDirective(), env);
      expect(readDirectiveSurface(runId, env)).not.toBeNull();
    }
    const keywordRegistry = registry({ query: emptyBody(ANONYMOUS_ACCESS, []) });
    const shapeRegistry = registry({ query: emptyBody(ANONYMOUS_ACCESS, []) });
    const keyword = await handlePrePrompt(event(KEYWORD_PROMPT, "r-keyword"), {
      env,
      fetchImpl: keywordRegistry.fetchImpl,
      recordHealth: vi.fn(),
    });
    const shaped = await handlePrePrompt(event(TASK_SHAPE_PROMPT, "r-shape"), {
      env,
      fetchImpl: shapeRegistry.fetchImpl,
      recordHealth: vi.fn(),
    });

    expect(keywordRegistry.queries()).toHaveLength(1);
    expect(shapeRegistry.queries()).toHaveLength(1);
    expect(shapeRegistry.queries()[0].body.client_context.trigger_reason).toBe(
      "task_shape",
    );
    expect(keyword.appendSystemContext).toContain("No matching skill/resource.");
    expect(shaped).toBeUndefined();
    expect(readTaskEligibilityCount("s-r-keyword", env)).toBe(1);
    expect(readTaskEligibilityCount("s-r-shape", env)).toBe(0);
    expect(readCompletionObligations("s-r-keyword", env)).toEqual([
      expect.objectContaining({ kind: "query_feedback", query_id: EMPTY_QUERY_ID }),
    ]);
    expect(readCompletionObligations("s-r-shape", env)).toEqual([]);
    expect(readRegistryUseCount("s-r-shape", env)).toBe(0);
    expect(readDirectiveSurface("r-keyword", env)).toBeNull();
    expect(readDirectiveSurface("r-shape", env)).toBeNull();
  });

  it("appends only a correction's capture and records its eligibility", async () => {
    const env = testEnv();
    const result = await handlePrePrompt(
      event(TASK_SHAPE_CORRECTION, "r-correction"),
      {
        env,
        fetchImpl: registry({ query: emptyBody(ANONYMOUS_ACCESS, []) }).fetchImpl,
        recordHealth: vi.fn(),
      },
    );
    const context = result.appendSystemContext;
    expect(context.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(context).toContain(
      userCorrectionCaptureDirective(TASK_SHAPE_CORRECTION, env).split("\n")[0],
    );
    expect(context).not.toMatch(/^Trigger: |No matching skill\/resource|^Query receipt: /mu);
    expect(readTaskEligibilityCount("s-r-correction", env)).toBe(1);
    expect(readCompletionObligations("s-r-correction", env)).toEqual([]);
  });

  it("searches nothing for the same prompt with the switch off", async () => {
    const searched = registry({ query: emptyBody(ANONYMOUS_ACCESS, []) });
    const result = await handlePrePrompt(event(TASK_SHAPE_PROMPT, "r-off"), {
      env: testEnv(KEYWORDS_ONLY),
      fetchImpl: searched.fetchImpl,
      recordHealth: vi.fn(),
    });
    expect(result).toBeUndefined();
    expect(searched.fetchImpl).not.toHaveBeenCalled();
  });
});
