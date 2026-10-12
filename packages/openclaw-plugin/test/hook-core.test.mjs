import { describe, expect, it } from "vitest";
import {
  agentLedgerIdFor,
  contributionReason,
  decideStop,
  formatContext,
  inferConstraints,
  inferDomain,
  readCompletionObligations,
  recordQueryFeedbackObligation,
  redactPrompt,
  shouldQueryPrompt,
  transferSubagentObligations,
} from "../src/hook-core.mjs";
import { checkPointerBound } from "../../codex-plugin/test/fixtures/pointer-bound.mjs";

// Smoke test for the shared runtime-agnostic core, copied verbatim into this
// package. Full behavioral coverage lives with the source (codex-plugin); here
// we only confirm the copy is importable and its exports behave.
describe("hook-core smoke (openclaw copy)", () => {
  it("shouldQueryPrompt matches service/tool/workflow prompts and skips trivia", () => {
    expect(
      shouldQueryPrompt("Set up a Vercel deployment pipeline").likely_match,
    ).toBe(true);
    expect(
      shouldQueryPrompt("What is the capital of France?").likely_match,
    ).toBe(false);
    expect(shouldQueryPrompt("hi").likely_match).toBe(false);
  });

  it("inferDomain and inferConstraints map prompts to seeded domains", () => {
    expect(inferDomain("stripe checkout billing")).toBe("agent-commerce");
    expect(inferDomain("redesign the dashboard layout")).toBe("web-ui-qa");
    expect(inferDomain("deploy to vercel via github actions")).toBe(
      "deployment",
    );
    expect(inferConstraints("deploy via github actions")).toEqual(
      expect.arrayContaining(["ci", "deployment"]),
    );
  });

  it("redactPrompt strips secrets and private URLs", () => {
    const out = redactPrompt(
      "token sk_live_1234567890123456 at http://svc.internal/x",
    );
    expect(out).toContain("[redacted-secret]");
    expect(out).toContain("[redacted-private-url]");
  });

  it("formatContext renders skills into an injectable context string", () => {
    const context = formatContext(
      {
        body: {
          query_id: "rq_openclaw",
          skills: [
            {
              slug: "s",
              description: "d",
              trust_tier: "t",
              result_id: "qres_openclaw",
            },
          ],
          resources: [],
        },
      },
      "external_service",
      3,
    );
    expect(context).toContain("Remembrance auto-query context");
    expect(context).toContain("Query receipt: rq_openclaw");
    expect(context).toContain("result qres_openclaw");
    expect(context).toContain("s");
  });

  it("decideStop prompts on first use and stays quiet once prompted", () => {
    const opts = {
      env: { REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1" },
      readUseCount: () => 1,
      readPromptedCount: () => 0,
    };
    expect(decideStop({ turn_id: "x" }, opts)).toMatchObject({ allow: false });
    expect(
      decideStop({ turn_id: "x" }, { ...opts, readPromptedCount: () => 1 }),
    ).toMatchObject({ allow: true, why: "no_new_usage" });
    expect(contributionReason()).toContain("submit_remembrance");
  });

  // The copy carries its own 1,024-byte bound on what a read follows: the
  // source's check runs here against the copy (R-W2 round 2 R2-1).
  it("skips an association and a forwarding marker one byte past the 1,024-byte bound and follows both at exactly 1,024 bytes (R2-1)", () => {
    checkPointerBound({
      agentLedgerIdFor,
      readCompletionObligations,
      recordQueryFeedbackObligation,
      transferSubagentObligations,
    });
  });
});
