import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureOpenCode,
  defaultOpenCodeConfigPath,
  parseArguments,
  runSetupCli,
  updateOpenCodeConfigText,
} from "../bin/setup.mjs";

// The two tests below exercise the "read the version off the installed package"
// path, so they must DERIVE the expected version rather than hardcode it. A
// literal defeats the assertion (it would still pass if the reader returned a
// constant) and, worse, fails on every synchronized release bump — turning a
// real guard into recurring release friction.
const installedVersion = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
).version;

const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("opencode one-command setup", () => {
  it("resolves explicit, OpenCode, XDG, and default config locations", () => {
    expect(
      defaultOpenCodeConfigPath(
        { OPENCODE_CONFIG: "/custom/opencode.json" },
        "/home/agent",
      ),
    ).toBe("/custom/opencode.json");
    expect(
      defaultOpenCodeConfigPath(
        { OPENCODE_CONFIG_DIR: "/custom/opencode" },
        "/home/agent",
      ),
    ).toBe("/custom/opencode/opencode.json");
    expect(
      defaultOpenCodeConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/agent"),
    ).toBe("/xdg/opencode/opencode.json");
    expect(defaultOpenCodeConfigPath({}, "/home/agent")).toBe(
      "/home/agent/.config/opencode/opencode.json",
    );
  });

  it("adds pinned plugin and MCP entries to an empty config", () => {
    const updated = updateOpenCodeConfigText("", "0.1.41");
    expect(updated).toContain('"@remembrance/opencode-plugin@0.1.41"');
    expect(updated).toContain('"@remembrance-ai/mcp-server@0.1.41"');
    expect(updated).toContain('"REMEMBRANCE_PLUGIN_HOST": "opencode"');
  });

  it("preserves comments and unrelated settings while replacing old pins", () => {
    const updated = updateOpenCodeConfigText(
      `{
  // Keep the selected model.
  "model": "anthropic/claude-sonnet-4",
  "plugin": ["existing", "@remembrance/opencode-plugin@0.1.39"],
  "mcp": {
    "other": { "type": "remote", "url": "https://example.test/mcp" },
    "remembrance": { "enabled": false }
  },
}
`,
      "0.1.41",
    );
    expect(updated).toContain("// Keep the selected model.");
    expect(updated).toContain('"model": "anthropic/claude-sonnet-4"');
    expect(updated).toContain('"existing"');
    expect(updated).not.toContain("0.1.39");
    expect(updated).toContain('"other"');
    expect(updated.match(/@remembrance\/opencode-plugin/g)).toHaveLength(1);
  });

  it("rejects malformed or non-object configs without guessing", () => {
    expect(() => updateOpenCodeConfigText("{", "0.1.41")).toThrow(
      /no changes were written/i,
    );
    expect(() => updateOpenCodeConfigText("[]", "0.1.41")).toThrow(
      /root must be an object/i,
    );
  });

  it("parses setup arguments strictly", () => {
    expect(
      parseArguments(["setup", "--dry-run", "--config", "./local.json"]),
    ).toEqual({
      configPath: expect.stringMatching(/local\.json$/),
      dryRun: true,
    });
    expect(() => parseArguments(["--config"])).toThrow(/requires a path/i);
    expect(() => parseArguments(["--unknown"])).toThrow(/unknown argument/i);
  });

  it("writes atomically with secure new-file permissions and supports dry-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-setup-"));
    tempDirs.push(root);
    const configPath = join(root, "nested", "opencode.json");
    const dryRun = await configureOpenCode({
      configPath,
      dryRun: true,
      packageVersion: "0.1.41",
    });
    expect(dryRun.written).toBe(false);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const written = await configureOpenCode({
      configPath,
      packageVersion: "0.1.41",
    });
    expect(written.written).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(written.updated);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("preserves existing file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-mode-"));
    tempDirs.push(root);
    const configPath = join(root, "opencode.json");
    await writeFile(configPath, "{}\n", { mode: 0o640 });
    await configureOpenCode({
      configPath,
      packageVersion: "0.1.41",
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
  });

  it("reads the installed package version when no override is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-version-"));
    tempDirs.push(root);
    const result = await configureOpenCode({
      configPath: join(root, "opencode.json"),
      dryRun: true,
    });
    expect(result.version).toBe(installedVersion);
    expect(result.updated).toContain(
      `"@remembrance/opencode-plugin@${installedVersion}"`,
    );
  });

  it("surfaces non-missing filesystem errors without replacing the config", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-error-"));
    tempDirs.push(root);
    const configPath = join(root, "opencode.json");
    await mkdir(configPath);
    await expect(
      configureOpenCode({ configPath, packageVersion: "0.1.41" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EACCES/) });
  });

  it("runs dry-run, write, and invalid-argument CLI paths without exiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-cli-"));
    tempDirs.push(root);
    const configPath = join(root, "opencode.json");
    const output = { logs: [], writes: [], errors: [] };
    const io = {
      log: (message) => output.logs.push(message),
      write: (message) => output.writes.push(message),
      error: (message) => output.errors.push(message),
    };

    await expect(
      runSetupCli(["setup", "--dry-run", "--config", configPath], io),
    ).resolves.toBe(0);
    expect(output.writes.join("")).toContain(
      `"@remembrance/opencode-plugin@${installedVersion}"`,
    );

    await expect(
      runSetupCli(["setup", "--config", configPath], io),
    ).resolves.toBe(0);
    expect(output.logs.at(-1)).toContain(
      `Configured Remembrance plugin and MCP in ${configPath}`,
    );

    await expect(runSetupCli(["--bad"], io)).resolves.toBe(1);
    expect(output.errors.at(-1)).toMatch(/unknown argument/i);
  });

  it("runs when Node resolves the executable through a symlinked path", async () => {
    const root = await mkdtemp(join(tmpdir(), "remembrance-opencode-link-"));
    tempDirs.push(root);
    const linkedScript = join(root, "setup.mjs");
    const configDirectory = join(root, "config");
    await symlink(
      fileURLToPath(new URL("../bin/setup.mjs", import.meta.url)),
      linkedScript,
    );

    const result = spawnSync(process.execPath, [linkedScript, "setup"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: configDirectory,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Configured Remembrance plugin and MCP");
    await expect(
      readFile(join(configDirectory, "opencode.json"), "utf8"),
    ).resolves.toContain(`"@remembrance/opencode-plugin@${installedVersion}"`);
  });
});
