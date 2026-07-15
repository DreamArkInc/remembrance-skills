#!/usr/bin/env node

// Claude Code Stop adapter — the contribution mirror of query-on-prompt.mjs.
//
// The query hook automates CONSUMPTION for explicit prompts and records task
// ELIGIBILITY for explicit or context-dependent prompts.
// Contribution had no trigger, so agents reliably query but rarely submit what
// they learned. This Stop hook closes that asymmetry: when reusable work or an
// actual Remembrance use is about to end, it blocks the stop ONCE. It can first
// recover a missed full-context query, then request a redacted contribution.
//
// Shared vs Claude-specific:
// - The runtime-agnostic pieces (contributeDisabled, countRegistryConsumption,
//   contributionReason) come from the shared hook-core.mjs, byte-identical across
//   the Codex / OpenClaw / Claude plugins (re-synced by `npm run sync:hook-core`).
// - The CONSUMPTION count is derived by SCANNING THE TRANSCRIPT here. Claude's
//   Stop payload carries a transcript_path, so — unlike Codex/OpenClaw, which
//   have no transcript and drive the same decision off per-session usage markers
//   — this adapter reads the transcript and counts consumption markers directly.
//   The per-session sentinel therefore lives under `remembrance-contribute` (a
//   single prompted-count file), not the marker directory the core's helpers use.
//
// Safety:
// - Env-flagged: disable with REMEMBRANCE_AUTO_CONTRIBUTE in {0,false,no}.
// - Loop-safe: Claude Code sets stop_hook_active=true on the continuation a
//   Stop-block causes, so the second stop is always allowed. A per-session
//   sentinel is a second guard so the agent is prompted at most once per session.
// - Non-nagging: only blocks when transcript/marker evidence shows registry use
//   or an eligible reusable task. If engagement can't be determined, it allows
//   the stop.
// - Fail-open: any error allows the stop.
// - The agent can satisfy it by contributing OR by briefly declining; either way
//   it is not asked again.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  contributeDisabled,
  contributionReason,
  countRegistryConsumption,
  countTaskEligibility,
  decideStop,
  readRegistryUseCount,
  readTaskEligibilityCount,
  reportTaskOutcomesOnStop,
} from "./hook-core.mjs";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

// Re-export the shared helpers the plugin test imports from this module.
export { contributeDisabled, contributionReason, countRegistryConsumption };

// True when the session's transcript shows Remembrance was engaged — an
// auto-query context injection, a Remembrance MCP tool call, a REST agent
// endpoint, or the remembrancer skill. Boolean only; no transcript content is
// ever emitted by this hook. (Claude-specific: keyed off the transcript, which
// only the Claude Stop payload provides.)
export function sessionUsedRemembrance(transcript) {
  const text = String(transcript ?? "");
  if (!text) {
    return false;
  }
  return (
    /Remembrance auto-query context/i.test(text) ||
    /mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource|submit_remembrance|submit_query_feedback|submit_feedback|submit_suggestion|submit_resource|propose_skill_idea)/i.test(
      text,
    ) ||
    /\/api\/v1\/agent\/(query|query-feedback|remembrances|skill-ideas|suggestions|feedback)\b/i.test(
      text,
    ) ||
    /\bremembrancer\b/i.test(text)
  );
}

function sentinelPath(sessionId) {
  const digest = createHash("sha256")
    .update(String(sessionId ?? "unknown"))
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "remembrance-contribute", `${digest}.count`);
}

// The consumption count at which we last prompted this session (0 if never).
function readPromptedCount(sessionId) {
  try {
    const raw = readFileSync(sentinelPath(sessionId), "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writePromptedCount(sessionId, count) {
  try {
    mkdirSync(join(tmpdir(), "remembrance-contribute"), { recursive: true });
    writeFileSync(sentinelPath(sessionId), String(count));
  } catch {
    // Non-fatal: stop_hook_active still prevents an immediate loop.
  }
}

function readTranscriptSafe(path) {
  if (!path || typeof path !== "string") {
    return "";
  }
  try {
    if (!existsSync(path)) {
      return "";
    }
    const raw = readFileSync(path, "utf8");
    return raw.length > MAX_TRANSCRIPT_BYTES
      ? raw.slice(raw.length - MAX_TRANSCRIPT_BYTES)
      : raw;
  } catch {
    return "";
  }
}

// Pure decision function (unit-tested): returns whether to allow the stop, and
// the block reason when it should prompt. Prompts when registry consumption has
// INCREASED since the last prompt this session — so it fires on the first use
// and again on each later distinct use, but never nags when nothing new was
// consumed and never re-fires just because the agent contributed.
// `readTranscript` / `readCount` are injectable so tests don't touch the FS.
export function decideContribution(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = input?.session_id ?? "unknown";
  const read = options.readTranscript ?? readTranscriptSafe;
  const transcript = read(input?.transcript_path);
  const transcriptConsumption = countRegistryConsumption(transcript);
  const transcriptEligibility = countTaskEligibility(transcript);
  const readUse = options.readUseCount ?? readRegistryUseCount;
  const readEligibility =
    options.readEligibilityCount ?? readTaskEligibilityCount;
  const readCount = options.readCount ?? readPromptedCount;
  const decision = decideStop(
    {
      session_id: sessionId,
      stop_hook_active: input?.stop_hook_active,
      last_assistant_message: transcript,
    },
    {
      env,
      readUseCount: () =>
        Math.max(transcriptConsumption, readUse(sessionId, env)),
      readEligibilityCount: () =>
        Math.max(transcriptEligibility, readEligibility(sessionId, env)),
      readPromptedCount: () => readCount(sessionId),
      readHighMatch: options.readHighMatch,
    },
  );
  return decision.allow
    ? { allow: true, why: decision.why }
    : {
        allow: false,
        why: decision.why,
        reason: decision.reason,
        consumption: decision.useCount,
      };
}

export async function handleStopHook(input, options = {}) {
  await (options.reportTaskOutcomes ?? reportTaskOutcomesOnStop)(
    input?.session_id ?? "unknown",
    input,
    {
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? fetch,
      userAgent: "@remembrance/claude-code-plugin",
    },
  );
  const decision = decideContribution(input, options);
  if (decision.allow) {
    return { allow: true, why: decision.why };
  }
  const writeCount = options.writeCount ?? writePromptedCount;
  writeCount(input?.session_id ?? "unknown", decision.consumption);
  return {
    allow: false,
    why: decision.why,
    output: { decision: "block", reason: decision.reason },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed input → allow the stop.
    return;
  }
  let result;
  try {
    result = await handleStopHook(input);
  } catch {
    // Fail open.
    return;
  }
  if (result && result.allow === false && result.output) {
    process.stdout.write(JSON.stringify(result.output));
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(() => {
    // Never block a stop on an unexpected error.
  });
}
