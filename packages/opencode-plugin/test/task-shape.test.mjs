import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Remembrance } from "../src/index.mjs";
import {
  readCompletionObligations,
  readDirectiveSurface,
  readRegistryUseCount,
  readTaskEligibilityCount,
} from "../scripts/hook-core.mjs";
import { ANONYMOUS_ACCESS } from "../../codex-plugin/test/fixtures/search-hygiene.mjs";
import {
  EMPTY_QUERY_ID,
  KEYWORD_PROMPT,
  TASK_SHAPE_CORRECTION,
  TASK_SHAPE_PROMPT,
  emptyBody,
} from "../../codex-plugin/test/fixtures/task-shape.mjs";

// Owner decision 34C: an empty task-shape search delivers nothing of its
// own, makes no completion eligibility and owes no query feedback; like any
// completed search it ends an earlier continuation directive. The adapter
// reads process.env, so these tests swap real keys and restore them.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-opencode-task-shape-"));
const saved = {};
const MANAGED = [
  "REMEMBRANCE_API_URL",
  "REMEMBRANCE_API_KEY",
  "REMEMBRANCE_USAGE_DIR",
  "REMEMBRANCE_HOOK_CACHE_PATH",
  "REMEMBRANCE_AGENT_KEY_PATH",
  "REMEMBRANCE_PRINCIPAL_SESSION_DIR",
  "REMEMBRANCE_AUTO_QUERY",
  "REMEMBRANCE_AUTO_QUERY_TASK_SHAPE",
  "REMEMBRANCE_AUTO_CONTRIBUTE",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
];
let counter = 0;

beforeEach(() => {
  counter += 1;
  for (const key of MANAGED) saved[key] = process.env[key];
  process.env.REMEMBRANCE_API_URL = "https://remembrance.dev";
  process.env.XDG_STATE_HOME = join(tempRoot, `state-${counter}`);
  process.env.XDG_CONFIG_HOME = join(tempRoot, `config-${counter}`);
  process.env.REMEMBRANCE_USAGE_DIR = join(tempRoot, `usage-${counter}`);
  process.env.REMEMBRANCE_HOOK_CACHE_PATH = join(tempRoot, `cache-${counter}.json`);
  process.env.REMEMBRANCE_AGENT_KEY_PATH = join(tempRoot, `agent-key-${counter}.json`);
  process.env.REMEMBRANCE_PRINCIPAL_SESSION_DIR = join(
    tempRoot,
    `principal-sessions-${counter}`,
  );
  delete process.env.REMEMBRANCE_API_KEY;
  delete process.env.REMEMBRANCE_AUTO_QUERY;
  delete process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE;
  delete process.env.REMEMBRANCE_AUTO_CONTRIBUTE;
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const client = { app: { log: async () => {} } };

// Answers every query with an empty result and every directive event with a
// receipt; returns the query bodies.
function stubEmptyRegistry() {
  const queries = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/api/v1/agent/query")) {
      queries.push(JSON.parse(String(init.body)));
      return Response.json(emptyBody(ANONYMOUS_ACCESS, []));
    }
    return Response.json({ recorded: true }, { status: 201 });
  });
  return queries;
}

async function emitUserMessage(hooks, prompt, sessionID, messageID) {
  await hooks["chat.message"](
    { messageID, sessionID },
    {
      message: { id: messageID, role: "user", sessionID },
      parts: [{ type: "text", messageID, sessionID, text: prompt }],
    },
  );
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, output);
  return output.system;
}

// A delivered continuation directive, then `prompt` in the same session.
async function afterContinuation(prompt, sessionID) {
  const queries = stubEmptyRegistry();
  const hooks = await Remembrance({ client });
  await emitUserMessage(hooks, "fix these issues", sessionID, `${sessionID}-1`);
  expect(readDirectiveSurface(sessionID, process.env)).not.toBeNull();
  expect(readTaskEligibilityCount(sessionID, process.env)).toBe(1);
  const system = await emitUserMessage(hooks, prompt, sessionID, `${sessionID}-2`);
  return { queries, system };
}

describe("opencode prompt hook with the task-shape default", () => {
  it("delivers nothing for an empty task-shape search, owes no feedback, and still ends an earlier directive", async () => {
    const sessionID = "s-task-shape-empty";
    const { queries, system } = await afterContinuation(TASK_SHAPE_PROMPT, sessionID);
    expect(queries).toHaveLength(1);
    expect(queries[0].client_context.trigger_reason).toBe("task_shape");
    expect(system).toEqual([]);
    expect(readDirectiveSurface(sessionID, process.env)).toBeNull();
    expect(readCompletionObligations(sessionID, process.env)).toEqual([]);
    expect(readTaskEligibilityCount(sessionID, process.env)).toBe(1);
    expect(readRegistryUseCount(sessionID, process.env)).toBe(0);
  });

  it("keeps an empty keyword search's block, eligibility and obligation", async () => {
    const sessionID = "s-keyword-empty";
    const { queries, system } = await afterContinuation(KEYWORD_PROMPT, sessionID);
    expect(queries).toHaveLength(1);
    expect(system.join("\n")).toContain("No matching skill/resource.");
    expect(readDirectiveSurface(sessionID, process.env)).toBeNull();
    expect(readCompletionObligations(sessionID, process.env)).toEqual([
      expect.objectContaining({ kind: "query_feedback", query_id: EMPTY_QUERY_ID }),
    ]);
    expect(readTaskEligibilityCount(sessionID, process.env)).toBe(2);
  });

  it("delivers only a correction's capture and records its eligibility", async () => {
    const queries = stubEmptyRegistry();
    const hooks = await Remembrance({ client });
    const sessionID = "s-task-shape-correction";
    const system = await emitUserMessage(
      hooks,
      TASK_SHAPE_CORRECTION,
      sessionID,
      `${sessionID}-1`,
    );
    expect(queries).toHaveLength(1);
    const context = system.join("\n");
    expect(context.split("\n")[0]).toBe("Remembrance auto-query context:");
    expect(context).toContain("Remembrance user-correction capture");
    expect(context).not.toMatch(/^Trigger: |No matching skill\/resource|^Query receipt: /mu);
    expect(readTaskEligibilityCount(sessionID, process.env)).toBe(1);
    expect(readCompletionObligations(sessionID, process.env)).toEqual([]);
  });

  it("searches nothing with the switch off", async () => {
    process.env.REMEMBRANCE_AUTO_QUERY_TASK_SHAPE = "0";
    const queries = stubEmptyRegistry();
    const hooks = await Remembrance({ client });
    const system = await emitUserMessage(hooks, TASK_SHAPE_PROMPT, "s-off", "s-off-1");
    expect(queries).toEqual([]);
    expect(system).toEqual([]);
  });
});
