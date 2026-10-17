import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeBoundedHookContext,
  decideStop,
  observeSuccessfulCompletionTool,
  pendingCompletionRecoveryInstruction,
  privateLearningLifecycleRecoveryInstruction,
  readCompletionObligations,
  readPrivateSkillLifecycleState,
  recordHostPolicyDenial,
} from "../scripts/hook-core.mjs";
import { PRIVATE_LEARNING_INSPECTOR_DIGEST } from "../scripts/private-learning-hook-policy.mjs";

const roots = [];
const candidateDigest = `sha256:${"1".repeat(64)}`;
const updatedAt = "2026-09-12T20:00:00.000Z";
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remembrance-agent-reformulation-"));
  roots.push(root);
  return {
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    REMEMBRANCE_API_KEY: "rk_local_synthetic_reformulation",
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
    REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
  };
}

function held(overrides = {}) {
  return {
    version: "private-skill-outbox-envelope-v1",
    draft_id: "psd_recovery_fixture",
    state: "held_validation",
    candidate_digest: candidateDigest,
    created_at: updatedAt,
    updated_at: updatedAt,
    inspector_digest: PRIVATE_LEARNING_INSPECTOR_DIGEST,
    reformulation_available: true,
    reformulation_reason: "ambiguous_source_ownership",
    reformulation_attempt_count: 0,
    next_retry_at: null,
    next_action: {
      version: "private-skill-recovery-action-v1",
      kind: "reformulate",
      candidate_digest: candidateDigest,
      inspector_digest: PRIVATE_LEARNING_INSPECTOR_DIGEST,
      draft_updated_at: updatedAt,
    },
    encryption: { ciphertext: "opaque-not-a-real-candidate" },
    ...overrides,
  };
}

