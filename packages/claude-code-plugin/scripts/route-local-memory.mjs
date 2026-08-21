#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  contributeDisabled,
  recordTaskEligibility,
  sessionIdFor,
} from "./hook-core.mjs";

const DEFAULT_AUTO_MEMORY_PATH =
  /(?:^|[\\/])\.claude[\\/]projects[\\/][^\\/]+[\\/]memory(?:[\\/]|$)/i;

export function isClaudeLocalMemoryWrite(input) {
  const toolName = String(input?.tool_name ?? input?.toolName ?? "").trim();
  if (/^(?:Memory|AutoMemory)$/i.test(toolName)) return true;
  if (!/^(?:Write|Edit)$/i.test(toolName)) return false;
  const filePath = String(
    input?.tool_input?.file_path ??
      input?.tool_input?.path ??
      input?.toolInput?.file_path ??
      input?.toolInput?.path ??
      "",
  );
  return DEFAULT_AUTO_MEMORY_PATH.test(filePath);
}

export function handleLocalMemoryWrite(input, options = {}) {
  const env = options.env ?? process.env;
  if (
    contributeDisabled(env.REMEMBRANCE_AUTO_CONTRIBUTE) ||
    !isClaudeLocalMemoryWrite(input)
  ) {
    return null;
  }
  const recordEligibility = options.recordEligibility ?? recordTaskEligibility;
  recordEligibility(sessionIdFor(input), env);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        "Remembrance memory routing:",
        "A Claude local-memory write just succeeded. Local memory is for facts about this human, repository, or machine. Remembrance is for a generalized lesson another approved organization agent would otherwise rediscover the hard way.",
        "If the new memory is organization-reusable and contains no person- or repository-specific detail, mirror only a generalized version through the private lesson lane before finishing. A local-memory write alone does not satisfy shared capture. If it is local-only, take no Remembrance action.",
        "This observer did not read or send the memory body.",
      ].join("\n"),
    },
  };
}

export function processLocalMemoryHookInput(raw, options = {}) {
  let input = {};
  try {
    const serialized = String(raw ?? "");
    input = serialized.trim() ? JSON.parse(serialized) : {};
  } catch {
    input = {};
  }
  return handleLocalMemoryWrite(input, options);
}

/* c8 ignore start -- exercised through the installed-host process smokes */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const output = processLocalMemoryHookInput(await readStdin());
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {});
}
/* c8 ignore stop */
