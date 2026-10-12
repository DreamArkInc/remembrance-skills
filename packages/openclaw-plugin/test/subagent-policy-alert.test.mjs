// From review round 1 of t14-openclaw-subagent
// (zz-review-subagent-policy-alert): a subagent finalize that already reports
// a pending host-policy alert returns before the completion decision, and it
// must still hand the subagent's leftovers up. Control: the same subagent
// without the alert hands them up too.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAfterToolCall,
  handleCompletion,
  ledgerIdFromEvent,
} from "../src/index.mjs";
import {
  readCompletionObligations,
  recordQueryFeedbackObligation,
} from "../src/hook-core.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const CHILD_KEY = "agent:main:subagent:7f1c2b4e-9a0d-4c55-8e21-3b6f0d9c1a77";
const child = {
  runId: "run-child",
  sessionId: "child-session",
  sessionKey: CHILD_KEY,
  agentId: "main",
};
const parent = {
  runId: "run-parent-1",
  sessionId: "parent-session",
  sessionKey: "agent:main:main",
  agentId: "main",
};
const ledger = (ctx) => ledgerIdFromEvent({ context: ctx });
const owed = (ctx) => readCompletionObligations(ledger(ctx), process.env);
const REPORTED =
  "Remembrance was blocked by host policy before reaching Remembrance.";

describe("OpenClaw subagent finalize with a reported host-policy alert", () => {
  let usage;
  beforeEach(() => {
    usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-alert-"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(usage, "health"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(usage, { recursive: true, force: true });
  });

  it.each([
    ["with a reported alert", true],
    ["control: no alert", false],
  ])("hands the subagent's leftovers up (%s)", async (_label, alert) => {
    const subagentRequesters = new Map();
    await handleAfterToolCall(
      {
        toolName: "sessions_spawn",
        result: {
          content: [],
          details: {
            status: "accepted",
            childSessionKey: CHILD_KEY,
            mode: "run",
          },
        },
        context: parent,
      },
      { subagentRequesters, recordHealth: () => {} },
    );
    recordQueryFeedbackObligation(
      ledger(child),
      { available: true, query_id: "rq_reviewalert" },
      process.env,
    );
    const options = {
      subagentRequesters,
      recordHealth: () => {},
      readPendingHostPolicyAlert: () =>
        alert ? { id: "alert-1", operation_class: "private_egress" } : null,
      markHostPolicyAlertDelivered: () => {},
    };
    const event = {
      context: child,
      lastAssistantMessage: `Done. ${REPORTED}`,
    };
    const decisions = [];
    for (let i = 0; i < 2; i += 1) {
      const decision = handleCompletion(event, options);
      decisions.push(`${decision.action}/${decision.why}`);
      if (decision.action === "finalize") break;
      options.readPendingHostPolicyAlert = () => null;
    }
    expect(decisions).toHaveLength(1);
    expect(owed(child)).toEqual([]);
    expect(owed(parent)).toEqual([
      expect.objectContaining({
        query_id: "rq_reviewalert",
        transferred_from: expect.objectContaining({ agent_id: CHILD_KEY }),
      }),
    ]);
  });
});
