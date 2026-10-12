import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";
import { handleSessionStart } from "../scripts/session-start.mjs";

const SESSION_SKILLS_HEADER = "Remembrance organization session skills:";
const network = useIsolatedHookEnvironment();

describe("Claude Code SessionStart health hook", () => {
  it("records registration and injects bounded connection guidance", async () => {
    const recordHealth = vi.fn();
    const output = await handleSessionStart(
      { claude_version: "2.1.0" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.37",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "claude_code",
        component: "session_start",
        pluginVersion: "0.1.37",
        hostVersion: "2.1.0",
        credentialSource: "environment",
      }),
      expect.any(Object),
    );
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "SessionStart",
    });
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("preserves current lifecycle health during context compaction", async () => {
    const recordHealth = vi.fn();
    const checkUpdate = vi.fn();
    await handleSessionStart(
      { source: "compact", session_id: "active-session" },
      { env: {}, pluginVersion: "0.1.53", recordHealth, checkUpdate },
    );
    expect(recordHealth).not.toHaveBeenCalled();
    expect(checkUpdate).not.toHaveBeenCalled();
  });

  it("loads organization session skills at startup and repeats them from the cache after compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-claude-session-"));
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              contract_version: "session-skills-v1",
              available: true,
              reason_code: null,
              session_skills: [
                {
                  slug: "ponytail",
                  version_id: "sv_7f7777fba96c441f86",
                  pinned: true,
                },
              ],
              omitted_count: 0,
            }),
          ),
      );
      const options = {
        env: {
          REMEMBRANCE_API_KEY: "rk_never_print",
          REMEMBRANCE_USAGE_DIR: join(root, "usage"),
          XDG_CONFIG_HOME: join(root, "config"),
        },
        pluginVersion: "0.2.0",
        recordHealth: vi.fn(),
        warmSession: vi.fn(async () => null),
        checkUpdate: vi.fn(async () => null),
        fetchImpl,
      };
      const started = await handleSessionStart(
        { source: "startup", session_id: "claude-session-1" },
        options,
      );
      const context = started.hookSpecificOutput.additionalContext;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "https://remembrance.dev/api/v1/agent/session-skills",
      );
      expect(context).toContain("run_connection_doctor");
      expect(context).toMatch(
        /\n- \{"slug":"ponytail","version_id":"sv_7f7777fba96c441f86","scope":"session","idempotency_key":"rss_[0-9a-f]{32}"\} \(pinned\)\n/,
      );

      const compacted = await handleSessionStart(
        { source: "compact", session_id: "claude-session-1" },
        options,
      );
      const compactedContext = compacted.hookSpecificOutput.additionalContext;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(options.checkUpdate).toHaveBeenCalledTimes(1);
      expect(
        compactedContext.slice(compactedContext.indexOf(SESSION_SKILLS_HEADER)),
      ).toBe(context.slice(context.indexOf(SESSION_SKILLS_HEADER)));
      expect(JSON.stringify([started, compacted])).not.toContain(
        "rk_never_print",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces an update to the agent with the Claude reload boundary", async () => {
    const output = await handleSessionStart(
      {},
      {
        env: {},
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async () => ({
          notice:
            "Update Remembrance, then run /reload-plugins or restart Claude Code.",
        })),
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "/reload-plugins",
    );
  });

  it("sends its default requests only to the stubbed fetch", async () => {
    network.fetch.mockClear();
    for (const source of ["startup", "resume", "clear", "compact"]) {
      await handleSessionStart(
        { source, session_id: "claude-offline-session" },
        { env: { REMEMBRANCE_API_KEY: "rk_never_print" } },
      );
    }
    expect(network.fetch).toHaveBeenCalledWith(
      "https://remembrance.dev/api/v1/agent/session-skills",
      expect.anything(),
    );
    expect(network.realRequests).toEqual([]);
  });
});
