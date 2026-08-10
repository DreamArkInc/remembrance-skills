#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  HOST_POLICY_ALERT_TEXT,
  markHostPolicyAlertDelivered,
  recordHostPolicyDenial,
  sessionIdFor,
} from "./hook-core.mjs";

function toolName(input) {
  return (
    input?.tool_name ??
    input?.toolName ??
    input?.name ??
    input?.tool?.name ??
    ""
  );
}

export function handleHostPolicyDenial(input, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = sessionIdFor(input);
  const record = options.recordHostPolicyDenial ?? recordHostPolicyDenial;
  const observation = record(
    {
      surface: "claude_code",
      sessionId,
      eventType: input?.hook_event_name ?? input?.event_type ?? "",
      toolName: toolName(input),
      value: input,
    },
    env,
  );
  if (!observation) return null;
  const markDelivered =
    options.markHostPolicyAlertDelivered ?? markHostPolicyAlertDelivered;
  markDelivered("claude_code", sessionId, observation.id, env);
  return {
    systemMessage: HOST_POLICY_ALERT_TEXT,
    hookSpecificOutput: {
      hookEventName:
        input?.hook_event_name || input?.event_type || "PostToolUseFailure",
      additionalContext: `${HOST_POLICY_ALERT_TEXT} Tell the user once. Do not retry the blocked content through another transport.`,
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    const raw = await readStdin();
    const result = handleHostPolicyDenial(raw.trim() ? JSON.parse(raw) : {});
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Observability is best effort and may never interfere with host execution.
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
