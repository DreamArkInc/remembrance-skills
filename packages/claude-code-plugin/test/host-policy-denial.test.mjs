import { describe, expect, it, vi } from "vitest";
import { HOST_POLICY_ALERT_TEXT } from "../scripts/hook-core.mjs";
import { handleHostPolicyDenial } from "../scripts/report-host-policy-denial.mjs";

describe("Claude Code host-policy denial observer", () => {
  it("emits one bounded user-visible alert for a classified pre-transport denial", () => {
    const record = vi.fn(() => ({ id: "observation-1" }));
    const mark = vi.fn(() => true);
    const result = handleHostPolicyDenial(
      {
        hook_event_name: "PermissionDenied",
        session_id: "session-a",
        tool_name: "mcp__remembrance__propose_private_skill",
        permission_decision_reason:
          "Blocked by workspace privacy and data-export policy.",
        tool_input: { proprietary: "must not be returned" },
      },
      {
        env: {},
        recordHostPolicyDenial: record,
        markHostPolicyAlertDelivered: mark,
      },
    );

    expect(result).toMatchObject({
      systemMessage: HOST_POLICY_ALERT_TEXT,
      hookSpecificOutput: {
        hookEventName: "PermissionDenied",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must not be returned");
    expect(mark).toHaveBeenCalledWith(
      "claude_code",
      "session-a",
      "observation-1",
      {},
    );
  });

  it("stays silent for ordinary API authorization failures", () => {
    expect(
      handleHostPolicyDenial(
        {
          hook_event_name: "PostToolUseFailure",
          session_id: "session-b",
          tool_name: "mcp__remembrance__submit_feedback",
          error: "HTTP 403 Forbidden",
        },
        { env: {}, recordHostPolicyDenial: () => null },
      ),
    ).toBeNull();
  });
});
