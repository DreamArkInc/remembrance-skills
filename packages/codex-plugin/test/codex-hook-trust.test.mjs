import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  inspectCodexHookTrust,
  resolveCodexExecutable,
  summarizeCodexHookTrust,
} from "../scripts/codex-hook-trust.mjs";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function hook(eventName, overrides = {}) {
  return {
    pluginId: "remembrance@remembrance",
    eventName,
    enabled: true,
    trustStatus: "trusted",
    ...overrides,
  };
}

function allHooks(overrides = {}) {
  return [
    hook("sessionStart", overrides.sessionStart),
    hook("userPromptSubmit", overrides.userPromptSubmit),
    hook("postToolUse", overrides.postToolUse),
    hook("stop", overrides.stop),
  ];
}

function fakeAppServer({
  hooks = allHooks(),
  initializeError,
  listError,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  child.stdin = {
    write: vi.fn((line) => {
      const request = JSON.parse(String(line));
      queueMicrotask(() => {
        if (request.id === 1) {
          child.stdout.write(
            `${JSON.stringify(
              initializeError
                ? { id: 1, error: initializeError }
                : { id: 1, result: {} },
            )}\n`,
          );
        } else if (request.id === 2) {
          child.stdout.write(
            `${JSON.stringify(
              listError
                ? { id: 2, error: listError }
                : { id: 2, result: { data: [{ cwd: "/safe", hooks }] } },
            )}\n`,
          );
        }
      });
      return true;
    }),
  };
  return child;
}

describe("Codex hook trust inspection", () => {
  it("reports all required Remembrance hooks as trusted", () => {
    expect(
      summarizeCodexHookTrust(
        allHooks({
          sessionStart: { trustStatus: "managed" },
          userPromptSubmit: { trustStatus: " TRUSTED " },
        }),
        NOW,
      ),
    ).toEqual({
      status: "trusted",
      checked_at: NOW.toISOString(),
      review_events: [],
      hooks: [
        { event: "SessionStart", enabled: true, trust_status: "managed" },
        {
          event: "UserPromptSubmit",
          enabled: true,
          trust_status: "trusted",
        },
        { event: "PostToolUse", enabled: true, trust_status: "trusted" },
        { event: "Stop", enabled: true, trust_status: "trusted" },
      ],
    });
  });

  it("requires review for modified, disabled, untrusted, and missing hooks", () => {
    const entries = allHooks({
      sessionStart: { enabled: false },
      userPromptSubmit: { trustStatus: "future-status" },
      postToolUse: { trustStatus: "modified" },
    }).filter((entry) => entry.eventName !== "stop");
    expect(summarizeCodexHookTrust(entries, NOW)).toMatchObject({
      status: "review_required",
      review_events: [
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
        "Stop",
      ],
      hooks: [
        { event: "SessionStart", enabled: false },
        { event: "UserPromptSubmit", trust_status: "unknown" },
        { event: "PostToolUse", trust_status: "modified" },
        { event: "Stop", enabled: false, trust_status: "missing" },
      ],
    });
  });

  it("ignores unrelated plugins and reports unavailable when Remembrance is absent", () => {
    expect(
      summarizeCodexHookTrust(
        [hook("postToolUse", { pluginId: "other@marketplace" })],
        NOW,
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "plugin_hooks_not_listed",
    });
    expect(summarizeCodexHookTrust(null, NOW)).toMatchObject({
      status: "unavailable",
      reason: "plugin_hooks_not_listed",
    });
    expect(
      summarizeCodexHookTrust(
        [null, "invalid", hook("stop", { pluginId: null })],
        NOW,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("uses the app-server hooks/list contract without persisting hook hashes or paths", async () => {
    const child = fakeAppServer({
      hooks: allHooks({
        postToolUse: {
          trustStatus: "modified",
          command: "node /private/plugin/script.mjs",
          currentHash: "sha256:secret",
        },
      }),
    });
    const spawnImpl = vi.fn(() => child);
    const status = await inspectCodexHookTrust({
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      cwd: "/workspace",
      env: {},
      now: () => NOW,
      spawnImpl,
      timeoutMs: 100,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      ["app-server", "--stdio"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(status).toMatchObject({
      status: "review_required",
      review_events: ["PostToolUse"],
    });
    expect(JSON.stringify(status)).not.toMatch(
      /secret|private\/plugin|sha256/i,
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails open for app-server errors and timeouts", async () => {
    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () =>
          fakeAppServer({ initializeError: { message: "bad init" } }),
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "app_server_initialize_failed",
    });

    for (const eventName of ["error", "close"]) {
      const child = fakeAppServer();
      child.stdin.write = vi.fn(() => true);
      const pending = inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => {
          queueMicrotask(() => child.emit(eventName));
          return child;
        },
        timeoutMs: 100,
      });
      await expect(pending).resolves.toMatchObject({
        status: "unavailable",
        reason:
          eventName === "error"
            ? "app_server_unavailable"
            : "app_server_closed",
      });
    }

    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => {
          throw new Error("spawn failed");
        },
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "app_server_unavailable",
    });

    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => fakeAppServer({ listError: { message: "nope" } }),
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "hooks_list_failed",
    });

    const silent = fakeAppServer();
    silent.stdin.write = vi.fn(() => true);
    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => silent,
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "hooks_list_timeout",
    });
  });

  it("bounds app-server output and ignores malformed or unrelated messages", async () => {
    const oversized = fakeAppServer();
    oversized.stdin.write = vi.fn(() => {
      queueMicrotask(() => oversized.stdout.write("x".repeat(512 * 1024 + 1)));
      return true;
    });
    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => oversized,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "hooks_list_too_large",
    });

    const child = fakeAppServer();
    const write = child.stdin.write;
    child.stdin.write = vi.fn((line) => {
      child.stdout.write("not-json\n");
      child.stdout.write(`${JSON.stringify({ method: "notification" })}\n`);
      return write(line);
    });
    child.kill = vi.fn(() => {
      child.emit("close");
      throw new Error("already closed");
    });
    await expect(
      inspectCodexHookTrust({
        codexPath: "/safe/codex",
        env: {},
        now: () => NOW,
        spawnImpl: () => child,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ status: "trusted" });

    for (const result of [{ data: null }, { data: [{ hooks: null }] }]) {
      const empty = fakeAppServer();
      empty.stdin.write = vi.fn((line) => {
        const request = JSON.parse(String(line));
        queueMicrotask(() => {
          empty.stdout.write(
            `${JSON.stringify(
              request.id === 1
                ? { id: 1, result: {} }
                : { id: 2, result },
            )}\n`,
          );
        });
        return true;
      });
      await expect(
        inspectCodexHookTrust({
          codexPath: "/safe/codex",
          env: {},
          now: () => NOW,
          spawnImpl: () => empty,
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "plugin_hooks_not_listed",
      });
    }
  });

  it("can be disabled and fails open when no executable is available", async () => {
    for (const disabled of ["0", "false", "NO"]) {
      await expect(
        inspectCodexHookTrust({
          env: { REMEMBRANCE_CODEX_HOOK_TRUST_CHECK: disabled },
          now: () => NOW,
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "check_disabled",
      });
    }
    await expect(
      inspectCodexHookTrust({
        env: { PATH: "" },
        platform: "linux",
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "check_disabled",
    });
    await expect(
      inspectCodexHookTrust({
        env: { PATH: "" },
        platform: "linux",
        now: () => NOW,
        spawnImpl: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "codex_executable_not_found",
    });
  });

  it("accepts only executable absolute configured paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "remembrance-codex-path-"));
    const executable = join(directory, "codex");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o700);
    expect(
      resolveCodexExecutable(
        { REMEMBRANCE_CODEX_CLI_PATH: executable },
        "linux",
      ),
    ).toBe(executable);
    expect(
      resolveCodexExecutable(
        { REMEMBRANCE_CODEX_CLI_PATH: "relative/codex" },
        "linux",
      ),
    ).toBeNull();
    expect(resolveCodexExecutable({ PATH: directory }, "linux")).toBe(
      executable,
    );
    expect(
      resolveCodexExecutable({ CODEX_CLI_PATH: executable }, "linux"),
    ).toBe(executable);
    expect(resolveCodexExecutable({ CODEX_CLI: executable }, "linux")).toBe(
      executable,
    );
    expect(
      resolveCodexExecutable(
        {
          REMEMBRANCE_CODEX_CLI_PATH: join(directory, "missing"),
          CODEX_CLI_PATH: executable,
        },
        "linux",
      ),
    ).toBe(executable);

    const darwinResolution = resolveCodexExecutable({ PATH: "" }, "darwin");
    expect(
      darwinResolution === null || darwinResolution.endsWith("/codex"),
    ).toBe(true);

    const windowsExecutable = join(directory, "codex.exe");
    writeFileSync(windowsExecutable, "executable");
    chmodSync(windowsExecutable, 0o700);
    expect(resolveCodexExecutable({ PATH: directory }, "win32")).toBe(
      windowsExecutable,
    );
  });
});
