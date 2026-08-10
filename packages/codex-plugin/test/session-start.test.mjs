import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";

describe("Codex SessionStart health hook", () => {
  it("records startup and tells the agent how to verify complete activation", async () => {
    const recordHealth = vi.fn(() => true);
    const output = await handleSessionStart(
      {
        codex_version: "0.145.0-alpha.30",
        turn_id: "session-health-check",
      },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.37",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
    );

    expect(recordHealth).toHaveBeenCalledWith(
      {
        surface: "codex",
        component: "session_start",
        pluginVersion: "0.1.37",
        hostVersion: "0.145.0-alpha.30",
        credentialSource: "environment",
        sessionId: "session-health-check",
      },
      expect.any(Object),
    );
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "bundled local MCP server",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "partial activation",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("falls back to anonymous public access without failing startup", async () => {
    const recordHealth = vi.fn(() => false);
    const env = {
      XDG_CONFIG_HOME: `/tmp/remembrance-codex-session-test-${process.pid}`,
    };
    const output = await handleSessionStart(
      {},
      {
        env,
        pluginVersion: "unknown",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "none" }),
      env,
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "public anonymous registry access",
    );
  });

  it("does not reset lifecycle health when Codex compacts an active turn", async () => {
    const recordHealth = vi.fn();
    const checkUpdate = vi.fn();
    const output = await handleSessionStart(
      {
        source: "compact",
        session_id: "active-task",
      },
      { env: {}, pluginVersion: "0.1.53", recordHealth, checkUpdate },
    );

    expect(recordHealth).not.toHaveBeenCalled();
    expect(checkUpdate).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("gives the agent a locally authored update command and restart boundary", async () => {
    const output = await handleSessionStart(
      { session_id: "update-session" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async (input) => ({
          current_version: input.currentVersion,
          latest_version: "0.1.55",
          notice:
            "Remembrance update available. Ask permission, run the trusted local command, then fully quit and reopen Codex.",
        })),
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Remembrance update available",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "fully quit and reopen Codex",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });
});
