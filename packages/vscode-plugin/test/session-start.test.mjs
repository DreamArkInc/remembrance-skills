import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";

describe("VS Code SessionStart health hook", () => {
  it("records registration under its own surface and never echoes the key", () => {
    const recordHealth = vi.fn();
    const output = handleSessionStart(
      { vscode_version: "1.104.0" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.39",
        recordHealth,
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

  it("falls back to a generic version key when the host omits its own", () => {
    const recordHealth = vi.fn();
    handleSessionStart(
      { version: "1.105.1" },
      { env: {}, pluginVersion: "0.1.39", recordHealth },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ hostVersion: "1.105.1" }),
      expect.any(Object),
    );
  });
});
