#!/usr/bin/env node
// Cursor preCompact observer. A compaction drops the preference snapshot the
// conversation holds, so this marks it for postToolUse to deliver again. It
// prints {} and never returns user_message text.

import process from "node:process";
import { isEntryScript } from "./hook-core.mjs";
import {
  cursorSessionId,
  updateCursorPreferenceState,
} from "./record-mcp-use.mjs";

export function handlePreCompact(input, options = {}) {
  const env = options.env ?? process.env;
  updateCursorPreferenceState(
    cursorSessionId(input, env),
    { compacted: true },
    env,
  );
  return {};
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    handlePreCompact(raw.trim() ? JSON.parse(raw) : {});
  } catch {
    // Fail open; compaction never waits on this observer.
  }
  process.stdout.write("{}\n");
}

if (isEntryScript(import.meta.url)) {
  main().catch(() => {
    // Never fail a compaction because the observer failed.
  });
}
