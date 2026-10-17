// OpenCode runs a task subagent in a child session, created with its parent's
// id (session.created: properties.info.parentID), and that session's
// chat.message reads like a user prompt. The user decisions about retained
// private drafts (drafts awaiting the user, held drafts, parked drafts coming
// back) go only to a session OpenCode created with no parent; a child session,
// or one no process of the plugin saw created, gets none and acknowledges
// none. A child session whose parent link the plugin recorded belongs to its
// root session's tree, so its drafts are listed silently there; one whose
// link it never saw keeps them, and they reach the user once it has been
// idle. The hooks are called as OpenCode calls them.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Remembrance } from "../src/index.mjs";
import {
  readPromptedCount,
  readRegistryUseCount,
  readTaskEligibilityCount,
} from "../scripts/hook-core.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const hash = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");
const ORPHAN_NOTICE = hash("private_draft_notice:awaiting_user").slice(0, 16);
const HELD = "held by the local safety check";
const MAIN = "ses_mainsession01";
const CHILD = "ses_childsession1";
const RESUMED = "ses_resumedsess01";
const GRANDCHILD = "ses_grandchild001";
const ledgerOf = (ledgerId) => hash(ledgerId).slice(0, 16);

describe("OpenCode child sessions and retained private drafts", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "remembrance-opencode-children-"));
    vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", join(root, "usage"));
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(root, "health"));
    vi.stubEnv("REMEMBRANCE_PLUGIN_ALERT_DIR", join(root, "alerts"));
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
    vi.stubEnv("REMEMBRANCE_API_KEY", "rk_synthetic_opencode_children");
    vi.stubEnv("REMEMBRANCE_API_URL", "http://127.0.0.1:9");
    vi.stubEnv("REMEMBRANCE_API_KEY_ORIGIN", "http://127.0.0.1:9");
    // So a stop asks, where it would.
    vi.stubEnv("REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const state = () => join(process.env.XDG_STATE_HOME, "remembrance");
  const lifecycle = () => join(state(), "private-learning-lifecycle");
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
  // A draft no session holds, a recorded safety hold, and a draft the user
  // kept earlier whose next notice is due.
  const retainedDrafts = () => {
    lessonEnvelope("pld_ocnoonesdraft");
    lessonEnvelope("pld_ocheldrecorded", "held_safety", {
      hold_telemetry_status: "submitted",
    });
    lessonEnvelope("pld_ocparkeddue01");
    mkdirSync(lifecycle(), { recursive: true, mode: 0o700 });
    const parked = join(lifecycle(), "pld_ocparkeddue01.parked.json");
    writeFileSync(
      parked,
      JSON.stringify({
        version: 1,
        reason: "not_reusable",
        parked_at: "2026-10-01T00:00:00.000Z",
        notices: 0,
        next_notice_at: "2026-10-02T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    return parked;
  };
  // `onShow` runs while the user reads what an idle shows.
  const plugin = async (onShow = async () => {}, hosted = {}) => {
    const shown = [];
    const hooks = await Remembrance({
      client: {
        tui: {
          showToast: async ({ body }) => {
            shown.push(body.message);
            await onShow();
          },
        },
      },
      clientUpdateCheck: async () => null,
      warmSession: async () => null,
      ...hosted,
    });
    return { hooks, shown };
  };
  const created = (hooks, info) =>
    hooks.event({ event: { type: "session.created", properties: { info } } });
  let message = 0;
  const send = ({ hooks }, sessionID) => {
    message += 1;
    const messageID = `msg_turn${message}`;
    return hooks["chat.message"](
      { sessionID, messageID },
      {
        message: { id: messageID, role: "user", sessionID },
        parts: [{ type: "text", text: "Review the deploy runbook." }],
      },
    );
  };
  // A model request of the turn: the context OpenCode delivers.
  const request = async ({ hooks }, sessionID) => {
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, output);
    return output.system.join("\n");
  };
  // What the session's idle shows the user.
  const idle = async ({ hooks, shown }, sessionID) => {
    const before = shown.length;
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID } },
    });
    return shown.slice(before).join("\n");
  };
  // One turn as OpenCode runs it: the prompt, one model request, then idle.
  const turn = async (opencode, sessionID) => {
    await send(opencode, sessionID);
    const context = await request(opencode, sessionID);
    return { context, stop: await idle(opencode, sessionID) };
  };
  const markerBytes = () =>
    Object.fromEntries(
      readdirSync(lifecycle())
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => [name, readFileSync(join(lifecycle(), name), "utf8")]),
    );
  const mainSessionMarker = (sessionId) =>
    join(process.env.REMEMBRANCE_USAGE_DIR, `${hash(sessionId).slice(0, 16)}.main-session`);
  const parentLink = (sessionId) =>
    join(process.env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(sessionId)}.parent-session`);
  // A capture as capture_learning answers it in that session, with the
  // draft's exact next action; the MCP server wrote the draft's envelope.
  const capture = async ({ hooks }, sessionID, draftId) => {
    lessonEnvelope(draftId);
    await hooks["tool.execute.after"](
      { tool: "remembrance_capture_learning", sessionID, args: {} },
      {
        body: {
          capture_route: "private_lesson",
          draft_id: draftId,
          state: "ready",
          next_action: {
            tool: "submit_private_lesson_candidate",
            arguments: { draft_id: draftId },
          },
        },
      },
    );
  };
  // Who holds a draft, as its hint records it.
  const hintOwner = (draftId) => {
    const hint = JSON.parse(
      readFileSync(
        join(
          lifecycle(),
          "obligations",
          `${hash(`private_lesson:${draftId}`).slice(0, 32)}.json`,
        ),
        "utf8",
      ),
    );
    return {
      owner_session: hint.owner_session,
      captured_by_ledger: hint.captured_by_ledger,
      captured_by_agent: hint.captured_by_agent,
    };
  };
  const lessonLine = (draftId, by = "") =>
    `- Private lesson${by}: call submit_private_lesson_candidate with draft_id ${draftId}.`;
  // The user keeps a notice's drafts: the local decline, as the agent calls it.
  const decline = ({ hooks }, sessionID, actionId) => {
    const args = { action_id: actionId, reason: "not_reusable" };
    return hooks["tool.execute.after"](
      { tool: "remembrance_decline_pending_action", sessionID, args },
      { status: "declined", ...args },
    );
  };
  // That ledger's last user prompt was more than a day ago.
  const idleForADay = (ledgerId) => {
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(
      join(process.env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.user-prompts`),
      dayAgo,
      dayAgo,
    );
  };
  const expectNoUserDecision = (...texts) => {
    for (const text of texts) {
      expect(text).not.toContain(ORPHAN_NOTICE);
      expect(text).not.toContain(HELD);
      expect(text).not.toContain("awaiting a user decision");
    }
  };

  it("gives a child session and a session it never saw created none of the user decisions, and leaves every one for the main session", async () => {
    const opencode = await plugin();
    await created(opencode.hooks, { id: MAIN, title: "New session" });
    await created(opencode.hooks, {
      id: CHILD,
      parentID: MAIN,
      title: "Review the runbook (@general subagent)",
    });
    const parked = retainedDrafts();
    const before = markerBytes();

    for (const sessionId of [CHILD, RESUMED]) {
      const { context, stop } = await turn(opencode, sessionId);
      for (const text of [context, stop]) {
        expect(text).not.toContain(ORPHAN_NOTICE);
        expect(text).not.toContain(HELD);
        expect(text).not.toContain("awaiting a user decision");
      }
    }
    // Nothing was acknowledged for the user.
    expect(markerBytes()).toEqual(before);
    expect(existsSync(mainSessionMarker(CHILD))).toBe(false);
    expect(existsSync(mainSessionMarker(RESUMED))).toBe(false);

    const { context } = await turn(opencode, MAIN);
    expect(context).toContain(
      "Retained private drafts awaiting a user decision: 2 lessons and 0 skills",
    );
    expect(context).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(context).toContain(HELD);
    expect(
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8")),
    ).toMatchObject({ drafts: ["pld_ocnoonesdraft", "pld_ocparkeddue01"] });
    expect(
      existsSync(join(lifecycle(), "pld_ocheldrecorded.held-notice.json")),
    ).toBe(true);
    expect(JSON.parse(readFileSync(parked, "utf8"))).toMatchObject({
      notices: 1,
    });
  });

  it("acknowledges the user decisions it delivers whole in a main session's context over its budget", async () => {
    const opencode = await plugin();
    await created(opencode.hooks, { id: MAIN });
    retainedDrafts();
    await capture(opencode, MAIN, "pld_ocownbudget1");
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
      const { context } = await turn(opencode, MAIN);
      expect(context).toContain("[Additional completion context omitted.]");
      expect(context).toContain(`action_id ${ORPHAN_NOTICE}`);
      expect(context).toContain(HELD);
      expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(true);
      expect(existsSync(join(lifecycle(), "pld_ocheldrecorded.held-notice.json"))).toBe(true);
      expectNoUserDecision((await turn(opencode, MAIN)).context);
    } finally {
      query.mockRestore();
    }
  });

  it("knows a main session it resumes in a later process, and still gives a child none", async () => {
    const first = await plugin();
    await created(first.hooks, { id: MAIN });
    await created(first.hooks, { id: CHILD, parentID: MAIN });
    expect(readFileSync(mainSessionMarker(MAIN), "utf8")).toBe("main\n");
    expect(existsSync(mainSessionMarker(CHILD))).toBe(false);
    retainedDrafts();
    const before = markerBytes();

    // OpenCode restarts and both sessions continue: no session.created.
    const later = await plugin();
    const child = await turn(later, CHILD);
    expect(child.context).not.toContain(ORPHAN_NOTICE);
    expect(child.stop).not.toContain(ORPHAN_NOTICE);
    expect(markerBytes()).toEqual(before);
    const main = await turn(later, MAIN);
    expect(main.context).toContain(`action_id ${ORPHAN_NOTICE}`);
    expect(main.context).toContain(HELD);
    expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(true);
  });

  it("acknowledges each main session's notice for its own drafts when another one composed the same words in between", async () => {
    const OTHER = "ses_othermain0001";
    const outbox = join(state(), "private-lessons");
    let between = async () => {};
    const opencode = await plugin(() => between());
    await created(opencode.hooks, { id: MAIN });
    await created(opencode.hooks, { id: OTHER });
    const offered = () =>
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8"))
        .drafts;

    // The main session's prompt composes its notice. Before its model
    // request, the user deletes that draft, another one awaits the user, and
    // the other session's prompt composes the same words.
    lessonEnvelope("pld_ocofferfirst1");
    await send(opencode, MAIN);
    rmSync(join(outbox, "pld_ocofferfirst1.lesson.json"));
    lessonEnvelope("pld_ocofferlater1");
    await send(opencode, OTHER);
    expect(await request(opencode, MAIN)).toContain(
      "awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(offered()).toEqual(["pld_ocofferfirst1"]);
    expect(await request(opencode, OTHER)).toContain(
      "awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(offered()).toEqual(["pld_ocofferlater1"]);

    // The main session's stop shows a held draft. While the user reads it,
    // that draft is deleted, another one is held, and the other session's
    // prompt composes the same words.
    lessonEnvelope("pld_ocheldfirst01", "held_safety", {
      hold_telemetry_status: "submitted",
    });
    between = async () => {
      between = async () => {};
      rmSync(join(outbox, "pld_ocheldfirst01.lesson.json"));
      lessonEnvelope("pld_ocheldlater01", "held_safety", {
        hold_telemetry_status: "submitted",
      });
      await send(opencode, OTHER);
    };
    expect(await idle(opencode, MAIN)).toContain(
      "1 retained private lesson draft was held",
    );
    expect(
      existsSync(join(lifecycle(), "pld_ocheldfirst01.held-notice.json")),
    ).toBe(true);
    expect(
      existsSync(join(lifecycle(), "pld_ocheldlater01.held-notice.json")),
    ).toBe(false);
  });

  it("lists a child session's capture silently in its parent's next prompt, and gives the child none of the user decisions", async () => {
    const opencode = await plugin();
    await created(opencode.hooks, { id: MAIN });
    await created(opencode.hooks, { id: CHILD, parentID: MAIN });
    // The content-free link, beside the main-session marker.
    expect(readFileSync(parentLink(CHILD), "utf8")).toBe(`${MAIN}\n`);
    expect(existsSync(parentLink(MAIN))).toBe(false);
    expect(existsSync(mainSessionMarker(CHILD))).toBe(false);

    // The main session's turn runs a task, whose child session captures a
    // lesson while other drafts wait for the user.
    await send(opencode, MAIN);
    await request(opencode, MAIN);
    retainedDrafts();
    const before = markerBytes();
    const draftId = "pld_occhildcapt01";
    await send(opencode, CHILD);
    const childContext = await request(opencode, CHILD);
    await capture(opencode, CHILD, draftId);
    const childStop = await idle(opencode, CHILD);
    expect(hintOwner(draftId)).toEqual({
      owner_session: ledgerOf(MAIN),
      captured_by_ledger: ledgerOf(`${MAIN}:agent:${CHILD}`),
      captured_by_agent: CHILD,
    });
    // The child is asked only about the draft it captured, again when the
    // task resumes it, and is never given a user decision.
    expect(childStop).toContain(`draft_id ${draftId}`);
    for (const other of ["pld_ocnoonesdraft", "pld_ocheldrecorded", "pld_ocparkeddue01"]) {
      expect(childStop).not.toContain(other);
    }
    const resumed = await turn(opencode, CHILD);
    expect(resumed.context).toContain(lessonLine(draftId));
    expectNoUserDecision(childContext, childStop, resumed.context, resumed.stop);
    expect(markerBytes()).toEqual(before);

    // The parent's idle and its next prompt list it silently, the prompt
    // naming the child; the user decision is about the other drafts only.
    const silently = `only for this session's due private drafts (${draftId})`;
    const mainStop = await idle(opencode, MAIN);
    expect(mainStop).toContain(silently);
    expect(mainStop).toContain(
      "Retained private drafts awaiting a user decision: 2 lessons and 0 skills",
    );
    expect(
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8")),
    ).toMatchObject({ drafts: ["pld_ocnoonesdraft", "pld_ocparkeddue01"] });
    await send(opencode, MAIN);
    const context = await request(opencode, MAIN);
    expect(context).toContain(silently);
    expect(context).toContain(
      lessonLine(draftId, ` (captured by subagent ${CHILD})`),
    );
  });

  it("puts a grandchild's capture in its root session's tree through the links a later process reads", async () => {
    const first = await plugin();
    await created(first.hooks, { id: MAIN });
    await created(first.hooks, { id: CHILD, parentID: MAIN });
    await created(first.hooks, { id: GRANDCHILD, parentID: CHILD });
    expect(readFileSync(parentLink(GRANDCHILD), "utf8")).toBe(`${CHILD}\n`);
    await send(first, MAIN);
    await request(first, MAIN);

    // OpenCode restarts and the task's sessions continue: no session.created.
    const later = await plugin();
    const draftId = "pld_ocgrandcapt01";
    await send(later, GRANDCHILD);
    const context = await request(later, GRANDCHILD);
    await capture(later, GRANDCHILD, draftId);
    const stop = await idle(later, GRANDCHILD);
    expect(stop).toContain(`draft_id ${draftId}`);
    expectNoUserDecision(context, stop);
    expect(hintOwner(draftId)).toEqual({
      owner_session: ledgerOf(MAIN),
      captured_by_ledger: ledgerOf(`${MAIN}:agent:${GRANDCHILD}`),
      captured_by_agent: GRANDCHILD,
    });
    // The child between them holds only what it captured itself.
    expect((await turn(later, CHILD)).context).not.toContain(draftId);
    const main = await turn(later, MAIN);
    expect(main.context).toContain(
      lessonLine(draftId, ` (captured by subagent ${GRANDCHILD})`),
    );
    expectNoUserDecision(main.context);
    expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(false);
  });

  it("keeps the capture of a child whose parent it never saw as that session's own, and offers it to the user once that session has been idle for a day", async () => {
    const opencode = await plugin();
    await created(opencode.hooks, { id: MAIN });
    // The child's session.created never reached the plugin.
    await send(opencode, MAIN);
    await request(opencode, MAIN);
    const draftId = "pld_ocunproven01";
    await send(opencode, CHILD);
    const context = await request(opencode, CHILD);
    await capture(opencode, CHILD, draftId);
    const stop = await idle(opencode, CHILD);
    expect(existsSync(parentLink(CHILD))).toBe(false);
    expect(hintOwner(draftId)).toEqual({
      owner_session: ledgerOf(CHILD),
      captured_by_ledger: ledgerOf(CHILD),
      captured_by_agent: undefined,
    });
    expect(stop).toContain(`draft_id ${draftId}`);
    expectNoUserDecision(context, stop);
    expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(false);

    // While that session is active, the main session neither lists nor
    // offers its draft.
    const active = await turn(opencode, MAIN);
    expect(active.context).not.toContain(draftId);
    expectNoUserDecision(active.context);

    // A day after that session's last prompt, the draft reaches the user.
    idleForADay(CHILD);
    const offered = await turn(opencode, MAIN);
    expect(offered.context).toContain(
      "Retained private drafts awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8")),
    ).toMatchObject({ drafts: [draftId] });
  });

  it("keeps a child's draft from the user decisions while the child is prompted and its root is idle, until the whole tree is idle", async () => {
    const OTHER = "ses_othermain0001";
    const opencode = await plugin();
    await created(opencode.hooks, { id: MAIN });
    await created(opencode.hooks, { id: OTHER });
    await created(opencode.hooks, { id: CHILD, parentID: MAIN });
    await send(opencode, MAIN);
    await request(opencode, MAIN);
    // The root's last user prompt was a day ago; the user now prompts the
    // child itself.
    idleForADay(MAIN);
    const draftId = "pld_occhildbusy01";
    await send(opencode, CHILD);
    await request(opencode, CHILD);
    await capture(opencode, CHILD, draftId);
    expect((await turn(opencode, CHILD)).context).toContain(lessonLine(draftId));

    // Another main session is offered nothing, and a keep there parks nothing.
    const other = await turn(opencode, OTHER);
    expectNoUserDecision(other.context, other.stop);
    await decline(opencode, OTHER, ORPHAN_NOTICE);
    expect(existsSync(join(lifecycle(), `${draftId}.parked.json`))).toBe(false);
    expect(existsSync(join(lifecycle(), "orphan-notice.json"))).toBe(false);
    expect(hintOwner(draftId)).toEqual({
      owner_session: ledgerOf(MAIN),
      captured_by_ledger: ledgerOf(`${MAIN}:agent:${CHILD}`),
      captured_by_agent: CHILD,
    });
    expect((await turn(opencode, CHILD)).context).toContain(lessonLine(draftId));

    // Once the child has had no prompt for a day either, it reaches the user.
    idleForADay(`${MAIN}:agent:${CHILD}`);
    const offered = await turn(opencode, OTHER);
    expect(offered.context).toContain(
      "Retained private drafts awaiting a user decision: 1 lesson and 0 skills",
    );
    expect(
      JSON.parse(readFileSync(join(lifecycle(), "orphan-notice.json"), "utf8")),
    ).toMatchObject({ drafts: [draftId] });
  });

  it("follows at most eight parent links to a session tree's root", async () => {
    const opencode = await plugin();
    const chain = Array.from(
      { length: 10 },
      (_, depth) => `ses_chainlink${String(depth).padStart(2, "0")}`,
    );
    await created(opencode.hooks, { id: chain[0] });
    for (let depth = 1; depth < chain.length; depth += 1) {
      await created(opencode.hooks, {
        id: chain[depth],
        parentID: chain[depth - 1],
      });
    }
    await capture(opencode, chain[8], "pld_occhaineight");
    await capture(opencode, chain[9], "pld_occhainnine01");
    expect(hintOwner("pld_occhaineight")).toEqual({
      owner_session: ledgerOf(chain[0]),
      captured_by_ledger: ledgerOf(`${chain[0]}:agent:${chain[8]}`),
      captured_by_agent: chain[8],
    });
    // Nine links prove nothing: that session keeps its draft.
    expect(hintOwner("pld_occhainnine01")).toEqual({
      owner_session: ledgerOf(chain[9]),
      captured_by_ledger: ledgerOf(chain[9]),
      captured_by_agent: undefined,
    });
  });

  it("keeps a child session's usage in its ledger in the root's tree, where the child's own idle finds it", async () => {
    const ledger = `${MAIN}:agent:${CHILD}`;
    const opencode = await plugin(undefined, {
      // A matched query, as the shared prompt hook reports one.
      runPromptHook: async () => ({
        context: "Relevant memory: release-review.",
        consumed: true,
        matched: true,
        eligible: true,
      }),
    });
    await created(opencode.hooks, { id: MAIN });
    await created(opencode.hooks, { id: CHILD, parentID: MAIN });
    await send(opencode, CHILD);
    expect(await request(opencode, CHILD)).toContain("release-review");
    await opencode.hooks["tool.execute.after"](
      { tool: "remembrance_query_skills", sessionID: CHILD, args: {} },
      {
        body: {
          query_id: "rq_occhildquery",
          skills: [
            {
              slug: "release-review",
              result_id: "qres_occhild",
              match_tier: "high",
            },
          ],
          resources: [],
        },
      },
    );
    expect(readRegistryUseCount(ledger, process.env)).toBe(2);
    expect(readTaskEligibilityCount(ledger, process.env)).toBe(1);
    expect(readRegistryUseCount(CHILD, process.env)).toBe(0);
    expect(readTaskEligibilityCount(CHILD, process.env)).toBe(0);
    expect(await idle(opencode, CHILD)).not.toBe("");
    expect(readPromptedCount(ledger, process.env)).toBe(2);
    expect(readPromptedCount(CHILD, process.env)).toBe(0);
  });
});
