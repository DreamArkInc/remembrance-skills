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
  HOST_POLICY_ALERT_TEXT,
  readPluginLifecycleHealth,
  readValueEpisodeSurfaces,
  readRegistryUseCount,
  recordRegistryUse,
  recordTaskEligibility,
  recordValueEpisodeSurface,
} from "../scripts/hook-core.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-opencode-idle-"));
const saved = {};
const MANAGED = [
  "REMEMBRANCE_API_KEY",
  "REMEMBRANCE_API_URL",
  "REMEMBRANCE_USAGE_DIR",
  "REMEMBRANCE_HOOK_CACHE_PATH",
  "REMEMBRANCE_AUTO_CONTRIBUTE",
  "REMEMBRANCE_PLUGIN_ALERT_DIR",
  "REMEMBRANCE_PLUGIN_HEALTH_DIR",
  "REMEMBRANCE_CLIENT_UPDATE_CHECK",
  "REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
];
let counter = 0;

beforeEach(() => {
  counter += 1;
  for (const key of MANAGED) saved[key] = process.env[key];
  process.env.REMEMBRANCE_USAGE_DIR = join(tempRoot, `usage-${counter}`);
  process.env.REMEMBRANCE_HOOK_CACHE_PATH = join(
    tempRoot,
    `cache-${counter}.json`,
  );
  process.env.REMEMBRANCE_API_URL = "https://remembrance.dev";
  process.env.REMEMBRANCE_PLUGIN_ALERT_DIR = join(
    tempRoot,
    `alerts-${counter}`,
  );
  process.env.REMEMBRANCE_PLUGIN_HEALTH_DIR = join(
    tempRoot,
    `health-${counter}`,
  );
  delete process.env.REMEMBRANCE_API_KEY;
  delete process.env.REMEMBRANCE_AUTO_CONTRIBUTE;
  process.env.REMEMBRANCE_CLIENT_UPDATE_CHECK = "0";
  process.env.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN = "0";
  process.env.XDG_CONFIG_HOME = join(tempRoot, `config-${counter}`);
  process.env.XDG_STATE_HOME = join(tempRoot, `state-${counter}`);
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

function loggingClient() {
  const messages = [];
  return {
    messages,
    client: {
      app: {
        log: async ({ body }) => {
          messages.push(body);
        },
      },
    },
  };
}

function toastClient() {
  const toasts = [];
  return {
    toasts,
    client: {
      tui: {
        showToast: async ({ body }) => {
          toasts.push(body);
        },
      },
    },
  };
}

async function emitSessionIdle(hooks, sessionID) {
  await hooks.event({
    event: {
      type: "session.idle",
      properties: { sessionID },
    },
  });
}

describe("opencode completion nudge (session.idle)", () => {
  it("nudges once per engagement after Remembrance was used", async () => {
    const sessionId = "s-used";
    recordRegistryUse(sessionId, process.env);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitSessionIdle(hooks, sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0].service).toBe("remembrance");
    expect(String(messages[0].message)).toContain(
      "silently close the pending Remembrance loop",
    );
    expect(String(messages[0].message)).toContain("submit_remembrance");
    expect(String(messages[0].message).length).toBeLessThan(1_200);

    // opencode cannot ask the agent to revise, so the adapter advances the
    // prompted count itself. A second idle must therefore stay silent.
    await emitSessionIdle(hooks, sessionId);
    expect(messages).toHaveLength(1);
  });

  it("routes organization lessons through local prepare and the exact visible submit action", async () => {
    process.env.REMEMBRANCE_API_KEY = "rk_opencode_private_lesson";
    const sessionId = "s-private-lesson";
    recordRegistryUse(sessionId, process.env);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitSessionIdle(hooks, sessionId);

    expect(messages).toHaveLength(1);
    const message = String(messages[0].message);
    expect(message).toContain("prepare_private_lesson_candidate");
    expect(message).toContain("submit_private_lesson_candidate");
    expect(message).toContain(
      "do not substitute submit_remembrance, REST, or another transport",
    );
  });

  it("reports a pending value episode before completing the engagement", async () => {
    const sessionId = "s-outcome";
    recordRegistryUse(sessionId, process.env);
    recordValueEpisodeSurface(
      sessionId,
      {
        query_id: "rq_opencode_outcome",
        interaction_kind: "query",
        candidates: [
          {
            result_id: "qres_opencode_outcome",
            value_estimate_id: null,
          },
        ],
        bundles: [],
        selected_result_ids: ["qres_opencode_outcome"],
        feedback_available: true,
        created_at: new Date().toISOString(),
        reported_at: null,
      },
      process.env,
    );
    const requests = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ recorded: true }, { status: 201 });
    });
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitSessionIdle(hooks, sessionId);

    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://remembrance.dev/api/v1/agent/task-outcomes",
        body: expect.objectContaining({
          query_id: "rq_opencode_outcome",
          result_ids: ["qres_opencode_outcome"],
          measurement_source: "plugin_observed",
          status: "completed",
        }),
      }),
    ]);
    expect(readValueEpisodeSurfaces(sessionId, process.env)).toEqual([
      expect.objectContaining({
        query_id: "rq_opencode_outcome",
        reported_at: expect.any(String),
      }),
    ]);
    expect(messages).toHaveLength(1);
  });

  it("keeps completion fail-open when outcome reporting is unavailable", async () => {
    const sessionId = "s-outcome-unavailable";
    recordRegistryUse(sessionId, process.env);
    recordValueEpisodeSurface(
      sessionId,
      {
        query_id: "rq_opencode_unavailable",
        interaction_kind: "query",
        candidates: [
          {
            result_id: "qres_opencode_unavailable",
            value_estimate_id: null,
          },
        ],
        bundles: [],
        selected_result_ids: ["qres_opencode_unavailable"],
        feedback_available: true,
        created_at: new Date().toISOString(),
        reported_at: null,
      },
      process.env,
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("simulated outcome outage"),
    );
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    await expect(emitSessionIdle(hooks, sessionId)).resolves.toBeUndefined();

    expect(readValueEpisodeSurfaces(sessionId, process.env)).toEqual([
      expect.objectContaining({
        query_id: "rq_opencode_unavailable",
        reported_at: null,
      }),
    ]);
    expect(messages).toHaveLength(1);
  });

  it("stays silent when the session never used Remembrance", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await emitSessionIdle(hooks, "s-unused");
    expect(messages).toHaveLength(0);
  });

  it("honours REMEMBRANCE_AUTO_CONTRIBUTE=0", async () => {
    const sessionId = "s-disabled";
    recordRegistryUse(sessionId, process.env);
    process.env.REMEMBRANCE_AUTO_CONTRIBUTE = "0";
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await emitSessionIdle(hooks, sessionId);
    expect(messages).toHaveLength(0);
  });

  it("nudges on eligible reusable work even without a recorded use", async () => {
    // Mirrors the Claude/Codex "recovers a contextual task even when no query
    // completed" case: eligibility alone is enough to ask for a lesson.
    const sessionId = "s-eligible";
    recordTaskEligibility(sessionId, process.env);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await emitSessionIdle(hooks, sessionId);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("does not mark a trivial prompt eligible for a completion nudge", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks["chat.message"](
      { messageID: "m-trivial", sessionID: "s-trivial" },
      {
        message: {
          id: "m-trivial",
          role: "user",
          sessionID: "s-trivial",
        },
        parts: [{ type: "text", text: "What time is it?" }],
      },
    );
    await emitSessionIdle(hooks, "s-trivial");
    expect(messages).toHaveLength(0);
  });

  it("uses the host toast surface when available", async () => {
    recordRegistryUse("s-toast", process.env);
    const { client, toasts } = toastClient();
    const hooks = await Remembrance({ client });
    await emitSessionIdle(hooks, "s-toast");
    expect(toasts).toEqual([
      expect.objectContaining({
        title: "Remembrance",
        message: expect.stringMatching(/feedback|remembrance/i),
      }),
    ]);
  });

  it("fails open when the host log throws", async () => {
    recordRegistryUse("s-explode", process.env);
    const hooks = await Remembrance({
      client: {
        app: {
          log: async () => {
            throw new Error("host is gone");
          },
        },
      },
    });
    await expect(emitSessionIdle(hooks, "s-explode")).resolves.toBeUndefined();
  });

  it("resolves a missing session id to the stable fallback without throwing", async () => {
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    await expect(
      hooks.event({
        event: { type: "session.idle", properties: {} },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("opencode tool observer (tool.execute.after)", () => {
  it("alerts once for a host-policy denial and does not certify the failed tool observer", async () => {
    const { client, toasts } = toastClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "s-policy" } },
      },
    });
    await hooks["tool.execute.after"](
      {
        tool: "remembrance_propose_private_skill",
        sessionID: "s-policy",
      },
      {
        isError: true,
        error: "Blocked by workspace data-export policy: proprietary content",
      },
    );
    expect(toasts.at(-1)).toMatchObject({
      title: "Remembrance",
      message: HOST_POLICY_ALERT_TEXT,
      variant: "error",
    });
    expect(JSON.stringify(toasts)).not.toContain("proprietary content");
    expect(
      readPluginLifecycleHealth("opencode", process.env, "s-policy")
        ?.components,
    ).not.toHaveProperty("tool_observer");

    await emitSessionIdle(hooks, "s-policy");
    expect(
      toasts.filter((toast) => toast.message === HOST_POLICY_ALERT_TEXT),
    ).toHaveLength(1);
  });

  it("observes explicit permission-policy replies but ignores ordinary API denial", async () => {
    const { client, toasts } = toastClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: {
          sessionID: "s-permission",
          permission: "remembrance_propose_private_skill",
          response: "rejected",
          reason: "Denied by organization privacy policy.",
        },
      },
    });
    expect(toasts.at(-1)?.message).toBe(HOST_POLICY_ALERT_TEXT);

    await hooks["tool.execute.after"](
      { tool: "remembrance_submit_feedback", sessionID: "s-api-403" },
      { isError: true, error: "HTTP 403 Forbidden" },
    );
    expect(
      toasts.filter((toast) => toast.message === HOST_POLICY_ALERT_TEXT),
    ).toHaveLength(1);
  });
  it("correlates a matched query and ignores empty query consumption", async () => {
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    await expect(
      hooks["tool.execute.after"](
        { tool: "query_skills", sessionID: "s-tool" },
        {
          body: {
            query_id: "rq_opencode",
            skills: [
              {
                slug: "release-review",
                result_id: "qres_opencode",
                match_tier: "high",
              },
            ],
            resources: [],
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(readRegistryUseCount("s-tool", process.env)).toBe(1);

    await hooks["tool.execute.after"](
      { tool: "query_skills", sessionID: "s-empty-tool" },
      { body: { query_id: "rq_empty", skills: [], resources: [] } },
    );
    expect(readRegistryUseCount("s-empty-tool", process.env)).toBe(0);
  });

  it("records explicit invocation and closes contribution handling", async () => {
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks["tool.execute.after"](
      {
        tool: "invoke_skill",
        sessionID: "s-direct",
        args: { slug: "release-review" },
      },
      {
        body: {
          selection_mode: "explicit",
          query_id: "rinv_opencode",
          result_id: "qres_direct",
          skill: {
            slug: "release-review",
            version_id: "skv_direct",
            skill_md: "# Release review\n\nCheck the release.",
          },
          feedback: { available: true },
        },
      },
    );
    expect(readRegistryUseCount("s-direct", process.env)).toBe(1);

    await hooks["tool.execute.after"](
      { tool: "submit_remembrance", sessionID: "s-direct" },
      { body: { id: "rem_direct" } },
    );
    await emitSessionIdle(hooks, "s-direct");
    expect(readRegistryUseCount("s-direct", process.env)).toBe(1);
  });

  it("keeps the contribution reminder open when feedback requests a remembrance", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    recordRegistryUse("s-followup", process.env);
    await hooks["tool.execute.after"](
      { tool: "submit_feedback", sessionID: "s-followup" },
      {
        body: {
          next_step: {
            submit_remembrance_payload: { type: "failure_report" },
          },
        },
      },
    );
    await emitSessionIdle(hooks, "s-followup");
    expect(messages).toHaveLength(1);
  });

  it("keeps the post-use reminder open after preference compatibility feedback", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    recordRegistryUse("s-preference-feedback", process.env);
    await hooks["tool.execute.after"](
      {
        tool: "submit_preference_compatibility_feedback",
        sessionID: "s-preference-feedback",
      },
      { body: { accepted: true } },
    );
    await emitSessionIdle(hooks, "s-preference-feedback");
    expect(messages).toHaveLength(1);
  });

  it("ignores an event with no resolvable tool name", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks["tool.execute.after"]({}, {});
    expect(messages).toHaveLength(0);
  });

  it("forwards detail-tool arguments so unopened high matches can clear", async () => {
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks["tool.execute.after"](
      { tool: "query_skills", sessionID: "s-detail" },
      {
        body: {
          query_id: "rq_detail",
          skills: [
            {
              slug: "release-review",
              result_id: "qres_detail",
              match_tier: "high",
            },
          ],
          resources: [],
        },
      },
    );
    await expect(
      hooks["tool.execute.after"](
        {
          tool: "get_skill",
          sessionID: "s-detail",
          arguments: {
            slug: "release-review",
            query_id: "rq_detail",
            result_id: "qres_detail",
          },
        },
        { body: { skill: { slug: "release-review" } } },
      ),
    ).resolves.toBeUndefined();
  });
});
