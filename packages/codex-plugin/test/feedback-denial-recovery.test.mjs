import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeFeedbackDenial } from "../scripts/feedback-disposition.mjs";
import {
  completionContinuationReason,
  decideStop,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  recordHostPolicyDenial,
  recordPostUseFeedbackObligation,
  recordQueryFeedbackObligation,
  recordTaskEligibility,
} from "../scripts/hook-core.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remembrance-feedback-denial-"));
  roots.push(root);
  const env = {
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    REMEMBRANCE_API_KEY: "rk_synthetic_organization_authorized",
  };
  const session = "feedback-session";
  recordTaskEligibility(session, env);
  recordQueryFeedbackObligation(
    session,
    { available: true, query_id: "rq_denied" },
    env,
  );
  recordPostUseFeedbackObligation(
    session,
    {
      query_id: "rq_denied",
      result_id: "qres_used",
      skill_slug: "synthetic-skill",
    },
    env,
  );
  return { env, session };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("host-denied feedback recovery", () => {
  it("acknowledges a denial without host events, retaining delivery truth and independent query fit", () => {
    const { env, session } = fixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("must not call network"));
    acknowledgeFeedbackDenial(
      {
        tool: "submit_feedback",
        query_id: "rq_denied",
        result_id: "qres_used",
        reason: "host_policy_denied",
      },
      env,
    );
    const pending = pendingCompletionRecoveryInstruction(session, env);
    expect(pending).toContain(
      "Query fit: call submit_query_feedback for query_id rq_denied",
    );
    expect(pending).not.toContain("Post-use feedback");
    // Local acknowledgment is not a successful feedback receipt or draft deletion.
    expect(readCompletionObligations(session, env)).toHaveLength(2);
    expect(
      readCompletionObligations(session, env).every((item) => !item.submitted),
    ).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(decideStop({ session_id: session }, { env }).allow).toBe(true);
    expect(
      decideStop({ session_id: session, stop_hook_active: true }, { env })
        .allow,
    ).toBe(true);

    recordPostUseFeedbackObligation(
      session,
      { query_id: "rq_other", result_id: "qres_other", skill_slug: "other" },
      env,
    );
    expect(pendingCompletionRecoveryInstruction(session, env)).toContain(
      "query_id rq_other and result_id qres_other",
    );
  });

  it("leaves strict Stop and prompt recovery quiet after both exact obligations were acknowledged", () => {
    const { env, session } = fixture();
    acknowledgeFeedbackDenial(
      {
        tool: "submit_feedback",
        query_id: "rq_denied",
        result_id: "qres_used",
        reason: "host_policy_denied",
      },
      env,
    );
    acknowledgeFeedbackDenial(
      {
        tool: "submit_query_feedback",
        query_id: "rq_denied",
        reason: "host_policy_denied",
      },
      env,
    );
    expect(pendingCompletionRecoveryInstruction(session, env)).toBeNull();
    expect(
      decideStop(
        { session_id: session },
        { env, visibleCompletionRecovery: true },
      ),
    ).toMatchObject({ allow: true, why: "feedback_host_denied" });
    recordTaskEligibility(session, env);
    expect(
      decideStop(
        { session_id: session },
        { env, visibleCompletionRecovery: true },
      ).why,
    ).not.toBe("feedback_host_denied");
  });

  it("acknowledges an observable exact host denial but not a registry authorization error", async () => {
    const { env, session } = fixture();
    const input = {
      session_id: session,
      tool_name: "mcp__remembrance__submit_feedback",
      tool_input: { query_id: "rq_denied", result_id: "qres_used" },
      tool_response: { isError: true, error: "HTTP 403 Forbidden" },
    };
    await handlePostToolUse(input, { env, recordHealth: () => null });
    expect(pendingCompletionRecoveryInstruction(session, env)).toContain(
      "Post-use feedback",
    );
    await handlePostToolUse(
      {
        ...input,
        tool_response: {
          isError: true,
          error: "Blocked before transport by host privacy policy",
        },
      },
      { env, recordHealth: () => null },
    );
    expect(pendingCompletionRecoveryInstruction(session, env)).not.toContain(
      "Post-use feedback",
    );
  });

  it("does not acknowledge unidentified feedback on a general host-policy event", () => {
    const { env, session } = fixture();
    recordHostPolicyDenial(
      {
        surface: "codex",
        sessionId: session,
        eventType: "PermissionDenied",
        toolName: "mcp__remembrance__submit_feedback",
        value: { error: "Blocked by host privacy policy" },
      },
      env,
    );
    expect(pendingCompletionRecoveryInstruction(session, env)).toContain(
      "Post-use feedback",
    );
  });

  it("preserves the task result without requesting duplicate warnings or unproven retention", () => {
    const instruction = completionContinuationReason(
      "Complete remaining actions.",
      { last_assistant_message: "Task done. Feedback was denied." },
      {},
    );
    expect(instruction).toContain("preserve the task result");
    expect(instruction).toContain(
      "Do not repeat already reported Remembrance warnings",
    );
    expect(instruction).not.toContain("repeat your immediately preceding");
    expect(instruction).not.toContain("draft remains");
  });
});
