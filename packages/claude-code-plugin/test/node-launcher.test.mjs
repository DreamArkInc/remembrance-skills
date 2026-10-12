import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { OFFLINE_FETCH_IMPORT } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

// The launcher runs as a real `sh` process with a controlled environment: a
// fake HOME, a PATH without node, and no inherited version-manager variables.
const root = resolve(import.meta.dirname, "..");
const launcher = resolve(root, "scripts/node-launcher");
// The launcher echoes at most 200 bytes of a path (`_line`), and the deepest
// node fixture below adds up to 110 bytes to this root
// (`<n>-layout-home/Library/Application Support/fnm/node-versions/...`).
// Under a TMPDIR too long for both, the root moves to realpath("/tmp"), so
// every path the tests compare stays whole. The plugin test setup nests
// TMPDIR 40 bytes deeper (`<TMPDIR>/remembrance-plugin-test-home-XXXXXX/tmp`),
// so that is any TMPDIR over 17 bytes: practically every run, macOS's own
// (`/var/folders/.../T`) included. afterAll removes the root; a killed run
// leaves it in the shared /private/tmp rather than in the run's TMPDIR.
const ECHO_BYTES = Number(
  readFileSync(launcher, "utf8").match(/printf '%\.(\d+)s'/)[1],
);
const DEEPEST_FIXTURE_BYTES = 110;
const tempBase =
  Buffer.byteLength(join(tmpdir(), "remembrance-node-launcher-XXXXXX")) +
    DEEPEST_FIXTURE_BYTES <=
  ECHO_BYTES
    ? tmpdir()
    : realpathSync("/tmp");
const tempRoot = mkdtempSync(join(tempBase, "remembrance-node-launcher-"));
const realNode = realpathSync(process.execPath);
const shells = ["/bin/sh", "/bin/dash", "/usr/bin/dash"]
  .filter(existsSync)
  .filter((shell, index, all) => all.indexOf(shell) === index);
// One source of truth: the bundled MCP server's engines floor.
const engines = JSON.parse(
  readFileSync(resolve(root, "../mcp-server/package.json"), "utf8"),
).engines.node;
const MIN = engines.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
const [minMajor, minMinor, minPatch] = (MIN ?? "0.0.0").split(".").map(Number);
let counter = 0;

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function fresh(name) {
  counter += 1;
  const dir = join(tempRoot, `${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(path, content, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function linkNode(path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(process.execPath, path);
  return path;
}

// A stand-in node that prints `version` verbatim for -v (after reading one
// stdin line, like a careless wrapper would) and runs everything else on the
// real node.
function fakeNode(path, version) {
  return write(
    path,
    `#!/bin/sh\nif [ "$1" = -v ]; then read -r _ || :; printf '%s\\n' '${version}'; exit 0; fi\nexec '${realNode}' "$@"\n`,
  );
}

// An empty PATH: no host node leaks in, and the launcher must not need any
// PATH tool (it uses shell builtins and `command -p sort`).
const toolsDir = fresh("empty-path");
const noSystemNode = fresh("no-system-node");
const probe = write(
  join(tempRoot, "probe.mjs"),
  [
    'import { readFileSync } from "node:fs";',
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid,",
    '  ppid: process.ppid, execPath: process.execPath, stdin: readFileSync(0, "utf8") }));',
    "",
  ].join("\n"),
  0o644,
);
const silent = write(join(tempRoot, "silent.mjs"), "", 0o644);

function run(shell, { env = {}, args = [probe], input = "", cwd } = {}) {
  const result = spawnSync(shell, [launcher, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: {
      HOME: fresh("empty-home"),
      PATH: toolsDir,
      REMEMBRANCE_NODE_LAUNCHER_SYSTEM_ROOT: noSystemNode,
      ...env,
    },
  });
  return {
    ...result,
    probe: result.stdout.startsWith("{") ? JSON.parse(result.stdout) : null,
    stderrLines: result.stderr.split("\n").filter(Boolean),
  };
}

const chosen = (result) =>
  result.stderr.match(/^Remembrance node launcher: (.+) v\d+\.\d+\.\d+[^\n]*\n$/)?.[1];

describe("node launcher runtime floor", () => {
  it("is the bundled MCP server's engines floor, stated once", () => {
    // Change the floor in packages/mcp-server/package.json; this test then
    // names every launcher line and manifest that must follow it.
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+$/);
    const launcherSource = readFileSync(launcher, "utf8");
    expect(launcherSource.match(/^_min=(.*)$/gm)).toEqual([`_min=${MIN}`]);
    expect(
      JSON.parse(
        readFileSync(resolve(root, "../opencode-plugin/package.json"), "utf8"),
      ).engines.node,
    ).toBe(engines);
  });
});

