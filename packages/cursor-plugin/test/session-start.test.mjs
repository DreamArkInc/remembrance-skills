import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CURSOR_REMEMBRANCE_CONTEXT,
  handleSessionStart,
} from "../scripts/session-start.mjs";
import {
  resolveApiCredential,
  sharedConfigCredentialNotice,
} from "../scripts/hook-core.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-cursor-status-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Cursor sessionStart hook", () => {
  it("injects compact Remembrance operating context", () => {
    const recordHealth = vi.fn();
    const env = { XDG_CONFIG_HOME: join(tempRoot, "empty-xdg") };
    const output = handleSessionStart(
      { session_id: "session_1", cursor_version: "1.7.0" },
      { env, pluginVersion: "0.1.37", recordHealth },
    );
    expect(output.additional_context).toBe(CURSOR_REMEMBRANCE_CONTEXT);
    expect(output.additional_context).toContain("query_skills");
    expect(output.additional_context).toContain("full conversation");
    expect(output.additional_context).toContain("submit redacted feedback");
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cursor",
        component: "session_start",
        pluginVersion: "0.1.37",
        hostVersion: "1.7.0",
        credentialSource: "none",
      }),
      env,
    );
  });

  it("can be disabled without failing the session", () => {
    expect(
      handleSessionStart(
        {},
        {
          env: { REMEMBRANCE_CURSOR_SESSION_CONTEXT: "0" },
          recordHealth: vi.fn(),
        },
      ),
    ).toEqual({});
  });

  it("resolves Cursor's shared config and explains how to verify its MCP scope", () => {
    const configHome = join(tempRoot, "xdg");
    mkdirSync(join(configHome, "remembrance"), { recursive: true });
    writeFileSync(
      join(configHome, "remembrance", "config.json"),
      JSON.stringify({ apiKey: "rk_cursor_shared" }),
      { mode: 0o600 },
    );
    const env = {
      XDG_CONFIG_HOME: configHome,
      REMEMBRANCE_API_KEY: "",
    };

    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rk_cursor_shared",
      source: "shared_config",
    });
    const notice = sharedConfigCredentialNotice(env);
    expect(notice).toContain("run_connection_doctor");
    expect(notice).not.toContain("rk_cursor_shared");
    expect(CURSOR_REMEMBRANCE_CONTEXT).toContain("run_connection_doctor");
    expect(CURSOR_REMEMBRANCE_CONTEXT).toContain(
      "anonymous REST/browser probe",
    );
  });
});
