import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";

describe("Claude Code SessionStart health hook", () => {
  it("records registration and injects bounded connection guidance", () => {
    const recordHealth = vi.fn();
    const output = handleSessionStart(
      { claude_version: "2.1.0" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.37",
        recordHealth,
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
});
