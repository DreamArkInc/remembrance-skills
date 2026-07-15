#!/usr/bin/env node
// Cursor stop adapter.
//
// If this Cursor session consumed Remembrance through MCP, or an eligible task
// reached Stop without a query, return followup_message once. The shared core
// chooses contribution or full-context query recovery accordingly.

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  decideStop,
  reportTaskOutcomesOnStop,
  sessionIdFor,
  writePromptedCount,
} from "./hook-core.mjs";
import { cursorSessionId } from "./record-mcp-use.mjs";

export function handleStop(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = cursorSessionId(input, env);
  const loopCount = Number(input?.loop_count ?? 0);
  const decision = decideStop(
    {
      session_id: sessionIdFor({ session_id: sessionId }),
      stop_hook_active: Number.isFinite(loopCount) && loopCount > 0,
      last_assistant_message:
        input?.last_assistant_message ??
        input?.lastAssistantMessage ??
        input?.assistant_message ??
        input?.message,
    },
    options,
  );
  if (decision.allow) {
    return { allow: true, why: decision.why };
  }
  const writePrompted = options.writePromptedCount ?? writePromptedCount;
  writePrompted(sessionId, decision.useCount, env);
  return {
    allow: false,
    why: decision.why,
    output: { followup_message: decision.reason },
  };
}

export async function handleStopHook(input, options = {}) {
  const env = options.env ?? process.env;
  const report = options.reportTaskOutcomes ?? reportTaskOutcomesOnStop;
  await report(cursorSessionId(input, env), input, {
    env,
    fetchImpl: options.fetchImpl ?? fetch,
    userAgent: "@remembrance/cursor-plugin",
  });
  return handleStop(input, options);
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
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  let result;
  try {
    result = await handleStopHook(input);
  } catch {
    return;
  }
  if (result?.allow === false && result.output) {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Never block stop on hook errors.
  });
}
