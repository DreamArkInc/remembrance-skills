// OpenClaw runs a subagent (sessions_spawn) in its own session, whose
// ledger names no agent. The user decisions about retained private drafts
// (drafts awaiting the user, held drafts, parked drafts coming back) are for
// main sessions only, and a draft such a subagent captured becomes the
// spawning session's when it ends, whatever else it left, or, when that
// session already ended and handed up its debts, the session they went to.
// The hooks are called as OpenClaw calls them: handler(event, ctx).
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const CHILD_KEY = "agent:main:subagent:5b2e8c1d-7a4f-4e63-9d0b-2c8f1a6e4b97";
const child = {
  runId: "run-child",
  sessionId: "child-session",
  sessionKey: CHILD_KEY,
  agentId: "main",
};
const GRANDCHILD_KEY = "agent:main:subagent:9c41d7e2-3b58-4f0a-8e6d-1a2b3c4d5e6f";
const grandchild = {
  runId: "run-grandchild",
  sessionId: "grandchild-session",
  sessionKey: GRANDCHILD_KEY,
  agentId: "main",
};
const parent = (runId) => ({
  runId,
  sessionId: "parent-session",
  sessionKey: "agent:main:main",
  agentId: "main",
});
const textResult = (body) => ({
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  details: body,
});
const hash = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");
const ORPHAN_NOTICE = hash("private_draft_notice:awaiting_user").slice(0, 16);
const HELD = "held by the local safety check";

