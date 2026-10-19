import {
  inspectPayloadForSensitiveMaterial,
  RedactionIncompleteError,
} from "@remembrance/core";
import { createPrivateKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.mjs";
import {
  handlePrivateLessonSubmitApproval,
  persistPrivateLearningSubmitApproval,
  persistPrivateLessonSubmitApproval,
  privateLearningSubmitApprovals,
  privateLessonSubmitApproved,
} from "../src/private-lesson-approval.mjs";
import {
  readPrivateSkillDraft,
  readPrivateSkillSubmittedRecord,
  updatePrivateSkillDraft,
} from "../../mcp-server/src/private-skill-outbox.ts";
import {
  callTool,
  resetPrincipalSessionCacheForTests,
  waitForPrincipalSessionBackgroundTasksForTests,
} from "../../mcp-server/src/server.ts";
import { toolDefinitions } from "../../mcp-server/src/tool-definitions.ts";

vi.mock("@remembrance/core", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, inspectPayloadForSensitiveMaterial: vi.fn() };
});

const actualCore = await vi.importActual("@remembrance/core");
const inspect = vi.mocked(inspectPayloadForSensitiveMaterial);
const localRequire = createRequire(import.meta.url);
localRequire("tsx/cjs");
const { terminalSourceAuthorityWitnessBytes } = localRequire(
  "../../core/test/fixtures/truncated-private-key-body.ts",
);
const { runPrivateLearningRootString: runRetiredPrivateLearningRootString } =
  localRequire("../../../scripts/prototypes/private-learning-root-runner.ts");

const recoveryWorkflow = Object.freeze([
  "Inspect the exact retained draft",
  "use only separately scanner-approved context",
  "author a complete replacement",
  "run fresh local inspection",
  "preserve the same draft and retry identity",
  "remove encrypted source content only after organization-private acceptance",
]);
const encryptedPrivateContainerDerBase64 =
  "MIGjMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBC5Vq3k5yAZB7X+aabpxXPpAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQSZozgJyN1plZ4uFDXAQ9LgRAeEAqEeXFh5wML9mOZhuJN5O9R8Kw2SHQYKHq4guvP3njuHpp0fg5XPbTy2mTrYOlMYZyzxKNp9AJ4Smo18NHnQ==";
const encryptedPrivateContainerPassphrase =
  "synthetic-openclaw-approval-fixture";

function integrationTool(name) {
  const found = toolDefinitions.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing integration tool: ${name}`);
  return found;
}

// Retired-root compatibility probe for the broad-inspector mock. Private skill
// capture uses the generated bounded root directly; this bridge is not its proof.
function inspectPrivateSkillFieldsWithActualRoot(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return actualCore.inspectPayloadForSensitiveMaterial(payload);
  }
  let changed = false;
  for (const field of [
    "title",
    "description",
    "domain_slug",
    "proposed_skill_md",
  ]) {
    const value = payload[field];
    if (typeof value !== "string") continue;
    const result = runRetiredPrivateLearningRootString(value);
    if (result.status === "incomplete") {
      throw new RedactionIncompleteError(result.recoveryReason ?? undefined);
    }
    changed ||= result.value !== value;
  }
  return changed
    ? { sensitiveMaterial: true, sensitiveObjectKeyMaterial: false }
    : actualCore.inspectPayloadForSensitiveMaterial(payload);
}

function heldPrivateSkill(fixture) {
  return {
    title: "Recover retained private-skill submissions",
    description: `${recoveryWorkflow.join("; ")}.`,
    domain_slug: "private-learning-recovery",
    proposed_skill_md: fixture.instructionsAlongsideSource
      ? "# Recover retained private-skill submissions\n\n" +
        `${recoveryWorkflow.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n` +
        "## Synthetic private input\n\n" +
        "This source-authority fixture is incidental and must remain local:\n\n" +
        fixture.serialized
      : fixture.serialized,
    proposed_metadata: {
      fixture_kind: "openclaw_persisted_private_lane",
    },
  };
}

function ambiguousPrivateStructureFixture() {
  const privateDer = terminalSourceAuthorityWitnessBytes();
  return {
    serialized:
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      privateDer
        .subarray(0, Math.floor(privateDer.length * 0.65))
        .toString("hex"),
    retiredRecoveryReason: "ambiguous_source_ownership",
    recoveryReason: "declared_private_format_unverified",
    instructionsAlongsideSource: true,
    recoveryProjection: "instructions",
    meaningAdequacy: "not_assessed",
  };
}

function encryptedPrivateContainerFixture() {
  const encryptedDer = Buffer.from(
    encryptedPrivateContainerDerBase64,
    "base64",
  );
  if (
    createPrivateKey({
      key: encryptedDer,
      format: "der",
      type: "pkcs8",
      passphrase: encryptedPrivateContainerPassphrase,
    }).asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Invalid synthetic encrypted private-key fixture");
  }
  return {
    serialized: encryptedPrivateContainerDerBase64,
    retiredRecoveryReason: "encrypted_private_container",
    recoveryReason: "encrypted_private_container",
    instructionsAlongsideSource: false,
    recoveryProjection: "instructions",
    meaningAdequacy: "not_assessed",
  };
}

function replacementFromSafeSummary(recovery) {
  const context = recovery.context;
  const steps = String(context.description)
    .split(";")
    .map((step) => step.trim().replace(/\.$/u, ""))
    .filter(Boolean);
  return {
    title: context.title,
    description: context.description,
    domain_slug: context.domain_slug,
    proposed_skill_md: [
      `# ${context.title}`,
      "",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ].join("\n"),
    proposed_metadata: {},
  };
}