function envelope(env, metadata) {
  const directory = join(env.XDG_STATE_HOME, "remembrance", "private-skills");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${metadata.draft_id}.json`);
  writeFileSync(path, JSON.stringify(metadata), { mode: 0o600 });
  return path;
}

function stop(session, env) {
  return decideStop(
    { turn_id: session },
    {
      env,
      readUseCount: () => 1,
      readEligibilityCount: () => 1,
      readPromptedCount: () => 0,
      readHighMatch: () => null,
      readDirectSelections: () => [],
    },
  );
}

describe("bounded agent reformulation lifecycle", () => {
  it.each(["ambiguous_source_ownership", "inspection_capacity_exhausted"])(
    "resumes a persisted reformulate action with legacy reason %s after restart without exposing or editing the draft",
    (reformulation_reason) => {
      const env = fixture();
      const path = envelope(env, held({ reformulation_reason }));
      const before = readFileSync(path);
      expect(readPrivateSkillLifecycleState(env)).toMatchObject({
        ready: 0,
        retry_scheduled: 0,
        reformulation_available: 1,
      });
      const instruction = privateLearningLifecycleRecoveryInstruction(env);
      expect(instruction).toContain("inspect_private_learning_outbox");
      expect(instruction).toContain(
        "private_skill_draft_id psd_recovery_fixture",
      );
      expect(instruction).toContain(
        "1 private skill draft awaits bounded agent reformulation",
      );
      expect(instruction).toContain(
        "active task context or independently validated recovery context",
      );
      expect(instruction).toContain(
        "Never copy suspected secrets or manufacture missing context",
      );
      expect(instruction).toContain(
        "Do not ask the user to inspect files or repeat an existing lane approval",
      );
      expect(instruction).not.toContain("opaque-not-a-real-candidate");
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it("wakes a persisted recovery action after the inspector identity changes", () => {
    const env = fixture();
    const staleInspector = `sha256:${"9".repeat(64)}`;
    const path = envelope(
      env,
      held({
        inspector_digest: staleInspector,
        next_action: {
          version: "private-skill-recovery-action-v1",
          kind: "reformulate",
          candidate_digest: candidateDigest,
          inspector_digest: staleInspector,
          draft_updated_at: updatedAt,
        },
      }),
    );
    const before = readFileSync(path);

    expect(readPrivateSkillLifecycleState(env)).toMatchObject({
      inspector_refresh: 1,
      next_reformulation_draft_id: "psd_recovery_fixture",
    });
    expect(privateLearningLifecycleRecoveryInstruction(env)).toContain(
      "inspect_private_learning_outbox",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it("wakes an operationally capped draft only after inspector identity changes", () => {
    const currentEnv = fixture();
    envelope(
      currentEnv,
      held({
        reformulation_available: false,
        reformulation_attempt_count: 3,
        recovery_epoch_attempt_count: 0,
        next_action: null,
      }),
    );
    expect(readPrivateSkillLifecycleState(currentEnv)).toBeNull();

    const env = fixture();
    const staleInspector = `sha256:${"8".repeat(64)}`;
    const path = envelope(
      env,
      held({
        inspector_digest: staleInspector,
        reformulation_available: false,
        reformulation_attempt_count: 3,
        recovery_epoch_attempt_count: 0,
        next_action: null,
      }),
    );
    const before = readFileSync(path);

    expect(readPrivateSkillLifecycleState(env)).toMatchObject({
      inspector_refresh: 1,
      reformulation_available: 0,
      operational_retry: 0,
      next_reformulation_draft_id: "psd_recovery_fixture",
    });
    expect(privateLearningLifecycleRecoveryInstruction(env)).toContain(
      "inspect_private_learning_outbox",
    );
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([
    { state: "held_safety" },
    { state: "awaiting_authorization", updated_at: new Date().toISOString() },
    { reformulation_reason: "resource_limit" },
    { reformulation_reason: "unknown" },
    { reformulation_available: false },
    { reformulation_attempt_count: -1 },
    { reformulation_attempt_count: 0.5 },
    { reformulation_attempt_count: "0" },
    { reformulation_attempt_count: 3 },
    { reformulation_attempt_count: 100 },
  ])(
    "does not wake a held draft without a bounded local recovery offer: %j",
    (patch) => {
      const env = fixture();
      const path = envelope(env, held({ ...patch, next_action: null }));
      const before = readFileSync(path);
      expect(readPrivateSkillLifecycleState(env)).toBeNull();
      expect(privateLearningLifecycleRecoveryInstruction(env)).toBeNull();
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it("rotates exact recovery references only after inspection, not as completion", () => {
    const env = fixture();
    const ids = [
      "psd_recovery_alpha",
      "psd_recovery_beta",
      "psd_recovery_gamma",
    ];
    const paths = ids.map((draft_id) => envelope(env, held({ draft_id })));
    const before = paths.map((path) => readFileSync(path));
    for (const id of [...ids, ids[0]]) {
      expect(
        readPrivateSkillLifecycleState(env).next_reformulation_draft_id,
      ).toBe(id);
      expect(
        readPrivateSkillLifecycleState(env).next_reformulation_draft_id,
      ).toBe(id);
      const result = observeSuccessfulCompletionTool(
        "recovery-rotation",
        "mcp__remembrance__inspect_private_learning_outbox",
        { private_skill_draft_id: id },
        { private_skills: { selected_draft: held({ draft_id: id }) } },
        env,
      );
      expect(result.closed).toEqual([]);
      expect(result.handled_count).toBe(0);
    }
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });

  it("supplies the exact held draft even when a listing would be filled by completion markers", () => {
    const env = fixture();
    const path = envelope(env, held());
    for (let index = 0; index < 205; index++) {
      const directory = join(
        env.XDG_STATE_HOME,
        "remembrance",
        "private-skills",
      );
      writeFileSync(
        join(directory, `psd_completed_${index}.submitted.json`),
        "{}",
        { mode: 0o600 },
      );
    }
    expect(privateLearningLifecycleRecoveryInstruction(env)).toContain(
      "private_skill_draft_id psd_recovery_fixture",
    );
    const before =
      readPrivateSkillLifecycleState(env).next_reformulation_draft_id;
    observeSuccessfulCompletionTool(
      "recovery-mismatch",
      "inspect_private_learning_outbox",
      { private_skill_draft_id: "psd_wrong_fixture" },
      { private_skills: { selected_draft: held() } },
      env,
    );
    expect(
      readPrivateSkillLifecycleState(env).next_reformulation_draft_id,
    ).toBe(before);
    expect(readFileSync(path, "utf8")).toContain("opaque-not-a-real-candidate");
  });

  it("requires the current lane authorization and honors a persisted host denial", () => {
    const env = fixture();
    envelope(env, held());
    expect(
      privateLearningLifecycleRecoveryInstruction({
        ...env,
        REMEMBRANCE_API_KEY: "",
      }),
    ).toBeNull();
    const denial = recordHostPolicyDenial(
      {
        surface: "codex",
        sessionId: "agent-recovery-denied",
        eventType: "PermissionDenied",
        toolName: "mcp__remembrance__submit_private_skill_candidate",
        value: {
          permission_decision_reason:
            "Blocked by host data-export policy before reaching Remembrance.",
        },
      },
      env,
    );
    expect(denial).toMatchObject({ before_mcp: "yes" });
    expect(privateLearningLifecycleRecoveryInstruction(env)).toBeNull();
  });

  it("keeps query-fit and post-use feedback pending independently of reformulation", () => {
    const env = fixture();
    const session = "agent-recovery-feedback";
    observeSuccessfulCompletionTool(
      session,
      "query_skills",
      {},
      {
        query_id: "rq_agent_recovery",
        query_feedback: { available: true, query_id: "rq_agent_recovery" },
      },
      env,
    );
    observeSuccessfulCompletionTool(
      session,
      "get_skill",
      {
        query_id: "rq_agent_recovery",
        result_id: "qres_agent_recovery",
        slug: "fixture-skill",
      },
      {},
      env,
    );
    observeSuccessfulCompletionTool(
      session,
      "capture_learning",
      {},
      {
        ...held(),
        capture_route: "private_skill",
      },
      env,
    );
    let decision = stop(session, env);
    expect(decision.reason).toContain("submit_query_feedback");
    expect(decision.reason).toContain("submit_feedback");
    expect(decision.reason).toContain("Recoverable private skill");
    expect(decision.reason).toContain("Do not submit the held original");
    expect(decision.reason).not.toContain(
      "call submit_private_skill_candidate",
    );

    observeSuccessfulCompletionTool(
      session,
      "capture_learning",
      {},
      {
        ...held({ state: "ready", reformulation_available: false }),
        capture_route: "private_skill",
        next_action: {
          tool: "submit_private_skill_candidate",
          arguments: { draft_id: "psd_recovery_fixture" },
        },
      },
      env,
    );
    decision = stop(session, env);
    expect(decision.reason).toContain(
      "call submit_private_skill_candidate with draft_id psd_recovery_fixture",
    );
    expect(decision.reason).not.toContain("Recoverable private skill");
    expect(
      readCompletionObligations(session, env)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(["post_use_feedback", "private_skill", "query_feedback"]);
  });

  it("keeps recovery and consent instructions within the shared context budget", () => {
    const env = fixture();
    envelope(env, held());
    const instruction = privateLearningLifecycleRecoveryInstruction(env);
    for (const pressure of [0, 1, 10, 100, 1000]) {
      const context = composeBoundedHookContext(
        [
          "Organization policy: preserve private information.",
          "Query receipt: query_id=rq_recovery result_id=qres_recovery.",
          instruction,
          "Discretionary context. ".repeat(pressure),
        ].join("\n"),
      );
      expect(context.length).toBeLessThanOrEqual(4000);
      expect(context).toContain("Organization policy");
      expect(context).toContain("query_id=rq_recovery");
      expect(context).toContain("inspect_private_learning_outbox");
      expect(context).toContain(
        "Never delete an unresolved draft automatically",
      );
      expect(context).toContain(
        "Never copy suspected secrets or manufacture missing context",
      );
    }
  });

  it("preserves pending feedback identities until the one shared allocator runs", () => {
    const env = fixture();
    envelope(env, held());
    const session = "recovery-combined-budget";
    // This session captured the draft, so its recovery stays silent.
    observeSuccessfulCompletionTool(
      session,
      "capture_learning",
      {},
      { capture_route: "private_skill", retained_locally: true, ...held() },
      env,
    );
    const identities = [];
    for (let index = 0; index < 3; index++) {
      const query_id = `rq_${index}_${"q".repeat(85)}`;
      const result_id = `qres_${index}_${"r".repeat(82)}`;
      identities.push(query_id, result_id);
      observeSuccessfulCompletionTool(
        session,
        "query_skills",
        {},
        {
          query_id,
          query_feedback: { available: true, query_id },
        },
        env,
      );
      observeSuccessfulCompletionTool(
        session,
        "get_skill",
        {
          query_id,
          result_id,
          slug: `fixture-${index}`,
        },
        {},
        env,
      );
    }
    const pending = pendingCompletionRecoveryInstruction(session, env);
    expect(pending.length).toBeGreaterThan(1200);
    for (const id of identities) expect(pending).toContain(id);
    const context = composeBoundedHookContext(
      "Organization policy: keep private data private.",
      [{ kind: "completion", text: pending }],
    );
    expect(context.length).toBeLessThanOrEqual(4000);
    for (const id of identities) expect(context).toContain(id);
    expect(context).toContain("private_skill_draft_id psd_recovery_fixture");
    expect(context).toContain("Never delete an unresolved draft automatically");
    expect(context).toContain("Do not retry authorization");
  });
});
