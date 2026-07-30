#!/usr/bin/env node

import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_PLUGIN_PACKAGE = "@remembrance-ai/opencode-plugin";
const LEGACY_OPENCODE_PLUGIN_PACKAGE = "@remembrance/opencode-plugin";

function isPackageSpec(value, packageName) {
  return value === packageName || value.startsWith(`${packageName}@`);
}

export function defaultOpenCodeConfigPath(env = process.env, home = homedir()) {
  if (env.OPENCODE_CONFIG?.trim()) {
    return resolve(env.OPENCODE_CONFIG.trim());
  }
  const configRoot =
    env.OPENCODE_CONFIG_DIR?.trim() ||
    join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "opencode");
  return resolve(configRoot, "opencode.json");
}

export function updateOpenCodeConfigText(source, version) {
  const initial = source.trim() ? source : "{}\n";
  const errors = [];
  const parsed = parse(initial, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    errors.length > 0 ||
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    const detail =
      errors.length > 0
        ? printParseErrorCode(errors[0].error)
        : "root must be an object";
    throw new Error(
      `OpenCode config is not valid JSONC (${detail}); no changes were written.`,
    );
  }

  const pluginSpec = `${OPENCODE_PLUGIN_PACKAGE}@${version}`;
  const currentPlugins = Array.isArray(parsed.plugin)
    ? parsed.plugin.filter((value) => typeof value === "string")
    : [];
  const plugins = [
    ...currentPlugins.filter(
      (value) =>
        ![OPENCODE_PLUGIN_PACKAGE, LEGACY_OPENCODE_PLUGIN_PACKAGE].some(
          (packageName) => isPackageSpec(value, packageName),
        ),
    ),
    pluginSpec,
  ];
  const remembranceMcp = {
    type: "local",
    command: ["npx", "-y", `@remembrance-ai/mcp-server@${version}`],
    enabled: true,
    environment: {
      REMEMBRANCE_PLUGIN_HOST: "opencode",
    },
  };
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: initial.includes("\r\n") ? "\r\n" : "\n",
  };
  let next = initial;
  next = applyEdits(
    next,
    modify(next, ["plugin"], plugins, { formattingOptions }),
  );
  next = applyEdits(
    next,
    modify(next, ["mcp", "remembrance"], remembranceMcp, {
      formattingOptions,
    }),
  );
  return next.endsWith(formattingOptions.eol)
    ? next
    : `${next}${formattingOptions.eol}`;
}

export async function configureOpenCode({
  configPath = defaultOpenCodeConfigPath(),
  dryRun = false,
  packageVersion,
} = {}) {
  const version = packageVersion ?? (await readPackageVersion());
  let source = "";
  let existingMode = 0o600;
  try {
    source = await readFile(configPath, "utf8");
    existingMode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const updated = updateOpenCodeConfigText(source, version);
  if (dryRun) {
    return { configPath, updated, version, written: false };
  }

  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.remembrance-${process.pid}.tmp`;
  await writeFile(temporaryPath, updated, { mode: existingMode });
  await chmod(temporaryPath, existingMode);
  await rename(temporaryPath, configPath);
  return { configPath, updated, version, written: true };
}

async function readPackageVersion() {
  const parsed = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error("The installed opencode plugin has no package version.");
  }
  return parsed.version.trim();
}

export function parseArguments(argv) {
  let configPath;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "setup") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      configPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { configPath, dryRun };
}

export async function runSetupCli(
  argv,
  io = {
    log: (message) => console.log(message),
    write: (message) => process.stdout.write(message),
    error: (message) => console.error(message),
  },
) {
  try {
    const result = await configureOpenCode(parseArguments(argv));
    if (result.written) {
      io.log(
        `Configured Remembrance plugin and MCP in ${result.configPath}. Restart opencode, then call get_connection_status.`,
      );
    } else {
      io.write(result.updated);
    }
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isInvokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return (
      realpathSync(resolve(argvPath)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

const invokedDirectly = isInvokedDirectly(process.argv[1]);

/* v8 ignore start -- exercised by the install smoke as a real subprocess */
if (invokedDirectly) {
  runSetupCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
/* v8 ignore stop */
