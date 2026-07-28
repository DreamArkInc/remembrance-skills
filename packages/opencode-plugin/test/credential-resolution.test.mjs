import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  remembranceConfigPath,
  resolveApiCredential,
  sharedConfigCredentialNotice,
} from "../scripts/hook-core.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function sharedCredentialEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "opencode-credential-"));
  temporaryDirectories.push(root);
  const directory = join(root, "remembrance");
  await mkdir(directory);
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      apiKey: "rk_opencode_shared",
      apiUrl: "https://registry.example",
    }),
    { mode: 0o600 },
  );
  return {
    REMEMBRANCE_API_KEY: "",
    XDG_CONFIG_HOME: root,
  };
}

describe("opencode credential resolution", () => {
  it("falls back to the shared config file and never echoes the key", async () => {
    const env = await sharedCredentialEnvironment();
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rk_opencode_shared",
      source: "shared_config",
    });
    const notice = sharedConfigCredentialNotice(env);
    expect(notice).toContain("shared Remembrance config file");
    expect(notice).toContain("get_connection_status");
    expect(notice).not.toContain("rk_opencode_shared");
  });

  it("keeps explicit environment credentials authoritative", async () => {
    const env = {
      ...(await sharedCredentialEnvironment()),
      REMEMBRANCE_API_KEY: "rk_opencode_environment",
    };
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rk_opencode_environment",
      source: "environment",
    });
    expect(sharedConfigCredentialNotice(env)).toBeNull();
  });

  it("resolves the config path from the standard XDG location", () => {
    expect(remembranceConfigPath({ XDG_CONFIG_HOME: "/custom/config" })).toBe(
      "/custom/config/remembrance/config.json",
    );
  });

  it("fails closed on malformed config and reports no credential when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-bad-credential-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "remembrance"));
    await writeFile(join(root, "remembrance/config.json"), "{");
    expect(resolveApiCredential({ XDG_CONFIG_HOME: root })).toMatchObject({
      apiKey: "",
      source: "unusable_shared_config",
    });
    expect(
      resolveApiCredential({
        XDG_CONFIG_HOME: join(root, "missing"),
        REMEMBRANCE_API_KEY: " ",
      }),
    ).toEqual({ apiKey: "", source: "none" });
  });
});