function withoutIdempotency(body) {
  const { idempotency_key: _idempotencyKey, ...candidate } = body;
  return candidate;
}

function registerApprovalHook(pluginConfig, configFile) {
  const on = vi.fn();
  const mutateConfigFile = vi.fn(async ({ mutate }) => mutate(configFile));
  plugin.register({
    registrationMode: "setup",
    on,
    registerCli: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    pluginConfig,
    runtime: { config: { mutateConfigFile } },
  });
  const beforeToolCall = on.mock.calls.find(
    ([name]) => name === "before_tool_call",
  )?.[1];
  if (typeof beforeToolCall !== "function") {
    throw new Error(
      "OpenClaw before_tool_call approval hook was not registered",
    );
  }
  return { beforeToolCall, mutateConfigFile };
}

function approvalAwareExecutor(beforeToolCall, approvalRequests) {
  return async (toolName, argumentsValue, decision) => {
    const gate = await beforeToolCall({
      toolName,
      arguments: argumentsValue,
    });
    if (gate?.requireApproval) {
      approvalRequests.push({
        toolName,
        title: gate.requireApproval.title,
      });
      if (!decision) {
        throw new Error(`No test-host decision supplied for ${toolName}`);
      }
      gate.requireApproval.onResolution(decision);
      if (decision === "deny") return { executed: false, result: undefined };
    }
    return {
      executed: true,
      result: await callTool(integrationTool(toolName), argumentsValue),
    };
  };
}

