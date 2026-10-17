// The per-turn pending-action list for private-learning drafts (0.2.3):
// a line only for an exact action the draft's own envelope allows now (A),
// every private line declinable and a host denial parking that one draft
// (B), and silent recovery only for the session tree that captured a draft,
// every other one offered as a user decision (C). Every case asserts what is
// left on disk: hints, parked and notice markers, and outbox bytes, which
// the hook never writes.
import { createHash } from "node:crypto";
import nodeFs, {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as hookCore from "../scripts/hook-core.mjs";
import {
  acknowledgePrivateAuthorizationReminders,
  agentLedgerIdFor,
  completionContinuationReason,
  decideStop,
  markCompletionObligationsPrompted,
  markCurrentEngagementHandled,
  observeSuccessfulCompletionTool,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  readPromptedCount,
  recordHostPolicyDenial,
  recordPrivateLessonObligation,
  recordRegistryUse,
  recordUserPrompt,
  runPromptHook,
} from "../scripts/hook-core.mjs";
import {
  PRIVATE_LEARNING_INSPECTOR_DIGEST,
  completeDirectiveUnits,
} from "../scripts/private-learning-hook-policy.mjs";

const roots = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "remembrance-pending-ownership-"));
  roots.push(root);
  return {
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_PLUGIN_ALERT_DIR: join(root, "alerts"),
    REMEMBRANCE_PLUGIN_HEALTH_DIR: join(root, "health"),
    REMEMBRANCE_API_KEY: "rk_synthetic_pending_ownership",
    REMEMBRANCE_API_URL: "http://127.0.0.1:9",
    REMEMBRANCE_API_KEY_ORIGIN: "http://127.0.0.1:9",
    ...extra,
  };
}

const hash = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const ledgerOf = (ledgerId) => hash(ledgerId).slice(0, 16);
const actionIdOf = (id) => hash(id).slice(0, 16);
const ORPHAN_NOTICE = actionIdOf("private_draft_notice:awaiting_user");
// The id an earlier client's held-safety notice named; the notice now
// names no action.
const HELD_NOTICE = actionIdOf("private_draft_notice:held_safety");
const HELD = "held by the local safety check";
const outbox = (env) => join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
const lifecycle = (env) =>
  join(env.XDG_STATE_HOME, "remembrance", "private-learning-lifecycle");
const hintDirectory = (env) => join(lifecycle(env), "obligations");
const hintFiles = (env) =>
  existsSync(hintDirectory(env)) ? readdirSync(hintDirectory(env)).sort() : [];
const hintFileOf = (draftId) => `${hash(`private_lesson:${draftId}`).slice(0, 32)}.json`;

// The content-free envelope the MCP server keeps beside an encrypted draft.
function lessonEnvelope(env, draftId, state = "ready", fields = {}) {
  mkdirSync(outbox(env), { recursive: true, mode: 0o700 });
  chmodSync(outbox(env), 0o700);
  const path = join(outbox(env), `${draftId}.lesson.json`);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: "private-lesson-outbox-envelope-v1",
      draft_id: draftId,
      state,
      hold_telemetry_status: state === "held_safety" ? "pending" : "not_required",
      last_error_code: null,
      next_retry_at: null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      encryption: { ciphertext: "opaque-encrypted-draft" },
      ...fields,
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}

// A complete-skill draft's envelope whose exact next action, a
// reformulation, the agent may take now.
function skillEnvelope(env, draftId) {
  const directory = join(env.XDG_STATE_HOME, "remembrance", "private-skills");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const candidateDigest = `sha256:${"1".repeat(64)}`;
  const updatedAt = "2026-10-01T00:00:00.000Z";
  writeFileSync(
    join(directory, `${draftId}.json`),
    `${JSON.stringify({
      version: "private-skill-outbox-envelope-v1",
      draft_id: draftId,
      state: "held_validation",
      candidate_digest: candidateDigest,
      created_at: updatedAt,
      updated_at: updatedAt,
      reformulation_available: true,
      reformulation_reason: "ambiguous_source_ownership",
      reformulation_attempt_count: 0,
      recovery_epoch_attempt_count: 0,
      inspector_digest: PRIVATE_LEARNING_INSPECTOR_DIGEST,
      native_context_pending: false,
      next_retry_at: null,
      next_action: {
        version: "private-skill-recovery-action-v1",
        kind: "reformulate",
        candidate_digest: candidateDigest,
        inspector_digest: PRIVATE_LEARNING_INSPECTOR_DIGEST,
        draft_updated_at: updatedAt,
      },
      encryption: { ciphertext: "opaque-encrypted-candidate" },
    })}\n`,
    { mode: 0o600 },
  );
}

// A capture as capture_learning answers it, with the exact next action.
function capture(env, ledgerId, draftId, state = "ready", core = hookCore) {
  return core.observeSuccessfulCompletionTool(
    ledgerId,
    "mcp__remembrance__capture_learning",
    {},
    {
      capture_route: "private_lesson",
      draft_id: draftId,
      state,
      next_action: {
        tool: "submit_private_lesson_candidate",
        arguments: { draft_id: draftId },
      },
    },
    env,
  );
}

// The session-scoped lifecycle text: only these drafts, by draft_id.
const ownDrafts = (...ids) =>
  `Silently call inspect_private_learning_outbox only for this session's due private drafts (${ids.join(", ")}):`;
const NO_OTHER_DRAFT =
  "Do not submit or retry, on your own, any other draft inspect_private_learning_outbox lists.";
// The user decision: unowned, parked, an idle session's, or untracked own
// drafts.
const awaitingUser = (lessons, skills) =>
  `Retained private drafts awaiting a user decision: ${lessons} lesson${lessons === 1 ? "" : "s"} and ${skills} skill${skills === 1 ? "" : "s"} that no active session is handling;`;
// The two user-decision notices, whole. Each is one sentence: one directive
// unit, which the context allocator keeps whole or drops, so a delivery's
// exact text acknowledges it.
const awaitingNotice = (lessons, skills) =>
  `- ${awaitingUser(lessons, skills)} do not submit them on your own, but ask the user once whether to deliver them (inspect_private_learning_outbox, then each draft's exact submit or retry action), keep them (local decline_pending_action with action_id ${ORPHAN_NOTICE} and any reason), or delete them (the matching delete tool with confirm=true); if no user can answer in this run, leave them in the outbox.`;
const heldNotice = (count) =>
  `- ${count} retained private lesson draft${count === 1 ? " was" : "s were"} held by the local safety check and will not be sent: ask the user once whether to re-capture a safe version with a new capture_learning call or delete ${count === 1 ? "it" : "them"} with delete_private_lesson_candidate and confirm=true (inspect_private_learning_outbox lists each draft_id), and never resubmit the held content; this notice is shown once and needs no reply, and if no user can answer in this run, leave the outbox as it is.`;
const lessonLine = (draftId, tool = "submit_private_lesson_candidate", by = "") =>
  `- Private lesson${by}: call ${tool} with draft_id ${draftId}.`;
const pending = (env, ledgerId, core = hookCore) =>
  core.pendingCompletionRecoveryInstruction(ledgerId, env) ?? "";
