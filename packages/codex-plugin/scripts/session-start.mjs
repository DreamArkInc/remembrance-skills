#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { inspectCodexHookTrust } from "./codex-hook-trust.mjs";
import {
  checkForClientUpdate,
  recordPluginLifecycleHealth,
  resolveApiCredential,
  sessionIdFor,
  warmPrincipalSession,
} from "./hook-core.mjs";

function pluginVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

export async function handleSessionStart(input, options = {}) {
  const env = options.env ?? process.env;
  const credential = resolveApiCredential(env);
  const version = options.pluginVersion ?? pluginVersion();
  const hostVersion = String(
    input?.codex_version ?? input?.app_version ?? input?.version ?? "",
  ).trim();
  const recordHealth = options.recordHealth ?? recordPluginLifecycleHealth;
  const isCompaction =
    String(input?.source ?? "")
      .trim()
      .toLowerCase() === "compact";
  const auth =
    credential.source === "none"
      ? "public anonymous registry access"
      : `${credential.source.replace("_", " ")} organization credential`;
  const baseContext =
    `Remembrance plugin health: Codex SessionStart hook is active for plugin ${version}; ` +
    `the bundled local MCP server uses the same ${auth}. ` +
    "Run run_connection_doctor if setup seems incomplete. It verifies the active connection and gives one exact next step. If that tool is absent, report partial activation, update or reinstall the plugin, and fully restart Codex.";
  const [hookTrust, , clientUpdate] = isCompaction
    ? [null, null, null]
    : await Promise.all([
        (options.inspectHookTrust ?? inspectCodexHookTrust)({
          env,
          cwd: options.cwd,
        }).catch(() => null),
        (options.warmSession ?? warmPrincipalSession)(
          {
            runtime: "codex",
            hostSurface:
              input?.host_surface === "desktop" || input?.host_surface === "cli"
                ? input.host_surface
                : input?.app_version || input?.codex_desktop_version
                  ? "desktop"
                  : "unknown",
            clientVersion: version,
            hostVersion,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
        (options.checkUpdate ?? checkForClientUpdate)(
          {
            surface: "codex",
            currentVersion: version,
            fetchImpl: options.fetchImpl ?? fetch,
          },
          env,
        ).catch(() => null),
      ]);
  if (!isCompaction) {
    recordHealth(
      {
        surface: "codex",
        component: "session_start",
        pluginVersion: version,
        hostVersion,
        credentialSource: credential.source,
        sessionId: sessionIdFor(input),
        hookTrust,
      },
      env,
    );
  }
  const trustNotice =
    hookTrust?.status === "review_required"
      ? `Remembrance hook trust review is required for ${hookTrust.review_events.join(", ")}. Automatic skill-use or completion tracking is paused for those hooks. Run run_connection_doctor and follow its exact Codex review steps before claiming full activation.`
      : null;
  const notices = [trustNotice, clientUpdate?.notice].filter(Boolean);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        notices.length > 0
          ? `${baseContext}\n\n${notices.join("\n\n")}`
          : baseContext,
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  process.stdout.write(`${JSON.stringify(await handleSessionStart(input))}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Health context is advisory and must never block startup.
  });
}