describe("OpenClaw private learning egress approval", () => {
  it("asks separately for administrator repair despite every existing learning approval", () => {
    const manifest = localRequire("../openclaw.plugin.json");
    expect(manifest.configSchema.properties.privateLearningEgressApprovals.properties.admin_review_repair)
      .toMatchObject({ type: "boolean", default: false });
    const approvedLanes = privateLearningSubmitApprovals({
      pluginConfig: {
        privateLessonSubmitApproval: true,
        privateLearningEgressApprovals: {
          private_lesson: true,
          private_skill: true,
          conditional_feedback: true,
          remembrance_submission: true,
          private_skill_proposal: true,
          skill_candidate: true,
          skill_suggestion: true,
          resource_submission: true,
          resource_review: true,
        },
        privateLearningSubmitApprovals: {
          submit_private_skill_candidate: true,
          retry_private_skill_candidate: true,
        },
      },
    });
    expect(approvedLanes.has("admin_review_repair")).toBe(false);
    for (const toolName of ["repair_review_draft", "mcp_remembrance_repair_review_draft"]) {
      const onAllowAlways = vi.fn();
      const gate = handlePrivateLessonSubmitApproval(
        { toolName },
        { approved: true, approvedLanes, onAllowAlways },
      );
      expect(gate).toMatchObject({ requireApproval: {
        title: "Create protected Remembrance review replacement",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        severity: "warning",
      } });
      const description = gate.requireApproval.description;
      for (const phrase of ["admin:review", "complete new protected skill replacement", "normal verification and review", "original draft is retained unchanged", "separate normal explicit decision", "accepted, tenant-readable active replacement"])
        expect(description).toContain(phrase);
      gate.requireApproval.onResolution("deny");
      gate.requireApproval.onResolution("allow-once");
      expect(onAllowAlways).not.toHaveBeenCalled();
      expect(handlePrivateLessonSubmitApproval({ toolName }, { approvedLanes }))
        .toHaveProperty("requireApproval");
      gate.requireApproval.onResolution("allow-always");
      expect(onAllowAlways).toHaveBeenCalledExactlyOnceWith("admin_review_repair");
    }
    expect(handlePrivateLessonSubmitApproval({ toolName: "get_review_comparison" }))
      .toBeUndefined();
  });

  it("persists only explicit repair authority and restores it independently", async () => {
    const config = { plugins: { entries: { remembrance: { config: {
      privateLearningEgressApprovals: { private_skill: true },
    } } } } };
    const api = { runtime: { config: {
      mutateConfigFile: vi.fn(async ({ mutate }) => mutate(config)),
    } } };
    await persistPrivateLearningSubmitApproval(api, "repair_review_draft");
    expect(config.plugins.entries.remembrance.config.privateLearningEgressApprovals)
      .toEqual({ private_skill: true, admin_review_repair: true });
    const approvedLanes = privateLearningSubmitApprovals({ pluginConfig:
      structuredClone(config.plugins.entries.remembrance.config),
    });
    expect(handlePrivateLessonSubmitApproval({ toolName: "repair_review_draft" }, { approvedLanes }))
      .toBeUndefined();
    const repairOnly = privateLearningSubmitApprovals({ pluginConfig: {
      privateLearningEgressApprovals: { admin_review_repair: true },
    } });
    expect(repairOnly).toEqual(new Set(["admin_review_repair"]));
    expect(handlePrivateLessonSubmitApproval({ toolName: "submit_private_skill_candidate" }, { approvedLanes: repairOnly }))
      .toHaveProperty("requireApproval");
    expect(privateLearningSubmitApprovals({ pluginConfig: {
      privateLearningEgressApprovals: { admin_review_repair: false },
    } }).has("admin_review_repair")).toBe(false);
  });

  it("keeps a denied administrator repair unapproved through the registered host hook", async () => {
    const configFile = { plugins: { entries: { remembrance: { config: {
      privateLearningEgressApprovals: { private_skill: true },
    } } } } };
    const host = registerApprovalHook(configFile.plugins.entries.remembrance.config, configFile);
    const event = { toolName: "repair_review_draft", arguments: {
      job_id: "job_000000000000000001",
      request_id: "psrr_00000000000000000000000000000001",
    } };
    const gate = await host.beforeToolCall(event);
    expect(gate).toHaveProperty("requireApproval");
    gate.requireApproval.onResolution("deny");
    expect(host.mutateConfigFile).not.toHaveBeenCalled();
    expect(configFile.plugins.entries.remembrance.config.privateLearningEgressApprovals)
      .toEqual({ private_skill: true });
    expect(await host.beforeToolCall(event)).toHaveProperty("requireApproval");
  });

  it("reuses the saved skill-lane approval after reformulation and host restart", async () => {
    const config = { plugins: { entries: { remembrance: { config: {} } } } };
    const api = {
      runtime: {
        config: {
          mutateConfigFile: vi.fn(async ({ mutate }) => mutate(config)),
        },
      },
    };
    const approvals = [];
    const options = {
      approvedLanes: new Set(),
      onAllowAlways(lane) {
        approvals.push(persistPrivateLearningSubmitApproval(api, lane));
      },
    };
    for (const toolName of [
      "capture_learning",
      "inspect_private_learning_outbox",
    ])
      expect(
        handlePrivateLessonSubmitApproval({ toolName }, options),
      ).toBeUndefined();

    const initial = handlePrivateLessonSubmitApproval(
      {
        toolName: "submit_private_skill_candidate",
        arguments: { draft_id: "psd_fixture_recovery" },
      },
      options,
    );
    expect(initial?.requireApproval).toBeDefined();
    initial.requireApproval.onResolution("allow-always");
    await Promise.all(approvals);
    expect(api.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);

    // Reconstruct the host from persisted configuration, not the old Set.
    const restarted = {
      approvedLanes: privateLearningSubmitApprovals({
        pluginConfig: structuredClone(
          config.plugins.entries.remembrance.config,
        ),
      }),
    };
    for (const toolName of [
      "capture_learning",
      "inspect_private_learning_outbox",
      "submit_private_skill_candidate",
      "retry_private_skill_candidate",
      "submit_query_feedback",
      "submit_feedback",
    ])
      expect(
        handlePrivateLessonSubmitApproval(
          { toolName, arguments: { useful: true } },
          restarted,
        ),
        toolName,
      ).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval(
        { toolName: "propose_skill_idea" },
        restarted,
      ),
    ).toMatchObject({ requireApproval: expect.any(Object) });
  });

  describe("released approval hook with actual private-skill tooling", () => {
    let directory;
    let privateSkillStatuses;
    let requests;

    beforeEach(async () => {
      directory = await mkdtemp(
        join(tmpdir(), "remembrance-openclaw-private-approval-"),
      );
      vi.stubEnv("XDG_CONFIG_HOME", directory);
      vi.stubEnv("XDG_STATE_HOME", directory);
      vi.stubEnv("REMEMBRANCE_API_KEY", "rk_synthetic_openclaw_approval");
      vi.stubEnv("REMEMBRANCE_API_URL", "https://example.test");
      vi.stubEnv("REMEMBRANCE_API_KEY_ORIGIN", "https://example.test");
      vi.stubEnv(
        "REMEMBRANCE_AGENT_KEY_PATH",
        join(directory, "agent-key.json"),
      );
      vi.stubEnv("REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN", "0");
      vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
      resetPrincipalSessionCacheForTests();
      inspect
        .mockReset()
        .mockImplementation(inspectPrivateSkillFieldsWithActualRoot);
      privateSkillStatuses = [503, 201];
      requests = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init) => {
          const path = new URL(url).pathname;
          const rawBody = String(init?.body ?? "{}");
          requests.push({ path, rawBody, body: JSON.parse(rawBody) });
          if (path !== "/api/v1/agent/private-skill-ideas") {
            throw new Error(`Unexpected synthetic transport route: ${path}`);
          }
          const status = privateSkillStatuses.shift() ?? 201;
          return status === 201
            ? Response.json(
                {
                  public_id: "sidea_openclaw_approval_fixture",
                  created: true,
                  visibility: "organization_private",
                  owner_scope: "organization",
                  verification: { status: "queued" },
                },
                {
                  status,
                  headers: { "idempotency-status": "created" },
                },
              )
            : Response.json(
                { code: "temporary_openclaw_approval_fixture_failure" },
                { status },
              );
        }),
      );
    });

    afterEach(async () => {
      await waitForPrincipalSessionBackgroundTasksForTests();
      inspect.mockReset();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    });

    async function prepareReadyReplacement(execute, fixture) {
      expect(
        runRetiredPrivateLearningRootString(fixture.serialized),
      ).toMatchObject({
        status: "incomplete",
        recoveryReason: fixture.retiredRecoveryReason,
      });
      const original = heldPrivateSkill(fixture);
      const capture = await execute("capture_learning", {
        private_skill: original,
      });
      expect(capture).toMatchObject({
        executed: true,
        result: {
          state: "held_validation",
          retained_locally: true,
          reformulation_reason: fixture.recoveryReason,
          reformulation_status: "awaiting_candidate",
          next_action: null,
        },
      });
      const draftId = String(capture.result.draft_id);
      const inspection = await execute("inspect_private_learning_outbox", {
        private_skill_draft_id: draftId,
        limit: 1,
      });
      const recovery =
        inspection.result.private_skills.selected_draft.recovery_context;
      expect(recovery).toMatchObject({
        status: "context_available",
        projection: fixture.recoveryProjection,
        partial: true,
        authoritative: false,
        meaning_adequacy: fixture.meaningAdequacy,
        context: {
          title: original.title,
          description: original.description,
          domain_slug: original.domain_slug,
        },
      });
      expect(JSON.stringify(inspection.result)).not.toContain(
        fixture.serialized,
      );

      // Deterministic test driver only: the live-model canary is separate.
      const replacement = replacementFromSafeSummary(recovery);
      for (const requiredStep of recoveryWorkflow) {
        expect(replacement.proposed_skill_md).toContain(requiredStep);
      }
      expect(replacement.proposed_skill_md).not.toContain(fixture.serialized);
      const ready = await execute("capture_learning", {
        private_skill: replacement,
        replacement_of: {
          draft_id: draftId,
          context_source: "safe_recovery_context",
        },
      });
      expect(ready).toMatchObject({
        executed: true,
        result: {
          draft_id: draftId,
          state: "ready",
          reformulation_status: "candidate_ready",
          next_action: {
            tool: "submit_private_skill_candidate",
            arguments: { draft_id: draftId },
          },
        },
      });
      return { draftId, fixture, original, replacement };
    }

    it("reuses one persisted private-skill approval for a transient retry after reformulation", async () => {
      const configFile = {
        plugins: { entries: { remembrance: { config: {} } } },
      };
      const initialHost = registerApprovalHook(
        configFile.plugins.entries.remembrance.config,
        configFile,
      );
      const approvalRequests = [];
      const initialExecute = approvalAwareExecutor(
        initialHost.beforeToolCall,
        approvalRequests,
      );
      const prepared = await prepareReadyReplacement(
        initialExecute,
        ambiguousPrivateStructureFixture(),
      );
      expect(approvalRequests).toEqual([]);
      expect(requests).toEqual([]);

      const failed = await initialExecute(
        "submit_private_skill_candidate",
        { draft_id: prepared.draftId },
        "allow-always",
      );
      expect(failed).toMatchObject({
        executed: true,
        result: {
          status: "not_submitted",
          state: "retry_scheduled",
          retained_locally: true,
        },
      });
      expect(approvalRequests).toEqual([
        {
          toolName: "submit_private_skill_candidate",
          title: "Submit private Remembrance skill",
        },
      ]);
      await vi.waitFor(() =>
        expect(initialHost.mutateConfigFile).toHaveBeenCalledOnce(),
      );
      expect(
        configFile.plugins.entries.remembrance.config
          .privateLearningEgressApprovals,
      ).toEqual({ private_skill: true });
      expect(requests).toHaveLength(1);
      expect(withoutIdempotency(requests[0].body)).toEqual(
        prepared.replacement,
      );

      const retained = await readPrivateSkillDraft(prepared.draftId);
      expect(retained).toMatchObject({
        state: "retry_scheduled",
        candidate: prepared.original,
        reformulation_attempts: [
          expect.objectContaining({
            candidate: prepared.replacement,
            outcome: "ready",
          }),
        ],
      });
      await updatePrivateSkillDraft(prepared.draftId, (draft) => ({
        ...draft,
        next_retry_at: "2000-01-01T00:00:00.000Z",
      }));

      resetPrincipalSessionCacheForTests();
      const restartedHost = registerApprovalHook(
        structuredClone(configFile.plugins.entries.remembrance.config),
        configFile,
      );
      const restartedExecute = approvalAwareExecutor(
        restartedHost.beforeToolCall,
        approvalRequests,
      );
      const retried = await restartedExecute("retry_private_skill_candidate", {
        draft_id: prepared.draftId,
      });
      expect(retried).toMatchObject({
        executed: true,
        result: {
          status: "accepted_private_candidate",
          state: "submitted",
          retained_locally: false,
        },
      });
      expect(approvalRequests).toHaveLength(1);
      expect(restartedHost.mutateConfigFile).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      expect(requests[1].rawBody).toBe(requests[0].rawBody);
      expect(JSON.stringify(requests)).not.toContain(
        prepared.fixture.serialized,
      );
      expect(
        await readPrivateSkillSubmittedRecord(prepared.draftId),
      ).toMatchObject({ state: "submitted" });
    });

    it("does not dispatch a ready private-skill submission when the initial lane is denied", async () => {
      privateSkillStatuses = [201];
      const configFile = {
        plugins: { entries: { remembrance: { config: {} } } },
      };
      const host = registerApprovalHook(
        configFile.plugins.entries.remembrance.config,
        configFile,
      );
      const approvalRequests = [];
      const execute = approvalAwareExecutor(
        host.beforeToolCall,
        approvalRequests,
      );
      const prepared = await prepareReadyReplacement(
        execute,
        encryptedPrivateContainerFixture(),
      );

      const denied = await execute(
        "submit_private_skill_candidate",
        { draft_id: prepared.draftId },
        "deny",
      );
      expect(denied).toEqual({ executed: false, result: undefined });
      expect(approvalRequests).toEqual([
        {
          toolName: "submit_private_skill_candidate",
          title: "Submit private Remembrance skill",
        },
      ]);
      expect(host.mutateConfigFile).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(await readPrivateSkillDraft(prepared.draftId)).toMatchObject({
        state: "ready",
        candidate: prepared.original,
        reformulation_attempts: [
          expect.objectContaining({
            candidate: prepared.replacement,
            outcome: "ready",
          }),
        ],
      });
      expect(
        configFile.plugins.entries.remembrance.config
          .privateLearningEgressApprovals,
      ).toBeUndefined();
    });
  });

  it("gates every network action by semantic lane and ignores global approval", () => {
    expect(handlePrivateLessonSubmitApproval(null)).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval({ toolName: "submit_remembrance" }),
    ).toMatchObject({ requireApproval: expect.any(Object) });
    expect(
      handlePrivateLessonSubmitApproval(
        { tool_name: "mcp_remembrance_submit_private_lesson_candidate" },
        { approved: true },
      ),
    ).toMatchObject({ requireApproval: expect.any(Object) });

    const onAllowAlways = vi.fn();
    const result = handlePrivateLessonSubmitApproval(
      { toolName: "submit_private_lesson_candidate" },
      { onAllowAlways },
    );
    expect(result).toMatchObject({
      requireApproval: {
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        timeoutMs: 120_000,
      },
    });
    result.requireApproval.onResolution("allow-once");
    result.requireApproval.onResolution("deny");
    expect(onAllowAlways).not.toHaveBeenCalled();
    result.requireApproval.onResolution("allow-always");
    expect(onAllowAlways).toHaveBeenCalledWith("private_lesson");

    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "retry_private_lesson_candidate",
      })?.requireApproval,
    ).toMatchObject({ title: "Submit private Remembrance lesson" });

    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_private_skill_candidate",
      })?.requireApproval,
    ).toMatchObject({ title: "Submit private Remembrance skill" });
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "retry_private_skill_candidate",
      })?.requireApproval,
    ).toMatchObject({ title: "Submit private Remembrance skill" });

    for (const toolName of [
      "submit_private_lesson_candidate",
      "retry_private_lesson_candidate",
    ]) {
      expect(
        handlePrivateLessonSubmitApproval(
          { toolName },
          { approvedLanes: new Set(["private_lesson"]) },
        ),
      ).toBeUndefined();
    }
    expect(
      handlePrivateLessonSubmitApproval(
        { toolName: "submit_private_skill_candidate" },
        { approvedLanes: new Set(["private_lesson"]) },
      ),
    ).toMatchObject({ requireApproval: expect.any(Object) });

    for (const [lane, tools] of [
      ["remembrance_submission", ["submit_remembrance"]],
      ["private_skill_proposal", ["propose_private_skill"]],
      ["skill_candidate", ["propose_skill_idea"]],
      ["skill_suggestion", ["submit_suggestion"]],
      ["resource_submission", ["submit_resource"]],
      ["resource_review", ["submit_resource_review"]],
    ]) {
      for (const toolName of tools) {
        expect(
          handlePrivateLessonSubmitApproval({ toolName }),
          toolName,
        ).toMatchObject({ requireApproval: expect.any(Object) });
        expect(
          handlePrivateLessonSubmitApproval(
            { toolName },
            { approvedLanes: new Set([lane]) },
          ),
          toolName,
        ).toBeUndefined();
      }
    }
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_query_feedback",
        arguments: { query_id: "rq", results: [] },
      }),
    ).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_feedback",
        arguments: { useful: true },
      }),
    ).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_feedback",
        arguments: { useful: true, lesson: null },
      }),
    ).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_feedback",
        arguments: { useful: true, lesson: "   " },
      }),
    ).toBeUndefined();
    for (const argumentsValue of [null, "not-an-object", []]) {
      expect(
        handlePrivateLessonSubmitApproval({
          toolName: "submit_feedback",
          arguments: argumentsValue,
        }),
      ).toBeUndefined();
    }
    expect(
      handlePrivateLessonSubmitApproval({
        toolName: "submit_feedback",
        arguments: { useful: true, lesson: "Reusable detail" },
      }),
    ).toMatchObject({ requireApproval: expect.any(Object) });
    for (const event of [
      {
        toolName: "submit_feedback",
        input: { useful: true, lesson: "Input-shaped reusable detail" },
      },
      {
        toolName: "submit_feedback",
        params: {
          arguments: { useful: true, lesson: "Nested reusable detail" },
        },
      },
      {
        toolName: "submit_feedback",
        params: { useful: true, lesson: "Params-shaped reusable detail" },
      },
    ]) {
      expect(handlePrivateLessonSubmitApproval(event)).toMatchObject({
        requireApproval: { title: "Submit reusable feedback content" },
      });
    }
  });

  it("reads and persists the one narrow approval without dropping config", async () => {
    expect(privateLessonSubmitApproved(null)).toBe(false);
    expect(
      privateLessonSubmitApproved({
        pluginConfig: { privateLessonSubmitApproval: true },
      }),
    ).toBe(true);
    expect(
      privateLearningSubmitApprovals({
        pluginConfig: {
          privateLessonSubmitApproval: true,
          privateLearningSubmitApprovals: {
            submit_private_skill_candidate: true,
          },
        },
      }),
    ).toEqual(new Set(["private_lesson", "private_skill"]));

    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      const draft = {
        retained: true,
        plugins: {
          retained: true,
          entries: {
            retained: { enabled: true },
            remembrance: { config: { retained: true } },
          },
        },
      };
      mutate(draft);
      expect(draft).toEqual({
        retained: true,
        plugins: {
          retained: true,
          entries: {
            retained: { enabled: true },
            remembrance: {
              config: {
                retained: true,
                privateLearningEgressApprovals: {
                  private_lesson: true,
                },
              },
            },
          },
        },
      });
    });
    await persistPrivateLessonSubmitApproval({
      runtime: { config: { mutateConfigFile } },
    });
    expect(mutateConfigFile).toHaveBeenCalledOnce();
  });

  it("fails clearly when the host cannot persist approval", async () => {
    await expect(persistPrivateLessonSubmitApproval(null)).rejects.toThrow(
      "config mutation is unavailable",
    );
  });

  it("initializes missing configuration containers", async () => {
    await persistPrivateLessonSubmitApproval({
      runtime: {
        config: {
          mutateConfigFile: async ({ mutate }) => {
            const draft = {};
            mutate(draft);
            expect(draft).toEqual({
              plugins: {
                entries: {
                  remembrance: {
                    config: {
                      privateLearningEgressApprovals: {
                        private_lesson: true,
                      },
                    },
                  },
                },
              },
            });
          },
        },
      },
    });
  });

  it("persists skill-lane approval independently from lesson-lane approval", async () => {
    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      const draft = {
        plugins: {
          entries: {
            remembrance: {
              config: {
                privateLearningEgressApprovals: {
                  private_lesson: true,
                },
              },
            },
          },
        },
      };
      mutate(draft);
      expect(
        draft.plugins.entries.remembrance.config.privateLearningEgressApprovals,
      ).toEqual({
        private_lesson: true,
        private_skill: true,
      });
    });
    await persistPrivateLearningSubmitApproval(
      { runtime: { config: { mutateConfigFile } } },
      "submit_private_skill_candidate",
    );
    expect(mutateConfigFile).toHaveBeenCalledOnce();
  });

  it("accepts retry and broad action names while rejecting unclassified actions", async () => {
    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      const draft = {};
      mutate(draft);
      expect(
        draft.plugins.entries.remembrance.config.privateLearningEgressApprovals,
      ).toEqual({ private_lesson: true });
    });
    await persistPrivateLearningSubmitApproval(
      { runtime: { config: { mutateConfigFile } } },
      "retry_private_lesson_candidate",
    );
    const broadMutation = vi.fn(async ({ mutate }) => {
      const draft = {};
      mutate(draft);
      expect(
        draft.plugins.entries.remembrance.config.privateLearningEgressApprovals,
      ).toEqual({ remembrance_submission: true });
    });
    await persistPrivateLearningSubmitApproval(
      { runtime: { config: { mutateConfigFile: broadMutation } } },
      "submit_remembrance",
    );
    await expect(
      persistPrivateLearningSubmitApproval(
        { runtime: { config: { mutateConfigFile: vi.fn() } } },
        "submit_query_feedback",
      ),
    ).rejects.toThrow("Unsupported private Remembrance submission action");
  });

  it("lazily maps every released approval shape to its lane", () => {
    expect(
      privateLearningSubmitApprovals({
        pluginConfig: {
          privateLearningEgressApprovals: { private_skill: true },
          privateLearningSubmitApprovals: {
            retry_private_lesson_candidate: true,
          },
        },
      }),
    ).toEqual(new Set(["private_skill", "private_lesson"]));
  });
});
