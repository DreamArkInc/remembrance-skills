import { spawn } from "node:child_process";
import { constants as fsConstants, accessSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import process from "node:process";

const REMEMBRANCE_PLUGIN_ID = "remembrance@remembrance";
const REQUIRED_HOOKS = new Map([
  ["sessionStart", "SessionStart"],
  ["userPromptSubmit", "UserPromptSubmit"],
  ["postToolUse", "PostToolUse"],
  ["stop", "Stop"],
]);
const TRUSTED_STATUSES = new Set(["managed", "trusted"]);
const DEFAULT_TIMEOUT_MS = 1_500;
const FORCE_KILL_GRACE_MS = 250;

export function summarizeCodexHookTrust(entries, now = new Date()) {
  const hooks = Array.isArray(entries)
    ? entries.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.pluginId === REMEMBRANCE_PLUGIN_ID,
      )
    : [];
  if (hooks.length === 0) {
    return unavailableHookTrust("plugin_hooks_not_listed", now);
  }

  const byEvent = new Map(hooks.map((entry) => [entry.eventName, entry]));
  const normalizedHooks = [];
  for (const [eventName, displayName] of REQUIRED_HOOKS) {
    const entry = byEvent.get(eventName);
    const trustStatus = normalizedTrustStatus(entry?.trustStatus);
    normalizedHooks.push({
      event: displayName,
      enabled: entry?.enabled === true,
      trust_status: entry ? trustStatus : "missing",
    });
  }
  const reviewEvents = normalizedHooks
    .filter(
      (entry) => !entry.enabled || !TRUSTED_STATUSES.has(entry.trust_status),
    )
    .map((entry) => entry.event);

  return {
    status: reviewEvents.length > 0 ? "review_required" : "trusted",
    checked_at: now.toISOString(),
    review_events: reviewEvents,
    hooks: normalizedHooks,
  };
}

export async function inspectCodexHookTrust(options = {}) {
  const env = options.env ?? process.env;
  if (
    /^(0|false|no)$/i.test(
      String(env.REMEMBRANCE_CODEX_HOOK_TRUST_CHECK ?? "").trim(),
    ) ||
    (process.env.VITEST && !options.spawnImpl)
  ) {
    return unavailableHookTrust(
      "check_disabled",
      options.now?.() ?? new Date(),
    );
  }

  const codexPath =
    options.codexPath ?? resolveCodexExecutable(env, options.platform);
  if (!codexPath) {
    return unavailableHookTrust(
      "codex_executable_not_found",
      options.now?.() ?? new Date(),
    );
  }

  return requestHookList({
    codexPath,
    cwd: options.cwd ?? process.cwd(),
    env,
    now: options.now ?? (() => new Date()),
    spawnImpl: options.spawnImpl ?? spawn,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

export function resolveCodexExecutable(
  env = process.env,
  platform = process.platform,
) {
  const candidates = [];
  const configured = String(env.REMEMBRANCE_CODEX_CLI_PATH ?? "").trim();
  if (configured && isAbsolute(configured)) candidates.push(configured);
  for (const name of ["CODEX_CLI_PATH", "CODEX_CLI"]) {
    const value = String(env[name] ?? "").trim();
    if (value && isAbsolute(value)) candidates.push(value);
  }
  if (platform === "darwin") {
    candidates.push(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    );
  }
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  for (const directory of String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .slice(0, 64)) {
    candidates.push(resolve(directory, executableName));
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit or platform-owned executable.
    }
  }
  return null;
}

function requestHookList({ codexPath, cwd, env, now, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdout = "";
    let forceKillTimer;
    const stopChild = () => {
      try {
        child?.stdin?.end?.();
        child?.stdin?.destroy?.();
        child?.stdout?.destroy?.();
      } catch {
        // Continue with process termination.
      }
      try {
        child?.kill?.("SIGTERM");
        forceKillTimer = setTimeout(() => {
          try {
            child?.kill?.("SIGKILL");
          } catch {
            // The diagnostic has already returned.
          }
        }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      } catch {
        // The diagnostic is already complete.
      }
      child?.unref?.();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(unavailableHookTrust("hooks_list_timeout", now())),
      Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    timer.unref?.();

    try {
      child = spawnImpl(codexPath, ["app-server", "--stdio"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.on?.("error", () =>
        finish(unavailableHookTrust("app_server_unavailable", now())),
      );
      child.on?.("close", () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (!settled) {
          finish(unavailableHookTrust("app_server_closed", now()));
        }
      });
      child.stdout?.on?.("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 512 * 1024) {
          finish(unavailableHookTrust("hooks_list_too_large", now()));
          return;
        }
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message?.id === 1) {
            if (message.error) {
              finish(
                unavailableHookTrust("app_server_initialize_failed", now()),
              );
              return;
            }
            writeMessage(child, {
              id: 2,
              method: "hooks/list",
              params: { cwds: [cwd] },
            });
          } else if (message?.id === 2) {
            if (message.error) {
              finish(unavailableHookTrust("hooks_list_failed", now()));
              return;
            }
            const entries = Array.isArray(message?.result?.data)
              ? message.result.data.flatMap((entry) =>
                  Array.isArray(entry?.hooks) ? entry.hooks : [],
                )
              : [];
            finish(summarizeCodexHookTrust(entries, now()));
            return;
          }
        }
      });
      writeMessage(child, {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "remembrance-hook-health", version: "1" },
          capabilities: { experimentalApi: true },
        },
      });
    } catch {
      finish(unavailableHookTrust("app_server_unavailable", now()));
    }
  });
}

function writeMessage(child, message) {
  child.stdin?.write?.(`${JSON.stringify(message)}\n`);
}

function normalizedTrustStatus(value) {
  const status = String(value ?? "unknown")
    .trim()
    .toLowerCase();
  return ["managed", "modified", "trusted", "untrusted"].includes(status)
    ? status
    : "unknown";
}

function unavailableHookTrust(reason, now) {
  return {
    status: "unavailable",
    checked_at: now.toISOString(),
    review_events: [],
    hooks: [],
    reason,
  };
}
