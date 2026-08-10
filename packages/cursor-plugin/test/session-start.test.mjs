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
  it("injects compact Remembrance operating context", async () => {
    const recordHealth = vi.fn();
    const env = { XDG_CONFIG_HOME: join(tempRoot, "empty-xdg") };
    const output = await handleSessionStart(
      { session_id: "session_1", cursor_version: "1.7.0" },
      {
        env,
        pluginVersion: "0.1.37",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
      },
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

  it("can be disabled without failing the session", async () => {
    expect(
      await handleSessionStart(
        {},
        {
          env: { REMEMBRANCE_CURSOR_SESSION_CONTEXT: "0" },
          recordHealth: vi.fn(),
        },
      ),
    ).toEqual({});
  });

  it("does not reset lifecycle health during context compaction", async () => {
    const recordHealth = vi.fn();
    const checkUpdate = vi.fn();
    const output = await handleSessionStart(
      { source: "compact", session_id: "active-session" },
      { env: {}, pluginVersion: "0.1.53", recordHealth, checkUpdate },
    );
    expect(recordHealth).not.toHaveBeenCalled();
    expect(checkUpdate).not.toHaveBeenCalled();
    expect(output.additional_context).toBe(CURSOR_REMEMBRANCE_CONTEXT);
  });

  it("tells the agent when Cursor must update and restart", async () => {
    const output = await handleSessionStart(
      {},
      {
        env: {},
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async () => ({
          notice:
            "A newer Remembrance plugin is available. Update it in Cursor settings, then fully quit and reopen Cursor.",
        })),
      },
    );
    expect(output.additional_context).toContain(
      "fully quit and reopen Cursor",
    );
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
