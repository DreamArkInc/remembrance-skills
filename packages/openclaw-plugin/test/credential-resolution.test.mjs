import { vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn((path, encoding) => {
      if (String(path).endsWith("/.config/remembrance/config.json")) {
        return JSON.stringify({
          apiKey: "rk_openclaw_shared",
          apiUrl: "https://registry.example",
        });
      }
      return actual.readFileSync(path, encoding);
    }),
  };
});

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  remembranceConfigPath,
  resolveApiCredential,
  sharedConfigCredentialNotice,
} from "../src/hook-core.mjs";

describe("OpenClaw credential resolution", () => {
  it("uses the fixed user-home config path and reports shared-file fallback", () => {
    expect(
      remembranceConfigPath({ XDG_CONFIG_HOME: "/attacker-controlled" }),
    ).toBe(join(homedir(), ".config", "remembrance", "config.json"));
    expect(
      resolveApiCredential({ REMEMBRANCE_API_KEY: "", XDG_CONFIG_HOME: "/x" }),
    ).toEqual({
      apiKey: "rk_openclaw_shared",
      source: "shared_config",
    });
    const notice = sharedConfigCredentialNotice({
      REMEMBRANCE_API_KEY: "",
      XDG_CONFIG_HOME: "/x",
    });
    expect(notice).toContain("shared Remembrance config file");
    expect(notice).toContain("get_connection_status");
    expect(notice).not.toContain("rk_openclaw_shared");
  });

  it("keeps explicit environment credentials authoritative", () => {
    const env = { REMEMBRANCE_API_KEY: "rk_openclaw_environment" };
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rk_openclaw_environment",
      source: "environment",
    });
    expect(sharedConfigCredentialNotice(env)).toBeNull();
  });
});
