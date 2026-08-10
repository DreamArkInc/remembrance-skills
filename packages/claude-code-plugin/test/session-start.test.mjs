import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";

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

  it("surfaces an update to the agent with the Claude reload boundary", async () => {
    const output = await handleSessionStart(
      {},
      {
        env: {},
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async () => ({
          notice: "Update Remembrance, then run /reload-plugins or restart Claude Code.",
        })),
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "/reload-plugins",
    );
  });
});