// What every prompt adapter does with the context it delivered.
const deliver = (env, text) => acknowledgePrivateAuthorizationReminders(text, env);
const parked = (env, draftId) => {
  const path = join(lifecycle(env), `${draftId}.parked.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};
const decline = (env, ledgerId, actionId, reason, core = hookCore) =>
  core.observeSuccessfulCompletionTool(
    ledgerId,
    "mcp__remembrance__decline_pending_action",
    { action_id: actionId, reason },
    { status: "declined", action_id: actionId, reason },
    env,
  );
// The record an earlier client wrote: no owner.
function legacyHint(env, draftId) {
  const id = `private_lesson:${draftId}`;
  mkdirSync(hintDirectory(env), { recursive: true, mode: 0o700 });
  const path = join(hintDirectory(env), `${hash(id).slice(0, 32)}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: "completion-obligation-v1",
      id,
      kind: "private_lesson",
      engagement_count: 1,
      draft_id: draftId,
      action_tool: "submit_private_lesson_candidate",
      next_retry_at: null,
      delivery_blocked: false,
      failed_credential_digest: null,
      agent_keyed: true,
      created_at: "2026-10-01T00:00:00.000Z",
      prompted_at: null,
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}
const stopOptions = (env) => ({
  env,
  readUseCount: () => 0,
  readEligibilityCount: () => 0,
  readPromptedCount: () => 0,
  readHighMatch: () => null,
  readDirectSelections: () => [],
});
// A session's last user prompt, `at` milliseconds since the epoch.
function promptedAt(env, ledgerId, at) {
  recordUserPrompt(ledgerId, env);
  const path = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.user-prompts`);
  utimesSync(path, at / 1000, at / 1000);
}
// A host's permission denial of one exact private submit.
const deny = (env, toolName, draftId, eventType = "PermissionDenied", extra = {}) =>
  recordHostPolicyDenial(
    {
      surface: "claude_code",
      sessionId: "session-a",
      eventType,
      toolName: `mcp__plugin_remembrance_remembrance__${toolName}`,
      value: { tool_input: { draft_id: draftId }, ...extra },
    },
    env,
  );
// An exact submit the host let through, which the server kept for later.
const allowedSubmit = (env, ledgerId, draftId) =>
  observeSuccessfulCompletionTool(
    ledgerId,
    "submit_private_lesson_candidate",
    { draft_id: draftId },
    {
      draft_id: draftId,
      state: "ready",
      status: "not_submitted",
      retained_locally: true,
      next_action: {
        tool: "submit_private_lesson_candidate",
        arguments: { draft_id: draftId },
      },
    },
    env,
  );
const markers = (env) =>
  existsSync(lifecycle(env))
    ? readdirSync(lifecycle(env)).filter((name) => name.endsWith(".json")).sort()
    : [];
// Another host on the machine at plugin version `version`: this core and
// its modules copied beside a package.json naming that version, loaded as a
// module of its own, which keeps its own composed notices as that host's
// process does. A version that is not a stable x.y.z counts as none.
async function hostAt(version) {
  const root = mkdtempSync(join(tmpdir(), "remembrance-pending-host-"));
  roots.push(root);
  const scripts = new URL("../scripts/", import.meta.url);
  mkdirSync(join(root, "scripts"));
  for (const name of readdirSync(scripts).filter((name) => name.endsWith(".mjs"))) {
    copyFileSync(new URL(name, scripts), join(root, "scripts", name));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  const core = await import(
    /* @vite-ignore */ pathToFileURL(join(root, "scripts", "hook-core.mjs")).href
  );
  expect(core.installedClientVersion()).toBe(/^\d+\.\d+\.\d+$/.test(version) ? version : null);
  return core;
}

describe("A: a private line only for an action the draft allows now", () => {
  it.each(["accepted_hold_telemetry", "duplicate", "already_recorded"])(
    "lists a safety hold's hold event once, then nothing after the server answers %s",
    (status) => {
      const env = fixture();
      const draftId = "pld_heldsafety01";
      const path = lessonEnvelope(env, draftId, "held_safety");
      capture(env, "session-a", draftId, "held_safety");
      expect(
        pending(env, "session-a")
          .split("\n")
          .filter((line) => line === lessonLine(draftId)),
      ).toHaveLength(1);

      // The server records the content-free event; the draft stays held.
      lessonEnvelope(env, draftId, "held_safety", {
        hold_telemetry_status: "submitted",
      });
      const bytes = readFileSync(path);
      const result = observeSuccessfulCompletionTool(
        "session-a",
        "submit_private_lesson_candidate",
        { draft_id: draftId },
        {
          draft_id: draftId,
          state: "held_safety",
          status,
          retained_locally: true,
          next_action: null,
        },
        env,
      );
      expect(result.opened).toEqual([]);
      expect(readCompletionObligations("session-a", env)).toEqual([]);
      expect(hintFiles(env)).toEqual([]);

      // Instead of a line: one user decision, once per draft.
      const after = pending(env, "session-a");
      expect(after).not.toContain(`draft_id ${draftId}`);
      expect(after).toContain(HELD);
      expect(after).toContain("re-capture a safe version");
      deliver(env, after);
      expect(
        JSON.parse(
          readFileSync(join(lifecycle(env), `${draftId}.held-notice.json`), "utf8"),
        ),
      ).toEqual({ version: 1, shown_at: expect.any(String) });
      expect(pendingCompletionRecoveryInstruction("session-a", env)).toBeNull();
      expect(pendingCompletionRecoveryInstruction("session-b", env)).toBeNull();
      expect(readFileSync(path)).toEqual(bytes);
    },
  );

  it("retires on the first prompt a hint an earlier client left for a recorded safety hold", () => {
    const env = fixture();
    const draftId = "pld_legacyheld01";
    const path = lessonEnvelope(env, draftId, "held_safety", {
      hold_telemetry_status: "submitted",
    });
    const hint = legacyHint(env, draftId);
    const bytes = readFileSync(path);
    expect(pending(env, "any-session")).not.toContain(`draft_id ${draftId}`);
    expect(existsSync(hint)).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("lists a safety hold's hold-event retry only once it is due", () => {
    const env = fixture();
    const draftId = "pld_telemetry001";
    lessonEnvelope(env, draftId, "held_safety", {
      hold_telemetry_status: "retry_scheduled",
      next_retry_at: "2999-01-01T00:00:00.000Z",
    });
    observeSuccessfulCompletionTool(
      "session-a",
      "submit_private_lesson_candidate",
      { draft_id: draftId },
      {
        draft_id: draftId,
        state: "held_safety",
        status: "not_submitted",
        retained_locally: true,
        next_action: null,
      },
      env,
    );
    expect(readCompletionObligations("session-a", env)).toEqual([
      expect.objectContaining({
        draft_id: draftId,
        action_tool: "retry_private_lesson_candidate",
      }),
    ]);
    expect(pendingCompletionRecoveryInstruction("session-a", env)).toBeNull();
    lessonEnvelope(env, draftId, "held_safety", {
      hold_telemetry_status: "retry_scheduled",
      next_retry_at: "2020-01-01T00:00:00.000Z",
    });
    expect(pending(env, "session-a")).toContain(
      lessonLine(draftId, "retry_private_lesson_candidate"),
    );
  });

  it.each([
    ["a safety hold while health reporting is off", { REMEMBRANCE_HEALTH_REPORTING: "0" }, "held_safety", {}],
    ["held_validation", {}, "held_validation", {}],
    ["superseded_redactor", {}, "superseded_redactor", {}],
    ["a policy hold a retry cannot refresh", {}, "held_policy", { last_error_code: "policy_audience_changed" }],
  ])("records no line for %s, whatever the response suggested", (_, extra, state, fields) => {
    const env = fixture(extra);
    const draftId = "pld_noaction0001";
    const path = lessonEnvelope(env, draftId, state, fields);
    const bytes = readFileSync(path);
    expect(capture(env, "session-a", draftId, state).opened).toEqual([]);
    expect(hintFiles(env)).toEqual([]);
    expect(pending(env, "session-a")).not.toContain(`draft_id ${draftId}`);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("names the tool the envelope allows now, not the one the hint recorded", () => {
    const env = fixture();
    const draftId = "pld_movedretry01";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId);
    lessonEnvelope(env, draftId, "retry_scheduled", {
      next_retry_at: "2020-01-01T00:00:00.000Z",
    });
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(draftId, "retry_private_lesson_candidate"));
    expect(text).not.toContain(lessonLine(draftId));
  });

  it("takes the response's exact next_action only while the envelope cannot be read", () => {
    const env = fixture();
    capture(env, "session-a", "pld_noenvelope01");
    expect(readCompletionObligations("session-a", env)).toEqual([
      expect.objectContaining({
        draft_id: "pld_noenvelope01",
        action_tool: "submit_private_lesson_candidate",
      }),
    ]);
    // An action naming more than the draft is not an exact action.
    expect(
      recordPrivateLessonObligation(
        "session-a",
        {
          draft_id: "pld_widenedact01",
          state: "ready",
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: "pld_widenedact01", visibility: "public" },
          },
        },
        env,
      ),
    ).toBeNull();
    mkdirSync(outbox(env), { recursive: true, mode: 0o700 });
    chmodSync(outbox(env), 0o700);
    writeFileSync(join(outbox(env), "pld_unreadable01.lesson.json"), "{", {
      mode: 0o600,
    });
    capture(env, "session-a", "pld_unreadable01");
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine("pld_unreadable01"));
    // A readable outbox without the draft has nothing to send: no line, and
    // the hint stays, since no tombstone proves where the draft went.
    expect(text).not.toContain("pld_noenvelope01");
    expect(readCompletionObligations("session-a", env).map((item) => item.draft_id)).toContain(
      "pld_noenvelope01",
    );
  });

  it("reads each lesson envelope once per prompt, however many hints point at it, delivery included", () => {
    const env = fixture();
    const ids = Array.from({ length: 6 }, (_, index) => `pld_boundedread${index}`);
    for (const id of ids) {
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    }
    // One draft for each user decision: no session's, and a recorded hold.
    lessonEnvelope(env, "pld_boundedorphn");
    lessonEnvelope(env, "pld_boundedheld1", "held_safety", {
      hold_telemetry_status: "submitted",
    });
    const opened = [];
    const original = nodeFs.openSync;
    nodeFs.openSync = function counted(path, ...rest) {
      if (String(path).endsWith(".lesson.json")) opened.push(basename(String(path)));
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    let text;
    try {
      text = pendingCompletionRecoveryInstruction("session-a", env);
      // What every prompt adapter then does with what it delivered.
      deliver(env, text);
    } finally {
      nodeFs.openSync = original;
      syncBuiltinESMExports();
    }
    for (const id of ids) expect(text).toContain(lessonLine(id));
    expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(text).toContain(HELD);
    expect(opened.sort()).toEqual(
      [...ids, "pld_boundedorphn", "pld_boundedheld1"]
        .map((id) => `${id}.lesson.json`)
        .sort(),
    );
    // The delivery was acknowledged all the same.
    expect(existsSync(join(lifecycle(env), "orphan-notice.json"))).toBe(true);
    expect(existsSync(join(lifecycle(env), "pld_boundedheld1.held-notice.json"))).toBe(true);
  });

  it("closes the engagement once the only hint points at a draft a readable outbox no longer holds", () => {
    const env = fixture();
    const draftId = "pld_goneenvelop1";
    recordRegistryUse("session-a", env);
    const path = lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId);
    // Its draft is still retained: the engagement stays open.
    expect(markCurrentEngagementHandled("session-a", env)).toBe(1);
    expect(readPromptedCount("session-a", env)).toBe(0);

    rmSync(path);
    // One read of that draft answers, as a prompt's scan does: nothing to
    // act on, so the engagement closes, and the hint stays as a pointer.
    expect(markCurrentEngagementHandled("session-a", env)).toBe(1);
    expect(readPromptedCount("session-a", env)).toBe(1);
    expect(hintFiles(env)).toHaveLength(1);
    expect(pending(env, "session-a")).not.toContain(draftId);
  });
});

describe("B: declinable private lines and host-denial parking", () => {
  it.each([
    "not_observed_by_this_agent",
    "agent_exited",
    "not_reusable",
    "duplicate",
    "host_policy_denied",
  ])("parks only the declined draft for %s", (reason) => {
    const env = fixture();
    const ids = ["pld_declineone01", "pld_declinetwo01"];
    const paths = ids.map((id) => lessonEnvelope(env, id));
    const bytes = paths.map((path) => readFileSync(path));
    for (const id of ids) capture(env, "session-a", id);
    const result = decline(env, "session-a", actionIdOf(`private_lesson:${ids[0]}`), reason);
    expect(result.closed.map((item) => item.draft_id)).toEqual([ids[0]]);
    expect(parked(env, ids[0])).toMatchObject({ version: 1, reason, notices: 0 });
    expect(parked(env, ids[1])).toBeNull();
    expect(readCompletionObligations("session-a", env).map((item) => item.draft_id)).toEqual([
      ids[1],
    ]);
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(ids[1]));
    expect(text).not.toContain(ids[0]);
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
  });

  it("parks exactly the draft a host permission denial names, whatever its wording", () => {
    const env = fixture();
    const ids = ["pld_denieddraft1", "pld_alloweddraft"];
    for (const id of ids) {
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    }
    const denial = (eventType, value, toolName = "submit_private_lesson_candidate") =>
      recordHostPolicyDenial(
        {
          surface: "claude_code",
          sessionId: "session-a",
          eventType,
          toolName: `mcp__plugin_remembrance_remembrance__${toolName}`,
          value,
        },
        env,
      );
    // Unknown wording on a generic failure is no evidence of a host denial.
    expect(
      denial("PostToolUseFailure", { tool_input: { draft_id: ids[0] }, error: "Request refused." }),
    ).toBeNull();
    expect(parked(env, ids[0])).toBeNull();
    // A draft of the other lane is no draft of this tool.
    denial("PermissionDenied", { tool_input: { draft_id: ids[0] } }, "submit_private_skill_candidate");
    expect(parked(env, ids[0])).toBeNull();
    // The same wording on a permission denial parks that draft only and
    // records no lane-wide observation.
    expect(
      denial("PermissionDenied", { tool_input: JSON.stringify({ draft_id: ids[0] }), reason: "Request refused." }),
    ).toBeNull();
    expect(parked(env, ids[0])).toMatchObject({ reason: "host_policy_denied", notices: 0 });
    expect(parked(env, ids[1])).toBeNull();
    expect(existsSync(env.REMEMBRANCE_PLUGIN_ALERT_DIR)).toBe(false);
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(ids[1]));
    expect(text).not.toContain(ids[0]);

    // A failure the classifier recognizes parks the draft it names, and the
    // lane-wide observation then holds only the silent lifecycle text.
    expect(
      denial(
        "PostToolUse",
        {
          tool_input: { draft_id: ids[1] },
          error: "Tool execution denied by host policy before reaching Remembrance.",
        },
        "retry_private_lesson_candidate",
      ),
    ).toMatchObject({ operation_class: "private_lesson" });
    expect(parked(env, ids[1])).toMatchObject({ reason: "host_policy_denied" });
    expect(pendingCompletionRecoveryInstruction("session-a", env)).toBeNull();
  });

  it("returns host-denied drafts once, as a user decision, after the host lets that lane through", () => {
    const env = fixture();
    const [denied, other] = ["pld_lanedenied01", "pld_laneother001"];
    for (const id of [denied, other]) {
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    }
    recordHostPolicyDenial(
      {
        surface: "claude_code",
        sessionId: "session-a",
        eventType: "PermissionDenied",
        toolName: "submit_private_lesson_candidate",
        value: { tool_input: { draft_id: denied } },
      },
      env,
    );
    expect(pending(env, "session-a")).not.toContain(ORPHAN_NOTICE);
    const allowOther = () =>
      observeSuccessfulCompletionTool(
        "session-a",
        "submit_private_lesson_candidate",
        { draft_id: other },
        {
          draft_id: other,
          state: "ready",
          status: "not_submitted",
          retained_locally: true,
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: other },
          },
        },
        env,
      );
    allowOther();
    expect(parked(env, denied)).toMatchObject({
      notices: 0,
      lane_allowed_at: expect.any(String),
    });
    const text = pending(env, "session-a");
    expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(text).toContain(awaitingUser(1, 0));
    expect(text).not.toContain(denied);
    deliver(env, text);
    const shown = parked(env, denied);
    expect(shown.notices).toBe(1);
    expect(Date.parse(shown.next_notice_at)).toBeGreaterThan(Date.now());
    // The lane allowed again does not bring it back a second time.
    allowOther();
    expect(parked(env, denied)).toEqual(shown);
  });

  it("brings a declined draft back after 1, 7 and 30 days, then only after a client update", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    vi.setSystemTime(start);
    const env = fixture();
    const draftId = "pld_snoozeddraft";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId);
    decline(env, "session-a", actionIdOf(`private_lesson:${draftId}`), "not_reusable");
    const shownOnDay = [];
    for (let hours = 0; hours <= 120 * 24; hours += 12) {
      vi.setSystemTime(start + hours * 60 * 60 * 1000);
      const text = pending(env, "session-a");
      expect(text).not.toContain(draftId);
      if (text.includes(`action_id ${ORPHAN_NOTICE}`)) {
        shownOnDay.push(hours / 24);
        deliver(env, text);
      }
    }
    expect(shownOnDay).toEqual([1, 8, 38]);
    expect(parked(env, draftId)).toMatchObject({ notices: 3, next_notice_at: null });

    // A client update brings it back once more.
    const path = join(lifecycle(env), `${draftId}.parked.json`);
    writeFileSync(path, JSON.stringify({ ...parked(env, draftId), client_version: "0.0.1" }), {
      mode: 0o600,
    });
    vi.setSystemTime(start + 122 * 24 * 60 * 60 * 1000);
    const updated = pending(env, "session-a");
    expect(updated).toContain(`action_id ${ORPHAN_NOTICE}`);
    deliver(env, updated);
    vi.setSystemTime(start + 160 * 24 * 60 * 60 * 1000);
    expect(pending(env, "session-a")).not.toContain(ORPHAN_NOTICE);
    expect(parked(env, draftId)).toMatchObject({ notices: 4, reason: "not_reusable" });
  });

  it.each([
    ["never lets its lane through", null, [1, 8, 38]],
    ["lets its lane through before the first return", ["lane", 0.5], [0.5, 7.5, 37.5]],
    ["lets its lane through after the first return", ["lane", 2], [1, 2, 32]],
    ["lets its lane through after the second return", ["lane", 9], [1, 8, 9]],
    ["lets its lane through after all three returns", ["lane", 40], [1, 8, 38, 40]],
    ["runs an updated client after the first return", ["update", 2], [1, 2, 32]],
    // A line the agent declined with host_policy_denied is parked as a host
    // denial parks it.
    [
      "lets its lane through after the first return of a draft whose line was declined with host_policy_denied",
      ["lane", 2],
      [1, 2, 32],
      "decline",
    ],
  ])(
    "returns a host-denied draft 1, 7 and 30 days after its park or last showing when the host %s",
    (_label, event, days, parkedBy = "denial") => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.parse("2026-10-16T12:00:00.000Z");
      vi.setSystemTime(start);
      const env = fixture();
      const draftId = "pld_scheduledeny";
      lessonEnvelope(env, draftId);
      if (parkedBy === "decline") {
        capture(env, "session-a", draftId);
        decline(env, "session-a", actionIdOf(`private_lesson:${draftId}`), "host_policy_denied");
      } else {
        deny(env, "submit_private_lesson_candidate", draftId);
      }
      const shownOnDay = [];
      for (let hours = 12; hours <= 45 * 24; hours += 12) {
        vi.setSystemTime(start + hours * 60 * 60 * 1000);
        if (event?.[0] === "lane" && event[1] * 24 === hours) {
          // The host lets another exact submit of that lane through.
          const other = "pld_scheduleothr";
          observeSuccessfulCompletionTool(
            "session-a",
            "submit_private_lesson_candidate",
            { draft_id: other },
            { draft_id: other, state: "submitted", accepted_private_candidate: true },
            env,
          );
        }
        if (event?.[0] === "update" && event[1] * 24 === hours) {
          writeFileSync(
            join(lifecycle(env), `${draftId}.parked.json`),
            JSON.stringify({ ...parked(env, draftId), client_version: "0.0.1" }),
            { mode: 0o600 },
          );
        }
        const text = pending(env, "session-a");
        if (text.includes(`action_id ${ORPHAN_NOTICE}`)) {
          shownOnDay.push(hours / 24);
          deliver(env, text);
        }
      }
      expect(shownOnDay).toEqual(days);
      expect(parked(env, draftId)).toMatchObject({
        reason: "host_policy_denied",
        notices: days.length,
      });
    },
  );

  it("moves a parked draft one step when several sessions composed its due notice before any delivered it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    vi.setSystemTime(start);
    const env = fixture();
    const draftId = "pld_racedparked1";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId);
    decline(env, "session-a", actionIdOf(`private_lesson:${draftId}`), "not_reusable");
    const due = start + 25 * 60 * 60 * 1000;
    vi.setSystemTime(due);
    // Three main sessions compose the notice before any of them delivers it.
    const sessions = ["session-a", "session-b", "session-c"];
    const composed = sessions.map((ledger) => pending(env, ledger));
    for (const text of composed) expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    sessions.forEach((ledger, index) =>
      acknowledgePrivateAuthorizationReminders(composed[index], env, ledger),
    );
    expect(parked(env, draftId)).toMatchObject({
      notices: 1,
      next_notice_at: new Date(due + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it("moves a parked draft one step when a host of an older version delivers first the due notice a newer host also composed", async () => {
    const [older, newer] = [await hostAt("0.2.3"), await hostAt("0.2.4")];
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    vi.setSystemTime(start);
    const env = fixture();
    const draftId = "pld_mixedversion";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId, "ready", newer);
    decline(env, "session-a", actionIdOf(`private_lesson:${draftId}`), "not_reusable", newer);
    expect(parked(env, draftId)).toMatchObject({ notices: 0, client_version: "0.2.4" });
    const due = start + 25 * 60 * 60 * 1000;
    vi.setSystemTime(due);
    const hosts = [
      [older, "session-b"],
      [newer, "session-c"],
    ];
    const composed = hosts.map(([core, ledger]) => pending(env, ledger, core));
    for (const text of composed) expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    // The older host delivers first; the newer one's delivery finds it moved.
    hosts.forEach(([core, ledger], index) =>
      core.acknowledgePrivateAuthorizationReminders(composed[index], env, ledger),
    );
    expect(parked(env, draftId)).toMatchObject({
      notices: 1,
      next_notice_at: new Date(due + 7 * 24 * 60 * 60 * 1000).toISOString(),
      client_version: "0.2.4",
    });
  });

  it("keeps a parked draft's wait and version when a host of an older or no stable version shows, keeps or re-parks it, so a newer host does not offer it the next day", async () => {
    const [older, newer, unversioned] = [
      await hostAt("0.2.3"),
      await hostAt("0.2.4"),
      await hostAt("0.2.5-rc.1"),
    ];
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    const hour = 60 * 60 * 1000;
    const at = (hours) => vi.setSystemTime(start + hours * hour);
    at(0);
    const env = fixture();
    const draftId = "pld_mixedwaiting";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId, "ready", newer);
    decline(env, "session-a", actionIdOf(`private_lesson:${draftId}`), "not_reusable", newer);
    const denyIn = (core, sessionId) =>
      core.recordHostPolicyDenial(
        {
          surface: "claude_code",
          sessionId,
          eventType: "PermissionDenied",
          toolName: "mcp__plugin_remembrance_remembrance__submit_private_lesson_candidate",
          value: { tool_input: { draft_id: draftId } },
        },
        env,
      );

    // A day later the older host shows the due notice, and the user keeps
    // the draft there.
    at(25);
    const shown = pending(env, "session-b", older);
    expect(shown).toContain(`action_id ${ORPHAN_NOTICE}`);
    older.acknowledgePrivateAuthorizationReminders(shown, env, "session-b");
    decline(env, "session-b", ORPHAN_NOTICE, "not_reusable", older);
    expect(parked(env, draftId)).toMatchObject({
      reason: "not_reusable",
      notices: 1,
      next_notice_at: new Date(start + (25 + 7 * 24) * hour).toISOString(),
      client_version: "0.2.4",
    });
    at(49);
    expect(pending(env, "session-c", newer)).not.toContain(ORPHAN_NOTICE);

    // The user asks for it in the older host, which denies the submit: the
    // re-park restarts the wait and keeps the newer version.
    denyIn(older, "session-b");
    expect(parked(env, draftId)).toMatchObject({
      reason: "host_policy_denied",
      notices: 1,
      next_notice_at: new Date(start + (49 + 7 * 24) * hour).toISOString(),
      client_version: "0.2.4",
    });
    at(73);
    expect(pending(env, "session-c", newer)).not.toContain(ORPHAN_NOTICE);
    // On that wait the newer host offers it; it never left the outbox.
    at(49 + 7 * 24);
    expect(pending(env, "session-c", newer)).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(readdirSync(outbox(env))).toEqual([`${draftId}.lesson.json`]);

    // A host with no stable version shows it there and, an hour later,
    // re-parks it on a denial: neither moves the recorded version.
    const shownThere = pending(env, "session-d", unversioned);
    expect(shownThere).toContain(`action_id ${ORPHAN_NOTICE}`);
    unversioned.acknowledgePrivateAuthorizationReminders(shownThere, env, "session-d");
    expect(parked(env, draftId)).toMatchObject({ notices: 2, client_version: "0.2.4" });
    at(50 + 7 * 24);
    denyIn(unversioned, "session-d");
    expect(parked(env, draftId)).toMatchObject({
      reason: "host_policy_denied",
      parked_at: new Date(start + (50 + 7 * 24) * hour).toISOString(),
      notices: 2,
      next_notice_at: new Date(start + (50 + 7 * 24 + 30 * 24) * hour).toISOString(),
      client_version: "0.2.4",
    });
  });

  it("drops a parked draft's hint, whatever parked it, and keeps its authorization backoff", () => {
    const env = fixture();
    const ids = ["pld_parkdenied01", "pld_parkdecline1"];
    for (const id of ids) {
      lessonEnvelope(env, id, "awaiting_authorization");
      recordPrivateLessonObligation(
        "session-a",
        {
          draft_id: id,
          state: "awaiting_authorization",
          status: "not_submitted",
          next_action: {
            tool: "retry_private_lesson_candidate",
            arguments: { draft_id: id },
          },
        },
        env,
      );
    }
    expect(hintFiles(env)).toHaveLength(2);
    deny(env, "retry_private_lesson_candidate", ids[0]);
    decline(env, "session-a", actionIdOf(`private_lesson:${ids[1]}`), "not_reusable");
    expect(hintFiles(env)).toEqual([]);
    expect(markers(env)).toEqual(
      ids.flatMap((id) => [`${id}.authorization.json`, `${id}.parked.json`]).sort(),
    );

    // The user has one delivered: its explicit retry records a hint again.
    observeSuccessfulCompletionTool(
      "session-a",
      "retry_private_lesson_candidate",
      { draft_id: ids[0] },
      {
        draft_id: ids[0],
        state: "awaiting_authorization",
        status: "not_submitted",
        retained_locally: true,
        next_action: {
          tool: "retry_private_lesson_candidate",
          arguments: { draft_id: ids[0] },
        },
      },
      env,
    );
    expect(parked(env, ids[0])).toBeNull();
    expect(readCompletionObligations("session-a", env).map((item) => item.draft_id)).toEqual([
      ids[0],
    ]);
  });

  it("returns only host-denied drafts of the lane the host let through", () => {
    const env = fixture();
    const [skill, declined, allowed] = ["psd_lanedenied01", "pld_lanedeclined", "pld_laneallowed1"];
    for (const id of [declined, allowed]) {
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    }
    deny(env, "submit_private_skill_candidate", skill);
    decline(env, "session-a", actionIdOf(`private_lesson:${declined}`), "not_reusable");
    const before = [parked(env, skill), parked(env, declined)];
    expect(before).toEqual([
      expect.objectContaining({ reason: "host_policy_denied", notices: 0 }),
      expect.objectContaining({ reason: "not_reusable", notices: 0 }),
    ]);

    allowedSubmit(env, "session-a", allowed);
    // A lesson submit allows the lesson lane only, and returns only what a
    // host denial parked there.
    expect([parked(env, skill), parked(env, declined)]).toEqual(before);
  });

  it("holds the silent lifecycle text while the host denies the lane, and restores it once a submit gets through", () => {
    const env = fixture();
    const [own, denied] = ["pld_gateowndraft", "pld_gatedenied01"];
    for (const id of [own, denied]) {
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    }
    expect(pending(env, "session-a")).toContain("Private learning recovery: 2 lesson candidates");
    // A failure the classifier recognizes records the lane-wide observation.
    expect(
      deny(env, "retry_private_lesson_candidate", denied, "PostToolUse", {
        error: "Tool execution denied by host policy before reaching Remembrance.",
      }),
    ).toMatchObject({ operation_class: "private_lesson" });
    const held = pending(env, "session-a");
    expect(held).toContain(lessonLine(own));
    expect(held).not.toContain("Private learning recovery");
    expect(held).not.toContain(denied);

    allowedSubmit(env, "session-a", own);
    const restored = pending(env, "session-a");
    expect(restored).toContain("Private learning recovery: 1 lesson candidate,");
    expect(restored).toContain(ownDrafts(own));
    expect(restored).not.toContain(denied);
  });
});

describe("C: silent recovery only for the session tree that captured a draft", () => {
  it("lists a draft only for its own session tree, naming a capturing subagent", () => {
    const env = fixture();
    lessonEnvelope(env, "pld_sessionown01");
    lessonEnvelope(env, "pld_subagentown1");
    recordUserPrompt("session-a", env);
    capture(env, "session-a", "pld_sessionown01");
    const subagentStop = (agentId) => ({
      hook_event_name: "SubagentStop",
      session_id: "session-a",
      agent_id: agentId,
    });
    capture(env, agentLedgerIdFor(subagentStop("agent-sub-1")), "pld_subagentown1");

    const own = pending(env, "session-a");
    expect(own).toContain(lessonLine("pld_sessionown01"));
    expect(own).toContain(
      lessonLine("pld_subagentown1", undefined, " (captured by subagent agent-sub-1)"),
    );
    // Another session sees neither, while session A is active.
    expect(pendingCompletionRecoveryInstruction("session-b", env)).toBeNull();

    // A subagent's stop asks only about the draft it captured.
    const asked = decideStop(subagentStop("agent-sub-1"), stopOptions(env));
    expect(asked.allow).toBe(false);
    expect(asked.reason).toContain("pld_subagentown1");
    expect(asked.reason).not.toContain("pld_sessionown01");
    expect(decideStop(subagentStop("agent-sub-2"), stopOptions(env)).allow).toBe(true);
  });

  it("leaves the user decisions to the main thread when a subagent's visible stop asks about its own draft", () => {
    const env = fixture();
    const [owned, unowned, held] = ["pld_subagentask1", "pld_subagentnone", "pld_subagentheld"];
    lessonEnvelope(env, owned);
    lessonEnvelope(env, unowned);
    lessonEnvelope(env, held, "held_safety", { hold_telemetry_status: "submitted" });
    recordUserPrompt("session-a", env);
    const input = {
      hook_event_name: "SubagentStop",
      session_id: "session-a",
      agent_id: "agent-sub-1",
    };
    const ledger = agentLedgerIdFor(input);
    capture(env, ledger, owned);
    // What a stop adapter does with a block: it marks what it asked, then
    // delivers the reason.
    const stop = () => {
      const decision = decideStop(input, { ...stopOptions(env), visibleCompletionRecovery: true });
      if (!decision.allow) {
        markCompletionObligationsPrompted(ledger, decision.obligationIds, env, decision.useCount);
        completionContinuationReason(decision.reason, input, env, { subagent: true });
      }
      return decision;
    };
    const asked = stop();
    expect(asked.allow).toBe(false);
    expect(asked.reason).toContain(`draft_id ${owned}`);
    // Its line asked about, the next stop names its draft in the silent text.
    const again = stop();
    expect(again.allow).toBe(false);
    expect(again.reason).toContain(ownDrafts(owned));
    for (const { reason } of [asked, again]) {
      expect(reason).not.toContain(ORPHAN_NOTICE);
      expect(reason).not.toContain(HELD);
    }
    expect(existsSync(join(lifecycle(env), "orphan-notice.json"))).toBe(false);
    expect(existsSync(join(lifecycle(env), `${held}.held-notice.json`))).toBe(false);

    // The main thread gets both, as before.
    const main = pending(env, "session-a");
    expect(main).toContain(
      "Retained private drafts awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(main).toContain(HELD);
  });

  it("moves a draft to the session whose exact call acted on it last", () => {
    const env = fixture();
    const draftId = "pld_lastcaller01";
    const path = lessonEnvelope(env, draftId);
    const bytes = readFileSync(path);
    recordUserPrompt("session-a", env);
    recordUserPrompt("session-b", env);
    capture(env, "session-a", draftId);
    expect(pending(env, "session-a")).toContain(lessonLine(draftId));
    expect(pending(env, "session-b")).not.toContain(draftId);

    // The user asks session B to deliver it; the server keeps it for later.
    allowedSubmit(env, "session-b", draftId);
    expect(hintFiles(env)).toHaveLength(1);
    expect(readCompletionObligations("session-b", env)).toEqual([
      expect.objectContaining({
        draft_id: draftId,
        owner_session: ledgerOf("session-b"),
        prompted_at: null,
      }),
    ]);
    expect(readCompletionObligations("session-a", env)).toEqual([]);
    expect(pending(env, "session-b")).toContain(lessonLine(draftId));
    const left = pending(env, "session-a");
    expect(left).not.toContain(draftId);
    expect(left).not.toContain(ORPHAN_NOTICE);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("offers an idle session's drafts to another session once, as a user decision, which that session can adopt", () => {
    const env = fixture();
    const ids = ["pld_idlesession1", "pld_idlesession2"];
    const paths = ids.map((id) => lessonEnvelope(env, id));
    const bytes = paths.map((path) => readFileSync(path));
    recordUserPrompt("session-a", env);
    for (const id of ids) capture(env, "session-a", id);
    expect(pendingCompletionRecoveryInstruction("session-b", env)).toBeNull();

    // Session A has had no user prompt for more than a day.
    const idleSince = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(
      join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf("session-a")}.user-prompts`),
      idleSince,
      idleSince,
    );
    const offered = pending(env, "session-b");
    expect(offered).toContain(
      awaitingUser(2, 0),
    );
    expect(offered).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(offered).toContain("do not submit them on your own");
    for (const id of ids) expect(offered).not.toContain(id);
    expect(offered).not.toContain("Silently call");

    // Shown at most once a day on this machine, with the drafts it offered.
    deliver(env, offered);
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toEqual({
      version: 1,
      shown_at: expect.any(String),
      drafts: ids,
    });
    expect(pendingCompletionRecoveryInstruction("session-b", env)).toBeNull();
    expect(pendingCompletionRecoveryInstruction("session-c", env)).toBeNull();

    // Declining the notice snoozes each draft it offered; a parked draft
    // keeps no hint.
    decline(env, "session-b", ORPHAN_NOTICE, "not_reusable");
    for (const id of ids) {
      expect(parked(env, id)).toMatchObject({
        reason: "not_reusable",
        notices: 0,
        next_notice_at: expect.any(String),
      });
    }
    expect(hintFiles(env)).toEqual([]);

    // The user asks B to deliver one: B's exact call adopts it.
    const submit = (response) =>
      observeSuccessfulCompletionTool(
        "session-b",
        "submit_private_lesson_candidate",
        { draft_id: ids[0] },
        { draft_id: ids[0], ...response },
        env,
      );
    submit({
      state: "ready",
      status: "not_submitted",
      retained_locally: true,
      next_action: {
        tool: "submit_private_lesson_candidate",
        arguments: { draft_id: ids[0] },
      },
    });
    expect(parked(env, ids[0])).toBeNull();
    expect(readCompletionObligations("session-b", env)).toEqual([
      expect.objectContaining({ draft_id: ids[0], owner_session: ledgerOf("session-b") }),
    ]);
    expect(readCompletionObligations("session-a", env)).toEqual([]);
    expect(parked(env, ids[1])).toMatchObject({ reason: "not_reusable" });
    expect(pending(env, "session-b")).toContain(lessonLine(ids[0]));
    submit({ state: "submitted", accepted_private_candidate: true });
    expect(readCompletionObligations("session-b", env)).toEqual([]);
    expect(paths.map((path) => readFileSync(path))).toEqual(bytes);
  });

  it("offers a draft an earlier client recorded as no session's", () => {
    const env = fixture();
    lessonEnvelope(env, "pld_legacyready1");
    legacyHint(env, "pld_legacyready1");
    recordUserPrompt("session-a", env);
    const text = pending(env, "session-a");
    expect(text).toContain(awaitingUser(1, 0));
    expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    // An unattended run, which no user answers, leaves them as they are.
    expect(text).toContain(awaitingNotice(1, 0));
    expect(text).not.toContain("pld_legacyready1");
  });

  it("names only its own due drafts in the silent lifecycle text, beside parked, unowned and another session's drafts", () => {
    const env = fixture();
    const [own, ownParked, unowned, other] = [
      "pld_scopedowned1",
      "pld_scopedparkd1",
      "pld_scopednoone1",
      "pld_scopedother1",
    ];
    for (const id of [own, ownParked, unowned, other]) lessonEnvelope(env, id);
    recordUserPrompt("session-a", env);
    recordUserPrompt("session-b", env);
    capture(env, "session-a", own);
    capture(env, "session-a", ownParked);
    decline(env, "session-a", actionIdOf(`private_lesson:${ownParked}`), "not_reusable");
    capture(env, "session-b", other);

    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(own));
    expect(text).toContain("Private learning recovery: 1 lesson candidate,");
    expect(text).toContain(ownDrafts(own));
    expect(text).toContain(NO_OTHER_DRAFT);
    // The context allocator keeps or drops a directive unit whole: the
    // drafts stay with the instruction that names them.
    expect(
      completeDirectiveUnits(text).filter(
        (unit) => unit.startsWith(ownDrafts(own)) && unit.endsWith("only for a due retry."),
      ),
    ).toHaveLength(1);
    // No unscoped submit or retry instruction remains.
    expect(text).not.toContain("Silently call inspect_private_learning_outbox. Submit ready lessons");
    for (const id of [ownParked, unowned, other]) expect(text).not.toContain(id);
    // The draft no session holds is one user decision, which agrees.
    expect(text).toContain(
      "Retained private drafts awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(text).toContain("do not submit them on your own");

    // Session B's text names only its own draft.
    expect(pending(env, "session-b")).toContain(ownDrafts(other));

    // A visible stop whose lines were all asked about before still names
    // the draft, and only it.
    const stop = decideStop(
      { session_id: "session-a" },
      { ...stopOptions(env), visibleCompletionRecovery: true, readCompletionObligations: () => [] },
    );
    expect(stop.reason).toContain(ownDrafts(own));
    expect(stop.reason).toContain(NO_OTHER_DRAFT);
    expect(stop.reason).not.toContain("Silently call inspect_private_learning_outbox. Submit ready lessons");
    for (const id of [ownParked, unowned, other]) expect(stop.reason).not.toContain(id);
  });

  it("names its own due drafts in the order of their lines, so each draft with a line is named", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    const env = fixture();
    // Fourteen drafts, captured in the reverse of their id order.
    const ids = Array.from(
      { length: 14 },
      (_, index) => `pld_${String.fromCharCode(122 - index)}ownorder${String(index).padStart(2, "0")}`,
    );
    ids.forEach((id, index) => {
      vi.setSystemTime(start + index * 1000);
      lessonEnvelope(env, id);
      capture(env, "session-a", id);
    });
    recordUserPrompt("session-a", env);
    const text = pending(env, "session-a");
    const lines = [...text.matchAll(/^- Private lesson: call \S+ with draft_id (\S+)\.$/gm)].map(
      ([, id]) => id,
    );
    expect(lines).toEqual(ids.slice(0, 12));
    expect(text).toContain(
      `only for this session's due private drafts (${ids.slice(0, 12).join(", ")}, and 2 more named in a later prompt):`,
    );
    expect(text).toContain("- 2 additional pending action(s) remain in this session.");
  });

  it("offers an idle session's drafts only after 24 hours without a user prompt, at most once every 24 hours", () => {
    // Whole seconds, so the prompt file's time is exactly the start.
    const start = Math.floor(Date.now() / 1000) * 1000;
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const env = fixture();
    const draftId = "pld_idlethresh01";
    lessonEnvelope(env, draftId);
    capture(env, "session-a", draftId);
    promptedAt(env, "session-a", start);
    const hour = 60 * 60 * 1000;
    const offered = (at) => {
      vi.setSystemTime(at);
      return pending(env, "session-b").includes(`action_id ${ORPHAN_NOTICE}`);
    };
    expect(offered(start + 24 * hour - 60 * 1000)).toBe(false);
    expect(offered(start + 24 * hour)).toBe(true);
    deliver(env, pending(env, "session-b"));
    const shown = start + 24 * hour;
    expect(offered(shown + 23 * hour)).toBe(false);
    expect(offered(shown + 24 * hour)).toBe(true);
    expect(parked(env, draftId)).toBeNull();
  });

  it("gives a safety-held draft its one notice while health reporting is off", () => {
    const env = fixture({ REMEMBRANCE_HEALTH_REPORTING: "0" });
    const draftId = "pld_heldhealth01";
    const path = lessonEnvelope(env, draftId, "held_safety");
    const bytes = readFileSync(path);
    recordUserPrompt("session-a", env);
    const first = pending(env, "session-a");
    // Shown once, at delivery: it asks for no reply.
    expect(first).toContain(heldNotice(1));
    expect(first).not.toContain(HELD_NOTICE);
    expect(first).not.toContain(draftId);
    expect(existsSync(join(lifecycle(env), `${draftId}.held-notice.json`))).toBe(false);
    deliver(env, first);
    expect(
      JSON.parse(readFileSync(join(lifecycle(env), `${draftId}.held-notice.json`), "utf8")),
    ).toEqual({ version: 1, shown_at: expect.any(String) });
    expect(pending(env, "session-a")).not.toContain(HELD);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("acknowledges a delivered notice only for the drafts it was composed from", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const env = fixture();
    const [unowned, denied, laneAllowed, held] = [
      "pld_windownoone1",
      "pld_windowdenid1",
      "pld_windowallow1",
      "pld_windowheld01",
    ];
    for (const id of [unowned, denied, laneAllowed]) lessonEnvelope(env, id);
    recordUserPrompt("session-a", env);
    recordUserPrompt("session-b", env);
    capture(env, "session-a", denied);
    deny(env, "submit_private_lesson_candidate", denied);
    capture(env, "session-b", laneAllowed);
    const text = pending(env, "session-a");
    expect(text).toContain("1 lesson and 0 skills");

    // Between composition and delivery another session's submit gets
    // through, which returns the denied draft, and a new hold appears.
    allowedSubmit(env, "session-b", laneAllowed);
    const returned = parked(env, denied);
    expect(returned).toMatchObject({ notices: 0, lane_allowed_at: expect.any(String) });
    lessonEnvelope(env, held, "held_safety", { hold_telemetry_status: "submitted" });
    deliver(env, text);

    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toEqual({
      version: 1,
      shown_at: expect.any(String),
      drafts: [unowned],
    });
    expect(parked(env, denied)).toEqual(returned);
    expect(existsSync(join(lifecycle(env), `${held}.held-notice.json`))).toBe(false);

    // Neither was shown: the hold gets its notice now, the returned draft
    // with the next notice for drafts awaiting the user.
    expect(pending(env, "session-a")).toContain(HELD);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    promptedAt(env, "session-b", Date.now());
    const next = pending(env, "session-a");
    expect(next).toContain("2 lessons and 0 skills");
    deliver(env, next);
    expect(parked(env, denied)).toMatchObject({ notices: 1 });
  });

  it("parks on a decline only the drafts the delivered notice offered, and a held notice's decline changes nothing", () => {
    const env = fixture();
    const [first, later, heldFirst, heldLater] = [
      "pld_offeredfirst",
      "pld_offeredlater",
      "pld_heldoffered1",
      "pld_heldoffered2",
    ];
    lessonEnvelope(env, first);
    lessonEnvelope(env, heldFirst, "held_safety", { hold_telemetry_status: "submitted" });
    recordUserPrompt("session-a", env);
    const text = pending(env, "session-a");
    expect(text).toContain("1 lesson and 0 skills");
    expect(text).toContain("1 retained private lesson draft was held");
    deliver(env, text);

    // After the delivery another draft awaits the user and another is held.
    lessonEnvelope(env, later);
    lessonEnvelope(env, heldLater, "held_safety", { hold_telemetry_status: "submitted" });
    decline(env, "session-a", ORPHAN_NOTICE, "not_reusable");
    decline(env, "session-a", HELD_NOTICE, "not_reusable");
    expect(parked(env, first)).toMatchObject({ reason: "not_reusable" });
    expect(parked(env, later)).toBeNull();
    expect(existsSync(join(lifecycle(env), `${heldFirst}.held-notice.json`))).toBe(true);
    expect(existsSync(join(lifecycle(env), `${heldLater}.held-notice.json`))).toBe(false);
    expect(pending(env, "session-a")).toContain(
      `- 1 retained private lesson draft was held by the local safety check`,
    );
  });

  // The record names the drafts a notice offered while they fit the bytes
  // read back (256), and a keep parks those alone, as for fewer.
  it("records the 256 drafts a delivered notice offered, so a keep parks those alone", () => {
    const env = fixture();
    const ids = Array.from({ length: 256 }, (_, index) => `pld_offerbound${String(index).padStart(3, "0")}`);
    for (const id of ids) lessonEnvelope(env, id);
    deliver(env, pending(env, "session-a"));
    expect(
      JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8")).drafts,
    ).toEqual(ids);
    const later = "pld_offerboundlater";
    lessonEnvelope(env, later);
    decline(env, "session-a", ORPHAN_NOTICE, "not_reusable");
    expect(markers(env)).toEqual(
      ["orphan-notice.json", ...ids.map((id) => `${id}.parked.json`)].sort(),
    );
    expect(parked(env, later)).toBeNull();
  });

  // A longer offer is recorded without them: its keep parks every draft
  // awaiting the user that is not parked yet, one that began awaiting after
  // the delivery too. A parked draft that came due after the delivery keeps
  // its own schedule.
  it("parks on one keep all 300 drafts awaiting the user, so they return 1, 7 and 30 days later and not the day after, and leaves alone a parked draft that came due after the delivery", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    const minute = 60 * 1000;
    const day = 24 * 60 * minute;
    // A host denial parks a draft that comes due 5 minutes after the
    // delivery below.
    vi.setSystemTime(start - day + 5 * minute);
    const env = fixture();
    const early = "pld_offerboundearly";
    lessonEnvelope(env, early);
    deny(env, "submit_private_lesson_candidate", early);
    const parkedEarly = parked(env, early);
    vi.setSystemTime(start);
    const ids = Array.from({ length: 300 }, (_, index) => `pld_offerbound${String(index).padStart(3, "0")}`);
    for (const id of ids) lessonEnvelope(env, id);
    const first = pending(env, "session-a");
    expect(first).toContain(awaitingNotice(300, 0));
    deliver(env, first);
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toEqual({
      version: 1,
      shown_at: new Date(start).toISOString(),
    });
    const later = "pld_offerboundlater";
    lessonEnvelope(env, later);
    // The user keeps them 10 minutes later.
    const kept = start + 10 * minute;
    vi.setSystemTime(kept);
    decline(env, "session-a", ORPHAN_NOTICE, "not_reusable");
    const all = [...ids, later];
    expect(markers(env)).toEqual(
      ["orphan-notice.json", ...[...all, early].map((id) => `${id}.parked.json`)].sort(),
    );
    for (const id of all) {
      expect(parked(env, id)).toMatchObject({ reason: "not_reusable", notices: 0 });
    }
    expect(parked(env, early)).toEqual(parkedEarly);
    // Each return and the day after it; each notice shown is delivered, and
    // no one answers it. On day 20 the host lets the lesson lane through.
    const shown = [];
    for (const after of [1, 2, 8, 9, 20, 21, 38, 39]) {
      vi.setSystemTime(kept + after * day);
      if (after === 20) {
        observeSuccessfulCompletionTool(
          "session-a",
          "submit_private_lesson_candidate",
          { draft_id: "pld_offerboundlane" },
          { draft_id: "pld_offerboundlane", state: "submitted", accepted_private_candidate: true },
          env,
        );
      }
      const text = pending(env, "session-a");
      const count = Number(text.match(/awaiting a user decision: (\d+) lessons?/)?.[1] ?? 0);
      if (!count) continue;
      expect(text).toContain(awaitingNotice(count, 0));
      shown.push([after, count]);
      deliver(env, text);
    }
    // The parked draft comes with them, and alone when its lane returns it.
    expect(shown).toEqual([
      [1, 302],
      [8, 302],
      [20, 1],
      [38, 301],
    ]);
    for (const id of all) {
      expect(parked(env, id)).toMatchObject({ reason: "not_reusable", notices: 3 });
    }
    expect(parked(env, early)).toMatchObject({
      reason: "host_policy_denied",
      notices: 3,
      lane_allowed_at: new Date(kept + 20 * day).toISOString(),
    });
    expect(readdirSync(outbox(env))).toHaveLength(302);
  });

  // Whatever made a parked draft due after that delivery, the keep leaves
  // its marker as it was, and the next notice offers it: a declined draft
  // whose wait came due, a draft shown all three times that a host of a
  // newer version brings back once, and a host-denied skill draft whose lane
  // the host let through.
  it("leaves alone on a keep of 257 drafts each parked draft due at the keep, whether its wait, a newer host or its lane brought it back", async () => {
    const [major, minor, patch] = hookCore.installedClientVersion().split(".");
    const version = `${major}.${minor}.${Number(patch) + 1}`;
    const newer = await hostAt(version);
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-16T12:00:00.000Z");
    const minute = 60 * 1000;
    const day = 24 * 60 * minute;
    const env = fixture();
    // A host denial parks a draft 60 days before the delivery, and it is
    // shown all three times: only a client update brings it back now.
    vi.setSystemTime(start - 60 * day);
    const updated = "pld_keepdueupdated";
    lessonEnvelope(env, updated);
    deny(env, "submit_private_lesson_candidate", updated);
    for (const after of [1, 8, 38]) {
      vi.setSystemTime(start - 60 * day + after * day);
      deliver(env, pending(env, "session-a"));
    }
    // The user keeps a draft's line; its first wait ends 5 minutes after the
    // delivery.
    vi.setSystemTime(start - day + 5 * minute);
    const declined = "pld_keepduedeclined";
    lessonEnvelope(env, declined);
    capture(env, "session-a", declined);
    decline(env, "session-a", actionIdOf(`private_lesson:${declined}`), "not_reusable");
    // A host denial parks a skill draft an hour before the delivery.
    vi.setSystemTime(start - 60 * minute);
    const lane = "psd_keepduelane01";
    skillEnvelope(env, lane);
    deny(env, "submit_private_skill_candidate", lane);
    vi.setSystemTime(start);
    const ids = Array.from({ length: 257 }, (_, index) => `pld_keepdue${String(index).padStart(3, "0")}`);
    for (const id of ids) lessonEnvelope(env, id);
    const first = pending(env, "session-a");
    expect(first).toContain(awaitingNotice(257, 0));
    deliver(env, first);
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toEqual({
      version: 1,
      shown_at: new Date(start).toISOString(),
    });
    // 5 minutes later the host lets a skill submit through.
    const afterDelivery = new Date(start + 5 * minute).toISOString();
    vi.setSystemTime(start + 5 * minute);
    observeSuccessfulCompletionTool(
      "session-a",
      "submit_private_skill_candidate",
      { draft_id: "psd_keepdueother1" },
      { draft_id: "psd_keepdueother1", state: "submitted", accepted_private_candidate: true },
      env,
    );
    const before = [declined, updated, lane].map((id) => parked(env, id));
    expect(before).toEqual([
      expect.objectContaining({ reason: "not_reusable", notices: 0, next_notice_at: afterDelivery }),
      expect.objectContaining({
        reason: "host_policy_denied",
        notices: 3,
        next_notice_at: null,
        client_version: hookCore.installedClientVersion(),
      }),
      expect.objectContaining({
        reason: "host_policy_denied",
        notices: 0,
        next_notice_at: afterDelivery,
        lane_allowed_at: afterDelivery,
      }),
    ]);
    // The user keeps them 10 minutes after the delivery, in a host of a
    // newer version.
    const kept = start + 10 * minute;
    vi.setSystemTime(kept);
    decline(env, "session-a", ORPHAN_NOTICE, "not_reusable", newer);
    for (const id of ids) {
      expect(parked(env, id)).toMatchObject({ reason: "not_reusable", notices: 0, client_version: version });
    }
    expect(parked(env, declined)).toEqual(before[0]);
    expect(parked(env, updated)).toEqual(before[1]);
    expect(parked(env, lane)).toEqual(before[2]);
    // A day later that host offers them with the drafts it kept.
    vi.setSystemTime(kept + day);
    expect(pending(env, "session-a", newer)).toContain(awaitingNotice(259, 1));
    expect(readdirSync(outbox(env))).toHaveLength(259);
  });

  it("acknowledges only the delivering session's notice when another session of the process composed the same words", () => {
    const env = fixture();
    const [ofA, ofB] = ["pld_samewordsa01", "pld_samewordsb01"];
    lessonEnvelope(env, ofA);
    lessonEnvelope(env, ofB);
    capture(env, "session-a", ofA);
    capture(env, "session-b", ofB);
    const idle = Date.now() - 25 * 60 * 60 * 1000;
    promptedAt(env, "session-a", idle);
    promptedAt(env, "session-b", idle);
    // One long-lived process composes both, each from the other's draft.
    const notice = (text) =>
      text.split("\n").find((line) => line.includes(`action_id ${ORPHAN_NOTICE}`));
    const toA = pending(env, "session-a");
    const toB = pending(env, "session-b");
    expect(notice(toA)).toContain("1 lesson and 0 skills");
    expect(notice(toB)).toEqual(notice(toA));

    // Session A's context is delivered first, and names its session.
    acknowledgePrivateAuthorizationReminders(toA, env, "session-a");
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toEqual({
      version: 1,
      shown_at: expect.any(String),
      drafts: [ofB],
    });
    // Its decline keeps the draft its notice offered, nothing else.
    decline(env, "session-a", ORPHAN_NOTICE, "not_reusable");
    expect(parked(env, ofB)).toMatchObject({ reason: "not_reusable" });
    expect(parked(env, ofA)).toBeNull();
  });

  it("acknowledges, for a delivery that names no session, only the newest composition of its words", () => {
    const env = fixture();
    const [ofA, ofB] = ["pld_newestwordsa", "pld_newestwordsb"];
    lessonEnvelope(env, ofA);
    lessonEnvelope(env, ofB);
    capture(env, "session-a", ofA);
    capture(env, "session-b", ofB);
    const idle = Date.now() - 25 * 60 * 60 * 1000;
    promptedAt(env, "session-a", idle);
    promptedAt(env, "session-b", idle);
    pending(env, "session-a");
    // A host that runs one session per process delivers what it just composed.
    deliver(env, pending(env, "session-b"));
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toMatchObject({
      drafts: [ofA],
    });
  });

  it("acknowledges a prompt's own notice when another session composed the same words while its query ran", async () => {
    const env = fixture();
    const [first, later] = ["pld_whilequery01", "pld_whilequery02"];
    lessonEnvelope(env, first);
    const orphanNotice = join(lifecycle(env), "orphan-notice.json");
    let composed;
    const otherComposed = new Promise((resolve) => {
      composed = resolve;
    });
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const offline = () => Promise.reject(new TypeError("network disabled in tests"));
    let other;
    // Session A's query starts after its notice was composed. Meanwhile its
    // draft goes, another awaits the user, and session B composes the same
    // words, then waits in its own query until A's context is delivered.
    let started = false;
    const fetchA = async () => {
      if (!started) {
        started = true;
        rmSync(join(outbox(env), `${first}.lesson.json`));
        lessonEnvelope(env, later);
        other = runPromptHook("Review the deploy runbook.", {
          env,
          sessionId: "session-b",
          fetchImpl: async () => {
            composed();
            await released;
            return offline();
          },
        });
        await otherComposed;
      }
      return offline();
    };
    const toA = await runPromptHook("Review the deploy runbook.", {
      env,
      sessionId: "session-a",
      fetchImpl: fetchA,
    });
    expect(started).toBe(true);
    expect(toA.context).toContain("Retained private drafts awaiting a user decision: 1 lesson and 0 skills");
    expect(JSON.parse(readFileSync(orphanNotice, "utf8"))).toMatchObject({ drafts: [first] });
    release();
    const toB = await other;
    expect(toB.context).toContain("Retained private drafts awaiting a user decision: 1 lesson and 0 skills");
    expect(JSON.parse(readFileSync(orphanNotice, "utf8"))).toMatchObject({ drafts: [later] });
  });

  it("keeps each user-decision notice one directive unit, whatever counts and kinds of drafts it names", () => {
    const named = (prefix, count) =>
      Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, "0")}`);
    // Ready lessons, skills and safety-held lessons, up to three-digit counts.
    for (const [lessons, skills, held] of [
      [1, 0, 1],
      [2, 0, 2],
      [0, 1, 1],
      [0, 2, 2],
      [1, 1, 1],
      [2, 2, 2],
      [100, 100, 100],
    ]) {
      const env = fixture();
      for (const id of named("pld_unitlesson", lessons)) lessonEnvelope(env, id);
      for (const id of named("psd_unitskill", skills)) skillEnvelope(env, id);
      for (const id of named("pld_unitheld", held)) {
        lessonEnvelope(env, id, "held_safety", { hold_telemetry_status: "submitted" });
      }
      const text = pending(env, "session-a");
      const notices = text
        .split("\n")
        .filter((line) => line.includes("awaiting a user decision") || line.includes(HELD));
      expect(notices).toEqual([awaitingNotice(lessons, skills), heldNotice(held)]);
      // Whatever its wording, a notice the allocator could split would be
      // re-joined over two lines, and its delivery would acknowledge nothing.
      for (const notice of notices) expect(completeDirectiveUnits(notice)).toEqual([notice]);
      expect(completeDirectiveUnits(text)).toEqual(expect.arrayContaining(notices));
    }
  });

  it("acknowledges both user-decision notices on their first delivery in a prompt context over its budget", async () => {
    const env = fixture();
    const [own, noOnes, held] = ["pld_ownbudget001", "pld_noonesbudget", "pld_heldbudget01"];
    lessonEnvelope(env, own);
    capture(env, "session-a", own);
    lessonEnvelope(env, noOnes);
    lessonEnvelope(env, held, "held_safety", { hold_telemetry_status: "submitted" });
    // Four long skill cards fill most of the 4,000-character budget.
    const fetchImpl = async (url) =>
      String(url).endsWith("/api/v1/agent/query")
        ? Response.json({
            query_id: "rq_overbudget",
            skills: Array.from({ length: 4 }, (_, index) => ({
              slug: `deploy-runbook-review-${index + 1}`,
              result_id: `qres_overbudget_${index + 1}`,
              description: `Review deploy runbook step ${index + 1}: ${"check rollback, health checks and staged rollout order. ".repeat(5)}`,
              match_reason: "Deploy runbook review workflow",
              trust_tier: "tofu_verified",
              verified_uses: 7,
              total_uses: 9,
            })),
            resources: [],
          })
        : Promise.reject(new TypeError("network disabled in tests"));
    const prompt = async () =>
      (await runPromptHook("Review the deploy runbook.", { env, sessionId: "session-a", fetchImpl }))
        .context;
    const first = await prompt();
    // The allocator cut the completion section to fit and kept each notice
    // whole, on one line: the delivery acknowledged both.
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first).toContain("[Additional completion context omitted.]");
    expect(first.split("\n")).toEqual(
      expect.arrayContaining([awaitingNotice(1, 0), heldNotice(1)]),
    );
    expect(JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8"))).toMatchObject({
      drafts: [noOnes],
    });
    expect(existsSync(join(lifecycle(env), `${held}.held-notice.json`))).toBe(true);
    const second = await prompt();
    expect(second).toContain(lessonLine(own));
    expect(second).not.toContain(ORPHAN_NOTICE);
    expect(second).not.toContain(HELD);
  });

  it("keeps at most 16 composed notices: the oldest one's delivery acknowledges nothing, so it comes again", () => {
    const env = fixture();
    const draftId = "pld_boundednote1";
    lessonEnvelope(env, draftId);
    const sessions = Array.from({ length: 17 }, (_, index) => `session-n${index}`);
    const texts = sessions.map((session) => pending(env, session));
    for (const text of texts) expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
    const orphanNotice = join(lifecycle(env), "orphan-notice.json");

    acknowledgePrivateAuthorizationReminders(texts[0], env, sessions[0]);
    expect(existsSync(orphanNotice)).toBe(false);
    expect(pending(env, sessions[0])).toContain(`action_id ${ORPHAN_NOTICE}`);
    acknowledgePrivateAuthorizationReminders(texts[16], env, sessions[16]);
    expect(JSON.parse(readFileSync(orphanNotice, "utf8"))).toMatchObject({ drafts: [draftId] });
    expect(pending(env, sessions[0])).not.toContain(ORPHAN_NOTICE);
  });

  it("makes room for its own new draft when the machine's hints are full of drafts awaiting the user", () => {
    const env = fixture();
    const idle = Array.from({ length: 64 }, (_, index) => `pld_idlefull${String(index).padStart(4, "0")}`);
    for (const id of idle) {
      lessonEnvelope(env, id);
      capture(env, "session-x", id);
    }
    promptedAt(env, "session-x", Date.now() - 25 * 60 * 60 * 1000);
    expect(hintFiles(env)).toHaveLength(64);
    recordUserPrompt("session-a", env);
    const fresh = "pld_freshowned01";
    lessonEnvelope(env, fresh);
    expect(capture(env, "session-a", fresh).opened).toEqual([
      expect.objectContaining({ draft_id: fresh }),
    ]);
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(fresh));
    expect(text).toContain(ownDrafts(fresh));
    // The oldest idle session's hint made room; its draft is offered as
    // before, with every other one, and no draft left the outbox.
    expect(hintFiles(env)).toHaveLength(64);
    expect(readCompletionObligations("session-x", env).map((item) => item.draft_id)).toEqual(
      idle.slice(1),
    );
    expect(text).toContain("64 lessons and 0 skills");
    expect(readdirSync(outbox(env))).toHaveLength(65);
  });

  it("offers an idle session's subagent draft as before, but not one whose capturing ledger is still prompted", () => {
    const env = fixture();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    // A Claude Code subagent's ledger counts no prompts of its own; an
    // OpenCode child session's tree ledger counts the prompts it gets.
    const subagent = agentLedgerIdFor({ session_id: "session-a", agent_id: "agent-sub-1" });
    const child = agentLedgerIdFor({ session_id: "session-c", agent_id: "ses_child00001" });
    const [ofSubagent, ofChild] = ["pld_subagentidle1", "pld_childprompted"];
    lessonEnvelope(env, ofSubagent);
    lessonEnvelope(env, ofChild);
    capture(env, subagent, ofSubagent);
    capture(env, child, ofChild);
    promptedAt(env, "session-a", dayAgo);
    promptedAt(env, "session-c", dayAgo);
    recordUserPrompt(child, env);
    recordUserPrompt("session-b", env);
    const text = pending(env, "session-b");
    expect(text).toContain(awaitingUser(1, 0));
    deliver(env, text);
    expect(
      JSON.parse(readFileSync(join(lifecycle(env), "orphan-notice.json"), "utf8")).drafts,
    ).toEqual([ofSubagent]);
  });

  it("keeps the hints of a capturing ledger that is still prompted when the machine's hints are full, though its root is idle", () => {
    const env = fixture();
    const child = agentLedgerIdFor({ session_id: "session-x", agent_id: "ses_child00001" });
    const busy = Array.from({ length: 64 }, (_, index) => `pld_busychild${String(index).padStart(3, "0")}`);
    for (const id of busy) {
      lessonEnvelope(env, id);
      capture(env, child, id);
    }
    promptedAt(env, "session-x", Date.now() - 25 * 60 * 60 * 1000);
    recordUserPrompt(child, env);
    recordUserPrompt("session-a", env);
    const fresh = "pld_freshbusyown";
    lessonEnvelope(env, fresh);
    expect(capture(env, "session-a", fresh).opened).toEqual([]);
    expect(hintFiles(env)).toHaveLength(64);
    expect(pending(env, "session-a")).toContain(awaitingUser(1, 0));
  });

  it("keeps the hints an active session's subagent captured when the machine's hints are full", () => {
    const env = fixture();
    // A Claude Code subagent's ledger counts no prompts of its own: the
    // clock of the session that started it decides.
    const subagent = agentLedgerIdFor({ session_id: "session-x", agent_id: "agent-sub-1" });
    const busy = Array.from({ length: 64 }, (_, index) => `pld_subactive${String(index).padStart(3, "0")}`);
    for (const id of busy) {
      lessonEnvelope(env, id);
      capture(env, subagent, id);
    }
    expect(
      JSON.parse(readFileSync(join(hintDirectory(env), hintFileOf(busy[0])), "utf8")),
    ).toMatchObject({ owner_session: ledgerOf("session-x"), captured_by_ledger: ledgerOf(subagent) });
    recordUserPrompt("session-x", env);
    recordUserPrompt("session-a", env);
    const fresh = "pld_freshsubactv";
    lessonEnvelope(env, fresh);
    expect(capture(env, "session-a", fresh).opened).toEqual([]);
    expect(hintFiles(env)).toEqual(busy.map(hintFileOf).sort());
    const text = pending(env, "session-a");
    expect(text).not.toContain(fresh);
    expect(text).toContain(awaitingUser(1, 0));
  });

  it("makes room for its own new draft from the hints an idle session's subagent captured", () => {
    const env = fixture();
    const subagent = agentLedgerIdFor({ session_id: "session-x", agent_id: "agent-sub-1" });
    const idle = Array.from({ length: 64 }, (_, index) => `pld_subidle${String(index).padStart(4, "0")}`);
    for (const id of idle) {
      lessonEnvelope(env, id);
      capture(env, subagent, id);
    }
    promptedAt(env, "session-x", Date.now() - 25 * 60 * 60 * 1000);
    recordUserPrompt("session-a", env);
    const fresh = "pld_freshsubidle";
    lessonEnvelope(env, fresh);
    expect(capture(env, "session-a", fresh).opened).toEqual([
      expect.objectContaining({ draft_id: fresh }),
    ]);
    // The oldest of them made room; every one of its drafts is offered.
    expect(hintFiles(env)).toEqual([...idle.slice(1), fresh].map(hintFileOf).sort());
    const text = pending(env, "session-a");
    expect(text).toContain(lessonLine(fresh));
    expect(text).toContain(ownDrafts(fresh));
    expect(text).toContain(awaitingUser(64, 0));
    expect(readdirSync(outbox(env))).toHaveLength(65);
  });

  it("offers its own new draft to the user when every hint on the machine belongs to an active session", () => {
    const env = fixture();
    const active = Array.from({ length: 64 }, (_, index) => `pld_activefull${String(index).padStart(2, "0")}`);
    for (const id of active) {
      lessonEnvelope(env, id);
      capture(env, "session-x", id);
    }
    recordUserPrompt("session-x", env);
    recordUserPrompt("session-a", env);
    const fresh = "pld_freshhintls1";
    lessonEnvelope(env, fresh);
    expect(capture(env, "session-a", fresh).opened).toEqual([]);
    expect(hintFiles(env)).toHaveLength(64);
    const text = pending(env, "session-a");
    expect(text).not.toContain(fresh);
    // Never dropped: one user decision offers it.
    expect(text).toContain(awaitingUser(1, 0));
  });
});
