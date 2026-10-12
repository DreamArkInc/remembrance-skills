import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";
import { handleSessionStart } from "../scripts/session-start.mjs";

const network = useIsolatedHookEnvironment();

describe("VS Code SessionStart health hook", () => {
  it("records registration under its own surface and never echoes the key", async () => {
    const recordHealth = vi.fn();
    const output = await handleSessionStart(
      { vscode_version: "1.104.0" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.39",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        // Must be vs_code, not claude_code: VS Code loads the Claude plugin
        // format, so a copied surface would silently merge two hosts in
        // client-health reporting.
        surface: "vs_code",
        component: "session_start",
        pluginVersion: "0.1.39",
        hostVersion: "1.104.0",
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
    expect(output.hookSpecificOutput.additionalContext).toContain("VS Code");
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("falls back to a generic version key when the host omits its own", async () => {
    const recordHealth = vi.fn();
    await handleSessionStart(
      { version: "1.105.1" },
      {
        env: {},
        pluginVersion: "0.1.39",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ hostVersion: "1.105.1" }),
      expect.any(Object),
    );
  });

  it("loads organization session skills when a session with an id starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-vscode-session-"));
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
                  slug: "caveman",
                  version_id: "sv_eed332475dea44a3a3",
                  pinned: false,
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
      // VS Code documents no start source and an optional session id.
      const started = await handleSessionStart(
        { hook_event_name: "SessionStart", session_id: "vscode-session-1" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(started.hookSpecificOutput.additionalContext).toMatch(
        /\n- \{"slug":"caveman","version_id":"sv_eed332475dea44a3a3","scope":"session","idempotency_key":"rss_[0-9a-f]{32}"\}\n/,
      );

      const anonymousSession = await handleSessionStart(
        { hook_event_name: "SessionStart" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(
        anonymousSession.hookSpecificOutput.additionalContext,
      ).not.toContain("invoke_skill");
      expect(JSON.stringify([started, anonymousSession])).not.toContain(
        "rk_never_print",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace active health markers during compaction", async () => {
    const recordHealth = vi.fn();
    const checkUpdate = vi.fn();
    await handleSessionStart(
      { source: "compact", session_id: "active-session" },
      { env: {}, pluginVersion: "0.1.53", recordHealth, checkUpdate },
    );
    expect(recordHealth).not.toHaveBeenCalled();
    expect(checkUpdate).not.toHaveBeenCalled();
  });

  it("adds the VS Code reload instruction when an update is available", async () => {
    const output = await handleSessionStart(
      {},
      {
        env: {},
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async () => ({
          notice: "Update Remembrance, then reload the VS Code window.",
        })),
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "reload the VS Code window",
    );
  });

  it("sends its default requests only to the stubbed fetch", async () => {
    network.fetch.mockClear();
    await handleSessionStart(
      { hook_event_name: "SessionStart", session_id: "vscode-offline-session" },
      { env: { REMEMBRANCE_API_KEY: "rk_never_print" } },
    );
    expect(network.fetch).toHaveBeenCalledWith(
      "https://remembrance.dev/api/v1/agent/session-skills",
      expect.anything(),
    );
    expect(network.realRequests).toEqual([]);
  });
});