describe("OpenClaw subagent sessions and retained private drafts", () => {
  let root;
  let hook;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "remembrance-openclaw-drafts-"));
    vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", join(root, "usage"));
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(root, "health"));
    vi.stubEnv("REMEMBRANCE_PLUGIN_ALERT_DIR", join(root, "alerts"));
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
    vi.stubEnv("REMEMBRANCE_API_KEY", "rk_synthetic_openclaw_drafts");
    vi.stubEnv("REMEMBRANCE_API_URL", "http://127.0.0.1:9");
    vi.stubEnv("REMEMBRANCE_API_KEY_ORIGIN", "http://127.0.0.1:9");
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    hook = (name) => on.mock.calls.find(([hookName]) => hookName === name)[1];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const state = () => join(process.env.XDG_STATE_HOME, "remembrance");
  const lifecycle = () => join(state(), "private-learning-lifecycle");
  const hints = () => {
    const directory = join(lifecycle(), "obligations");
    return existsSync(directory)
      ? readdirSync(directory).map((name) =>
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        )
      : [];
  };
  // The content-free envelope the MCP server keeps beside an encrypted draft.
  const lessonEnvelope = (draftId, envelopeState = "ready", fields = {}) => {
    const outbox = join(state(), "private-lessons");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    chmodSync(outbox, 0o700);
    writeFileSync(
      join(outbox, `${draftId}.lesson.json`),
      `${JSON.stringify({
        version: "private-lesson-outbox-envelope-v1",
        draft_id: draftId,
        state: envelopeState,
        hold_telemetry_status:
          envelopeState === "held_safety" ? "pending" : "not_required",
        last_error_code: null,
        next_retry_at: null,
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
        ...fields,
      })}\n`,
      { mode: 0o600 },
    );
  };
  const prompt = async (ctx, text = "Review the deploy runbook.") =>
    String(
      (await hook("before_prompt_build")({ prompt: text, messages: [] }, ctx))
        ?.appendSystemContext ?? "",
    );
  // A sessions_spawn result, as OpenClaw returns it (jsonResult): by
  // default the parent's, of the child.
  const spawn = (ctx = parent("run-parent-1"), spawned = child) =>
    hook("after_tool_call")(
      {
        toolName: "sessions_spawn",
        params: { task: "Review the deploy runbook.", mode: "run" },
        runId: ctx.runId,
        toolCallId: `call-spawn-${spawned.runId}`,
        result: textResult({
          status: "accepted",
          childSessionKey: spawned.sessionKey,
          runId: spawned.runId,
          mode: "run",
        }),
      },
      ctx,
    );
  const finalize = (ctx) =>
    hook("before_agent_finalize")(
      { runId: ctx.runId, sessionId: ctx.sessionId, stopHookActive: false },
      ctx,
    );

  it("gives a subagent's session none of the user decisions and leaves every one for the main session", async () => {
    await prompt(parent("run-parent-0"));
    await spawn();
    lessonEnvelope("pld_noonesdraft1");
    lessonEnvelope("pld_heldrecorded", "held_safety", {
      hold_telemetry_status: "submitted",
    });
    // A draft the user kept earlier, whose next notice is due.
    lessonEnvelope("pld_parkeddue001");
    mkdirSync(lifecycle(), { recursive: true, mode: 0o700 });
    const parkedPath = join(lifecycle(), "pld_parkeddue001.parked.json");
    writeFileSync(
      parkedPath,
      JSON.stringify({
        version: 1,
        reason: "not_reusable",
        parked_at: "2026-10-01T00:00:00.000Z",
        notices: 0,
        next_notice_at: "2026-10-02T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const parkedBytes = readFileSync(parkedPath);
    const markers = readdirSync(lifecycle()).sort();

    const childText = await prompt(child);
    expect(childText).not.toContain(ORPHAN_NOTICE);
    expect(childText).not.toContain(HELD);
    expect(childText).not.toContain("awaiting a user decision");
    // Nor does its stop, where a stop asks.
    vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "1");
    const stop = JSON.stringify((await finalize(child)) ?? {});
    expect(stop).not.toContain(ORPHAN_NOTICE);
    expect(stop).not.toContain(HELD);
    vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "0");
    // Nothing was acknowledged for the user.
    expect(readdirSync(lifecycle()).sort()).toEqual(markers);
    expect(readFileSync(parkedPath)).toEqual(parkedBytes);

    const parentText = await prompt(parent("run-parent-2"));
    expect(parentText).toContain(
      "Retained private drafts awaiting a user decision: 2 lessons and 0 skills",
    );
    expect(parentText).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(parentText).toContain(HELD);
    expect(
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8")),
    ).toMatchObject({ drafts: ["pld_noonesdraft1", "pld_parkeddue001"] });
    expect(
      existsSync(join(lifecycle(), "pld_heldrecorded.held-notice.json")),
    ).toBe(true);
    expect(JSON.parse(readFileSync(parkedPath, "utf8"))).toMatchObject({
      notices: 1,
    });
  });

  it("acknowledges the user decisions it delivers whole in a main session's context over its budget", async () => {
    const main = parent("run-parent-0");
    await prompt(main);
    const own = "pld_clawownbudgt";
    lessonEnvelope(own);
    await hook("after_tool_call")(
      {
        toolName: "remembrance__capture_learning",
        params: {},
        runId: main.runId,
        result: textResult({
          capture_route: "private_lesson",
          draft_id: own,
          state: "ready",
          next_action: { tool: "submit_private_lesson_candidate", arguments: { draft_id: own } },
        }),
      },
      main,
    );
    lessonEnvelope("pld_noonesdraft1");
    lessonEnvelope("pld_heldrecorded", "held_safety", { hold_telemetry_status: "submitted" });
    // Four long skill cards fill most of the 4,000-character budget.
    const query = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
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
        : Promise.reject(new TypeError("network disabled in tests")),
    );
    try {
      const text = await prompt(parent("run-parent-1"));
      expect(text).toContain("[Additional completion context omitted.]");
      expect(text).toContain(`action_id ${ORPHAN_NOTICE}`);
      expect(text).toContain(HELD);
      expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(true);
      expect(existsSync(join(lifecycle(), "pld_heldrecorded.held-notice.json"))).toBe(true);
      const again = await prompt(parent("run-parent-2"));
      expect(again).not.toContain(ORPHAN_NOTICE);
      expect(again).not.toContain(HELD);
    } finally {
      query.mockRestore();
    }
  });

  it("hands a draft that was a subagent's only debt to the session that spawned it", async () => {
    await prompt(parent("run-parent-0"));
    await spawn();
    const draftId = "pld_childonlydebt";
    lessonEnvelope(draftId);
    await prompt(child);
    await hook("after_tool_call")(
      {
        toolName: "remembrance__capture_learning",
        params: { lesson: { summary: "Check the runbook's rollback step." } },
        runId: child.runId,
        result: textResult({
          capture_route: "private_lesson",
          draft_id: draftId,
          state: "ready",
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: draftId },
          },
        }),
      },
      child,
    );
    // Its only debt is the hint, kept beside the outbox, not in its ledger.
    expect(hints()).toEqual([
      expect.objectContaining({
        draft_id: draftId,
        owner_session: hash("child-session").slice(0, 16),
      }),
    ]);

    await finalize(child);
    expect(hints()).toEqual([
      expect.objectContaining({
        draft_id: draftId,
        owner_session: hash("parent-session").slice(0, 16),
        captured_by_agent: CHILD_KEY,
      }),
    ]);
    const parentText = await prompt(parent("run-parent-2"));
    expect(parentText).toContain(
      `- Private lesson (captured by subagent ${CHILD_KEY}): call submit_private_lesson_candidate with draft_id ${draftId}.`,
    );
    expect(parentText).not.toContain(ORPHAN_NOTICE);
  });

  it.each([
    ["after", true],
    ["before", false],
  ])("hands a grandchild's draft to the top session when it ends %s the subagent that spawned it", async (_order, late) => {
    const draftId = late ? "pld_grandlate001" : "pld_grandearly01";
    await prompt(parent("run-parent-0"));
    await spawn();
    await prompt(child);
    await spawn(child, grandchild);
    if (late) await finalize(child);
    await prompt(grandchild);
    lessonEnvelope(draftId);
    await hook("after_tool_call")(
      {
        toolName: "remembrance__capture_learning",
        params: {},
        runId: grandchild.runId,
        result: textResult({
          capture_route: "private_lesson",
          draft_id: draftId,
          state: "ready",
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: draftId },
          },
        }),
      },
      grandchild,
    );
    // Its query feedback goes up the same way, as it did before.
    await hook("after_tool_call")(
      {
        toolName: "remembrance__query_skills",
        params: { query: "review" },
        runId: grandchild.runId,
        result: textResult({
          query_id: "rq_grandchildq01",
          skills: [],
          resources: [],
          query_feedback: { available: true, query_id: "rq_grandchildq01" },
        }),
      },
      grandchild,
    );
    await finalize(grandchild);
    if (!late) await finalize(child);

    // The top session's tree holds the draft: when the child had already
    // ended, as the grandchild's capture in the child's tree; otherwise as
    // the child's.
    const by = late
      ? `child-session:agent:${GRANDCHILD_KEY}`
      : `parent-session:agent:${CHILD_KEY}`;
    expect(hints()).toEqual([
      expect.objectContaining({
        draft_id: draftId,
        owner_session: hash("parent-session").slice(0, 16),
        captured_by_ledger: hash(by).slice(0, 16),
        captured_by_agent: late ? GRANDCHILD_KEY : CHILD_KEY,
      }),
    ]);
    const parentText = await prompt(parent("run-parent-2"));
    expect(parentText).toContain(
      `only for this session's due private drafts (${draftId})`,
    );
    expect(parentText).toContain(`call submit_private_lesson_candidate with draft_id ${draftId}.`);
    expect(parentText).toContain("rq_grandchildq01");
    expect(parentText).not.toContain(ORPHAN_NOTICE);
  });
});