describe.each(shells)("node launcher under %s", (shell) => {
  it("uses REMEMBRANCE_NODE and passes every argument through verbatim", () => {
    const args = ["a b", "c'd", "$HOME", "*", "", "--flag=x y"];
    const result = run(shell, {
      env: { REMEMBRANCE_NODE: process.execPath },
      args: [probe, ...args],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.probe.argv).toEqual(args);
    expect(realpathSync(result.probe.execPath)).toBe(realNode);
  });

  it("never falls back past an unusable REMEMBRANCE_NODE", () => {
    const home = fresh("override-home");
    const bin = fresh("override-bin");
    linkNode(join(bin, "node"));
    linkNode(join(home, ".nvm/versions/node/v24.0.0/bin/node"));
    const below = `v${minMajor}.${minMinor}.${minPatch}-rc.1`;
    const unusable = [
      [join(home, "missing-node"), ""],
      [home, ""],
      [write(join(home, "not-executable"), "#!/bin/sh\n", 0o644), ""],
      [fakeNode(join(home, "old-node"), "v16.20.0"), " (it reports v16.20.0)"],
      [fakeNode(join(home, "below-floor"), below), ` (it reports ${below})`],
    ];
    for (const [value, reported] of unusable) {
      const result = run(shell, {
        env: { HOME: home, PATH: `${bin}:${toolsDir}`, REMEMBRANCE_NODE: value },
      });
      expect(result.status, value).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderrLines).toHaveLength(1);
      expect(result.stderr).toContain(
        `REMEMBRANCE_NODE=${value} is not an executable Node.js ${MIN} or newer${reported};`,
      );
    }
  });

  it("prefers node on PATH and treats an empty REMEMBRANCE_NODE as unset", () => {
    const bin = fresh("path-bin");
    const pathNode = linkNode(join(bin, "node"));
    const home = fresh("path-home");
    linkNode(join(home, ".nvm/versions/node/v24.0.0/bin/node"));
    for (const override of [{}, { REMEMBRANCE_NODE: "" }]) {
      const result = run(shell, {
        env: {
          HOME: home,
          PATH: `${bin}:${toolsDir}`,
          REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1",
          ...override,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(chosen(result)).toBe(pathNode);
    }
  });

  // [output of `node -v`, accepted]: numeric major.minor.patch comparison,
  // a prerelease of the floor itself is below it, anything else is refused.
  // One test per row, each within its own time limit: a row starts the
  // launcher and, when it accepts, a Node.js, too many for a single test on
  // a loaded host.
  it.each(
    [
      // The current contract (engines >=18.17.0) pinned literally ...
      ["v17.9.1", false],
      ["v18.0.0", false],
      ["v18.16.9", false],
      ["v18.17.0", true],
      // ... and the boundary derived from engines, so the two cannot drift.
      [`v${minMajor}.${minMinor - 1}.99`, false],
      [`v${minMajor}.${minMinor}.${minPatch}`, true],
      [`v${minMajor}.${minMinor}.${minPatch}-rc.1`, false],
      [`v${minMajor}.${minMinor}.${minPatch}-pre`, false],
      [`v${minMajor}.${minMinor}.${minPatch + 1}-rc.1`, true],
      [`v${minMajor}.${minMinor}.${minPatch}+build.7`, true],
      [`v${minMajor}.${minMinor + 1}.0`, true],
      ["v20.19.4", true],
      ["v24.15.0", true],
      ["v25.0.0-nightly20260101abcdef", true],
      // A Windows node.exe under Git Bash ends its line with a carriage return.
      ["v20.1.0\r", true],
      ["v18", false],
      [`v${minMajor}.${minMinor}`, false],
      [`v${minMajor}.${minMinor}.${minPatch}.1`, false],
      [`v${minMajor}.${minMinor}.${minPatch} extra`, false],
      [`v${minMajor}.${minMinor}.x`, false],
      ["vX.Y.Z", false],
      ["node", false],
      ["", false],
      ["v99999999999.0.0", false],
    ].map(([version, accepted]) => [
      version,
      accepted ? "accepted" : "refused",
    ]),
  )(
    "accepts exactly the engines floor of the bundled MCP server (row %#: %j %s)",
    (version, verdict) => {
      const home = fresh("floor-home");
      const node = fakeNode(join(home, "node"), version);
      const result = run(shell, {
        env: {
          HOME: home,
          REMEMBRANCE_NODE: node,
          REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1",
        },
      });
      const label = JSON.stringify(version);
      if (verdict === "accepted") {
        expect(result.status, `${label}: ${result.stderr}`).toBe(0);
        expect(chosen(result), label).toBe(node);
      } else {
        expect(result.status, label).toBe(127);
        expect(result.stdout, label).toBe("");
        expect(result.stderrLines, label).toHaveLength(1);
        expect(result.stderr, label).toContain(
          `REMEMBRANCE_NODE=${node} is not an executable Node.js ${MIN} or newer`,
        );
      }
    },
  );

  it("skips a too-old node on PATH for a supported version-manager install", () => {
    const bin = fresh("older-path-bin");
    fakeNode(join(bin, "node"), `v${minMajor}.${minMinor - 1}.9`);
    const home = fresh("older-path-home");
    const managed = fakeNode(join(home, ".nvm/versions/node/v20.5.0/bin/node"), "v20.5.0");
    const result = run(shell, {
      env: { HOME: home, PATH: `${bin}:${toolsDir}`, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(chosen(result)).toBe(managed);
  });

  it("falls past unsupported managed versions to a newer usable install", () => {
    const home = fresh("fallback-home");
    const versions = join(home, ".nvm/versions/node");
    const old = `${minMajor}.${minMinor - 1}.0`;
    fakeNode(join(versions, `v${old}/bin/node`), `v${old}`);
    const newer = fakeNode(join(versions, "v20.5.0/bin/node"), "v20.5.0");
    write(join(home, ".nvm/alias/default"), `${old}\n`, 0o644);
    // Volta holds only an unsupported release; asdf holds a usable one.
    fakeNode(join(home, ".volta/bin/node"), "v18.0.0");
    const asdf = fakeNode(join(home, ".asdf/installs/nodejs/22.1.0/bin/node"), "v22.1.0");
    const nvm = run(shell, { env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" } });
    expect(nvm.status, nvm.stderr).toBe(0);
    expect(chosen(nvm)).toBe(newer);
    rmSync(join(home, ".nvm"), { recursive: true });
    const managed = run(shell, { env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" } });
    expect(managed.status, managed.stderr).toBe(0);
    expect(chosen(managed)).toBe(asdf);
  });

  it("resolves nvm lts/*, nested and system default aliases", () => {
    const layout = (name, aliases) => {
      const home = fresh(name);
      const versions = join(home, ".nvm/versions/node");
      const nodes = Object.fromEntries(
        ["v20.1.0", "v20.10.0", "v22.12.0", "v24.1.0"].map((version) => [
          version,
          fakeNode(join(versions, `${version}/bin/node`), version),
        ]),
      );
      for (const [alias, target] of Object.entries(aliases)) {
        write(join(home, ".nvm/alias", alias), `${target}\n`, 0o644);
      }
      return { home, nodes };
    };
    const pick = (home, env = {}) => {
      const result = run(shell, {
        env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1", ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      return chosen(result);
    };
    // default -> lts/* -> lts/jod -> v22.12.0, not the newest (v24.1.0).
    const lts = layout("nvm-lts-home", {
      default: "lts/*",
      "lts/*": "lts/jod",
      "lts/jod": "v22.12.0",
    });
    expect(pick(lts.home)).toBe(lts.nodes["v22.12.0"]);
    // default -> work -> 20: the newest 20.x.
    const nested = layout("nvm-nested-home", { default: "work", work: "20" });
    expect(pick(nested.home)).toBe(nested.nodes["v20.10.0"]);
    // system: the Node.js outside nvm wins over every nvm version.
    const system = layout("nvm-system-home", { default: "system" });
    const root = fresh("nvm-system-root");
    const systemNode = fakeNode(join(root, "usr/local/bin/node"), "v20.3.0");
    expect(
      pick(system.home, { REMEMBRANCE_NODE_LAUNCHER_SYSTEM_ROOT: root }),
    ).toBe(systemNode);
    // A cycle ends after a bounded number of steps at the newest version.
    const cycle = layout("nvm-cycle-home", { default: "a", a: "b", b: "default" });
    expect(pick(cycle.home)).toBe(cycle.nodes["v24.1.0"]);
  });

  it("builds nvm paths only from a version-number alias and reports other text", () => {
    const home = fresh("nvm-glob-home");
    const newest = fakeNode(
      join(home, ".nvm/versions/node/v22.1.0/bin/node"),
      "v22.1.0",
    );
    // Whitespace would split the alias into a second glob word, expanded in
    // the current directory (the user's project); ../ climbs out of nvm.
    const cwd = fresh("nvm-glob-cwd");
    const ran = join(cwd, "ran");
    const planted = `#!/bin/sh\n: > '${ran}'\nprintf 'v24.0.0\\n'\n`;
    write(join(cwd, "evil.d/bin/node"), planted);
    mkdirSync(join(home, ".nvm/versions/node/v1"));
    write(join(home, "escape/bin/node"), planted);
    const note = "; nvm default alias is not a version number: ";
    for (const [alias, reported] of [
      ["1 ./evil", `${note}1 ./evil`],
      ["1\t./evil", `${note}1\t./evil`],
      ["1/../../../../escape", `${note}1/../../../../escape`],
      ["v20.1.0 # pinned", `${note}20.1.0 # pinned`],
      ["x".repeat(400), `${note}${"x".repeat(200)}`],
      ["node", ""],
      ["stable", ""],
    ]) {
      write(join(home, ".nvm/alias/default"), `${alias}\n`, 0o644);
      const result = run(shell, {
        env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
        cwd,
      });
      const label = JSON.stringify(alias);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderrLines, label).toEqual([
        `Remembrance node launcher: ${newest} v22.1.0${reported}`,
      ]);
      expect(existsSync(ran), label).toBe(false);
    }
  });

  it("finds Node.js when the host PATH is empty or only /usr/bin:/bin", () => {
    const hostHasNode = ["/usr/bin/node", "/bin/node"].some(existsSync);
    const home = fresh("gui-path-home");
    const nvmNode = linkNode(join(home, ".nvm/versions/node/v24.15.0/bin/node"));
    for (const PATH of ["", "/usr/bin:/bin"]) {
      const result = run(shell, {
        env: { HOME: home, PATH, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
      });
      expect(result.status, result.stderr).toBe(0);
      if (!hostHasNode) expect(chosen(result), JSON.stringify(PATH)).toBe(nvmNode);
      expect(result.probe.argv).toEqual([]);
    }
  });

  it("honours an exact nvm default alias when a newer version is installed", () => {
    const home = fresh("nvm-exact-home");
    const exact = linkNode(join(home, ".nvm/versions/node/v20.1.0/bin/node"));
    linkNode(join(home, ".nvm/versions/node/v20.10.0/bin/node"));
    write(join(home, ".nvm/alias/default"), "v20.1.0\n", 0o644);
    const result = run(shell, {
      env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(chosen(result)).toBe(exact);
  });

  it("orders minor and patch versions numerically", () => {
    for (const [older, newer] of [
      ["v20.9.1", "v20.9.10"],
      ["v20.9.1", "v20.10.0"],
    ]) {
      const home = fresh("nvm-order-home");
      const versions = join(home, ".nvm/versions/node");
      fakeNode(join(versions, `${older}/bin/node`), older);
      const expected = fakeNode(join(versions, `${newer}/bin/node`), newer);
      const result = run(shell, {
        env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(chosen(result), `${older} vs ${newer}`).toBe(expected);
    }
  });

  it("rejects a PATH node older than the floor, keeps stdin, and honours the nvm default alias", () => {
    const bin = fresh("old-bin");
    fakeNode(join(bin, "node"), "v16.20.0");
    const home = fresh("nvm-alias-home");
    const aliased = linkNode(join(home, ".nvm/versions/node/v20.1.0/bin/node"));
    linkNode(join(home, ".nvm/versions/node/v22.3.0/bin/node"));
    write(join(home, ".nvm/alias/default"), "20\n", 0o644);
    const result = run(shell, {
      env: { HOME: home, PATH: `${bin}:${toolsDir}`, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
      input: "first line\nsecond line\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(chosen(result)).toBe(aliased);
    expect(result.probe.stdin).toBe("first line\nsecond line\n");
  });

  it("picks the newest working nvm version by number when no alias names one", () => {
    const home = fresh("nvm-newest-home");
    const versions = join(home, ".nvm/versions/node");
    fakeNode(join(versions, "v8.0.0/bin/node"), "v8.0.0");
    fakeNode(join(versions, "v22.9.0/bin/node"), "v22.9.0");
    const newest = fakeNode(join(versions, "v22.10.0/bin/node"), "v22.10.0");
    write(join(versions, "v23.0.0/bin/node"), "#!/bin/sh\n", 0o644);
    write(join(home, ".nvm/alias/default"), "lts/*\n", 0o644);
    const result = run(shell, {
      env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(chosen(result)).toBe(newest);
    expect(result.stderrLines).toHaveLength(1);
  });

  it("finds Node.js in each documented version-manager and system layout", () => {
    const layouts = [
      ["NVM_DIR", "custom-nvm", "versions/node/v20.0.0/bin/node"],
      ["VOLTA_HOME", "volta", "bin/node"],
      [null, ".volta", "bin/node"],
      ["FNM_DIR", "fnm", "aliases/default/bin/node"],
      ["FNM_DIR", "fnm", "node-versions/v20.0.0/installation/bin/node"],
      ["XDG_DATA_HOME", "xdg", "fnm/node-versions/v20.0.0/installation/bin/node"],
      [null, "Library/Application Support/fnm", "node-versions/v20.0.0/installation/bin/node"],
      [null, ".fnm", "node-versions/v20.0.0/installation/bin/node"],
      ["N_PREFIX", "n", "bin/node"],
      [null, ".n", "bin/node"],
      ["ASDF_DATA_DIR", "asdf", "installs/nodejs/20.0.0/bin/node"],
      [null, ".nodenv", "versions/20.0.0/bin/node"],
      ["MISE_DATA_DIR", "mise", "installs/node/20.0.0/bin/node"],
      [null, ".local/share/mise", "installs/node/20.0.0/bin/node"],
      ["MISE_DATA_DIR", "mise", "installs/node/lts/bin/node"],
      ["REMEMBRANCE_NODE_LAUNCHER_SYSTEM_ROOT", "system", "usr/local/bin/node"],
      ["REMEMBRANCE_NODE_LAUNCHER_SYSTEM_ROOT", "system", "opt/homebrew/opt/node@22/bin/node"],
      ["REMEMBRANCE_NODE_LAUNCHER_SYSTEM_ROOT", "system", "usr/local/opt/node@20/bin/node"],
      [null, ".local", "bin/node"],
    ];
    for (const [variable, base, rest] of layouts) {
      const home = fresh("layout-home");
      const dir = join(home, base);
      const node = linkNode(join(dir, rest));
      const env = { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" };
      if (variable) env[variable] = dir;
      const result = run(shell, { env });
      expect(result.status, `${variable ?? "~"}/${base}/${rest}`).toBe(0);
      expect(chosen(result)).toBe(node);
    }
  });

  it("explains the fix on one stderr line and exits 127 when no Node.js is found", () => {
    const home = fresh("nothing-home");
    fakeNode(join(home, ".nvm/versions/node/v16.0.0/bin/node"), "v16.0.0");
    // Launcher variables are initialised, never taken from the environment.
    const result = run(shell, { env: { HOME: home, _skipped: "; inherited" } });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderrLines).toHaveLength(1);
    expect(result.stderr).toContain("REMEMBRANCE_NODE=/absolute/path/to/node");
    expect(result.stderr).toContain(`cannot find Node.js ${MIN} or newer`);
    // The same copy ships to every host, so the hint names no host's settings.
    expect(result.stderr).toContain("in the environment the host starts with");
    expect(result.stderr).not.toContain("settings.json");
    expect(result.stderr).not.toContain("node on PATH (");
    expect(result.stderr).not.toContain("inherited");
  });

  it("names the too-old node on PATH when that is why none was found", () => {
    const bin = fresh("too-old-bin");
    const old = fakeNode(join(bin, "node"), "v16.20.0");
    const result = run(shell, {
      env: { HOME: fresh("too-old-home"), PATH: `${bin}:${toolsDir}` },
    });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderrLines).toHaveLength(1);
    expect(result.stderr).toContain(`node on PATH (${old}) is v16.20.0`);
  });

  it("echoes an override and a rejected node's -v output as one bounded line", () => {
    const home = fresh("bounded-home");
    const override = `${join(home, "x".repeat(400))}\nsecond line`;
    const missing = run(shell, {
      env: { HOME: home, REMEMBRANCE_NODE: override },
    });
    expect(missing.status).toBe(127);
    expect(missing.stderrLines).toHaveLength(1);
    expect(missing.stderr).toContain(
      `REMEMBRANCE_NODE=${override.slice(0, 200)} is not an executable Node.js ${MIN} or newer;`,
    );
    const noisy = write(
      join(home, "noisy-node"),
      "#!/bin/sh\nprintf 'v16.20.0\\nsecond line\\n'\n",
    );
    const reported = run(shell, {
      env: { HOME: home, REMEMBRANCE_NODE: noisy },
    });
    expect(reported.status).toBe(127);
    expect(reported.stderrLines).toHaveLength(1);
    expect(reported.stderr).toContain(
      `REMEMBRANCE_NODE=${noisy} is not an executable Node.js ${MIN} or newer (it reports v16.20.0);`,
    );
    const bin = fresh("wordy-bin");
    const wordy = `v16.20.0-${"y".repeat(400)}`;
    const pathNode = write(
      join(bin, "node"),
      `#!/bin/sh\nprintf '%s\\nsecond line\\n' '${wordy}'\n`,
    );
    const skipped = run(shell, {
      env: { HOME: fresh("wordy-home"), PATH: `${bin}:${toolsDir}` },
    });
    expect(skipped.status).toBe(127);
    expect(skipped.stderrLines).toHaveLength(1);
    expect(skipped.stderr).toContain(
      `node on PATH (${pathNode}) is ${wordy.slice(0, 200)}). Install`,
    );
    const newline = join(fresh("newline-bin"), "a\nb");
    fakeNode(join(newline, "node"), "v16.20.0");
    const split = run(shell, {
      env: { HOME: fresh("newline-home"), PATH: `${newline}:${toolsDir}` },
    });
    expect(split.status).toBe(127);
    expect(split.stderrLines).toHaveLength(1);
    expect(split.stderr).toContain(
      `node on PATH (${newline.split("\n")[0]}) is v16.20.0). Install`,
    );
  });

  it("bounds the debug line's node path and version to one line each", () => {
    const home = fresh("debug-bounded-home");
    const node = fakeNode(
      join(home, "y".repeat(150), "z".repeat(150), "node"),
      "v24.0.0-x\nsecond line",
    );
    const result = run(shell, {
      env: {
        HOME: home,
        REMEMBRANCE_NODE: node,
        REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1",
      },
      args: [silent],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderrLines).toEqual([
      `Remembrance node launcher: ${node.slice(0, 200)} v24.0.0-x`,
    ]);
  });

  it("replaces itself with node instead of staying in the process tree", () => {
    const result = run(shell, { env: { REMEMBRANCE_NODE: process.execPath } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.pid).toBe(result.pid);
    expect(result.probe.ppid).toBe(process.pid);
  });

  it("prints exactly one debug line to stderr and nothing to stdout", () => {
    const home = fresh("debug-home");
    const node = linkNode(join(home, ".nvm/versions/node/v24.0.0/bin/node"));
    const result = run(shell, {
      env: { HOME: home, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
      args: [silent],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderrLines).toEqual([
      `Remembrance node launcher: ${node} ${process.version}`,
    ]);
  });
});

// Live proof: the real manifests, a host PATH without node, and a Node.js that
// exists only under nvm, as for a desktop app or IDE started outside a shell.
describe("plugin manifests run through the launcher on a PATH without node", () => {
  const home = fresh("live-home");
  const nvmNode = linkNode(join(home, ".nvm/versions/node/v24.15.0/bin/node"));
  write(join(home, ".nvm/alias/default"), "v24.15.0\n", 0o644);
  const state = fresh("live-state");
  const hostPath = "/usr/bin:/bin";
  const hostHasNode = ["/usr/bin/node", "/bin/node"].some(existsSync);
  const expand = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  const baseEnv = {
    HOME: home,
    PATH: hostPath,
    CLAUDE_PLUGIN_ROOT: root,
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_STATE_HOME: join(state, "state"),
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_DATA_HOME: join(state, "data"),
    TMPDIR: fresh("live-tmp"),
    REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
    REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1",
    NODE_OPTIONS: `--import=${OFFLINE_FETCH_IMPORT}`,
  };
  const expectNvmChoice = (stderr) => {
    if (!hostHasNode) expect(stderr).toContain(`launcher: ${nvmNode} v24.15.0`);
  };

  it("starts the bundled MCP server exactly as .mcp.json declares it", async () => {
    const server = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"))
      .mcpServers.remembrance;
    const env = { ...baseEnv };
    for (const [key, value] of Object.entries(server.env)) {
      env[key] = value.replace(/^\$\{[A-Z_]+:-\}$/, "");
    }
    const child = spawn(expand(server.command), server.args.map(expand), {
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((done) => child.on("close", done));
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "node-launcher-test", version: "1.0.0" },
          },
        })}\n`,
      );
      const startedAt = Date.now();
      let response;
      while (!response && Date.now() - startedAt < 10_000) {
        response = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 1);
        if (!response) await delay(25);
      }
      expect(response, stderr).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: expect.any(String),
          capabilities: expect.any(Object),
          serverInfo: { name: "@remembrance-ai/mcp-server" },
        },
      });
      expectNvmChoice(stderr);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });

  it.each([
    ["SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    [
      "UserPromptSubmit",
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
      },
    ],
  ])("runs the %s hook command from hooks.json", (event, input) => {
    const { hooks } = JSON.parse(
      readFileSync(resolve(root, "hooks/hooks.json"), "utf8"),
    );
    const command = hooks[event][0].hooks[0].command;
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: baseEnv,
      input: JSON.stringify({ ...input, session_id: "node-launcher-live" }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: event,
      additionalContext: expect.stringContaining("Remembrance"),
    });
    expectNvmChoice(result.stderr);
  });
});

// Native Windows cannot run here. These tests pin the Windows mechanism and
// replay the pinned host's own command handling with Windows rules; running
// node-launcher.cmd itself is not covered.
describe("native Windows startup without sh", () => {
  const repoRoot = resolve(root, "../..");
  const twin = resolve(root, "scripts/node-launcher.cmd");
  const claudeCli = readFileSync(
    resolve(repoRoot, "node_modules/@anthropic-ai/claude-code/cli.js"),
    "utf8",
  );
  const server = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"))
    .mcpServers.remembrance;
  const hookCommands = Object.values(
    JSON.parse(readFileSync(resolve(root, "hooks/hooks.json"), "utf8")).hooks,
  ).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );

  function pluginCopy(name, files) {
    // Windows plugin roots contain dots (C:\Users\me\.claude\plugins\...).
    const dir = join(fresh(name), ".claude", "plugins", "remembrance");
    for (const file of files) {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      copyFileSync(resolve(root, file), join(dir, file));
    }
    return dir;
  }

  // Claude Code starts stdio MCP servers through its bundled cross-spawn.
  // Replay cross-spawn's win32 resolution (PATHEXT; batch files through
  // cmd.exe) in a child whose process.platform is win32.
  function resolveOnWindows(command, args) {
    const script = `
      const path = require("node:path");
      Object.defineProperty(process, "platform", { value: "win32" });
      path.delimiter = ";";
      process.env.PATHEXT = ".com;.exe;.bat;.cmd";
      const crossSpawn = require("node:module").createRequire(
        ${JSON.stringify(join(repoRoot, "package.json"))},
      )("cross-spawn");
      const [command, args] = JSON.parse(process.argv[1]);
      const parsed = crossSpawn._parse(command, args, { env: { PATH: "" } });
      process.stdout.write(JSON.stringify({
        command: parsed.command,
        args: parsed.args,
        file: parsed.file ?? null,
        verbatim: parsed.options.windowsVerbatimArguments === true,
      }));`;
    const result = spawnSync(
      process.execPath,
      ["-e", script, JSON.stringify([command, args])],
      { cwd: fresh("windows-cwd"), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  // cmd.exe cannot run here either. Replay its documented parsing of the
  // twin's FOR /F command lines: %name% and %~1 expand first; then quoted
  // text stays literal, while outside quotes ^x is a literal x (^" neither
  // opens nor closes quoting) and ) ends the IN clause. FOR runs the text
  // between the single quotes as `cmd /c <text>`, which drops the first and
  // the last quote when the text starts with one and holds more than two.
  function forCommand(line, variables) {
    const expanded = line.replace(
      /%~1|%(\w+)%/g,
      (match, name) => variables[name ?? "~1"] ?? match,
    );
    let index = expanded.indexOf(" in (") + " in (".length;
    let text = "";
    let quoted = false;
    for (; index < expanded.length; index += 1) {
      const char = expanded[index];
      if (!quoted && char === "^") text += expanded[++index];
      else if (!quoted && char === ")") break;
      else {
        if (char === '"') quoted = !quoted;
        text += char;
      }
    }
    expect(expanded.slice(index), "the IN clause ends early").toMatch(
      /^\) do /,
    );
    expect(text).toMatch(/^'.*'$/);
    const command = text.slice(1, -1);
    const last = command.lastIndexOf('"');
    return command.startsWith('"') && command.split('"').length > 3
      ? command.slice(1, last) + command.slice(last + 1)
      : command;
  }

  // The child cmd.exe's reading of that command: only an unquoted,
  // unescaped < or > redirects.
  function childCommand(command) {
    const words = [];
    const redirects = [];
    let word = null;
    let redirect = "";
    let quoted = false;
    const end = () => {
      if (word !== null) (redirect ? redirects : words).push(redirect + word);
      word = null;
      redirect = "";
    };
    for (let index = 0; index < command.length; index += 1) {
      const char = command[index];
      if (!quoted && char === "^") word = (word ?? "") + command[++index];
      else if (char === '"') {
        quoted = !quoted;
        word ??= "";
      } else if (!quoted && (char === "<" || char === ">")) {
        const handle = /^\d$/.test(word ?? "") ? word : "";
        if (!handle) end();
        redirect = handle + char;
        word = null;
      } else if (!quoted && char === " ") end();
      else word = (word ?? "") + char;
    }
    end();
    return { program: words[0], args: words.slice(1), redirects };
  }

  it("runs where.exe and each node -v probe by absolute path with stdin and stderr closed", () => {
    const commands = readFileSync(twin, "latin1")
      .split("\r\n")
      .filter((line) => /^for \/f .* in \('/.test(line));
    expect(commands).toHaveLength(2);
    const [where, probe] = commands;
    const closed = ["2>nul", "<nul"];
    // where.exe from System32, never a where.* in the current directory
    // (the user's project); $PATH: keeps that directory out of its search.
    expect(
      childCommand(forCommand(where, { SystemRoot: "C:\\WINDOWS" })),
    ).toEqual({
      program: "C:\\WINDOWS\\System32\\where.exe",
      args: ["$PATH:node.exe"],
      redirects: closed,
    });
    for (const node of [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
      "D:\\Tools & Co\\node.exe",
    ]) {
      expect(childCommand(forCommand(probe, { "~1": node })), node).toEqual({
        program: node,
        args: ["-v"],
        redirects: closed,
      });
    }
  });

  // Replays the twin's main flow, everything before :try, one statement at
  // a time: %%, %name% and %name:~a,b% expand first (case-insensitive
  // names), then, between setlocal EnableDelayedExpansion and endlocal,
  // !name! and !name:~a,b!. The where.exe line, :try and the final node run
  // are stubbed: `where` is what where.exe prints, `nodes` maps a candidate
  // to its -v output, and `accept` is the one :try accepts; the _min split
  // only feeds :try. Any other statement form throws, so the replay cannot
  // skip one.
  function replayTwin(environment, { where = [], nodes = {}, accept } = {}) {
    const lines = readFileSync(twin, "latin1").split("\r\n");
    const flow = lines.slice(0, lines.indexOf(":try"));
    const variables = new Map(
      Object.entries(environment).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const get = (name) => variables.get(name.toLowerCase());
    const set = (name, value) =>
      value === undefined || value === ""
        ? variables.delete(name.toLowerCase())
        : variables.set(name.toLowerCase(), value);
    const cut = (value = "", range) => {
      if (!range) return value;
      const [start, length] = range.slice(2).split(",").map(Number);
      return value.slice(start, start + length);
    };
    let delayed = false;
    const expand = (line) => {
      const text = line.replace(
        /%%|%([^%:]+)(:~\d+,\d+)?%/g,
        (all, name, range) => (all === "%%" ? "%" : cut(get(name), range)),
      );
      return delayed
        ? text.replace(/!([^!:]+)(:~\d+,\d+)?!/g, (all, name, range) =>
            cut(get(name), range),
          )
        : text;
    };
    const result = { stderr: [], tried: [], whereRuns: 0, ran: null };
    let errorlevel = 0;
    const statement = (text) => {
      let m;
      if ((m = text.match(/^if (not )?defined (\S+) (.+)$/)))
        return (get(m[2]) !== undefined) !== Boolean(m[1])
          ? statement(m[3])
          : null;
      if ((m = text.match(/^if not errorlevel 1 (.+)$/)))
        return errorlevel < 1 ? statement(m[1]) : null;
      if ((m = text.match(/^if not "([^"]*)"=="([^"]*)" (.+)$/)))
        return m[1] !== m[2] ? statement(m[3]) : null;
      if ((m = text.match(/^set "([^=]+)=(.*)"$/)))
        return (set(m[1], m[2]), null);
      if ((m = text.match(/^goto (\w+)$/))) return { goto: m[1] };
      if ((m = text.match(/^call :try "(.*)"$/))) {
        result.tried.push(m[1]);
        set("_ver", nodes[m[1]]);
        errorlevel = m[1] === accept ? 0 : 1;
        if (!errorlevel) set("_node", m[1]);
        return null;
      }
      if ((m = text.match(/^>&2 echo\((.*)$/)))
        return (result.stderr.push(m[1]), null);
      if ((m = text.match(/^exit \/b ?(\d*)$/)))
        return { exit: Number(m[1] || errorlevel) };
      if ((m = text.match(/^"(.+)" %\*$/))) return ((result.ran = m[1]), null);
      throw new Error(`the replay does not model: ${text}`);
    };
    let index = flow.indexOf(
      "setlocal EnableExtensions DisableDelayedExpansion",
    );
    expect(index).toBeGreaterThan(-1);
    for (let steps = 0; ++index < flow.length; steps += 1) {
      expect(steps, "the replay loops").toBeLessThan(200);
      const line = flow[index];
      if (line === "" || /^(:|rem\b)/.test(line)) continue;
      if (/^(setlocal EnableDelayedExpansion|endlocal)$/.test(line)) {
        delayed = line !== "endlocal";
        continue;
      }
      if (line.startsWith('for /f "tokens=1-3 delims=." ')) {
        index = flow.indexOf(")", index);
        continue;
      }
      if (/^for \/f .*where\.exe/.test(line)) {
        result.whereRuns += 1;
        if (where.length > 0) set("_cand", where[0]);
        continue;
      }
      const action = statement(expand(line));
      if (action?.goto) index = flow.indexOf(`:${action.goto}`);
      expect(index, action?.goto).toBeGreaterThan(-1);
      if (action?.exit !== undefined) return { ...result, code: action.exit };
    }
    throw new Error("the replay ran past the main flow");
  }

  it("names what it searched and bounds every echoed value", () => {
    const windows = {
      SystemRoot: "C:\\WINDOWS",
      ProgramFiles: "C:\\Program Files",
    };
    const programFilesNode = "C:\\Program Files\\nodejs\\node.exe";
    const hint = `. Install Node.js ${MIN}+ where this host can see it, or set REMEMBRANCE_NODE=C:\\absolute\\path\\to\\node.exe in the environment the host starts with, then fully restart the host.`;
    const notFound = (searched) =>
      `Remembrance: cannot find Node.js ${MIN} or newer (searched ${searched})${hint}`;
    const old = { [programFilesNode]: "v16.20.0" };
    // Nothing usable: the message names both places it searched.
    expect(replayTwin(windows, { nodes: old })).toMatchObject({
      code: 127,
      whereRuns: 1,
      tried: [programFilesNode],
      stderr: [notFound("PATH and %ProgramFiles%\\nodejs")],
    });
    // Without SystemRoot there is no where.exe: PATH is not searched, and
    // the message says so instead of claiming it was.
    const { SystemRoot, ...noSystemRoot } = windows;
    expect(SystemRoot).toBeTruthy();
    expect(
      replayTwin(noSystemRoot, { where: ["C:\\nodejs\\node.exe"], nodes: old }),
    ).toMatchObject({
      code: 127,
      whereRuns: 0,
      tried: [programFilesNode],
      stderr: [
        notFound(
          "%ProgramFiles%\\nodejs; PATH was not searched because SystemRoot is unset",
        ),
      ],
    });
    const { ProgramFiles, ...noProgramFiles } = windows;
    expect(ProgramFiles).toBeTruthy();
    const long = `D:\\${"x".repeat(300)}\\node.exe`;
    const wordy = `v16.20.0-${"y".repeat(300)}`;
    expect(
      replayTwin(noProgramFiles, { where: [long], nodes: { [long]: wordy } }),
    ).toMatchObject({
      code: 127,
      tried: [long],
      stderr: [
        notFound(
          `PATH; %ProgramFiles%\\nodejs was not searched because ProgramFiles is unset; node.exe on PATH (${long.slice(0, 200)}) is ${wordy.slice(0, 200)}`,
        ),
      ],
    });
    expect(
      replayTwin({}, { where: [long], nodes: { [long]: wordy } }),
    ).toMatchObject({
      code: 127,
      whereRuns: 0,
      tried: [],
      stderr: [
        notFound(
          "nothing; PATH was not searched because SystemRoot is unset; %ProgramFiles%\\nodejs was not searched because ProgramFiles is unset",
        ),
      ],
    });
    // An override and an accepted node's -v output echo at most 200
    // characters; the node that runs is the full path.
    expect(
      replayTwin(
        { ...windows, REMEMBRANCE_NODE: long },
        { nodes: { [long]: wordy } },
      ),
    ).toMatchObject({
      code: 127,
      whereRuns: 0,
      stderr: [
        `Remembrance: REMEMBRANCE_NODE=${long.slice(0, 200)} is not an executable Node.js ${MIN} or newer (it reports ${wordy.slice(0, 200)}); point it at a working node.exe or unset it, then fully restart the host.`,
      ],
    });
    const fresh = `v24.0.0-${"z".repeat(300)}`;
    expect(
      replayTwin(
        { ...windows, REMEMBRANCE_NODE_LAUNCHER_DEBUG: "1" },
        { where: [long], nodes: { [long]: fresh }, accept: long },
      ),
    ).toMatchObject({
      code: 0,
      tried: [long],
      ran: long,
      stderr: [
        `Remembrance node launcher: ${long.slice(0, 200)} ${fresh.slice(0, 200)}`,
      ],
    });
  });

  it("ships a CRLF batch twin that keeps the launcher's contract", () => {
    const bytes = readFileSync(twin);
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
    const text = bytes.toString("latin1");
    const lines = text.split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines.filter((line) => line.includes("\n"))).toEqual([]);
    expect(lines[0]).toBe("@echo off");
    expect(text.match(/^set "_min=.*"$/gm)).toEqual([`set "_min=${MIN}"`]);
    // stdout is the MCP transport: every message goes to stderr.
    const echoes = lines.filter(
      (line) => /\becho\b/i.test(line) && !/^rem\b/i.test(line),
    );
    expect(echoes[0]).toBe("@echo off");
    for (const line of echoes.slice(1)) expect(line).toMatch(/^>&2 echo\(/);
    expect(lines).toContain('"%_node%" %*');
    expect(lines.filter((line) => line === "exit /b 127")).toHaveLength(2);
    expect(lines).toContain('if /i not "%~x1"==".exe" exit /b 1');
    const eol = spawnSync(
      "git",
      ["ls-files", "--eol", "--", "scripts/node-launcher.cmd"],
      { cwd: root, encoding: "utf8" },
    );
    expect(eol.stdout).toMatch(/^i\/crlf\s+w\/crlf\s+attr\/-text\s/);
  });

  it("keeps the MCP launcher executable in the committed tree", () => {
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    const staged = spawnSync(
      "git",
      ["ls-files", "-s", "--", "scripts/node-launcher"],
      { cwd: root, encoding: "utf8" },
    );
    expect(staged.stdout).toMatch(/^100755 /);
  });

  it("keeps the launchers' line endings in a Windows-style mirror checkout", async () => {
    // Claude Code clones the marketplace with the user's git settings; Git for
    // Windows defaults to core.autocrlf=true.
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "launcher-test",
      GIT_AUTHOR_EMAIL: "launcher-test@example.invalid",
      GIT_COMMITTER_NAME: "launcher-test",
      GIT_COMMITTER_EMAIL: "launcher-test@example.invalid",
    };
    const git = (cwd, ...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
      expect(result.status, result.stderr).toBe(0);
    };
    const { stagePublicMirror } = await import(
      pathToFileURL(resolve(repoRoot, "scripts/sync-public-mirror.mjs")).href
    );
    const staged = fresh("mirror");
    await stagePublicMirror(staged, repoRoot);
    const launchers = ["claude-code", "codex", "cursor", "vscode"].map(
      (host) => `packages/${host}-plugin/scripts/node-launcher`,
    );
    const twinPath = "packages/claude-code-plugin/scripts/node-launcher.cmd";
    const checkout = (files) => {
      const repo = fresh("mirror-repo");
      for (const file of files) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        copyFileSync(join(staged, file), join(repo, file));
      }
      git(repo, "init", "-q");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "mirror");
      const clone = join(fresh("windows-clone"), "clone");
      git(repo, "clone", "-q", "-c", "core.autocrlf=true", repo, clone);
      return clone;
    };

    const windows = checkout([".gitattributes", ...launchers, twinPath]);
    for (const file of launchers) {
      expect(readFileSync(join(windows, file), "latin1"), file).not.toContain("\r");
      expect(spawnSync("/bin/sh", ["-n", join(windows, file)]).status).toBe(0);
    }
    expect(statSync(join(windows, launchers[0])).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(windows, twinPath))).toEqual(readFileSync(twin));

    // Without the published rules the same checkout gives the launcher CRLF
    // line endings, which sh cannot parse.
    const bare = checkout([...launchers, twinPath]);
    expect(readFileSync(join(bare, launchers[0]), "latin1")).toContain("\r\n");
    expect(spawnSync("/bin/sh", ["-n", join(bare, launchers[0])]).status).not.toBe(0);
  });

  it("resolves the MCP entry to node-launcher.cmd through cmd.exe", () => {
    expect(claudeCli).toContain('iL5=/\\.(?:com|exe)$/i');
    expect(claudeCli).toContain('q.args=["/d","/s","/c",`"${Y}"`]');
    const pluginRoot = pluginCopy("windows-plugin", [
      "scripts/node-launcher",
      "scripts/node-launcher.cmd",
    ]);
    const at = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
    const parsed = resolveOnWindows(at(server.command), server.args.map(at));
    expect(parsed.file).toBe(join(pluginRoot, "scripts/node-launcher.cmd"));
    expect(parsed.command).toBe("cmd.exe");
    expect(parsed.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(parsed.verbatim).toBe(true);
    expect(parsed.args[3]).toMatch(/^"[^ ]*node-launcher [^ ]*remembrance-mcp\.mjs/);
  });

  it("needs sh on Windows without the twin, as the old sh entry did", () => {
    const pluginRoot = pluginCopy("windows-no-twin", ["scripts/node-launcher"]);
    const launcherCopy = join(pluginRoot, "scripts/node-launcher");
    // The launcher's #!/bin/sh sends cross-spawn to an sh it cannot find.
    const noTwin = resolveOnWindows(launcherCopy, ["server.mjs"]);
    expect(noTwin.command).toBe("cmd.exe");
    expect(noTwin.args[3]).toMatch(/^"sh /);
    const oldEntry = resolveOnWindows("sh", [launcherCopy, "server.mjs"]);
    expect(oldEntry.file).toBeNull();
    expect(oldEntry.args[3]).toMatch(/^"sh /);
  });

  it("keeps hook commands out of Claude Code's Windows .sh rewrite", () => {
    // Claude Code 2.1.89 on Windows runs hooks in Git Bash and prefixes any
    // command that mentions ".sh" with `bash `.
    expect(claudeCli).toContain(
      'k.trim().match(/\\.sh(\\s|$|")/)){if(!k.trim().startsWith("bash "))k=`bash ${k}`}',
    );
    const rewritten = (command) =>
      /\.sh(\s|$|")/.test(command.trim()) &&
      !command.trim().startsWith("bash ")
        ? `bash ${command}`
        : command;
    const gitBashRoot = "/c/Users/dev/.claude/plugins/cache/remembrance/remembrance/0.2.0";
    expect(hookCommands).toHaveLength(9);
    for (const command of hookCommands) {
      const expanded = command.replaceAll("${CLAUDE_PLUGIN_ROOT}", gitBashRoot);
      expect(rewritten(expanded)).toBe(expanded);
    }

    // The previous launcher name was rewritten into `bash sh ...`, which
    // bash refuses (sh is a binary, not a script): every hook failed.
    const dir = fresh("rewrite");
    const oldLauncher = join(dir, "node-launcher.sh");
    copyFileSync(launcher, oldLauncher);
    const env = { PATH: "/usr/bin:/bin", REMEMBRANCE_NODE: process.execPath };
    const old = spawnSync(
      "/bin/sh",
      ["-c", rewritten(`sh "${oldLauncher}" "${silent}"`)],
      { cwd: dir, encoding: "utf8", env },
    );
    expect(old.status).toBe(126);
    expect(old.stderr).toMatch(/cannot execute binary file/);
    const current = spawnSync(
      "/bin/sh",
      ["-c", rewritten(`sh "${launcher}" "${silent}"`)],
      { cwd: dir, encoding: "utf8", env },
    );
    expect(current.status, current.stderr).toBe(0);
  });
});
