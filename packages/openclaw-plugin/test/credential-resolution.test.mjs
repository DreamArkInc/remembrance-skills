import { vi } from "vitest";

const sharedConfig = JSON.stringify({
  apiKey: "rk_openclaw_shared",
  apiUrl: "https://registry.example",
});
const sharedConfigBytes = Buffer.from(sharedConfig);
let sharedConfigOffset = 0;

function secureDirectoryMetadata() {
  return {
    uid: process.getuid?.() ?? 0,
    mode: 0o40700,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  };
}

function secureFileMetadata() {
  return {
    uid: process.getuid?.() ?? 0,
    mode: 0o100600,
    size: sharedConfigBytes.length,
    dev: 1,
    ino: 2,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  };
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const isSharedConfig = (path) =>
    String(path).endsWith("/.config/remembrance/config.json");
  const isSharedConfigParent = (path) =>
    String(path).endsWith("/.config/remembrance");
  return {
    ...actual,
    existsSync: vi.fn((path) =>
      isSharedConfig(path) ? true : actual.existsSync(path),
    ),
    lstatSync: vi.fn((path) =>
      isSharedConfig(path)
        ? secureFileMetadata()
        : isSharedConfigParent(path)
          ? secureDirectoryMetadata()
          : actual.lstatSync(path),
    ),
    openSync: vi.fn((path, flags, mode) => {
      if (!isSharedConfig(path)) return actual.openSync(path, flags, mode);
      sharedConfigOffset = 0;
      return 9876;
    }),
    fstatSync: vi.fn((descriptor) =>
      descriptor === 9876
        ? secureFileMetadata()
        : actual.fstatSync(descriptor),
    ),
    readSync: vi.fn((descriptor, buffer, offset, length, position) => {
      if (descriptor !== 9876) {
        return actual.readSync(descriptor, buffer, offset, length, position);
      }
      const count = Math.min(length, sharedConfigBytes.length - sharedConfigOffset);
      if (count <= 0) return 0;
      sharedConfigBytes.copy(
        buffer,
        offset,
        sharedConfigOffset,
        sharedConfigOffset + count,
      );
      sharedConfigOffset += count;
      return count;
    }),
    closeSync: vi.fn((descriptor) => {
      if (descriptor !== 9876) actual.closeSync(descriptor);
    }),
  };
});

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  remembranceConfigPath,
  resolveApiConfiguration,
  resolveApiCredential,
  sharedConfigCredentialNotice,
} from "../src/hook-core.mjs";

describe("OpenClaw credential resolution", () => {
  it("uses the fixed user-home config path and reports shared-file fallback", () => {
    expect(
      remembranceConfigPath({ XDG_CONFIG_HOME: "/attacker-controlled" }),
    ).toBe(join(homedir(), ".config", "remembrance", "config.json"));
    expect(
      resolveApiConfiguration({
        REMEMBRANCE_API_URL: "",
        XDG_CONFIG_HOME: "/attacker-controlled",
      }),
    ).toEqual({
      apiUrl: "https://registry.example",
      source: "shared_config",
    });
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
    expect(notice).toContain("run_connection_doctor");
    expect(notice).not.toContain("rk_openclaw_shared");
  });

  it("keeps explicit environment credentials authoritative", () => {
    const env = {
      REMEMBRANCE_API_KEY: "rk_openclaw_environment",
      REMEMBRANCE_API_KEY_ORIGIN: "https://registry.example",
      REMEMBRANCE_API_URL: "https://registry.example",
    };
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rk_openclaw_environment",
      source: "environment",
    });
    expect(sharedConfigCredentialNotice(env)).toBeNull();
  });
});
