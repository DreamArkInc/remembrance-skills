import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";

describe("Codex SessionStart health hook", () => {
  it("records startup and tells the agent how to verify complete activation", () => {
    const recordHealth = vi.fn(() => true);
    const output = handleSessionStart(
      {
        codex_version: "0.145.0-alpha.30",
        turn_id: "session-health-check",
      },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.37",
        recordHealth,
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
      "get_connection_status",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "partial activation",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("falls back to anonymous public access without failing startup", () => {
    const recordHealth = vi.fn(() => false);
    const output = handleSessionStart(
      {},
      { env: {}, pluginVersion: "unknown", recordHealth },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "none" }),
      {},
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "public anonymous registry access",
    );
  });
});
