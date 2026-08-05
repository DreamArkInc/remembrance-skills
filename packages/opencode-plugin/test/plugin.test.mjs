import { describe, expect, it } from "vitest";
import {
  Remembrance,
  isUserMessageEvent,
  messageIdFromEvent,
  promptFromMessageEvent,
  sessionIdFromEvent,
  toolNameFromEvent,
} from "../src/index.mjs";

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

describe("opencode payload probing", () => {
  // Published SDK fields lead; legacy spellings remain compatibility probes.
  it("reads the prompt from current and legacy host fields", () => {
    expect(
      promptFromMessageEvent(
        {},
        { properties: { part: { type: "text", text: "sdk" } } },
      ),
    ).toBe("sdk");
    expect(promptFromMessageEvent({}, { message: { content: "a" } })).toBe("a");
    expect(promptFromMessageEvent({}, { text: "b" })).toBe("b");
    expect(promptFromMessageEvent({ content: "c" }, {})).toBe("c");
    expect(
      promptFromMessageEvent({}, { message: { content: [{ text: "d" }] } }),
    ).toBe("d");
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(promptFromMessageEvent({}, {})).toBeNull();
    expect(
      promptFromMessageEvent({}, { message: { content: "   " } }),
    ).toBeNull();
  });

  it("identifies user messages and ignores assistant ones", () => {
    expect(
      isUserMessageEvent({}, { properties: { info: { role: "user" } } }),
    ).toBe(true);
    expect(isUserMessageEvent({}, { message: { role: "user" } })).toBe(true);
    expect(isUserMessageEvent({}, { role: "user" })).toBe(true);
    expect(isUserMessageEvent({}, { message: { role: "assistant" } })).toBe(
      false,
    );
    expect(isUserMessageEvent({}, {})).toBe(false);
  });

  it("resolves a session id with a stable fallback", () => {
    expect(
      sessionIdFromEvent({}, { properties: { info: { id: "s-sdk" } } }),
    ).toBe("s-sdk");
    expect(sessionIdFromEvent({}, { sessionID: "s1" })).toBe("s1");
    expect(sessionIdFromEvent({}, { session: { id: "s2" } })).toBe("s2");
    expect(sessionIdFromEvent({}, {})).toBe("opencode-session");
  });

  it("resolves message ids from metadata and text-part events", () => {
    expect(
      messageIdFromEvent({}, { properties: { info: { id: "msg-info" } } }),
    ).toBe("msg-info");
    expect(
      messageIdFromEvent(
        {},
        { properties: { part: { messageID: "msg-part" } } },
      ),
    ).toBe("msg-part");
    expect(messageIdFromEvent({}, {})).toBeNull();
  });

  it("resolves the tool name from either argument", () => {
    expect(toolNameFromEvent({ tool: "query_skills" }, {})).toBe(
      "query_skills",
    );
    expect(toolNameFromEvent({}, { toolName: "get_skill" })).toBe("get_skill");
    expect(toolNameFromEvent({}, {})).toBe("");
  });
});

describe("opencode plugin hooks", () => {
  it("exposes only event keys the host documents", async () => {
    const hooks = await Remembrance({});
    expect(Object.keys(hooks).sort()).toEqual([
      "chat.message",
      "event",
      "experimental.chat.system.transform",
      "tool.execute.after",
    ]);
  });

  it("records activation health and logs how to verify setup", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "s-activate" } },
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].service).toBe("remembrance");
    expect(messages[0].message).toContain("run_connection_doctor");
    expect(messages[0].message).toContain("Relevant memory is added");
  });

  it("falls back to structured logging when the TUI toast surface fails", async () => {
    const messages = [];
    const hooks = await Remembrance({
      client: {
        tui: {
          showToast: async () => {
            throw new Error("no active TUI");
          },
        },
        app: {
          log: async ({ body }) => {
            messages.push(body);
          },
        },
      },
    });
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "s-toast-fallback" } },
      },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        level: "info",
        message: expect.stringContaining("run_connection_doctor"),
      }),
    ]);
  });

  it("never echoes a credential into the log", async () => {
    const { client, messages } = loggingClient();
    process.env.REMEMBRANCE_API_KEY = "rk_never_print";
    try {
      const hooks = await Remembrance({ client });
      await hooks.event({
        event: {
          type: "session.created",
          properties: { info: { id: "s-secret" } },
        },
      });
      expect(JSON.stringify(messages)).not.toContain("rk_never_print");
    } finally {
      delete process.env.REMEMBRANCE_API_KEY;
    }
  });

  it("skips the prompt hook for non-user messages and unreadable payloads", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "m-assistant", sessionID: "s", role: "assistant" },
        },
      },
    });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "m-user", sessionID: "s", role: "user" },
        },
      },
    });
    expect(messages).toHaveLength(0);
  });

  it("fails open when a hook throws", async () => {
    const exploding = {
      app: {
        log: async () => {
          throw new Error("host is gone");
        },
      },
    };
    const hooks = await Remembrance({ client: exploding });
    await expect(
      hooks.event({
        event: {
          type: "session.created",
          properties: { info: { id: "s-fail-open" } },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      hooks.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "s-fail-open" },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.after"]({ tool: "query_skills" }, {}),
    ).resolves.toBeUndefined();
  });

  it("stays silent at idle when the session never used Remembrance", async () => {
    const { client, messages } = loggingClient();
    const hooks = await Remembrance({ client });
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "s-unused" },
      },
    });
    expect(messages).toHaveLength(0);
  });

  it("ignores unknown and malformed general events", async () => {
    const hooks = await Remembrance({});
    await expect(hooks.event()).resolves.toBeUndefined();
    await expect(
      hooks.event({ event: { type: "server.connected", properties: {} } }),
    ).resolves.toBeUndefined();
  });

  it("fails open when hostile host payload getters throw", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("host payload unavailable");
        },
      },
    );
    const hooks = await Remembrance({});
    await expect(hooks.event({ event: hostile })).resolves.toBeUndefined();
    await expect(
      hooks.event({
        event: {
          type: "session.created",
          get properties() {
            throw new Error("session metadata unavailable");
          },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      hooks.event({
        event: {
          type: "session.idle",
          get properties() {
            throw new Error("session metadata unavailable");
          },
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.after"](hostile, hostile),
    ).resolves.toBeUndefined();
    await expect(
      hooks["chat.message"](hostile, hostile),
    ).resolves.toBeUndefined();
    await expect(
      hooks["experimental.chat.system.transform"](hostile, hostile),
    ).resolves.toBeUndefined();
  });
});
