import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeFeedbackDenial,
  feedbackDenialAcknowledged,
} from "../scripts/feedback-disposition.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "remembrance-feedback-denial-"));
  temporaryDirectories.push(root);
  return {
    root,
    env: { REMEMBRANCE_USAGE_DIR: join(root, "usage") },
  };
}

const queryFeedbackDenial = {
  tool: "submit_query_feedback",
  query_id: "rq_feedback_denial_fixture",
  reason: "host_policy_denied",
};

const postUseFeedbackDenial = {
  tool: "submit_feedback",
  query_id: "rq_feedback_denial_fixture",
  result_id: "qres_feedback_denial_fixture",
  reason: "host_policy_denied",
};

function markerFiles(env) {
  return readdirSync(join(env.REMEMBRANCE_USAGE_DIR, "feedback-denials"));
}

describe("local feedback denial disposition", () => {
  it("isolates exact query-fit and post-use events without retaining identifiers", () => {
    const { env } = testEnvironment();
    const anotherResult = {
      ...postUseFeedbackDenial,
      result_id: "qres_independent_feedback_denial",
    };

    expect(acknowledgeFeedbackDenial(queryFeedbackDenial, env)).toMatchObject({
      status: "acknowledged_host_denial",
      acknowledged: true,
      submitted: false,
      local_only: true,
      already_acknowledged: false,
    });
    expect(acknowledgeFeedbackDenial(postUseFeedbackDenial, env)).toMatchObject(
      {
        status: "acknowledged_host_denial",
        already_acknowledged: false,
      },
    );

    expect(feedbackDenialAcknowledged(queryFeedbackDenial, env)).toBe(true);
    expect(feedbackDenialAcknowledged(postUseFeedbackDenial, env)).toBe(true);
    expect(feedbackDenialAcknowledged(anotherResult, env)).toBe(false);

    const files = markerFiles(env);
    expect(files).toHaveLength(2);
    expect(files.every((name) => /^[a-f0-9]{64}\.json$/u.test(name))).toBe(
      true,
    );
    const stored = files
      .map((name) =>
        readFileSync(
          join(env.REMEMBRANCE_USAGE_DIR, "feedback-denials", name),
          "utf8",
        ),
      )
      .join("\n");
    expect(stored).not.toContain(queryFeedbackDenial.query_id);
    expect(stored).not.toContain(postUseFeedbackDenial.result_id);
    expect(stored).not.toContain("submit_query_feedback");
    expect(stored).not.toContain("submit_feedback");

    if (typeof process.getuid === "function") {
      expect(lstatSync(env.REMEMBRANCE_USAGE_DIR).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(join(env.REMEMBRANCE_USAGE_DIR, "feedback-denials")).mode &
          0o777,
      ).toBe(0o700);
      for (const name of files) {
        expect(
          lstatSync(join(env.REMEMBRANCE_USAGE_DIR, "feedback-denials", name))
            .mode & 0o777,
        ).toBe(0o600);
      }
    }
  });

  it("is idempotent and remains readable after a fresh module load", async () => {
    const { env } = testEnvironment();
    const first = acknowledgeFeedbackDenial(postUseFeedbackDenial, env);
    const replay = acknowledgeFeedbackDenial(postUseFeedbackDenial, env);

    expect(replay).toMatchObject({
      status: "acknowledged_host_denial",
      already_acknowledged: true,
      expires_at: first.expires_at,
    });
    expect(markerFiles(env)).toHaveLength(1);

    const restarted =
      await import("../scripts/feedback-disposition.mjs?restart");
    expect(
      restarted.feedbackDenialAcknowledged(postUseFeedbackDenial, env),
    ).toBe(true);
  });

  it("expires and cleans exact content-free markers after fourteen days", () => {
    const { env } = testEnvironment();
    const acknowledgement = acknowledgeFeedbackDenial(queryFeedbackDenial, env);
    const retainedMs = Date.parse(acknowledgement.expires_at) - Date.now();
    expect(retainedMs).toBeGreaterThan(14 * 24 * 60 * 60 * 1000 - 5_000);
    expect(retainedMs).toBeLessThanOrEqual(14 * 24 * 60 * 60 * 1000);

    const path = join(
      env.REMEMBRANCE_USAGE_DIR,
      "feedback-denials",
      markerFiles(env)[0],
    );
    const marker = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      `${JSON.stringify({ ...marker, expires_at: "2000-01-01T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);

    expect(feedbackDenialAcknowledged(queryFeedbackDenial, env)).toBe(false);
    expect(markerFiles(env)).toHaveLength(0);
    expect(acknowledgeFeedbackDenial(queryFeedbackDenial, env)).toMatchObject({
      already_acknowledged: false,
    });
  });

  it("rejects every non-exact input and fails open for corrupt state", () => {
    const { env } = testEnvironment();
    const invalidInputs = [
      { ...queryFeedbackDenial, result_id: "qres_extraneous" },
      { ...postUseFeedbackDenial, result_id: undefined },
      { ...queryFeedbackDenial, reason: "denied" },
      { ...queryFeedbackDenial, extra: true },
      { ...queryFeedbackDenial, query_id: "" },
    ];
    for (const input of invalidInputs) {
      expect(() => acknowledgeFeedbackDenial(input, env)).toThrow(TypeError);
      expect(feedbackDenialAcknowledged(input, env)).toBe(false);
    }

    acknowledgeFeedbackDenial(queryFeedbackDenial, env);
    const path = join(
      env.REMEMBRANCE_USAGE_DIR,
      "feedback-denials",
      markerFiles(env)[0],
    );
    writeFileSync(path, "not-json", { mode: 0o600 });
    expect(feedbackDenialAcknowledged(queryFeedbackDenial, env)).toBe(false);
  });

  it("does not follow marker symlinks and throws on unsafe write storage", () => {
    const { root, env } = testEnvironment();
    acknowledgeFeedbackDenial(queryFeedbackDenial, env);
    const path = join(
      env.REMEMBRANCE_USAGE_DIR,
      "feedback-denials",
      markerFiles(env)[0],
    );
    const target = join(root, "target");
    writeFileSync(target, "unchanged", { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);

    expect(feedbackDenialAcknowledged(queryFeedbackDenial, env)).toBe(false);
    expect(() => acknowledgeFeedbackDenial(queryFeedbackDenial, env)).toThrow(
      expect.objectContaining({
        code: "feedback_denial_acknowledgement_failed",
        acknowledged: false,
        submitted: false,
        local_only: true,
      }),
    );
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });
});
