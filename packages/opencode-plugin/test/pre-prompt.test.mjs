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
  readDirectiveSurface,
  readHighMatchSurface,
  readRegistryUseCount,
  readValueEpisodeSurfaces,
} from "../scripts/hook-core.mjs";

// The opencode adapter reads process.env directly (that is how the host passes
// configuration to an in-process plugin), so these tests swap real env keys and
// restore them rather than injecting an env object.
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-opencode-prompt-"));
const saved = {};
const MANAGED = [
  "REMEMBRANCE_API_URL",
  "REMEMBRANCE_API_KEY",
  "REMEMBRANCE_USAGE_DIR",
  "REMEMBRANCE_HOOK_CACHE_PATH",
  "REMEMBRANCE_AGENT_KEY_PATH",
  "REMEMBRANCE_PRINCIPAL_SESSION_DIR",
  "REMEMBRANCE_AUTO_QUERY",
  "REMEMBRANCE_AUTO_CONTRIBUTE",
];
let counter = 0;

beforeEach(() => {
  counter += 1;
  for (const key of MANAGED) saved[key] = process.env[key];
  process.env.REMEMBRANCE_API_URL = "https://remembrance.dev";
  process.env.REMEMBRANCE_USAGE_DIR = join(tempRoot, `usage-${counter}`);
  process.env.REMEMBRANCE_HOOK_CACHE_PATH = join(
    tempRoot,
    `cache-${counter}.json`,
  );
  process.env.REMEMBRANCE_AGENT_KEY_PATH = join(
    tempRoot,
    `agent-key-${counter}.json`,
  );
  process.env.REMEMBRANCE_PRINCIPAL_SESSION_DIR = join(
    tempRoot,
    `principal-sessions-${counter}`,
  );
  delete process.env.REMEMBRANCE_AUTO_QUERY;
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

function stubQuery(
  calls,
  skills = [{ slug: "vercel-build-debug" }],
  response = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/api/v1/agent/query")) {
      calls.push({
        url: String(url),
        headers: init?.headers,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
    }
    return Response.json({
      ...response,
      skills: skills.map((s) => ({
        description: "Debug Vercel build failures.",
        trust_tier: "tofu_verified",
        verified_uses: 7,
        total_uses: 9,
        ...s,
      })),
      resources: response.resources ?? [],
    });
  });
}

function stubCorrelatedQuery(calls, suffix) {
  return stubQuery(
    calls,
    [
      {
        slug: "vercel-build-debug",
        result_id: `qres_${suffix}`,
        match_tier: "high",
        match_reason: "Exact deployment failure workflow",
        risk_level: "low",
        task_outcome_eligible: true,
      },
    ],
    {
      query_id: `rq_${suffix}`,
      task_outcome: {
        available: true,
        eligible_result_ids: [`qres_${suffix}`],
      },
    },
  );
}

const TRIGGER_PROMPT = "Fix this Vercel Next.js build error in GitHub Actions.";

async function emitUserMessage(
  hooks,
  prompt,
  sessionID = "s-prompt",
  messageID = `msg-${sessionID}`,
) {
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

describe("opencode prompt context injection", () => {
  it("queries Remembrance and injects matched guidance before model dispatch", async () => {
    const calls = [];
    stubQuery(calls);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    const system = await emitUserMessage(hooks, TRIGGER_PROMPT);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://remembrance.dev/api/v1/agent/query");
    expect(system.join("\n")).toContain("vercel-build-debug");
    expect(messages.map((m) => m.message).join("\n")).not.toContain(
      "vercel-build-debug",
    );
    expect(messages.every((m) => m.service === "remembrance")).toBe(true);
  });

  it("attributes the query to opencode, not to the codex core default", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitUserMessage(hooks, TRIGGER_PROMPT);

    expect(calls[0].body).toMatchObject({
      agent: { provider: "opencode", model: "opencode" },
    });
    expect(calls[0].body.client_context?.runtime).toBe("opencode");
    expect(calls[0].headers).toMatchObject({
      "user-agent": expect.stringMatching(
        /^@remembrance-ai\/opencode-plugin\/\d+\.\d+\.\d+$/,
      ),
    });
  });

  it("queries once per user message even when the host re-fires the event", async () => {
    // The host can re-fire metadata and part events. The message id is the
    // stable dedupe boundary.
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitUserMessage(hooks, TRIGGER_PROMPT);
    await emitUserMessage(hooks, TRIGGER_PROMPT);
    await emitUserMessage(hooks, TRIGGER_PROMPT);

    expect(calls).toHaveLength(1);
  });

  it("releases message dedupe and pending state when a session is deleted", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitUserMessage(hooks, TRIGGER_PROMPT, "s-clean", "msg-reused");
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "s-clean" },
      },
    });
    await emitUserMessage(hooks, TRIGGER_PROMPT, "s-clean", "msg-reused");

    expect(calls).toHaveLength(2);

    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "pending-cleanup",
            sessionID: "s-pending",
            text: TRIGGER_PROMPT,
          },
        },
      },
    });
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "s-pending" },
      },
    });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "pending-cleanup",
            sessionID: "s-pending",
            role: "user",
          },
        },
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("treats a different session as a different message", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitUserMessage(hooks, TRIGGER_PROMPT, "s-a");
    await emitUserMessage(hooks, TRIGGER_PROMPT, "s-b");

    expect(calls).toHaveLength(2);
  });

  it("does not query for an assistant message or an unreadable payload", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "assistant", sessionID: "s", role: "assistant" },
        },
      },
    });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "user-no-part", sessionID: "s", role: "user" },
        },
      },
    });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "assistant",
            sessionID: "s",
            text: TRIGGER_PROMPT,
          },
        },
      },
    });

    expect(calls).toHaveLength(0);
  });

  it("does not query for a generic one-off fact prompt", async () => {
    const calls = [];
    stubQuery(calls);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    const system = await emitUserMessage(hooks, "What time is it?");

    expect(calls).toHaveLength(0);
    expect(system).toEqual([]);
    expect(messages).toHaveLength(0);
  });

  it("honours REMEMBRANCE_AUTO_QUERY=0", async () => {
    process.env.REMEMBRANCE_AUTO_QUERY = "0";
    const calls = [];
    stubQuery(calls);
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    const system = await emitUserMessage(hooks, TRIGGER_PROMPT);

    expect(calls).toHaveLength(0);
    expect(system).toEqual([]);
    expect(messages).toHaveLength(0);
  });

  it("redacts secrets before the prompt leaves the machine", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });

    await emitUserMessage(
      hooks,
      "Deploy to Vercel with token sk-ABCDEF1234567890ABCDEF and host https://internal.corp.example/x",
    );

    expect(calls).toHaveLength(1);
    const wire = JSON.stringify(calls[0].body);
    expect(wire).not.toContain("sk-ABCDEF1234567890ABCDEF");
    expect(wire).not.toContain("internal.corp.example");
  });

  it("fails open and stays silent when the query errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    process.env.REMEMBRANCE_API_KEY = "rk_never_print";
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });

    const system = await emitUserMessage(hooks, TRIGGER_PROMPT);
    expect(system.join("\n")).toContain("query-unavailable");
    expect(JSON.stringify(messages)).not.toContain("rk_never_print");
    expect(JSON.stringify(system)).not.toContain("rk_never_print");
  });

  it("never lets a host logging failure escape the hook", async () => {
    const calls = [];
    stubQuery(calls);
    const exploding = {
      app: {
        log: async () => {
          throw new Error("host is gone");
        },
      },
    };
    const hooks = await Remembrance({ client: exploding });

    await expect(emitUserMessage(hooks, TRIGGER_PROMPT)).resolves.toEqual([
      expect.stringContaining("vercel-build-debug"),
    ]);
  });

  it("keeps legacy out-of-order events as a deduplicated fallback", async () => {
    const calls = [];
    stubQuery(calls);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            messageID: "msg-out-of-order",
            sessionID: "s-out-of-order",
            text: TRIGGER_PROMPT,
          },
        },
      },
    });
    expect(calls).toHaveLength(0);
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-out-of-order",
            sessionID: "s-out-of-order",
            role: "user",
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "s-out-of-order" },
      output,
    );
    expect(output.system.join("\n")).toContain("vercel-build-debug");
  });

  it("does not count an empty query as a selected registry result", async () => {
    const calls = [];
    stubQuery(calls, []);
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const system = await emitUserMessage(hooks, TRIGGER_PROMPT, "s-empty");

    expect(calls).toHaveLength(1);
    expect(system.join("\n")).toContain("returned no matching skill");
    expect(readRegistryUseCount("s-empty", process.env)).toBe(0);
  });

  // Registry use must be recorded on DELIVERY, not on query. This host injects
  // through `experimental.chat.system.transform` — a separate later callback on
  // an unstable host API. If use were counted at query time, a host that stopped
  // calling that hook would keep reporting consumption and keep firing the
  // completion nudge while the model saw nothing at all.
  it("counts registry use only after the guidance reaches the model", async () => {
    const calls = [];
    stubCorrelatedQuery(calls, "delivery");
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const sessionID = "s-delivery-order";
    const messageID = `msg-${sessionID}`;

    await hooks["chat.message"](
      { messageID, sessionID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [{ type: "text", messageID, sessionID, text: TRIGGER_PROMPT }],
      },
    );

    // Query has completed and matched, but nothing has been delivered yet.
    expect(calls).toHaveLength(1);
    expect(readRegistryUseCount(sessionID, process.env)).toBe(0);
    expect(readHighMatchSurface(sessionID, process.env)).toBeNull();
    expect(readValueEpisodeSurfaces(sessionID, process.env)).toEqual([]);

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, output);

    expect(output.system.join("\n")).toContain("vercel-build-debug");
    expect(readRegistryUseCount(sessionID, process.env)).toBe(1);
    expect(readHighMatchSurface(sessionID, process.env)).toMatchObject({
      query_id: "rq_delivery",
      result_id: "qres_delivery",
      slug: "vercel-build-debug",
    });
    expect(readValueEpisodeSurfaces(sessionID, process.env)).toEqual([
      expect.objectContaining({
        query_id: "rq_delivery",
        candidates: [
          expect.objectContaining({
            result_id: "qres_delivery",
          }),
        ],
      }),
    ]);
  });

  it("records no registry use when the host never calls the transform hook", async () => {
    // The failure this guards: opencode renames or drops the experimental hook.
    // Delivery silently stops; the telemetry must stop too rather than assert
    // value that was never delivered.
    const calls = [];
    stubCorrelatedQuery(calls, "never_delivered");
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const sessionID = "s-never-delivered";
    const messageID = `msg-${sessionID}`;

    await hooks["chat.message"](
      { messageID, sessionID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [{ type: "text", messageID, sessionID, text: TRIGGER_PROMPT }],
      },
    );

    expect(calls).toHaveLength(1);
    expect(readRegistryUseCount(sessionID, process.env)).toBe(0);
    expect(readHighMatchSurface(sessionID, process.env)).toBeNull();
    expect(readValueEpisodeSurfaces(sessionID, process.env)).toEqual([]);
  });

  it("does not double-count when the host calls the transform twice", async () => {
    const calls = [];
    stubCorrelatedQuery(calls, "double_transform");
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const sessionID = "s-double-transform";

    await emitUserMessage(hooks, TRIGGER_PROMPT, sessionID);
    const second = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, second);

    // The pending entry is consumed on first delivery, so a repeated transform
    // injects nothing more and cannot inflate the counter.
    expect(second.system).toHaveLength(0);
    expect(readRegistryUseCount(sessionID, process.env)).toBe(1);
    expect(readHighMatchSurface(sessionID, process.env)).toMatchObject({
      query_id: "rq_double_transform",
      result_id: "qres_double_transform",
    });
    expect(readValueEpisodeSurfaces(sessionID, process.env)).toHaveLength(1);
  });

  it("records a continuation directive only after its guidance is delivered", async () => {
    const calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ recorded: true }, { status: 201 });
    });
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const sessionID = "s-continuation-delivery";
    const messageID = `msg-${sessionID}`;

    await hooks["chat.message"](
      { messageID, sessionID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [
          {
            type: "text",
            messageID,
            sessionID,
            text: "fix these issues",
          },
        ],
      },
    );

    expect(calls).toEqual([]);
    expect(readDirectiveSurface(sessionID, process.env)).toBeNull();

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, output);

    expect(output.system.join("\n")).toContain("task-continuation reminder");
    expect(calls).toEqual([
      expect.objectContaining({
        url: "https://remembrance.dev/api/v1/agent/directive-events",
        body: expect.objectContaining({
          event: "shown",
          runtime: "opencode",
          surface: "plugin_hook",
        }),
      }),
    ]);
    const deliveredDirective = readDirectiveSurface(sessionID, process.env);
    expect(deliveredDirective).toMatchObject({
      directive_id: expect.stringMatching(/^dir_/),
      runtime: "opencode",
      trigger_reason: "contextual_continuation",
    });

    const repeated = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, repeated);
    expect(repeated.system).toEqual([]);
    expect(calls).toHaveLength(1);

    await hooks["tool.execute.after"](
      { tool: "query_skills", sessionID },
      {
        body: {
          query_id: "rq_continuation_followed",
          skills: [],
          resources: [],
        },
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      url: "https://remembrance.dev/api/v1/agent/directive-events",
      body: {
        event: "followed",
        directive_id: deliveredDirective.directive_id,
        query_id: "rq_continuation_followed",
      },
    });
    expect(readDirectiveSurface(sessionID, process.env)).toBeNull();
  });

  it("still delivers continuation guidance when shown telemetry is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("simulated directive telemetry outage"),
    );
    const { client } = loggingClient();
    const hooks = await Remembrance({ client });
    const sessionID = "s-continuation-fail-open";
    const messageID = `msg-${sessionID}`;

    await hooks["chat.message"](
      { messageID, sessionID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [
          {
            type: "text",
            messageID,
            sessionID,
            text: "fix these issues",
          },
        ],
      },
    );
    const output = { system: [] };

    await expect(
      hooks["experimental.chat.system.transform"]({ sessionID }, output),
    ).resolves.toBeUndefined();

    expect(output.system.join("\n")).toContain("task-continuation reminder");
    expect(readDirectiveSurface(sessionID, process.env)).toMatchObject({
      directive_id: expect.stringMatching(/^dir_/),
      runtime: "opencode",
    });
  });
});
