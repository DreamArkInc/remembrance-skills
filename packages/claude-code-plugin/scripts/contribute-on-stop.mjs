#!/usr/bin/env node

// Completion hook — the contribution mirror of query-on-prompt.mjs.
//
// The query hook automates CONSUMPTION (it queries Remembrance on every prompt).
// Contribution had no trigger, so agents reliably query but rarely submit what
// they learned. This Stop hook closes that asymmetry: when a session that
// actually used Remembrance is about to end, it blocks the stop ONCE and asks
// the agent to contribute a redacted remembrance / feedback / skill idea.
//
// Safety:
// - Env-flagged: disable with REMEMBRANCE_AUTO_CONTRIBUTE in {0,false,no}.
// - Loop-safe: Claude Code sets stop_hook_active=true on the continuation a
//   Stop-block causes, so the second stop is always allowed. A per-session
//   sentinel is a second guard so the agent is prompted at most once per session.
// - Non-nagging: only blocks when the transcript shows Remembrance was used this
//   session. If usage can't be determined, it allows the stop.
// - Fail-open: any error allows the stop.
// - The agent can satisfy it by contributing OR by briefly declining; either way
//   it is not asked again.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

export function contributeDisabled(value) {
  return /^(0|false|no)$/i.test(String(value ?? "").trim());
}

// True when the session's transcript shows Remembrance was engaged — an
// auto-query context injection, a Remembrance MCP tool call, a REST agent
// endpoint, or the remembrancer skill. Boolean only; no transcript content is
// ever emitted by this hook.
export function sessionUsedRemembrance(transcript) {
  const text = String(transcript ?? "");
  if (!text) {
    return false;
  }
  return (
    /Remembrance auto-query context/i.test(text) ||
    /mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource|submit_remembrance|submit_feedback|submit_suggestion|submit_resource|propose_skill_idea)/i.test(
      text,
    ) ||
    /\/api\/v1\/agent\/(query|remembrances|skill-ideas|suggestions|feedback)\b/i.test(
      text,
    ) ||
    /\bremembrancer\b/i.test(text)
  );
}

// Count only CONSUMPTION of the registry (queries / explicit skill retrieval) — not the
// agent's own submissions. The decision re-prompts when consumption has grown
// since the last prompt, so a long session with several distinct skill uses
// gets several nudges, while contributing (submit_*) never triggers a re-prompt.
const CONSUMPTION_MARKERS =
  /Remembrance auto-query context|mcp__[a-z0-9_]*remembrance[a-z0-9_]*__(query_skills|get_skill|get_resource)|\/api\/v1\/agent\/query\b/gi;

export function countRegistryConsumption(transcript) {
  const matches = String(transcript ?? "").match(CONSUMPTION_MARKERS);
  return matches ? matches.length : 0;
}

export function contributionReason() {
  return [
    "Before you finish: you used Remembrance this session.",
    "If you learned something reusable — a lesson, a gotcha, a fix, a skill that helped, or a skill that was missing — contribute it now so the next agent inherits it instead of rediscovering it:",
    "• submit_remembrance — a redacted, evidence-backed lesson tied to the skill/resource you used (the fastest path: a prior submit_feedback response includes a ready next_step.submit_remembrance_payload you can post as-is).",
    "• submit_feedback — a quick useful / not-useful signal plus a one-line lesson.",
    "• propose_skill_idea — only if no existing skill fit and you built a reusable workflow.",
    "Redact secrets, private URLs, and proprietary content; submit redacted summaries and hashes, not raw traces.",
    "If nothing is genuinely worth capturing, just say so in one line — you will not be asked again this session.",
  ].join("\n");
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
  if (contributeDisabled(env.REMEMBRANCE_AUTO_CONTRIBUTE)) {
    return { allow: true, why: "disabled" };
  }
  if (input?.stop_hook_active) {
    return { allow: true, why: "stop_hook_active" };
  }
  const sessionId = input?.session_id ?? "unknown";
  const read = options.readTranscript ?? readTranscriptSafe;
  const consumption = countRegistryConsumption(read(input?.transcript_path));
  if (consumption === 0) {
    return { allow: true, why: "registry_not_used" };
  }
  const readCount = options.readCount ?? readPromptedCount;
  if (consumption <= readCount(sessionId)) {
    return { allow: true, why: "no_new_usage" };
  }
  return {
    allow: false,
    why: "prompt_contribution",
    reason: contributionReason(),
    consumption,
  };
}

export async function handleStopHook(input, options = {}) {
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
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(() => {
    // Never block a stop on an unexpected error.
  });
}
