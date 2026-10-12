// Codex Task 15 review F2: a kept subagent debt (its exact arguments sealed
// in the subagent's ledger) must stay discoverable by its parent however full
// the parent is, through every hop, and after the parent drains: one
// content-free pointer per kept debt, in the durable home or, while that is
// refused, the temporary one; bounded, paged reads. Every recovery below
// finds its handle in the demand text alone and retrieves through the same
// local reader the MCP tool uses.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import nodeFs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentLedgerIdFor,
  decideStop,
  foldTurnLedgerIntoSession,
  markCurrentEngagementHandled,
  observeSuccessfulCompletionTool,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  recordPostUseFeedbackObligation,
  recordPrivateLessonObligation,
  recordQueryFeedbackObligation,
  recordTaskEligibility,
  releaseCompletionForward,
  transferSubagentObligations,
  writePromptedCount,
} from "../scripts/hook-core.mjs";
import {
  inventoryRetainedKeyConsumers,
  readPendingActionPayload,
  resupplyPayloadDigest,
} from "../scripts/pending-action-payload.mjs";
import { checkPointerBound } from "./fixtures/pointer-bound.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-transfer-recovery-"));
let counter = 0;

beforeAll(() => {
  for (const [key, name] of [
    ["HOME", "home"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
    ["TMPDIR", "tmp"],
  ]) {
    mkdirSync(join(tempRoot, name), { recursive: true });
    vi.stubEnv(key, join(tempRoot, name));
  }
  vi.stubEnv("REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN", "0");
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv() {
  counter += 1;
  return {
    REMEMBRANCE_USAGE_DIR: join(tempRoot, `usage-${counter}`),
    XDG_STATE_HOME: join(tempRoot, `state-${counter}`),
    XDG_CONFIG_HOME: join(tempRoot, `config-${counter}`),
    REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
    REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
  };
}

const hash = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");
const ledgerOf = (ledgerId) => hash(ledgerId).slice(0, 16);
const retainedRoot = (env) =>
  join(env.XDG_STATE_HOME, "remembrance", "private-learning-lifecycle", "retained");
const listed = (directory) => (existsSync(directory) ? readdirSync(directory) : []);
const durablePointers = (env, ledgerId) =>
  listed(join(retainedRoot(env), `${ledgerOf(ledgerId)}.pointers`));
const temporaryPointers = (env, ledgerId) =>
  listed(join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.pointers`));
const overflowFile = (env, ledgerId) =>
  join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.obligations-overflow.json`);
const preference = (value) => ({
  setting: {
    key: "workflow.transfer_recovery",
    value,
    label: "Transfer recovery",
    behavior: "Use a synthetic fixture.",
    effect: "workflow",
  },
  scope: "member",
});
const childId = (index) => `c${index.toString(16).padStart(16, "0")}`;
const stopOf = (session, agentId) => ({
  hook_event_name: "SubagentStop",
  session_id: session,
  agent_id: agentId,
});

// A capture_learning preference route the hook observes; the arguments are
// sealed into the ledger and nothing of them is returned.
function capture(env, ledgerId, value) {
  observeSuccessfulCompletionTool(
    ledgerId,
    "capture_learning",
    {},
    {
      capture_route: "preference",
      persisted_locally: false,
      next_action: { tool: "record_preference", arguments: preference(value) },
    },
    env,
  );
}

function fillOwn(env, ledgerId) {
  for (let index = 0; index < 64; index += 1) {
    recordQueryFeedbackObligation(
      ledgerId,
      { available: true, query_id: `rq_own_${index}` },
      env,
    );
  }
}

// A parent with 64 debts of its own and 64 subagents' kept debts it could not
// take whole: today's pointer capacity. Round 0 R0-5 (D4): each of the 64 is
// sealed in its subagent's ledger, named after that subagent and pointed to
// by direct writes, as 64 stops leave them; no test using this has those 64
// hand-overs under test (each test's own stops run the real hook).
function saturate(env, parent) {
  fillOwn(env, parent);
  const pointers = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
  mkdirSync(pointers, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 64; index += 1) {
    const keeper = ledgerOf(agentLedgerIdFor(stopOf(parent, childId(index))));
    capture(env, agentLedgerIdFor(stopOf(parent, childId(index))), `v${index}`);
    const id = preferenceId(`v${index}`);
    tagRecord(join(retainedRoot(env), `${keeper}.obligations`, recordFileName(id)), childId(index));
    writeFileSync(join(pointers, pointerFileName(keeper, id)), pointerText(keeper, id), { mode: 0o600 });
  }
}

// Pays the parent's own debts, then declines what each read shows (all but
// `keep`), page after page, as an agent working through its demands would.
function drain(env, parent, { keep = () => false, pages = 1 } = {}) {
  payOwn(env, parent);
  for (let page = 0; page < pages; page += 1) {
    for (const item of readCompletionObligations(parent, env)) {
      if (keep(item)) continue;
      observeSuccessfulCompletionTool(
        parent,
        "decline_pending_action",
        { action_id: hash(item.id).slice(0, 16), reason: "not_reusable" },
        { declined: true },
        env,
      );
    }
  }
}

const HANDLE =
  /get_pending_action_payload with action_id ([a-f0-9]{16}) and ledger ([a-f0-9]{16})/g;
const handlesIn = (text) =>
  [...String(text ?? "").matchAll(HANDLE)].map(([, action_id, ledger]) => ({
    action_id,
    ledger,
  }));
const keyOf = (env) =>
  Buffer.from(
    readFileSync(
      join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key"),
      "utf8",
    ).trim(),
    "base64url",
  );
const retrieve = (env, handle) =>
  readPendingActionPayload(handle, env, { readKey: async () => keyOf(env) });
const modeOf = (path) => statSync(path).mode & 0o777;
const pointerFileName = (keeper, id) => `${hash(`${keeper}:${id}`).slice(0, 32)}.json`;
const pointerText = (keeper, id) =>
  `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: keeper, id })}\n`;
// The same pointer as OpenClaw's path writes it.
const flaggedPointerText = (keeper, id) =>
  `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: keeper, id, forwarded: true })}\n`;
const preferenceId = (value) =>
  `capture_next_action:${resupplyPayloadDigest(preference(value))}`;
const recordFileName = (id) => `${hash(id).slice(0, 32)}.json`;
const associationFileName = (from) => `${hash(`association:${from}`).slice(0, 32)}.json`;
// A kept record as a hand-over names it: transferred_from added, nothing else.
function tagRecord(path, agentId) {
  writeFileSync(
    path,
    `${JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), transferred_from: { agent_id: agentId, transcript_path: null } })}\n`,
  );
}
// The durable root refused while `run` runs (a link to the same directory
// stands in for it), then restored.
function withRefusedRoot(env, run) {
  const root = retainedRoot(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  renameSync(root, `${root}-real`);
  symlinkSync(`${root}-real`, root);
  try {
    return run();
  } finally {
    rmSync(root);
    renameSync(`${root}-real`, root);
  }
}
// The outbox key, as a first capture with a usable root writes it; a capture
// whose durable home is refused seals with it all the same.
function ensureKey(env) {
  mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key"),
    `${Buffer.alloc(32, 7).toString("base64url")}\n`,
    { mode: 0o600 },
  );
}
// The 64 debts fillOwn gave a ledger, paid. Round 0 R0-5 (D4): removed
// where they are kept, as their completions would; no test using this has
// their completion path under test, and each completion would read the
// ledger's whole page again.
function payOwn(env, ledgerId) {
  const directory = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.obligations`);
  for (const name of listed(directory)) {
    const path = join(directory, name);
    if (/^rq_own_/.test(JSON.parse(readFileSync(path, "utf8")).query_id ?? "")) rmSync(path);
  }
}
// One real sealed record, captured in a scratch ledger, for fixtures that
// need many live records: copies of it open with the same envelope.
function sealedRecord(env, value) {
  const source = `f2-fixture-source-${value}`;
  capture(env, source, value);
  const id = preferenceId(value);
  return {
    id,
    text: readFileSync(
      join(retainedRoot(env), `${ledgerOf(source)}.obligations`, recordFileName(id)),
      "utf8",
    ),
  };
}
// The same record kept by `count` more ledgers, as 16-hex keeper names.
function keepCopies(env, record, count, label) {
  return Array.from({ length: count }, (_, index) => {
    const keeper = hash(`${label}-${index}`).slice(0, 16);
    const directory = join(retainedRoot(env), `${keeper}.obligations`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, recordFileName(record.id)), record.text, { mode: 0o600 });
    return keeper;
  });
}
// Every file below the given roots, with its bytes.
function snapshotTree(roots) {
  const files = {};
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root, { recursive: true })) {
      const path = join(root, String(name));
      if (statSync(path).isFile()) files[path] = readFileSync(path, "utf8");
    }
  }
  return files;
}

// The real Stop/SubagentStop entry (hooks/hooks.json), in a fresh process
// whose fetch only records that it was called.
const stopScript = fileURLToPath(
  new URL("../scripts/contribute-on-stop.mjs", import.meta.url),
);
function freshStop(env, input) {
  const trap = join(tempRoot, "fetch-trap.mjs");
  writeFileSync(
    trap,
    'import { appendFileSync } from "node:fs";\nglobalThis.fetch = async () => { appendFileSync(process.env.F2_FETCH_LOG, "fetch\\n"); throw new Error("no network in this test"); };\n',
  );
  const log = join(tempRoot, `fetch-${counter}.log`);
  const stdout = execFileSync(
    process.execPath,
    ["--import", pathToFileURL(trap).href, stopScript],
    {
      input: JSON.stringify(input),
      env: {
        PATH: process.env.PATH,
        HOME: join(tempRoot, "home"),
        TMPDIR: join(tempRoot, "tmp"),
        F2_FETCH_LOG: log,
        ...env,
      },
      encoding: "utf8",
    },
  );
  return { output: stdout.trim() ? JSON.parse(stdout) : null, fetched: existsSync(log) };
}

// Asserts what the demand's one handle retrieves (`valueFor` maps the
// subagent the record names to the value it captured), then completes it
// with exactly those arguments and checks nothing is left anywhere.
async function recoverAndComplete(env, parent, demand, valueFor) {
  const handles = handlesIn(demand);
  expect(handles).toHaveLength(1);
  const retrieved = await retrieve(env, handles[0]);
  const value = valueFor(retrieved.transferred_from?.agent_id);
  expect(retrieved).toMatchObject({
    status: "retrieved",
    kind: "capture_next_action",
    provenance: "second_hand",
    arguments: preference(value),
  });
  expect(retrieved.payload_digest).toBe(resupplyPayloadDigest(preference(value)));
  observeSuccessfulCompletionTool(
    parent,
    "record_preference",
    retrieved.arguments,
    { recorded: true },
    env,
  );
  expect(readCompletionObligations(parent, env)).toEqual([]);
  expect(pendingCompletionRecoveryInstruction(parent, env)).toBeNull();
  expect(durablePointers(env, parent)).toEqual([]);
  expect(temporaryPointers(env, parent)).toEqual([]);
  expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
  expect((await retrieve(env, handles[0])).status).toBe("not_found");
}

describe("F2: kept transferred work stays discoverable after saturation", () => {
  // The two saturated parents the first two cases start from are built
  // before any case runs, so neither case times its fixture (round 3,
  // helper F2: both are load-sensitive).
  const saturated = {};
  beforeAll(() => {
    for (const parent of ["f2-codex-scenario", "f2-nested"]) {
      saturated[parent] = testEnv();
      saturate(saturated[parent], parent);
    }
  });

  it("names every kept subagent debt past a full parent and 64 pointers, and recovers the last one after the drain from a fresh Stop process", async () => {
    const parent = "f2-codex-scenario";
    const env = saturated[parent];
    const last = stopOf(parent, childId(64));
    capture(env, agentLedgerIdFor(last), "v64");
    transferSubagentObligations(last, env);

    expect(durablePointers(env, parent)).toHaveLength(65);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(readCompletionObligations(parent, env)).toHaveLength(128);
    expect(pendingCompletionRecoveryInstruction(parent, env)).not.toContain(
      "repeat the original request",
    );

    drain(env, parent);
    // One debt is left, and nothing in memory names it: only the demand does.
    const { output, fetched } = freshStop(env, {
      hook_event_name: "Stop",
      session_id: parent,
    });
    expect(fetched).toBe(false);
    expect(output?.decision).toBe("block");
    expect(output.reason).not.toContain("repeat the original request");
    await recoverAndComplete(env, parent, output.reason, (agentId) => {
      const index = Number.parseInt(String(agentId).slice(1), 16);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(64);
      return `v${index}`;
    });
    expect(existsSync(overflowFile(env, parent))).toBe(false);
  });

  it("points a parent at a nested subagent's kept debt, keeps its first provenance, moves the hop's own pointer up and counts no kept debt", async () => {
    const parent = "f2-nested";
    const env = saturated[parent];
    const childStop = stopOf(parent, childId(0x100));
    const child = agentLedgerIdFor(childStop);
    fillOwn(env, child);
    const grandStop = stopOf(child, childId(0x200));
    const grand = agentLedgerIdFor(grandStop);
    capture(env, grand, "nested");
    transferSubagentObligations(grandStop, env);
    expect(durablePointers(env, child)).toHaveLength(1);

    transferSubagentObligations(childStop, env);
    transferSubagentObligations(childStop, env);
    expect(durablePointers(env, child)).toEqual([]);
    expect(durablePointers(env, parent)).toHaveLength(65);
    for (const ledgerId of [parent, child, grand]) {
      const path = overflowFile(env, ledgerId);
      const kinds = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).kinds : [];
      expect(kinds).not.toContain("capture_next_action");
    }

    drain(env, parent, { keep: (item) => item.ledger === ledgerOf(grand), pages: 3 });
    const demand = pendingCompletionRecoveryInstruction(parent, env);
    expect(demand).toContain(`second-hand from subagent ${childId(0x200)}`);
    await recoverAndComplete(env, parent, demand, (agentId) => {
      expect(agentId).toBe(childId(0x200));
      return "nested";
    });
  });

  it("points a Codex session at a turn's kept debt that the fold cannot move, and recovers it after the drain", async () => {
    const env = testEnv();
    const session = "f2-fold-session";
    const turn = "f2-fold-turn-7";
    saturate(env, session);
    // A turn-keyed debt, as an earlier Codex client kept it.
    capture(env, turn, "fold");
    foldTurnLedgerIntoSession({ session_id: session, turn_id: turn }, env);
    foldTurnLedgerIntoSession({ session_id: session, turn_id: turn }, env);

    expect(durablePointers(env, session)).toHaveLength(65);
    expect(existsSync(overflowFile(env, session))).toBe(false);
    drain(env, session, { keep: (item) => item.ledger === ledgerOf(turn), pages: 3 });
    const demand = pendingCompletionRecoveryInstruction(session, env);
    const [handle] = handlesIn(demand);
    expect(handle?.ledger).toBe(ledgerOf(turn));
    const retrieved = await retrieve(env, handle);
    expect(retrieved).toMatchObject({ status: "retrieved", arguments: preference("fold") });
    observeSuccessfulCompletionTool(session, "record_preference", retrieved.arguments, { recorded: true }, env);
    expect(readCompletionObligations(session, env)).toEqual([]);
    expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
  });

  it("folds, then transfers, a ledger that holds only a pointer (OpenClaw's order), so the debt reaches the spawning session", async () => {
    const env = testEnv();
    const parent = "f2-openclaw-parent";
    const runLedger = "f2-openclaw-child-session";
    fillOwn(env, runLedger);
    const grandStop = stopOf(runLedger, childId(0x300));
    capture(env, agentLedgerIdFor(grandStop), "openclaw");
    transferSubagentObligations(grandStop, env);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(runLedger, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    expect(readCompletionObligations(runLedger, env)).toHaveLength(1);

    const handoff = stopOf(parent, childId(0x301));
    foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(handoff), turn_id: runLedger }, env);
    transferSubagentObligations(handoff, env);
    expect(readCompletionObligations(runLedger, env)).toEqual([]);
    const demand = pendingCompletionRecoveryInstruction(parent, env);
    const [handle] = handlesIn(demand);
    expect(handle).toBeDefined();
    const retrieved = await retrieve(env, handle);
    expect(retrieved).toMatchObject({
      status: "retrieved",
      provenance: "second_hand",
      arguments: preference("openclaw"),
    });
  });

  it("keeps the pointer in the temporary home while the durable root is refused, writes nothing through the link, promotes it once restored, and recovers the debt", async () => {
    const env = testEnv();
    const parent = "f2-refused";
    mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key"),
      `${Buffer.alloc(32, 7).toString("base64url")}\n`,
      { mode: 0o600 },
    );
    const lifecycle = join(env.XDG_STATE_HOME, "remembrance", "private-learning-lifecycle");
    mkdirSync(lifecycle, { recursive: true, mode: 0o700 });
    const outside = `${env.XDG_STATE_HOME}-outside`;
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(lifecycle, "retained"));
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(7));
    capture(env, agentLedgerIdFor(stop), "refused");
    transferSubagentObligations(stop, env);
    transferSubagentObligations(stop, env);

    expect(readdirSync(outside)).toEqual([]);
    // The pointer, and the association the stop left because it could not
    // read the subagent's durable home (D1): both content-free, both here.
    const child = ledgerOf(agentLedgerIdFor(stop));
    const entries = [pointerFileName(child, preferenceId("refused")), associationFileName(child)].sort();
    expect(temporaryPointers(env, parent).sort()).toEqual(entries);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(readCompletionObligations(parent, env).filter((item) => item.ledger)).toHaveLength(1);

    rmSync(join(lifecycle, "retained"));
    readCompletionObligations(parent, env);
    expect(temporaryPointers(env, parent)).toEqual([]);
    expect(durablePointers(env, parent).sort()).toEqual(entries);

    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    await recoverAndComplete(
      env,
      parent,
      pendingCompletionRecoveryInstruction(parent, env),
      (agentId) => {
        expect(agentId).toBe(childId(7));
        return "refused";
      },
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  // Claude Code and Codex hand every subagent's debts to the main session's
  // ledger; OpenClaw's adapter passes `forward` (round 1 R1-6).
  const HOST_PATHS = [
    ["Claude Code and Codex", {}],
    ["OpenClaw", { forward: true }],
  ];

  // Filesystem calls and directory entries listed, counted by wrapping every
  // synchronous node:fs function and Dir#readSync, never by product counters.
  function countFilesystem(run) {
    const counts = { calls: 0, listed: 0, pointerListings: 0 };
    const restore = [];
    const wrap = (target, name, onResult) => {
      const original = target[name];
      restore.push(() => {
        target[name] = original;
      });
      target[name] = function counted(...args) {
        counts.calls += 1;
        const result = original.apply(this, args);
        onResult?.(result);
        return result;
      };
    };
    for (const name of Object.keys(nodeFs)) {
      if (name.endsWith("Sync") && typeof nodeFs[name] === "function") {
        wrap(nodeFs, name, name === "readdirSync"
          ? (result) => { counts.listed += Array.isArray(result) ? result.length : 0; }
          : undefined);
      }
    }
    // A full listing of a pointer directory: the unbounded work D-A removed.
    const readdir = nodeFs.readdirSync;
    nodeFs.readdirSync = function listing(path, ...rest) {
      if (String(path).endsWith(".pointers")) counts.pointerListings += 1;
      return readdir.call(this, path, ...rest);
    };
    wrap(nodeFs.Dir.prototype, "readSync", (entry) => {
      if (entry) counts.listed += 1;
    });
    wrap(nodeFs.Dir.prototype, "closeSync");
    syncBuiltinESMExports();
    try {
      run();
    } finally {
      for (const undo of restore.reverse()) undo();
      syncBuiltinESMExports();
    }
    return counts;
  }

  // Pinned per-event work (design note d-a.md (d), (g)): a read lists the
  // parent's 64 own record names and examines exactly 64 pointer entries,
  // stopping when its page is full; a hand-over event lists the child's one
  // record name and the parent's 64 own record names once (held and room
  // share one listing), examining none of the parent's pointers. Neither
  // depends on how many pointers lie beyond the page, and no pointer
  // directory is ever listed whole. Round 0 R0-5 (D4): one case per size,
  // each with its own fixture, built before the case runs, so no case grows
  // with another and none times its fixture. Round 1 R1-6: a stop on Claude
  // Code's or Codex's path writes no forwarding marker; OpenClaw's path
  // (`forward`) writes the exiting ledger's and looks for the parent's.
  const BOUNDED = {
    read: { calls: 1483, listed: 128, pointerListings: 0 },
    // Round 3 (R3C-7): OpenClaw's own pointers carry the flag, and a read
    // looks up whose each is: one failed marker lookup (two calls) per
    // examined flagged entry, counted toward nothing (d-a.md (d)).
    flaggedRead: { calls: 1611, listed: 128, pointerListings: 0 },
    write: {
      "Claude Code and Codex": { calls: 601, listed: 65, pointerListings: 0 },
      OpenClaw: { calls: 616, listed: 65, pointerListings: 0 },
    },
  };
  for (const [shape, options, flagged = false] of [
    ...HOST_PATHS,
    ["OpenClaw", { forward: true }, true],
  ]) for (const extra of [0, 1, 1000]) {
    describe(`${extra} more pointers beyond the page (${shape}${flagged ? ", flagged" : ""})`, () => {
      const env = testEnv();
      const parent = `f2-bounded-${extra}-${options.forward ? "forward" : "main"}${flagged ? "-flagged" : ""}`;
      const stop = stopOf(parent, childId(0x400));
      beforeAll(() => {
        const record = sealedRecord(env, "bounded");
        const pointers = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
        mkdirSync(pointers, { recursive: true, mode: 0o700 });
        for (const keeper of keepCopies(env, record, 64 + extra, "f2-bounded-keeper")) {
          writeFileSync(
            join(pointers, pointerFileName(keeper, record.id)),
            (flagged ? flaggedPointerText : pointerText)(keeper, record.id),
            { mode: 0o600 },
          );
        }
        fillOwn(env, parent);
        capture(env, agentLedgerIdFor(stop), "bounded-new");
      });
      it(`reads a page and writes a pointer with the same filesystem work when ${extra} more pointers lie beyond the page`, () => {
        let page;
        const read = countFilesystem(() => {
          page = readCompletionObligations(parent, env);
        });
        expect(page.filter((item) => item.ledger)).toHaveLength(64);
        const write = countFilesystem(() => transferSubagentObligations(stop, env, options));
        expect(durablePointers(env, parent)).toHaveLength(65 + extra);
        console.info(`F2 bounded filesystem work, ${extra} beyond the page (${shape}${flagged ? ", flagged" : ""}): ${JSON.stringify({ read, write })}`);
        expect(read).toEqual(flagged ? BOUNDED.flaggedRead : BOUNDED.read);
        expect(write).toEqual(BOUNDED.write[shape]);
      });
    });
  }

  it("changes nothing on a repeated SubagentStop or a StopFailure for the same subagent: byte-identical state", () => {
    const env = testEnv();
    const parent = "f2-duplicate";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(9));
    capture(env, agentLedgerIdFor(stop), "duplicate");
    expect(transferSubagentObligations(stop, env)).toBe(0);
    const roots = [env.REMEMBRANCE_USAGE_DIR, env.XDG_STATE_HOME];
    const before = snapshotTree(roots);
    expect(durablePointers(env, parent)).toHaveLength(1);

    expect(transferSubagentObligations(stop, env)).toBe(0);
    expect(transferSubagentObligations({ ...stop, hook_event_name: "StopFailure" }, env)).toBe(0);
    expect(snapshotTree(roots)).toEqual(before);
  });

  it("names a kept debt in the next prompt of a fresh hook process, the default silent recovery, with no network call", async () => {
    const env = testEnv();
    const parent = "f2-restart";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(10));
    capture(env, agentLedgerIdFor(stop), "restart");
    transferSubagentObligations(stop, env);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    const trap = join(tempRoot, "fetch-trap-prompt.mjs");
    writeFileSync(
      trap,
      'import { appendFileSync } from "node:fs";\nglobalThis.fetch = async () => { appendFileSync(process.env.F2_FETCH_LOG, "fetch\\n"); throw new Error("no network in this test"); };\n',
    );
    const log = join(tempRoot, `fetch-prompt-${counter}.log`);
    const { REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: _visible, ...silent } = env;
    const stdout = execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(trap).href,
        fileURLToPath(new URL("../scripts/query-on-prompt.mjs", import.meta.url)),
      ],
      {
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: parent,
          turn_id: "f2-restart-turn",
          prompt: "rename a local variable",
        }),
        env: { PATH: process.env.PATH, HOME: join(tempRoot, "home"), TMPDIR: join(tempRoot, "tmp"), F2_FETCH_LOG: log, ...silent },
        encoding: "utf8",
      },
    );
    expect(existsSync(log)).toBe(false);
    await recoverAndComplete(
      env,
      parent,
      JSON.parse(stdout).hookSpecificOutput.additionalContext,
      (agentId) => {
        expect(agentId).toBe(childId(10));
        return "restart";
      },
    );
  });

  it("writes the pointer in the temporary home (0600 in 0700) when the durable pointer directory is a link, writes nothing behind it, and promotes the pointer once the link is gone", async () => {
    const env = testEnv();
    const parent = "f2-write-failure";
    fillOwn(env, parent);
    const durableDir = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    const temporaryDir = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`);
    mkdirSync(retainedRoot(env), { recursive: true, mode: 0o700 });
    const outside = `${env.XDG_STATE_HOME}-outside-pointers`;
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    symlinkSync(outside, durableDir);
    const stop = stopOf(parent, childId(11));
    capture(env, agentLedgerIdFor(stop), "write-failure");
    transferSubagentObligations(stop, env);

    expect(readdirSync(outside)).toEqual([]);
    const [name] = temporaryPointers(env, parent);
    expect(name).toBeDefined();
    expect(modeOf(join(temporaryDir, name))).toBe(0o600);
    expect(modeOf(temporaryDir)).toBe(0o700);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    readCompletionObligations(parent, env);
    expect(readdirSync(outside)).toEqual([]);
    expect(temporaryPointers(env, parent)).toEqual([name]);

    rmSync(durableDir);
    readCompletionObligations(parent, env);
    expect(temporaryPointers(env, parent)).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([name]);
    expect(modeOf(join(durableDir, name))).toBe(0o600);
    expect(modeOf(durableDir)).toBe(0o700);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(11));
      return "write-failure";
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("leaves a kept debt intact, never counted, when no home accepts its pointer (residual 1), and a repeated stop names it once a home does", async () => {
    const env = testEnv();
    const parent = "f2-every-home-refused";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(12));
    const child = agentLedgerIdFor(stop);
    capture(env, child, "every-home-refused");
    const blocked = [
      join(retainedRoot(env), `${ledgerOf(parent)}.pointers`),
      join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`),
    ];
    for (const path of blocked) writeFileSync(path, "x", { mode: 0o600 });
    expect(transferSubagentObligations(stop, env)).toBe(0);

    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(readCompletionObligations(child, env)).toEqual([
      expect.objectContaining({ id: preferenceId("every-home-refused"), transferred_from: expect.objectContaining({ agent_id: childId(12) }) }),
    ]);
    expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(1);
    // What the agent sees: the parent's demand names its own debts only.
    expect(handlesIn(pendingCompletionRecoveryInstruction(parent, env))).toEqual([]);
    // Still refused: a repeated stop changes nothing and counts nothing.
    const roots = [env.REMEMBRANCE_USAGE_DIR, env.XDG_STATE_HOME];
    const refused = snapshotTree(roots);
    expect(transferSubagentObligations(stop, env)).toBe(0);
    expect(snapshotTree(roots)).toEqual(refused);

    // A home accepts again: the repeated stop writes the pointer.
    for (const path of blocked) rmSync(path);
    expect(transferSubagentObligations(stop, env)).toBe(0);
    expect(durablePointers(env, parent)).toHaveLength(1);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(12));
      return "every-home-refused";
    });
  });

  it("names two subagents' debts of one id sealed differently as two handles, opens each with its own envelope, and a decline after retrieval removes both records, their pointers and their demand lines", async () => {
    const env = testEnv();
    const parent = "f2-same-id";
    fillOwn(env, parent);
    const stops = [stopOf(parent, childId(21)), stopOf(parent, childId(22))];
    for (const stop of stops) {
      capture(env, agentLedgerIdFor(stop), "same-id");
      transferSubagentObligations(stop, env);
    }
    const id = preferenceId("same-id");
    const records = stops.map((stop) =>
      join(retainedRoot(env), `${ledgerOf(agentLedgerIdFor(stop))}.obligations`, recordFileName(id)),
    );
    const envelopes = records.map((path) => JSON.stringify(JSON.parse(readFileSync(path, "utf8")).local_resupply_envelope));
    expect(envelopes[0]).not.toBe(envelopes[1]);
    expect(durablePointers(env, parent)).toHaveLength(2);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }

    const handles = handlesIn(pendingCompletionRecoveryInstruction(parent, env));
    expect(handles.map((handle) => handle.ledger).sort()).toEqual(
      stops.map((stop) => ledgerOf(agentLedgerIdFor(stop))).sort(),
    );
    expect(new Set(handles.map((handle) => handle.action_id))).toEqual(new Set([hash(id).slice(0, 16)]));
    for (const handle of handles) {
      expect(await retrieve(env, handle)).toMatchObject({ status: "retrieved", arguments: preference("same-id") });
    }

    observeSuccessfulCompletionTool(parent, "decline_pending_action", { action_id: handles[0].action_id, reason: "duplicate" }, { declined: true }, env);
    expect(pendingCompletionRecoveryInstruction(parent, env) ?? "").not.toContain(handles[0].action_id);
    for (const path of records) expect(existsSync(path)).toBe(false);
    expect(durablePointers(env, parent)).toEqual([]);
    expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
    for (const handle of handles) expect((await retrieve(env, handle)).status).toBe("not_found");
  });

  it("removes by name, where it is kept, a pointed debt the parent already holds an equal copy of, even when a concurrent hook pushes it beyond the exiting ledger's page (436fe94e)", () => {
    const env = testEnv();
    const parent = "f2-by-name-parent";
    const childStop = stopOf(parent, childId(0x500));
    const child = agentLedgerIdFor(childStop);
    fillOwn(env, child);
    const grandStop = stopOf(child, childId(0x501));
    const grand = agentLedgerIdFor(grandStop);
    capture(env, grand, "by-name");
    transferSubagentObligations(grandStop, env);
    payOwn(env, child);
    expect(readCompletionObligations(child, env)).toEqual([expect.objectContaining({ ledger: ledgerOf(grand) })]);
    // A pointed debt never moves whole (round 0 R0-3, D2(i)); it leaves
    // where it is kept only when the parent already holds an equal copy,
    // byte for byte, as an earlier, interrupted hand-over can leave it.
    const grandRecord = join(retainedRoot(env), `${ledgerOf(grand)}.obligations`, recordFileName(preferenceId("by-name")));
    const parentDurable = join(retainedRoot(env), `${ledgerOf(parent)}.obligations`);
    const parentCopy = join(parentDurable, recordFileName(preferenceId("by-name")));
    mkdirSync(parentDurable, { recursive: true, mode: 0o700 });
    writeFileSync(parentCopy, readFileSync(grandRecord, "utf8"), { mode: 0o600 });
    const concurrent = sealedRecord(env, "concurrent");
    const keepers = keepCopies(env, concurrent, 64, "f2-by-name-keeper");
    // When the hand-over opens the parent's copy, a concurrent hook adds 64
    // live pointers to the child's temporary home, which every read examines
    // first: a page read of the child no longer shows the pointed debt.
    const original = nodeFs.openSync;
    let armed = true;
    nodeFs.openSync = function opened(path, ...rest) {
      if (armed && String(path) === parentCopy) {
        armed = false;
        const directory = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(child)}.pointers`);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const keeper of keepers) {
          writeFileSync(join(directory, pointerFileName(keeper, concurrent.id)), pointerText(keeper, concurrent.id), { mode: 0o600 });
        }
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      expect(transferSubagentObligations(childStop, env)).toBe(1);
    } finally {
      nodeFs.openSync = original;
      syncBuiltinESMExports();
    }
    expect(armed).toBe(false);
    expect(existsSync(grandRecord)).toBe(false);
    expect(durablePointers(env, child)).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([]);
    const held = readCompletionObligations(parent, env).find((item) => item.id === preferenceId("by-name"));
    expect(held).toMatchObject({ transferred_from: { agent_id: childId(0x501) } });
    expect(held.ledger).toBeUndefined();
  });

  it("writes a pointer again when a repeated stop finds it unreadable or altered, so the parent names the debt again", async () => {
    const env = testEnv();
    const parent = "f2-pointer-repair";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(13));
    const keeper = ledgerOf(agentLedgerIdFor(stop));
    capture(env, agentLedgerIdFor(stop), "pointer-repair");
    transferSubagentObligations(stop, env);
    const [name] = durablePointers(env, parent);
    const pointer = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`, name);
    const exact = readFileSync(pointer, "utf8");
    const named = () =>
      readCompletionObligations(parent, env).some((item) => item.ledger === keeper);
    expect(named()).toBe(true);
    for (const alter of [
      () => chmodSync(pointer, 0o644),
      () =>
        writeFileSync(pointer, '{"version":"completion-obligation-pointer-v1"}\n', {
          mode: 0o600,
        }),
    ]) {
      alter();
      // A read skips it, so the parent no longer names the debt.
      expect(named()).toBe(false);
      expect(transferSubagentObligations(stop, env)).toBe(0);
      expect(readFileSync(pointer, "utf8")).toBe(exact);
      expect(modeOf(pointer)).toBe(0o600);
      expect(durablePointers(env, parent)).toEqual([name]);
      expect(named()).toBe(true);
    }
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    for (let index = 0; index < 64; index += 1) {
      observeSuccessfulCompletionTool(parent, "submit_query_feedback", { query_id: `rq_own_${index}` }, { accepted: true }, env);
    }
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(13));
      return "pointer-repair";
    });
  });

  it("never counts a kept debt when the parent fills between its room check and its write (8b1cdb65)", () => {
    const env = testEnv();
    const parent = "f2-fills-during";
    for (let index = 0; index < 63; index += 1) {
      recordQueryFeedbackObligation(parent, { available: true, query_id: `rq_own_${index}` }, env);
    }
    recordQueryFeedbackObligation("f2-fills-template", { available: true, query_id: "rq_concurrent" }, env);
    const templateDir = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf("f2-fills-template")}.obligations`);
    const [templateName] = readdirSync(templateDir);
    const templateText = readFileSync(join(templateDir, templateName), "utf8");
    const stop = stopOf(parent, childId(0x600));
    capture(env, agentLedgerIdFor(stop), "fills-during");
    const ownDir = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.obligations`);
    // The hand-over lists the parent's own records twice: once for whether
    // it is held and has room (63 of 64: yes), then for the write's own
    // capacity check. Just before that second listing, a concurrent hook
    // records a 64th debt.
    const original = nodeFs.readdirSync;
    let listings = 0;
    nodeFs.readdirSync = function listed(path, ...rest) {
      if (String(path) === ownDir && (listings += 1) === 2) {
        writeFileSync(join(ownDir, templateName), templateText, { mode: 0o600 });
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      expect(transferSubagentObligations(stop, env)).toBe(0);
    } finally {
      nodeFs.readdirSync = original;
      syncBuiltinESMExports();
    }
    expect(listings).toBeGreaterThanOrEqual(2);
    expect(readCompletionObligations(parent, env).filter((item) => !item.ledger)).toHaveLength(64);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(durablePointers(env, parent)).toHaveLength(1);
    expect(pendingCompletionRecoveryInstruction(parent, env)).not.toContain("repeat the original request");
  });
  // Round 0 R0-3 (D2) and round 1 R1-1: nested orderings, on OpenClaw's path
  // (`forward`), where a ledger that handed over can still receive. A record
  // another ledger may point to never moves whole; a hand-over goes into the
  // ledger it names, never past it, and when that ledger has handed over, the
  // ledger it went to gets an association to it (probe-late-repeat.mts, both
  // cases).
  for (const [label, order] of [
    ["repeats after the intermediate subagent's end", "repeat"],
    ["comes first after the intermediate subagent's end", "late-first"],
  ]) {
    it(`names a nested subagent's kept debt to the parent when its stop ${label} (R0-3)`, async () => {
      const env = testEnv();
      const parent = `f2-${order}`;
      fillOwn(env, parent);
      const childStop = stopOf(parent, childId(0x700));
      const child = agentLedgerIdFor(childStop);
      fillOwn(env, child);
      const grandStop = stopOf(child, childId(0x701));
      const grand = agentLedgerIdFor(grandStop);
      capture(env, grand, order);
      const forward = { forward: true };
      if (order === "repeat") {
        transferSubagentObligations(grandStop, env, forward);
        expect(durablePointers(env, child)).toHaveLength(1);
      }
      // The child ends: its own debts go to the full parent (counted), and
      // it leaves a forwarding marker; then the grandchild's stop, into the
      // child's ledger.
      transferSubagentObligations(childStop, env, forward);
      transferSubagentObligations(grandStop, env, forward);
      const record = join(retainedRoot(env), `${ledgerOf(grand)}.obligations`, recordFileName(preferenceId(order)));
      if (order === "repeat") {
        // Pointed once, the record stays where it is kept: the parent has the
        // pointer the child's end moved up, the child a new one, and the
        // parent an association to the child.
        expect(existsSync(record)).toBe(true);
        expect(durablePointers(env, parent).sort()).toEqual(
          [pointerFileName(ledgerOf(grand), preferenceId(order)), associationFileName(ledgerOf(child))].sort(),
        );
        expect(durablePointers(env, child)).toEqual([pointerFileName(ledgerOf(grand), preferenceId(order))]);
      } else {
        // First hop: it moves whole into the child, which has room again,
        // and the parent reaches it there.
        expect(existsSync(record)).toBe(false);
        expect(readCompletionObligations(child, env, { pointers: false })).toEqual([
          expect.objectContaining({ id: preferenceId(order), transferred_from: expect.objectContaining({ agent_id: childId(0x701) }) }),
        ]);
        expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
      }
      payOwn(env, parent);
      await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
        expect(agentId).toBe(childId(0x701));
        return order;
      });
      expect(existsSync(record)).toBe(false);
      expect(readCompletionObligations(child, env)).toEqual([]);
    });
  }

  it("reaches a kept debt whose durable home was refused only while its subagent stopped, through the association that stop left (R0-2)", async () => {
    const env = testEnv();
    const parent = "f2-refused-at-stop";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(0x720));
    const child = agentLedgerIdFor(stop);
    capture(env, child, "refused-at-stop");
    withRefusedRoot(env, () => transferSubagentObligations(stop, env));
    expect(temporaryPointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    payOwn(env, parent);
    const demand = pendingCompletionRecoveryInstruction(parent, env);
    expect(demand).toContain(`second-hand from subagent ${childId(0x720)}`);
    await recoverAndComplete(env, parent, demand, (agentId) => {
      expect(agentId).toBe(childId(0x720));
      return "refused-at-stop";
    });
    expect(existsSync(join(retainedRoot(env), `${ledgerOf(child)}.obligations`))).toBe(false);
  });

  it("moves an association the exiting ledger holds up as it is, so the debts behind it reach the parent two hops on", async () => {
    const env = testEnv();
    const parent = "f2-association-hop";
    fillOwn(env, parent);
    const childStop = stopOf(parent, childId(0x721));
    const child = agentLedgerIdFor(childStop);
    const grandStop = stopOf(child, childId(0x722));
    const grand = agentLedgerIdFor(grandStop);
    capture(env, grand, "hop-a");
    capture(env, grand, "hop-b");
    withRefusedRoot(env, () => transferSubagentObligations(grandStop, env));
    expect(temporaryPointers(env, child)).toEqual([associationFileName(ledgerOf(grand))]);
    transferSubagentObligations(childStop, env);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(grand))]);
    expect(existsSync(join(retainedRoot(env), `${ledgerOf(child)}.pointers`))).toBe(false);
    expect(temporaryPointers(env, child)).toEqual([]);
    payOwn(env, parent);
    const pointed = readCompletionObligations(parent, env);
    expect(pointed.map((item) => item.id).sort()).toEqual([preferenceId("hop-a"), preferenceId("hop-b")].sort());
    for (const item of pointed) {
      expect(item).toMatchObject({ ledger: ledgerOf(grand), transferred_from: { agent_id: childId(0x722) } });
      const retrieved = await retrieve(env, { action_id: hash(item.id).slice(0, 16), ledger: item.ledger });
      expect(retrieved).toMatchObject({ status: "retrieved", provenance: "second_hand" });
      observeSuccessfulCompletionTool(parent, "record_preference", retrieved.arguments, { recorded: true }, env);
    }
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([]);
    expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
  });

  it("hands one page over per stop and leaves one association for the rest, which the parent's reads expand (R0-1, M20)", () => {
    const env = testEnv();
    const parent = "f2-one-page";
    const childStop = stopOf(parent, childId(0x760));
    const child = agentLedgerIdFor(childStop);
    const record = sealedRecord(env, "one-page");
    const keepers = keepCopies(env, record, 100, "f2-one-page-keeper");
    const childPointers = join(retainedRoot(env), `${ledgerOf(child)}.pointers`);
    mkdirSync(childPointers, { recursive: true, mode: 0o700 });
    for (const keeper of keepers) {
      writeFileSync(join(childPointers, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
    }
    fillOwn(env, parent);
    transferSubagentObligations(childStop, env);
    expect(durablePointers(env, parent)).toHaveLength(65);
    expect(durablePointers(env, parent)).toContain(associationFileName(ledgerOf(child)));
    expect(durablePointers(env, child)).toHaveLength(36);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    // Resolved where they are kept, a page at a time: the rest come through
    // the association, and it goes once the child is found empty.
    const reached = new Set();
    for (let page = 0; page < 3; page += 1) {
      for (const item of readCompletionObligations(parent, env).filter((entry) => entry.ledger)) {
        reached.add(item.ledger);
        rmSync(join(retainedRoot(env), `${item.ledger}.obligations`, recordFileName(record.id)));
      }
    }
    expect([...reached].sort()).toEqual([...keepers].sort());
    expect(readCompletionObligations(parent, env)).toHaveLength(64);
    expect(durablePointers(env, parent)).toEqual([]);
    expect(existsSync(childPointers)).toBe(false);
  });

  it("writes the association before it hands anything over, so a stop interrupted anywhere leaves the rest reachable, and removes it once all is handed over (R0-1)", () => {
    const env = testEnv();
    const parent = "f2-association-first";
    const childStop = stopOf(parent, childId(0x761));
    const child = agentLedgerIdFor(childStop);
    const record = sealedRecord(env, "association-first");
    const childPointers = join(retainedRoot(env), `${ledgerOf(child)}.pointers`);
    mkdirSync(childPointers, { recursive: true, mode: 0o700 });
    for (const keeper of keepCopies(env, record, 3, "f2-association-first-keeper")) {
      writeFileSync(join(childPointers, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
    }
    fillOwn(env, parent);
    const home = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    const written = [];
    const original = nodeFs.renameSync;
    nodeFs.renameSync = function renamed(from, to, ...rest) {
      const result = original.call(this, from, to, ...rest);
      if (dirname(String(to)) === home) written.push(basename(String(to)));
      return result;
    };
    syncBuiltinESMExports();
    try {
      transferSubagentObligations(childStop, env);
    } finally {
      nodeFs.renameSync = original;
      syncBuiltinESMExports();
    }
    expect(written).toHaveLength(4);
    expect(written[0]).toBe(associationFileName(ledgerOf(child)));
    expect(durablePointers(env, parent)).toHaveLength(3);
    expect(durablePointers(env, parent)).not.toContain(associationFileName(ledgerOf(child)));
  });

  // Per-event work of a stop whose ledger points to A kept debts (design note
  // d-a.md (d), (g); rw2-measure.mjs "nested"): one page whatever A is.
  const HAND_OVER = {
    "Claude Code and Codex": {
      1: { calls: 97, listed: 1, pointerListings: 0 },
      64: { calls: 3486, listed: 64, pointerListings: 0 },
    },
    OpenClaw: {
      1: { calls: 114, listed: 1, pointerListings: 0 },
      64: { calls: 3497, listed: 64, pointerListings: 0 },
    },
  };
  for (const [shape, options] of HOST_PATHS) for (const pointed of [1, 64, 256, 1000]) {
    describe(`an exiting ledger that points to ${pointed} (${shape})`, () => {
      const env = testEnv();
      const parent = `f2-per-event-${pointed}-${options.forward ? "forward" : "main"}`;
      const childStop = stopOf(parent, childId(0x770));
      const child = agentLedgerIdFor(childStop);
      beforeAll(() => {
        fillOwn(env, parent);
        const record = sealedRecord(env, "per-event");
        const childPointers = join(retainedRoot(env), `${ledgerOf(child)}.pointers`);
        mkdirSync(childPointers, { recursive: true, mode: 0o700 });
        for (const keeper of keepCopies(env, record, pointed, "f2-per-event-keeper")) {
          writeFileSync(join(childPointers, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
        }
      });
      it(`hands one page over when the exiting ledger points to ${pointed} kept debt(s), with work that stops growing at one page (R0-1, R0-7)`, () => {
        const event = countFilesystem(() => transferSubagentObligations(childStop, env, options));
        console.info(`F2 per-event work, ${pointed} pointed (${shape}): ${JSON.stringify(event)}`);
        expect(event).toEqual(HAND_OVER[shape][Math.min(pointed, 64)]);
        expect(durablePointers(env, parent)).toHaveLength(Math.min(pointed, 64) + (pointed >= 64 ? 1 : 0));
        expect(durablePointers(env, child)).toHaveLength(pointed - Math.min(pointed, 64));
      });
    });
  }

  it("retires the never-kept count only by a complete read: not while the durable root is refused (R0-8)", () => {
    const env = testEnv();
    const parent = "f2-no-drain-refused";
    fillOwn(env, parent);
    recordQueryFeedbackObligation(parent, { available: true, query_id: "rq_counted" }, env);
    expect(existsSync(overflowFile(env, parent))).toBe(true);
    // Its own debts are paid while the root is refused: no read is complete.
    withRefusedRoot(env, () => {
      payOwn(env, parent);
      expect(readCompletionObligations(parent, env)).toEqual([]);
      expect(existsSync(overflowFile(env, parent))).toBe(true);
    });
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
  });

  it("keeps the never-kept count while a pointed record can be neither read nor ruled out, and retires it once a read is complete (M09)", () => {
    const env = testEnv();
    const parent = "f2-undecidable";
    fillOwn(env, parent);
    recordQueryFeedbackObligation(parent, { available: true, query_id: "rq_counted" }, env);
    const record = sealedRecord(env, "undecidable");
    const [keeper] = keepCopies(env, record, 1, "f2-undecidable-keeper");
    const recordPath = join(retainedRoot(env), `${keeper}.obligations`, recordFileName(record.id));
    chmodSync(recordPath, 0o644);
    const pointers = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    mkdirSync(pointers, { recursive: true, mode: 0o700 });
    writeFileSync(join(pointers, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
    payOwn(env, parent);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(overflowFile(env, parent))).toBe(true);
    expect(durablePointers(env, parent)).toHaveLength(1);
    rmSync(recordPath);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(durablePointers(env, parent)).toEqual([]);
  });

  // A pointer fixture: one kept record (a copy of a real sealed one) and the
  // parent's pointer to it, in the given home.
  function pointerFixture(env, parent, label, home = "durable") {
    const record = sealedRecord(env, label);
    const [keeper] = keepCopies(env, record, 1, `f2-${label}-keeper`);
    const directory = home === "durable"
      ? join(retainedRoot(env), `${ledgerOf(parent)}.pointers`)
      : join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = pointerFileName(keeper, record.id);
    writeFileSync(join(directory, name), pointerText(keeper, record.id), { mode: 0o600 });
    return { record, keeper, directory, name };
  }

  it("keeps a temporary pointer to a durable record while the root is refused, and names the debt once it is usable (M08)", () => {
    const env = testEnv();
    const parent = "f2-temporary-to-durable";
    const { keeper, name } = pointerFixture(env, parent, "temporary-to-durable", "temporary");
    withRefusedRoot(env, () => {
      expect(readCompletionObligations(parent, env)).toEqual([]);
    });
    expect(temporaryPointers(env, parent)).toEqual([name]);
    expect(readCompletionObligations(parent, env)).toEqual([expect.objectContaining({ ledger: keeper })]);
  });

  it("ignores, and leaves in place, a pointer or an association whose file name is not the digest of what it names (M10)", () => {
    const env = testEnv();
    const parent = "f2-renamed";
    const { record, keeper, directory, name } = pointerFixture(env, parent, "renamed");
    const renamed = `${hash("f2-renamed-pointer").slice(0, 32)}.json`;
    const renamedAssociation = `${hash("f2-renamed-association").slice(0, 32)}.json`;
    renameSync(join(directory, name), join(directory, renamed));
    writeFileSync(
      join(directory, renamedAssociation),
      `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: keeper, transferred_from: null })}\n`,
      { mode: 0o600 },
    );
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(durablePointers(env, parent).sort()).toEqual([renamed, renamedAssociation].sort());
    expect(existsSync(join(retainedRoot(env), `${keeper}.obligations`, recordFileName(record.id)))).toBe(true);
  });

  it("keeps the hop's own pointer when no home of the parent accepts the next one, and moves it once one does (M11)", async () => {
    const env = testEnv();
    const parent = "f2-next-write-fails";
    fillOwn(env, parent);
    const childStop = stopOf(parent, childId(0x730));
    const child = agentLedgerIdFor(childStop);
    fillOwn(env, child);
    const grandStop = stopOf(child, childId(0x731));
    capture(env, agentLedgerIdFor(grandStop), "next-write-fails");
    transferSubagentObligations(grandStop, env);
    const own = durablePointers(env, child);
    expect(own).toHaveLength(1);
    const blocked = [
      join(retainedRoot(env), `${ledgerOf(parent)}.pointers`),
      join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`),
    ];
    for (const path of blocked) writeFileSync(path, "x", { mode: 0o600 });
    transferSubagentObligations(childStop, env);
    expect(durablePointers(env, child)).toEqual(own);
    for (const path of blocked) rmSync(path);
    transferSubagentObligations(childStop, env);
    expect(durablePointers(env, child)).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([pointerFileName(ledgerOf(agentLedgerIdFor(grandStop)), preferenceId("next-write-fails"))]);
    payOwn(env, parent);
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x731));
      return "next-write-fails";
    });
  });

  it("shows a pointer present in both homes once (M14)", () => {
    const env = testEnv();
    const parent = "f2-both-homes";
    const { keeper, directory, name } = pointerFixture(env, parent, "both-homes");
    const temporary = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    writeFileSync(join(temporary, name), readFileSync(join(directory, name), "utf8"), { mode: 0o600 });
    expect(readCompletionObligations(parent, env)).toEqual([expect.objectContaining({ ledger: keeper })]);
    expect(handlesIn(pendingCompletionRecoveryInstruction(parent, env))).toHaveLength(1);
  });

  it("examines at most 256 entries per read however many undecidable pointers lie ahead of a live one (M15)", () => {
    const env = testEnv();
    const parent = "f2-scan-bound";
    const record = sealedRecord(env, "scan-bound");
    const keepers = keepCopies(env, record, 257, "f2-scan-bound-keeper");
    const temporary = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`);
    const durable = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    for (const directory of [temporary, durable]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [index, keeper] of keepers.entries()) {
      if (index < 256) chmodSync(join(retainedRoot(env), `${keeper}.obligations`, recordFileName(record.id)), 0o644);
      writeFileSync(join(index < 256 ? temporary : durable, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
    }
    let page;
    const counts = countFilesystem(() => {
      page = readCompletionObligations(parent, env);
    });
    expect(page).toEqual([]);
    expect(counts).toMatchObject({ listed: 256, pointerListings: 0 });
  });

  it("removes the temporary pointer when its debt is declined while the durable root is refused (M18)", () => {
    const env = testEnv();
    const parent = "f2-decline-refused";
    ensureKey(env);
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(0x740));
    const child = ledgerOf(agentLedgerIdFor(stop));
    const id = preferenceId("decline-refused");
    withRefusedRoot(env, () => {
      capture(env, agentLedgerIdFor(stop), "decline-refused");
      transferSubagentObligations(stop, env);
      expect(temporaryPointers(env, parent).sort()).toEqual([pointerFileName(child, id), associationFileName(child)].sort());
      observeSuccessfulCompletionTool(parent, "decline_pending_action", { action_id: hash(id).slice(0, 16), reason: "not_reusable" }, { declined: true }, env);
      expect(temporaryPointers(env, parent)).toEqual([associationFileName(child)]);
    });
    payOwn(env, parent);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(temporaryPointers(env, parent)).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([]);
  });

  it("never lists the durable pointer home through a refused root (M21)", () => {
    const env = testEnv();
    const parent = "f2-linked-home";
    const { keeper } = pointerFixture(env, parent, "linked-home");
    withRefusedRoot(env, () => {
      let page;
      const counts = countFilesystem(() => {
        page = readCompletionObligations(parent, env);
      });
      expect(page).toEqual([]);
      expect(counts.listed).toBe(0);
    });
    expect(readCompletionObligations(parent, env)).toEqual([expect.objectContaining({ ledger: keeper })]);
  });

  it("removes nothing through a pointer directory that is a link: the decoy behind it survives completion (R0-9)", async () => {
    const env = testEnv();
    const parent = "f2-linked-pointer-dir";
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(0x750));
    const child = ledgerOf(agentLedgerIdFor(stop));
    capture(env, agentLedgerIdFor(stop), "linked-pointer-dir");
    const name = pointerFileName(child, preferenceId("linked-pointer-dir"));
    const outside = `${env.XDG_STATE_HOME}-decoys`;
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, name), "decoy\n", { mode: 0o600 });
    symlinkSync(outside, join(retainedRoot(env), `${ledgerOf(parent)}.pointers`));
    transferSubagentObligations(stop, env);
    expect(temporaryPointers(env, parent)).toEqual([name]);
    payOwn(env, parent);
    const [handle] = handlesIn(pendingCompletionRecoveryInstruction(parent, env));
    const retrieved = await retrieve(env, handle);
    observeSuccessfulCompletionTool(parent, "record_preference", retrieved.arguments, { recorded: true }, env);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(temporaryPointers(env, parent)).toEqual([]);
    expect(readdirSync(outside)).toEqual([name]);
    expect(readFileSync(join(outside, name), "utf8")).toBe("decoy\n");
  });

  it("removes nothing through a record directory that is a link: the decoy behind it survives completion (R0-9)", async () => {
    const env = testEnv();
    const parent = "f2-linked-record-dir";
    ensureKey(env);
    fillOwn(env, parent);
    const stop = stopOf(parent, childId(0x751));
    const child = ledgerOf(agentLedgerIdFor(stop));
    const name = recordFileName(preferenceId("linked-record-dir"));
    const outside = `${env.XDG_STATE_HOME}-record-decoys`;
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, name), "decoy\n", { mode: 0o600 });
    mkdirSync(retainedRoot(env), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(retainedRoot(env), `${child}.obligations`));
    capture(env, agentLedgerIdFor(stop), "linked-record-dir");
    transferSubagentObligations(stop, env);
    payOwn(env, parent);
    const [handle] = handlesIn(pendingCompletionRecoveryInstruction(parent, env));
    expect(handle?.ledger).toBe(child);
    const retrieved = await retrieve(env, handle);
    expect(retrieved).toMatchObject({ status: "retrieved", arguments: preference("linked-record-dir") });
    observeSuccessfulCompletionTool(parent, "record_preference", retrieved.arguments, { recorded: true }, env);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(readdirSync(outside)).toEqual([name]);
    expect(readFileSync(join(outside, name), "utf8")).toBe("decoy\n");
  });
  // Nested hand-overs, two hooks at once: only on OpenClaw's path (`forward`)
  // does a subagent's ledger receive from its own subagent; Claude Code and
  // Codex hand every subagent's debts to the main session's ledger.
  it("keeps a nested kept debt reachable from the parent when it lands in an intermediate ledger while that ledger hands over (R0-3, D2(ii))", async () => {
    const env = testEnv();
    const parent = "f2-race-parent";
    fillOwn(env, parent);
    const childStop = stopOf(parent, childId(0x790));
    const child = agentLedgerIdFor(childStop);
    fillOwn(env, child);
    const grandStop = stopOf(child, childId(0x791));
    const grand = agentLedgerIdFor(grandStop);
    capture(env, grand, "race");
    // The grandchild's stop hands into the child; just before anything of it
    // lands there, the child's own stop runs to its end.
    const childHome = join(retainedRoot(env), `${ledgerOf(child)}.pointers`);
    const original = nodeFs.renameSync;
    let armed = true;
    nodeFs.renameSync = function renamed(from, to, ...rest) {
      if (armed && dirname(String(to)) === childHome) {
        armed = false;
        transferSubagentObligations(childStop, env, { forward: true });
      }
      return original.call(this, from, to, ...rest);
    };
    syncBuiltinESMExports();
    try {
      transferSubagentObligations(grandStop, env, { forward: true });
    } finally {
      nodeFs.renameSync = original;
      syncBuiltinESMExports();
    }
    expect(armed).toBe(false);
    // The child had room by then: the record moved whole into its exited
    // ledger, and the parent, where the child went, reaches it there.
    expect(readCompletionObligations(child, env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("race") }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    payOwn(env, parent);
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x791));
      return "race";
    });
  });

  it("writes nothing at all when a subagent that left nothing stops on Claude Code's or Codex's path (R1-6)", () => {
    const env = testEnv();
    const childStop = stopOf("f2-empty-stop-main", childId(0x7a2));
    expect(transferSubagentObligations(childStop, env)).toBe(0);
    expect(transferSubagentObligations({ ...childStop, hook_event_name: "StopFailure" }, env)).toBe(0);
    expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
    expect(listed(env.REMEMBRANCE_USAGE_DIR)).toEqual([]);
  });

  it("writes only its forwarding marker when a subagent that left nothing stops on OpenClaw's path: no association and no directory for the parent, and a later nested stop still reaches the parent (R1-2)", async () => {
    const env = testEnv();
    const parent = "f2-empty-stop";
    const childStop = stopOf(parent, childId(0x7a0));
    const child = agentLedgerIdFor(childStop);
    transferSubagentObligations(childStop, env, { forward: true });
    transferSubagentObligations(childStop, env, { forward: true });
    expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
    expect(readdirSync(env.REMEMBRANCE_USAGE_DIR)).toEqual([`${ledgerOf(child)}.forward.json`]);
    // The grandchild's first stop comes after the child's: its kept debt
    // lands in the child's ledger, the one it names, and the parent, where
    // the child's marker leads, gets an association to it.
    const grandStop = stopOf(child, childId(0x7a1));
    capture(env, agentLedgerIdFor(grandStop), "empty-stop");
    transferSubagentObligations(grandStop, env, { forward: true });
    expect(readCompletionObligations(child, env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("empty-stop") }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x7a1));
      return "empty-stop";
    });
  });

  it("reaches a nested kept debt that lands in an intermediate ledger which left nothing and handed over meanwhile (D2(ii))", async () => {
    const env = testEnv();
    const parent = "f2-empty-race-parent";
    fillOwn(env, parent);
    const childStop = stopOf(parent, childId(0x7b0));
    const child = agentLedgerIdFor(childStop);
    const grandStop = stopOf(child, childId(0x7b1));
    capture(env, agentLedgerIdFor(grandStop), "empty-race");
    // The grandchild's stop hands into the child, which holds nothing; just
    // before the child's pointer home is made, the child's own stop runs.
    const childHome = join(retainedRoot(env), `${ledgerOf(child)}.pointers`);
    const original = nodeFs.mkdirSync;
    let armed = true;
    nodeFs.mkdirSync = function made(path, ...rest) {
      if (armed && String(path) === childHome) {
        armed = false;
        transferSubagentObligations(childStop, env, { forward: true });
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      transferSubagentObligations(grandStop, env, { forward: true });
    } finally {
      nodeFs.mkdirSync = original;
      syncBuiltinESMExports();
    }
    expect(armed).toBe(false);
    expect(readCompletionObligations(child, env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("empty-race") }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    payOwn(env, parent);
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x7b1));
      return "empty-race";
    });
  });

  it("hands into the ledger it names and follows at most 8 forwarding markers from there, leaving an association where the last one leads (R0-3, D2(ii))", async () => {
    const env = testEnv();
    const chain = Array.from({ length: 10 }, (_, index) => `f2-chain-${index}`);
    mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(
        join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(chain[index])}.forward.json`),
        `${JSON.stringify({ version: "completion-obligation-forward-v1", ledger: ledgerOf(chain[index + 1]), transferred_from: null })}\n`,
        { mode: 0o600 },
      );
    }
    const stop = stopOf(chain[0], childId(0x780));
    capture(env, agentLedgerIdFor(stop), "chain");
    transferSubagentObligations(stop, env, { forward: true });
    // The debt lands in the first ledger; eight hops from there lead to the
    // ninth, which still forwards: it gets the association, the tenth and
    // every ledger between nothing.
    expect(readCompletionObligations(chain[0], env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("chain"), transferred_from: expect.objectContaining({ agent_id: childId(0x780) }) }),
    ]);
    expect(durablePointers(env, chain[8])).toEqual([associationFileName(ledgerOf(chain[0]))]);
    for (const ledger of [...chain.slice(1, 8), chain[9]]) expect(durablePointers(env, ledger)).toEqual([]);
    await recoverAndComplete(env, chain[8], pendingCompletionRecoveryInstruction(chain[8], env), (agentId) => {
      expect(agentId).toBe(childId(0x780));
      return "chain";
    });
  });

  it("reads a forwarding marker and an association that name a 256-character agent id and the longest transcript path, the association with OpenClaw's flag, within the 1024-byte bound (R1-7, R2-3)", async () => {
    const env = testEnv();
    const parent = "f2-largest-parent";
    const agentId = `c${"a".repeat(255)}`;
    const transcript = `/${"p".repeat(511)}`;
    const childStop = { ...stopOf(parent, agentId), agent_transcript_path: transcript };
    const child = agentLedgerIdFor(childStop);
    transferSubagentObligations(childStop, env, { forward: true });
    const grandStop = stopOf(child, childId(0x7f0));
    capture(env, agentLedgerIdFor(grandStop), "largest");
    transferSubagentObligations(grandStop, env, { forward: true });
    const marker = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(child)}.forward.json`);
    const association = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`, associationFileName(ledgerOf(child)));
    for (const path of [marker, association]) {
      expect(JSON.parse(readFileSync(path, "utf8")).transferred_from).toEqual({ agent_id: agentId, transcript_path: transcript });
      console.info(`F2 largest ${basename(path)}: ${statSync(path).size} bytes`);
      expect(statSync(path).size).toBeGreaterThan(890);
      expect(statSync(path).size).toBeLessThanOrEqual(1024);
    }
    expect(JSON.parse(readFileSync(association, "utf8")).forwarded).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8"))).not.toHaveProperty("forwarded");
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (id) => {
      expect(id).toBe(childId(0x7f0));
      return "largest";
    });
  });

  // The OpenClaw copy's suite runs the same check (test/hook-core.test.mjs).
  it("skips an association and a forwarding marker one byte past the 1,024-byte bound, so nothing behind them is named and nothing is drained or removed, and follows both at exactly 1,024 bytes (R2-1)", () => {
    checkPointerBound({
      agentLedgerIdFor,
      readCompletionObligations,
      recordQueryFeedbackObligation,
      transferSubagentObligations,
    });
  });

  // R-W2 round 2 R2-5: a sealed record its keeper keeps in the temporary
  // home (its durable write failed) is moved to the durable home by any read
  // that finds it there while the durable root is usable, not only by its
  // keeper's own read, which an ended subagent's ledger never gets again.
  // Each read below reaches it one way only: through a pointer, then through
  // an association.
  for (const way of ["pointer", "association"]) {
  it(`moves a sealed record its keeper keeps in the temporary home to the durable home when a read finds it through ${way === "pointer" ? "a pointer" : "an association"}, so temporary-directory cleanup afterwards loses nothing (R2-5)`, async () => {
    const env = testEnv();
    const parent = `f2-temporary-${way}-parent`;
    const keeper = `f2-temporary-${way}-keeper`;
    const value = `temporary-${way}`;
    const subagent = childId(way === "pointer" ? 0x8c0 : 0x8c1);
    capture(env, keeper, value);
    const id = preferenceId(value);
    const name = recordFileName(id);
    const durable = join(retainedRoot(env), `${ledgerOf(keeper)}.obligations`);
    const temporary = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(keeper)}.obligations`);
    // Kept in the temporary home only, as when the durable write failed.
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    renameSync(join(durable, name), join(temporary, name));
    const pointers = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    mkdirSync(pointers, { recursive: true, mode: 0o700 });
    if (way === "pointer") {
      // Named second-hand as a hand-over names it, and pointed to.
      tagRecord(join(temporary, name), subagent);
      writeFileSync(
        join(pointers, pointerFileName(ledgerOf(keeper), id)),
        pointerText(ledgerOf(keeper), id),
        { mode: 0o600 },
      );
    } else {
      // An association naming the subagent; the read names the record after it.
      writeFileSync(
        join(pointers, associationFileName(ledgerOf(keeper))),
        `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: ledgerOf(keeper), transferred_from: { agent_id: subagent, transcript_path: null } })}\n`,
        { mode: 0o600 },
      );
    }
    expect(listed(durable)).toEqual([]);

    expect(readCompletionObligations(parent, env)).toEqual([
      expect.objectContaining({ id, ledger: ledgerOf(keeper) }),
    ]);
    expect(listed(temporary)).toEqual([]);
    expect(listed(durable)).toEqual([name]);
    expect(modeOf(join(durable, name))).toBe(0o600);

    // A temporary-directory cleanup (or a reboot) afterwards.
    rmSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, force: true });
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(subagent);
      return value;
    });
  });
  }

  // The move needs a usable durable root: a pointer read while the root is
  // refused names the record from the temporary home and writes nothing
  // through the link (R2-5).
  it("writes nothing through a refused durable root when a pointer read finds a sealed record in its keeper's temporary home, and moves it there once the root is usable (R2-5)", async () => {
    const env = testEnv();
    const parent = "f2-temporary-refused-parent";
    const keeper = "f2-temporary-refused-keeper";
    const value = "temporary-refused";
    capture(env, keeper, value);
    const id = preferenceId(value);
    const name = recordFileName(id);
    const durable = join(retainedRoot(env), `${ledgerOf(keeper)}.obligations`);
    const temporary = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(keeper)}.obligations`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    renameSync(join(durable, name), join(temporary, name));
    tagRecord(join(temporary, name), childId(0x8c2));
    // The pointer in the parent's temporary home, as a stop writes it while
    // the durable root is refused.
    const pointers = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.pointers`);
    mkdirSync(pointers, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pointers, pointerFileName(ledgerOf(keeper), id)),
      pointerText(ledgerOf(keeper), id),
      { mode: 0o600 },
    );
    withRefusedRoot(env, () => {
      const behind = snapshotTree([`${retainedRoot(env)}-real`]);
      expect(readCompletionObligations(parent, env)).toEqual([
        expect.objectContaining({ id, ledger: ledgerOf(keeper) }),
      ]);
      expect(snapshotTree([`${retainedRoot(env)}-real`])).toEqual(behind);
      expect(listed(temporary)).toEqual([name]);
    });

    expect(readCompletionObligations(parent, env)).toEqual([
      expect.objectContaining({ id, ledger: ledgerOf(keeper) }),
    ]);
    expect(listed(temporary)).toEqual([]);
    expect(listed(durable)).toEqual([name]);
    rmSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, force: true });
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x8c2));
      return value;
    });
  });

  // Only a sealed record moves: a record without a payload (kept while no
  // key could seal it) stays in the temporary home, as at 639298f2, also
  // when a hand-over's holder check finds it there (R2-5).
  it("leaves a parent's record without a payload in the temporary home when a subagent hands over a sealed record of the same id, and points the parent to that one (R2-5)", () => {
    const env = testEnv();
    const parent = "f2-temporary-unsealed-parent";
    const value = "temporary-unsealed";
    withRefusedRoot(env, () => capture(env, parent, value));
    const id = preferenceId(value);
    const name = recordFileName(id);
    const own = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.obligations`);
    expect(listed(own)).toEqual([name]);
    expect(JSON.parse(readFileSync(join(own, name), "utf8")).local_resupply_envelope ?? null).toBeNull();
    const stop = stopOf(parent, childId(0x8c3));
    const child = agentLedgerIdFor(stop);
    capture(env, child, value);

    transferSubagentObligations(stop, env);

    expect(listed(own)).toEqual([name]);
    expect(listed(join(retainedRoot(env), `${ledgerOf(parent)}.obligations`))).toEqual([]);
    expect(durablePointers(env, parent)).toEqual([pointerFileName(ledgerOf(child), id)]);
    expect(
      readCompletionObligations(parent, env).map((item) => [
        item.id,
        item.ledger ?? null,
        Boolean(item.local_resupply_envelope),
      ]),
    ).toEqual([
      [id, null, false],
      [id, ledgerOf(child), true],
    ]);
  });

  // A private hint waiting on this machine shows in every ledger's page but
  // is held per machine, not in the exiting ledger's homes: it must not stop
  // the re-check from looking at them.
  for (const hint of [false, true]) {
  it(`writes the association back when a nested stop reaches the exiting ledger just before that ledger removes its association${hint ? ", also while a private hint waits on this machine" : ""} (R1-4)`, async () => {
    const env = testEnv();
    const parent = `f2-race-removal-parent${hint ? "-hint" : ""}`;
    for (let index = 0; index < 3; index += 1) {
      recordQueryFeedbackObligation(parent, { available: true, query_id: `rq_own_${index}` }, env);
    }
    const childStop = stopOf(parent, childId(0x7c0));
    const child = agentLedgerIdFor(childStop);
    recordQueryFeedbackObligation(child, { available: true, query_id: "rq_own_child" }, env);
    const draft = { draft_id: "pld_racehint0001", state: "ready" };
    if (hint) {
      expect(recordPrivateLessonObligation(child, { body: draft }, env)).toMatchObject({ kind: "private_lesson" });
    }
    const grandStop = stopOf(child, childId(0x7c1));
    capture(env, agentLedgerIdFor(grandStop), "race-removal");
    // The child's stop has handed its page over and removes the parent's
    // association to it; just before that, the grandchild's whole stop runs
    // (probe-r1-orderings.mts race-removal).
    const association = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`, associationFileName(ledgerOf(child)));
    const original = nodeFs.rmSync;
    let armed = true;
    nodeFs.rmSync = function removed(path, ...rest) {
      if (armed && String(path) === association) {
        armed = false;
        transferSubagentObligations(grandStop, env, { forward: true });
      }
      return original.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      transferSubagentObligations(childStop, env, { forward: true });
    } finally {
      nodeFs.rmSync = original;
      syncBuiltinESMExports();
    }
    expect(armed).toBe(false);
    expect(readCompletionObligations(child, env, { pointers: false }).filter((item) => item.kind !== "private_lesson")).toEqual([
      expect.objectContaining({ id: preferenceId("race-removal") }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    if (hint) {
      observeSuccessfulCompletionTool(parent, "submit_private_lesson_candidate", { draft_id: draft.draft_id }, { body: { accepted_private_candidate: true } }, env);
    }
    payOwn(env, parent);
    await recoverAndComplete(env, parent, pendingCompletionRecoveryInstruction(parent, env), (agentId) => {
      expect(agentId).toBe(childId(0x7c1));
      return "race-removal";
    });
  });
  }

  it("deletes nothing, and writes nothing into the exiting ledger, when forwarding markers lead back to it (R1-3, X17)", () => {
    const env = testEnv();
    const parent = "f2-cycle-parent";
    const other = "f2-cycle-other";
    const stop = stopOf(parent, childId(0x7d0));
    const child = agentLedgerIdFor(stop);
    capture(env, child, "cycle");
    recordQueryFeedbackObligation(child, { available: true, query_id: "rq_cycle" }, env);
    // Markers no host order writes: the parent forwards to another ledger,
    // which forwards to the exiting one; the stop adds the exiting ledger's
    // own, back to the parent.
    mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
    for (const [from, to] of [[parent, other], [other, child]]) {
      writeFileSync(
        join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(from)}.forward.json`),
        `${JSON.stringify({ version: "completion-obligation-forward-v1", ledger: ledgerOf(to), transferred_from: null })}\n`,
        { mode: 0o600 },
      );
    }
    expect(transferSubagentObligations(stop, env, { forward: true })).toBe(2);
    expect(readCompletionObligations(parent, env).map((item) => item.kind).sort()).toEqual([
      "capture_next_action",
      "query_feedback",
    ]);
    // The onward association stops before the exiting ledger.
    expect(readCompletionObligations(child, env)).toEqual([]);
    expect(durablePointers(env, child)).toEqual([]);
    expect(temporaryPointers(env, child)).toEqual([]);
    expect(durablePointers(env, other)).toEqual([associationFileName(ledgerOf(parent))]);
  });

  // An association written as a hand-over writes it.
  function associate(env, holder, target) {
    const directory = join(retainedRoot(env), `${ledgerOf(holder)}.pointers`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, associationFileName(ledgerOf(target))),
      `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: ledgerOf(target), transferred_from: null })}\n`,
      { mode: 0o600 },
    );
  }

  // A read expands associations at most 8 deep (COMPLETION_HOP_LIMIT); one it
  // cannot expand leaves the read incomplete, so the never-kept count stays.
  for (const [depth, named] of [[2, true], [8, true], [9, false]]) {
    it(`${named ? "names" : "leaves unnamed, with the never-kept count kept,"} a kept debt behind ${depth} associations (R1-3, ${named ? "X11" : "X10"})`, () => {
      const env = testEnv();
      const chain = Array.from({ length: depth + 1 }, (_, index) => `f2-depth-${depth}-${index}`);
      capture(env, chain[depth], `depth-${depth}`);
      for (let index = 0; index < depth; index += 1) associate(env, chain[index], chain[index + 1]);
      fillOwn(env, chain[0]);
      recordQueryFeedbackObligation(chain[0], { available: true, query_id: "rq_counted" }, env);
      payOwn(env, chain[0]);
      const shown = readCompletionObligations(chain[0], env);
      const handles = handlesIn(pendingCompletionRecoveryInstruction(chain[0], env));
      if (named) {
        expect(shown).toEqual([expect.objectContaining({ id: preferenceId(`depth-${depth}`), ledger: ledgerOf(chain[depth]) })]);
        expect(handles).toEqual([{ action_id: hash(preferenceId(`depth-${depth}`)).slice(0, 16), ledger: ledgerOf(chain[depth]) }]);
      } else {
        expect(shown).toEqual([]);
        expect(handles).toEqual([]);
      }
      expect(existsSync(overflowFile(env, chain[0]))).toBe(true);
      expect(durablePointers(env, chain[0])).toEqual([associationFileName(ledgerOf(chain[1]))]);
    });
  }

  // One read through 64 associations, each to a ledger whose own temporary
  // home holds 300 files that are not records (a writer's leftovers) and
  // whose durable one holds one record: the read's one 256-entry budget
  // covers every home it lists, through every association, and no home is
  // listed whole (probe-assoc-reads.mjs budget).
  describe("64 associations to ledgers with 300 leftover files each", () => {
    const env = testEnv();
    const parent = "f2-association-budget";
    beforeAll(() => {
      for (let index = 0; index < 64; index += 1) {
        const keeper = `f2-association-budget-${index}`;
        capture(env, keeper, `budget-${index}`);
        associate(env, parent, keeper);
        const own = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(keeper)}.obligations`);
        mkdirSync(own, { recursive: true, mode: 0o700 });
        for (let leftover = 0; leftover < 300; leftover += 1) {
          writeFileSync(join(own, `.leftover-${leftover}.partial`), "x", { mode: 0o600 });
        }
      }
    });
    it("examines 256 entries in one read, whichever homes they are in, and shows the one record they reach (R1-3, X03, X12, X13)", () => {
      let shown;
      const read = countFilesystem(() => {
        shown = readCompletionObligations(parent, env);
      });
      console.info(`F2 association budget: ${JSON.stringify(read)}`);
      expect(shown).toHaveLength(1);
      expect(read).toEqual({ calls: 289, listed: 256, pointerListings: 0 });
      expect(durablePointers(env, parent)).toHaveLength(64);
    });
  });

  it("folds into the ledger it names, never past it, when that ledger and the one it went to have handed over (R1-1)", () => {
    const env = testEnv();
    const turn = "f2-fold-named-turn";
    const session = "f2-fold-named-session";
    const onward = "f2-fold-named-onward";
    const further = "f2-fold-named-further";
    mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
    for (const [from, to] of [[session, onward], [onward, further]]) {
      writeFileSync(
        join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(from)}.forward.json`),
        `${JSON.stringify({ version: "completion-obligation-forward-v1", ledger: ledgerOf(to), transferred_from: null })}\n`,
        { mode: 0o600 },
      );
    }
    capture(env, turn, "fold-named");
    recordQueryFeedbackObligation(turn, { available: true, query_id: "rq_fold_named" }, env);
    // OpenClaw's fold of a subagent's session ledger (`forward`).
    expect(foldTurnLedgerIntoSession({ session_id: session, turn_id: turn }, env, { forward: true })).toBe(2);
    expect(readCompletionObligations(session, env, { pointers: false }).map((item) => item.kind).sort()).toEqual([
      "capture_next_action",
      "query_feedback",
    ]);
    expect(readCompletionObligations(onward, env, { pointers: false })).toEqual([]);
    expect(readCompletionObligations(further, env, { pointers: false })).toEqual([]);
    // Where the session's markers lead, one association reaches them.
    expect(durablePointers(env, onward)).toEqual([]);
    expect(durablePointers(env, further)).toEqual([associationFileName(ledgerOf(session))]);
  });

  it("gives a session that handed over its debts back when it runs again: its marker becomes a released one, content-free, and nothing else is written or removed; the association to it above goes at the next read there (R1-1, R2-3, R4C-1)", () => {
    const env = testEnv();
    // OpenClaw's shape (index.mjs passSubagentDebts): a subagent's session
    // ledger folds into its agent ledger, which hands over to the session
    // that started it.
    const parent = "f2-release-parent";
    const childSession = "f2-release-child-session";
    const handoff = stopOf(parent, childId(0x7e0));
    recordQueryFeedbackObligation(childSession, { available: true, query_id: "rq_release" }, env);
    foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(handoff), turn_id: childSession }, env, { forward: true });
    transferSubagentObligations(handoff, env, { forward: true });
    // Its own subagent ends after it: the debt lands in its session ledger,
    // and the parent, where its markers lead, gets an association to it.
    const grandSession = "f2-release-grand-session";
    const grandHandoff = stopOf(childSession, childId(0x7e1));
    capture(env, grandSession, "release");
    foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(grandHandoff), turn_id: grandSession }, env, { forward: true });
    transferSubagentObligations(grandHandoff, env, { forward: true });
    expect(readCompletionObligations(childSession, env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("release"), transferred_from: expect.objectContaining({ agent_id: childId(0x7e1) }) }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(childSession))]);
    expect(readCompletionObligations(parent, env).map((item) => item.kind).sort()).toEqual([
      "capture_next_action",
      "query_feedback",
    ]);
    // Its session runs again: what reached it is its own to settle again.
    // The release writes its marker and nothing else (R4C-1): the parent's
    // association stays until the parent's next read, which leaves the debt
    // to the session that runs again and removes it.
    const roots = [retainedRoot(env), env.REMEMBRANCE_USAGE_DIR];
    const marker = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(childSession)}.forward.json`);
    const before = snapshotTree(roots);
    expect(releaseCompletionForward(childSession, env)).toBe(true);
    const after = snapshotTree(roots);
    expect(after[marker]).toBe(`${JSON.stringify({ version: "completion-obligation-released-v1" })}\n`);
    expect({ ...after, [marker]: before[marker] }).toEqual(before);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(childSession))]);
    expect(readCompletionObligations(parent, env).map((item) => item.kind)).toEqual(["query_feedback"]);
    expect(durablePointers(env, parent)).toEqual([]);
    expect(readCompletionObligations(childSession, env).map((item) => item.kind)).toEqual(["capture_next_action"]);
    expect(releaseCompletionForward(childSession, env)).toBe(false);
  });

  it("asks one session at a time when sessions in between run again: the top's read leaves a debt kept below to the session that runs again and drops its association, and that session's next end hands it to the session above it, which runs again too (R1-1, deeper nesting, R2-3)", () => {
    const env = testEnv();
    // OpenClaw's shape three levels down (index.mjs passSubagentDebts):
    // top > p > c > g, each end a fold and a transfer with `forward`.
    const top = "f2-deep-top";
    const pSession = "f2-deep-p-session";
    const cSession = "f2-deep-c-session";
    const gSession = "f2-deep-g-session";
    const end = (requester, agentId, session) => {
      const handoff = stopOf(requester, agentId);
      foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(handoff), turn_id: session }, env, { forward: true });
      transferSubagentObligations(handoff, env, { forward: true });
    };
    const queries = (ledger) => readCompletionObligations(ledger, env).map((item) => item.query_id).sort();
    recordQueryFeedbackObligation(pSession, { available: true, query_id: "rq_deep_p" }, env);
    end(top, childId(0x7f2), pSession);
    end(pSession, childId(0x7f3), cSession);
    recordQueryFeedbackObligation(gSession, { available: true, query_id: "rq_deep_g" }, env);
    end(cSession, childId(0x7f4), gSession);
    // g's debt lands in c's session; c's markers lead past p to the top.
    expect(queries(cSession)).toEqual(["rq_deep_g"]);
    expect(durablePointers(env, top)).toEqual([associationFileName(ledgerOf(cSession))]);
    // p's session runs again first, then c's: c's markers now end at p, so
    // the association at the top stays until the top's next read, which
    // leaves g's debt to c's session (its marker is released) and drops it:
    // only c's session is asked.
    expect(releaseCompletionForward(pSession, env)).toBe(true);
    expect(releaseCompletionForward(cSession, env)).toBe(true);
    expect(durablePointers(env, top)).toEqual([associationFileName(ledgerOf(cSession))]);
    expect(queries(top)).toEqual(["rq_deep_p"]);
    expect(durablePointers(env, top)).toEqual([]);
    expect(queries(cSession)).toEqual(["rq_deep_g"]);
    // c's next end hands it up to p's session, which runs again and owns it.
    end(pSession, childId(0x7f3), cSession);
    expect(queries(pSession)).toEqual(["rq_deep_g"]);
    expect(queries(top)).toEqual(["rq_deep_p"]);
    expect(durablePointers(env, top)).toEqual([]);
  });

  it("leaves the session ledger's marker when OpenClaw folds a subagent session that holds nothing, so a nested end after it still reaches the parent (R1-2)", () => {
    const env = testEnv();
    const parent = "f2-empty-fold-parent";
    const childSession = "f2-empty-fold-child-session";
    const handoff = stopOf(parent, childId(0x7f0));
    // The subagent left nothing: OpenClaw folds its empty session ledger into
    // its agent ledger and transfers that, both with `forward`.
    expect(
      foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(handoff), turn_id: childSession }, env, { forward: true }),
    ).toBe(0);
    transferSubagentObligations(handoff, env, { forward: true });
    expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
    expect(readdirSync(env.REMEMBRANCE_USAGE_DIR).sort()).toEqual(
      [`${ledgerOf(childSession)}.forward.json`, `${ledgerOf(agentLedgerIdFor(handoff))}.forward.json`].sort(),
    );
    // Its own subagent ends after it, and its session never runs again: the
    // debt lands in its session ledger, and the parent, where its markers
    // lead, gets an association to it.
    const grandSession = "f2-empty-fold-grand-session";
    const grandHandoff = stopOf(childSession, childId(0x7f1));
    capture(env, grandSession, "empty-fold");
    foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(grandHandoff), turn_id: grandSession }, env, { forward: true });
    transferSubagentObligations(grandHandoff, env, { forward: true });
    expect(readCompletionObligations(childSession, env, { pointers: false })).toEqual([
      expect.objectContaining({ id: preferenceId("empty-fold"), transferred_from: expect.objectContaining({ agent_id: childId(0x7f1) }) }),
    ]);
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(childSession))]);
    expect(readCompletionObligations(parent, env).map((item) => item.kind)).toEqual(["capture_next_action"]);
  });

  it("keeps the never-kept count while an association leads to a record that cannot be read, and retires it once a read is complete (D1)", () => {
    const env = testEnv();
    const parent = "f2-association-undecidable";
    fillOwn(env, parent);
    recordQueryFeedbackObligation(parent, { available: true, query_id: "rq_counted" }, env);
    const record = sealedRecord(env, "association-undecidable");
    const [keeper] = keepCopies(env, record, 1, "f2-association-undecidable-keeper");
    const recordPath = join(retainedRoot(env), `${keeper}.obligations`, recordFileName(record.id));
    chmodSync(recordPath, 0o644);
    const pointers = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    mkdirSync(pointers, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pointers, associationFileName(keeper)),
      `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: keeper, transferred_from: null })}\n`,
      { mode: 0o600 },
    );
    payOwn(env, parent);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(overflowFile(env, parent))).toBe(true);
    expect(durablePointers(env, parent)).toEqual([associationFileName(keeper)]);
    chmodSync(recordPath, 0o600);
    expect(readCompletionObligations(parent, env)).toEqual([expect.objectContaining({ id: record.id, ledger: keeper })]);
    rmSync(recordPath);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(overflowFile(env, parent))).toBe(false);
    expect(durablePointers(env, parent)).toEqual([]);
  });
  it("keeps a turn's count with its debts while the session can neither take them nor hold an association to the turn (M13)", () => {
    const env = testEnv();
    const session = "f2-fold-blocked";
    const turn = "f2-fold-blocked-turn";
    fillOwn(env, turn);
    recordQueryFeedbackObligation(turn, { available: true, query_id: "rq_counted" }, env);
    expect(existsSync(overflowFile(env, turn))).toBe(true);
    mkdirSync(retainedRoot(env), { recursive: true, mode: 0o700 });
    const blocked = [
      join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(session)}.obligations`),
      join(retainedRoot(env), `${ledgerOf(session)}.pointers`),
      join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(session)}.pointers`),
    ];
    for (const path of blocked) writeFileSync(path, "x", { mode: 0o600 });
    foldTurnLedgerIntoSession({ session_id: session, turn_id: turn }, env);
    expect(readCompletionObligations(turn, env)).toHaveLength(64);
    expect(existsSync(overflowFile(env, turn))).toBe(true);
    expect(existsSync(overflowFile(env, session))).toBe(false);
    for (const path of blocked) rmSync(path);
    foldTurnLedgerIntoSession({ session_id: session, turn_id: turn }, env);
    expect(readCompletionObligations(turn, env)).toEqual([]);
    expect(readCompletionObligations(session, env)).toHaveLength(64);
    expect(existsSync(overflowFile(env, turn))).toBe(false);
    expect(JSON.parse(readFileSync(overflowFile(env, session), "utf8")).count).toBe(1);
  });

  // Brief :29 (U5): a never-kept count whose own write fails. Its path is
  // refused (a directory stands where the count goes, as when the usage
  // directory refuses that write), then usable again.
  const refuseCount = (env, ledgerId) =>
    mkdirSync(overflowFile(env, ledgerId), { recursive: true, mode: 0o700 });
  const allowCount = (env, ledgerId) =>
    rmSync(overflowFile(env, ledgerId), { recursive: true, force: true });
  const countOf = (env, ledgerId) => {
    const path = overflowFile(env, ledgerId);
    return existsSync(path) && statSync(path).isFile() ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  const NOT_RECORDED =
    /1 obligation could not be recorded since \S+ \(query_feedback\): the pending list was full\./;

  it.each([
    ["a repeated stop counts it", "stop"],
    ["the parent's own reads name it once it has room", "room"],
  ])("keeps a subagent's debt without content with the subagent while a full parent cannot write its count, and %s (brief :29, U5)", (_, recovery) => {
    const env = testEnv();
    const parent = `f2-count-refused-${recovery}`;
    const stop = stopOf(parent, childId(0x290));
    const child = agentLedgerIdFor(stop);
    fillOwn(env, parent);
    recordQueryFeedbackObligation(child, { available: true, query_id: "rq_handed" }, env);
    refuseCount(env, parent);
    transferSubagentObligations(stop, env);
    // Not dropped: still the subagent's, and the parent's association leads to it.
    expect(readCompletionObligations(child, env)).toEqual([expect.objectContaining({ query_id: "rq_handed" })]);
    expect(countOf(env, parent)).toBeNull();
    expect(durablePointers(env, parent)).toEqual([associationFileName(ledgerOf(child))]);
    allowCount(env, parent);
    if (recovery === "stop") {
      transferSubagentObligations(stop, env);
      expect(countOf(env, parent)).toMatchObject({ count: 1, kinds: ["query_feedback"] });
      expect(readCompletionObligations(child, env)).toEqual([]);
      expect(pendingCompletionRecoveryInstruction(parent, env)).toMatch(NOT_RECORDED);
    } else {
      payOwn(env, parent);
      expect(readCompletionObligations(parent, env)).toEqual([
        expect.objectContaining({ query_id: "rq_handed", ledger: ledgerOf(child) }),
      ]);
      expect(pendingCompletionRecoveryInstruction(parent, env)).toContain("rq_handed");
    }
  });

  it.each([
    ["a subagent's own count at its stop", "stop"],
    ["a Codex turn's count at its fold", "fold"],
  ])("puts %s back where it was while the parent cannot write it, and passes it on at that ledger's next hand-over once it can (brief :29, U5)", (_, path) => {
    const env = testEnv();
    const parent = `f2-count-back-${path}`;
    const stop = stopOf(parent, childId(0x291));
    const from = path === "stop" ? agentLedgerIdFor(stop) : `${parent}-turn`;
    const handOver = () =>
      path === "stop"
        ? transferSubagentObligations(stop, env)
        : foldTurnLedgerIntoSession({ session_id: parent, turn_id: from }, env);
    fillOwn(env, from);
    recordQueryFeedbackObligation(from, { available: true, query_id: "rq_counted" }, env);
    expect(countOf(env, from)).toMatchObject({ count: 1, kinds: ["query_feedback"] });
    refuseCount(env, parent);
    handOver();
    // Its 64 debts moved; its count went back, to wait for that ledger's next
    // hand-over, and the parent is not told of it until then.
    expect(readCompletionObligations(parent, env)).toHaveLength(64);
    expect(countOf(env, from)).toMatchObject({ count: 1, kinds: ["query_feedback"] });
    allowCount(env, parent);
    expect(pendingCompletionRecoveryInstruction(parent, env)).not.toMatch(NOT_RECORDED);
    handOver();
    expect(countOf(env, parent)).toMatchObject({ count: 1, kinds: ["query_feedback"] });
    expect(countOf(env, from)).toBeNull();
    expect(pendingCompletionRecoveryInstruction(parent, env)).toMatch(NOT_RECORDED);
  });

  it("shows a record reached both by a pointer and by an association once (D-A')", () => {
    const env = testEnv();
    const parent = "f2-pointer-and-association";
    const { keeper } = pointerFixture(env, parent, "pointer-and-association", "temporary");
    const durable = join(retainedRoot(env), `${ledgerOf(parent)}.pointers`);
    mkdirSync(durable, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(durable, associationFileName(keeper)),
      `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: keeper, transferred_from: null })}\n`,
      { mode: 0o600 },
    );
    expect(readCompletionObligations(parent, env)).toEqual([expect.objectContaining({ ledger: keeper })]);
    expect(handlesIn(pendingCompletionRecoveryInstruction(parent, env))).toHaveLength(1);
  });

  // R-W2 round 2 R2-3, R2-4 (design note r2-ownership.md, mechanism A): on
  // OpenClaw's path one live session at a time is asked for a kept debt. A
  // session that runs again leaves a content-free released marker; every
  // pointer and association OpenClaw's hand-overs write says so
  // ("forwarded": true); an asking read follows such an entry only when no
  // other live session asks for what it names, and otherwise removes it (the
  // keeper's own session asks) or moves it, byte for byte, to the session
  // that does. A completion's or a decline's read follows every entry its
  // session holds and names nothing. Claude Code's and Codex's entries carry
  // no flag and are read as before.
  describe("one session asked at a time on OpenClaw's path (R2-3, R2-4)", () => {
    // Each case's homes go when it ends, so the file's final cleanup has no
    // more to remove than before these cases.
    const used = [];
    const freshEnv = () => {
      const env = testEnv();
      used.push(env);
      return env;
    };
    afterEach(() => {
      for (const env of used.splice(0)) {
        for (const directory of [env.REMEMBRANCE_USAGE_DIR, env.XDG_STATE_HOME, env.XDG_CONFIG_HOME]) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    });
    const FORWARD = { forward: true };
    const RELEASED = `${JSON.stringify({ version: "completion-obligation-released-v1" })}\n`;
    const markerOf = (env, ledgerId) => join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.forward.json`);
    const pointerHome = (env, ledgerId) => join(retainedRoot(env), `${ledgerOf(ledgerId)}.pointers`);
    const temporaryHome = (env, ledgerId) => join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(ledgerId)}.pointers`);
    // OpenClaw's end of a subagent's run (index.mjs passSubagentDebts): its
    // session ledger folds into its agent ledger, which hands over.
    const endRun = (env, requester, agentId, session) => {
      const handoff = stopOf(requester, agentId);
      foldTurnLedgerIntoSession({ session_id: agentLedgerIdFor(handoff), turn_id: session }, env, FORWARD);
      transferSubagentObligations(handoff, env, FORWARD);
    };
    // What a session's read shows, as its next prompt asks for it: a query
    // fit by its query id, a kept preference by its value, and "@" with the
    // keeper's name when another ledger keeps it.
    const viewer = (env, sessions, values) => {
      const keepers = Object.fromEntries(Object.entries(sessions).map(([name, id]) => [ledgerOf(id), name]));
      const prefs = Object.fromEntries(values.map((value) => [preferenceId(value), value]));
      return (ledgerId) =>
        readCompletionObligations(ledgerId, env)
          .map((item) => {
            const what = item.kind === "capture_next_action" ? `pref:${prefs[item.id] ?? "?"}` : item.query_id ?? item.kind;
            return item.ledger ? `${what}@${keepers[item.ledger] ?? "?"}` : what;
          })
          .sort();
    };
    // Every entry of a ledger's pointer homes, with its bytes.
    const entriesOf = (env, ledgerId) => {
      const entries = {};
      for (const [home, directory] of [["durable", pointerHome(env, ledgerId)], ["temporary", temporaryHome(env, ledgerId)]]) {
        for (const name of listed(directory)) entries[`${home}/${name}`] = readFileSync(join(directory, name), "utf8");
      }
      return entries;
    };
    // A ledger's own records, by query id or kind, with the subagent each names.
    const ownRecords = (env, ledgerId) =>
      readCompletionObligations(ledgerId, env, { pointers: false })
        .map((item) => `${item.query_id ?? item.kind}<${item.transferred_from?.agent_id ?? "none"}`)
        .sort();
    const declineShown = (env, ledgerId, queryId) => {
      const item = readCompletionObligations(ledgerId, env).find((entry) => entry.query_id === queryId);
      expect(item).toBeDefined();
      observeSuccessfulCompletionTool(
        ledgerId,
        "decline_pending_action",
        { action_id: hash(item.id).slice(0, 16), reason: "not_reusable" },
        { declined: true },
        env,
      );
    };
    // Forwarding markers opened while `run` runs, counted by wrapping
    // node:fs, never by product counters.
    function markersOpened(run) {
      const opened = [];
      const original = nodeFs.openSync;
      nodeFs.openSync = function opening(path, ...rest) {
        if (String(path).endsWith(".forward.json")) opened.push(basename(String(path)));
        return original.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      try {
        return { result: run(), opened };
      } finally {
        nodeFs.openSync = original;
        syncBuiltinESMExports();
      }
    }
    const forwardTo = (env, ledger, next) => {
      mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(env.REMEMBRANCE_USAGE_DIR, `${ledger}.forward.json`),
        `${JSON.stringify({ version: "completion-obligation-forward-v1", ledger: next, transferred_from: null })}\n`,
        { mode: 0o600 },
      );
    };
    const flaggedPointers = (env, holder, keepers, id) => {
      const directory = pointerHome(env, holder);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const keeper of keepers) {
        writeFileSync(
          join(directory, pointerFileName(keeper, id)),
          `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: keeper, id, forwarded: true })}\n`,
          { mode: 0o600 },
        );
      }
    };

    it("leaves a debt its keeper keeps to the keeper's session while it runs again, removes the pointer above, and asks the session above again after the keeper's next end (keeper runs again)", async () => {
      const env = freshEnv();
      const top = "f2-own-keeper-top";
      const cSession = "f2-own-keeper-c";
      const gSession = "f2-own-keeper-g";
      const view = viewer(env, { c: cSession }, ["keeper"]);
      capture(env, gSession, "keeper");
      recordQueryFeedbackObligation(gSession, { available: true, query_id: "rq_keeper" }, env);
      // G ends during C's run: its debts land in C's ledger, the preference
      // sealed. C ends: the query fit moves up whole; C keeps the preference
      // and the top gets a pointer to it that says it is OpenClaw's.
      endRun(env, cSession, childId(0x901), gSession);
      endRun(env, top, childId(0x900), cSession);
      const pointer = join(pointerHome(env, top), pointerFileName(ledgerOf(cSession), preferenceId("keeper")));
      expect(readFileSync(pointer, "utf8")).toBe(
        `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: ledgerOf(cSession), id: preferenceId("keeper"), forwarded: true })}\n`,
      );
      expect(view(top)).toEqual(["pref:keeper@c", "rq_keeper"]);
      // C's session runs again: its marker is released, content-free; the
      // top's next read leaves the preference to C and removes its pointer.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(readFileSync(markerOf(env, cSession), "utf8")).toBe(RELEASED);
      expect(modeOf(markerOf(env, cSession))).toBe(0o600);
      expect(releaseCompletionForward(cSession, env)).toBe(false);
      expect(readFileSync(markerOf(env, cSession), "utf8")).toBe(RELEASED);
      expect(view(top)).toEqual(["rq_keeper"]);
      expect(entriesOf(env, top)).toEqual({});
      expect(handlesIn(pendingCompletionRecoveryInstruction(top, env))).toEqual([]);
      expect(view(cSession)).toEqual(["pref:keeper"]);
      expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toHaveLength(1);
      // C's run ends again: its marker forwards again, and the top alone is
      // asked again, through a pointer written again.
      endRun(env, top, childId(0x900), cSession);
      expect(JSON.parse(readFileSync(markerOf(env, cSession), "utf8")).version).toBe("completion-obligation-forward-v1");
      expect(readFileSync(pointer, "utf8")).toBe(
        `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: ledgerOf(cSession), id: preferenceId("keeper"), forwarded: true })}\n`,
      );
      expect(view(top)).toEqual(["pref:keeper@c", "rq_keeper"]);
      declineShown(env, top, "rq_keeper");
      await recoverAndComplete(env, top, pendingCompletionRecoveryInstruction(top, env), (agentId) => {
        expect(agentId).toBe(childId(0x901));
        return "keeper";
      });
    });

    it("moves an association, byte for byte, to the session between it and its keeper that runs again, which alone is asked, and that association goes at that session's next read once the keeper's session runs again (P, then C)", () => {
      const env = freshEnv();
      const top = "f2-own-pc-top";
      const pSession = "f2-own-pc-p";
      const cSession = "f2-own-pc-c";
      const gSession = "f2-own-pc-g";
      const view = viewer(env, { c: cSession }, ["pc"]);
      recordQueryFeedbackObligation(pSession, { available: true, query_id: "rq_pc_p" }, env);
      endRun(env, top, childId(0x910), pSession);
      endRun(env, pSession, childId(0x911), cSession);
      // G ends late, after C and P: its debts land in C's ledger, and the top,
      // where C's markers lead, gets an association to it.
      capture(env, gSession, "pc");
      recordQueryFeedbackObligation(gSession, { available: true, query_id: "rq_pc_g" }, env);
      endRun(env, cSession, childId(0x912), gSession);
      const name = associationFileName(ledgerOf(cSession));
      const association = entriesOf(env, top)[`durable/${name}`];
      expect(Object.keys(entriesOf(env, top))).toEqual([`durable/${name}`]);
      expect(JSON.parse(association)).toMatchObject({
        version: "completion-obligation-association-v1",
        ledger: ledgerOf(cSession),
        forwarded: true,
      });
      expect(view(top)).toEqual(["pref:pc@c", "rq_pc_g@c", "rq_pc_p"]);
      expect(view(pSession)).toEqual([]);
      // P's session runs again: the top's next read moves the association to
      // P's durable home, as it was (0600 in 0700), and P alone is asked.
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      expect(view(top)).toEqual(["rq_pc_p"]);
      expect(entriesOf(env, top)).toEqual({});
      expect(entriesOf(env, pSession)).toEqual({ [`durable/${name}`]: association });
      expect(modeOf(join(pointerHome(env, pSession), name))).toBe(0o600);
      expect(modeOf(pointerHome(env, pSession))).toBe(0o700);
      expect(view(pSession)).toEqual(["pref:pc@c", "rq_pc_g@c"]);
      expect(view(top)).toEqual(["rq_pc_p"]);
      // C's session runs again: its release writes only its marker, P's next
      // read removes the association (C keeps the debts), and C alone is
      // asked.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(entriesOf(env, pSession)).toEqual({ [`durable/${name}`]: association });
      expect(view(pSession)).toEqual([]);
      expect(entriesOf(env, pSession)).toEqual({});
      expect(view(top)).toEqual(["rq_pc_p"]);
      expect(view(cSession)).toEqual(["pref:pc", "rq_pc_g"]);
    });

    it("neither names after anything nor asks the top for what a session that runs again records itself, and asks the session above it, which runs again, after its next end (r9-cnew)", () => {
      const env = freshEnv();
      const top = "f2-own-cnew-top";
      const pSession = "f2-own-cnew-p";
      const cSession = "f2-own-cnew-c";
      const gSession = "f2-own-cnew-g";
      const view = viewer(env, { c: cSession }, ["cnew-g", "cnew-c"]);
      endRun(env, top, childId(0x920), pSession);
      endRun(env, pSession, childId(0x921), cSession);
      capture(env, gSession, "cnew-g");
      endRun(env, cSession, childId(0x922), gSession);
      expect(view(top)).toEqual(["pref:cnew-g@c"]);
      // P's session runs again, then C's: C's markers now end at P, so the
      // association at the top stays; C records debts of its own.
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(Object.keys(entriesOf(env, top))).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
      recordQueryFeedbackObligation(cSession, { available: true, query_id: "rq_cnew_c" }, env);
      capture(env, cSession, "cnew-c");
      // The top's read leaves all of it to C and drops its association: C's
      // own debts are named after nothing.
      expect(view(top)).toEqual([]);
      expect(entriesOf(env, top)).toEqual({});
      expect(view(cSession)).toEqual(["pref:cnew-c", "pref:cnew-g", "rq_cnew_c"]);
      expect(ownRecords(env, cSession)).toEqual([
        `capture_next_action<${childId(0x922)}`,
        "capture_next_action<none",
        "rq_cnew_c<none",
      ]);
      // C's run ends: P's session, which runs again, takes what moves and is
      // asked; the top is not.
      endRun(env, pSession, childId(0x921), cSession);
      expect(view(top)).toEqual([]);
      expect(view(pSession)).toEqual(["pref:cnew-c", "pref:cnew-g@c", "rq_cnew_c"]);
    });

    for (const first of ["top", "p"]) {
      it(`asks only the session that runs again for two late ends' debts, whichever session reads first (${first} first; late2)`, () => {
        const env = freshEnv();
        const top = `f2-own-late2-${first}-top`;
        const pSession = `f2-own-late2-${first}-p`;
        const cSession = `f2-own-late2-${first}-c`;
        const view = viewer(env, { c: cSession }, ["late2-g1", "late2-g2"]);
        endRun(env, top, childId(0x930), pSession);
        endRun(env, pSession, childId(0x931), cSession);
        capture(env, `${cSession}-g1`, "late2-g1");
        endRun(env, cSession, childId(0x932), `${cSession}-g1`);
        expect(view(top)).toEqual(["pref:late2-g1@c"]);
        // P's session runs again; G2 ends late: the hand-over stops at P,
        // which gets an association to C as well.
        expect(releaseCompletionForward(pSession, env)).toBe(true);
        capture(env, `${cSession}-g2`, "late2-g2");
        endRun(env, cSession, childId(0x933), `${cSession}-g2`);
        expect(Object.keys(entriesOf(env, pSession))).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
        const order = first === "top" ? [top, pSession] : [pSession, top];
        const shown = Object.fromEntries(order.map((ledgerId) => [ledgerId, view(ledgerId)]));
        expect(shown[top]).toEqual([]);
        expect(shown[pSession]).toEqual(["pref:late2-g1@c", "pref:late2-g2@c"]);
        expect(entriesOf(env, top)).toEqual({});
        expect(Object.keys(entriesOf(env, pSession))).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
        expect(view(top)).toEqual([]);
        expect(view(pSession)).toEqual(["pref:late2-g1@c", "pref:late2-g2@c"]);
      });
    }

    it("settles through a pointer a debt its holder was asked for before the keeper's session ran again: completed once, where it is kept, and asked of no one after (step 4)", async () => {
      const env = freshEnv();
      const top = "f2-own-asker-top";
      const cSession = "f2-own-asker-c";
      const gSession = "f2-own-asker-g";
      const view = viewer(env, { c: cSession }, ["asker"]);
      capture(env, gSession, "asker");
      endRun(env, cSession, childId(0x941), gSession);
      endRun(env, top, childId(0x940), cSession);
      const demand = pendingCompletionRecoveryInstruction(top, env);
      const handles = handlesIn(demand);
      expect(handles).toHaveLength(1);
      const retrieved = await retrieve(env, handles[0]);
      expect(retrieved).toMatchObject({ status: "retrieved", arguments: preference("asker") });
      // C's session runs again before the top completes what it was asked for.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      observeSuccessfulCompletionTool(top, "record_preference", retrieved.arguments, { recorded: true }, env);
      expect(view(cSession)).toEqual([]);
      expect(view(top)).toEqual([]);
      expect(entriesOf(env, top)).toEqual({});
      expect(pendingCompletionRecoveryInstruction(cSession, env)).toBeNull();
      expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
      expect((await retrieve(env, handles[0])).status).toBe("not_found");
    });

    it("settles through an association a debt its holder was asked for before the sessions below ran again, and names nothing it reaches there (step 4)", () => {
      const env = freshEnv();
      const top = "f2-own-settle-top";
      const pSession = "f2-own-settle-p";
      const cSession = "f2-own-settle-c";
      const gSession = "f2-own-settle-g";
      const view = viewer(env, { c: cSession }, []);
      endRun(env, top, childId(0x950), pSession);
      endRun(env, pSession, childId(0x951), cSession);
      recordQueryFeedbackObligation(gSession, { available: true, query_id: "rq_settle_g" }, env);
      endRun(env, cSession, childId(0x952), gSession);
      expect(view(top)).toEqual(["rq_settle_g@c"]);
      const asked = readCompletionObligations(top, env).find((item) => item.query_id === "rq_settle_g");
      // P's session runs again, then C's (the association at the top stays,
      // as C's markers end at P), and C records a debt of its own.
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      recordQueryFeedbackObligation(cSession, { available: true, query_id: "rq_settle_c" }, env);
      // The top declines what it was asked for.
      observeSuccessfulCompletionTool(
        top,
        "decline_pending_action",
        { action_id: hash(asked.id).slice(0, 16), reason: "not_reusable" },
        { declined: true },
        env,
      );
      expect(ownRecords(env, cSession)).toEqual(["rq_settle_c<none"]);
      expect(view(cSession)).toEqual(["rq_settle_c"]);
      expect(view(top)).toEqual([]);
      expect(entriesOf(env, top)).toEqual({});
    });

    it("asks the keeper's session and the session above while a released marker is lost, loses nothing, and asks only the session above after the keeper's next end (lost released marker)", async () => {
      const env = freshEnv();
      const top = "f2-own-lost-top";
      const cSession = "f2-own-lost-c";
      const gSession = "f2-own-lost-g";
      const view = viewer(env, { c: cSession }, ["lost"]);
      capture(env, gSession, "lost");
      endRun(env, cSession, childId(0x961), gSession);
      endRun(env, top, childId(0x960), cSession);
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(readFileSync(markerOf(env, cSession), "utf8")).toBe(RELEASED);
      // The released marker is lost before the top reads again: until C's
      // next end the top is asked as well (residual), and nothing is lost.
      rmSync(markerOf(env, cSession));
      expect(view(top)).toEqual(["pref:lost@c"]);
      expect(view(cSession)).toEqual(["pref:lost"]);
      expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(1);
      endRun(env, top, childId(0x960), cSession);
      expect(JSON.parse(readFileSync(markerOf(env, cSession), "utf8")).version).toBe("completion-obligation-forward-v1");
      await recoverAndComplete(env, top, pendingCompletionRecoveryInstruction(top, env), (agentId) => {
        expect(agentId).toBe(childId(0x961));
        return "lost";
      });
    });

    it("writes Claude Code's and Codex's pointers and associations without the flag, as before, and their reads follow them without opening any forwarding marker (flagless entries)", () => {
      const env = freshEnv();
      const parent = "f2-flagless-parent";
      const childStop = stopOf(parent, childId(0x970));
      const child = agentLedgerIdFor(childStop);
      const record = sealedRecord(env, "flagless");
      const keepers = keepCopies(env, record, 65, "f2-flagless-keeper");
      const childPointers = pointerHome(env, child);
      mkdirSync(childPointers, { recursive: true, mode: 0o700 });
      for (const keeper of keepers) {
        writeFileSync(join(childPointers, pointerFileName(keeper, record.id)), pointerText(keeper, record.id), { mode: 0o600 });
      }
      fillOwn(env, parent);
      transferSubagentObligations(childStop, env);
      const entries = entriesOf(env, parent);
      expect(Object.keys(entries)).toHaveLength(65);
      for (const [name, text] of Object.entries(entries)) {
        expect(text).not.toContain("forwarded");
        const entry = JSON.parse(text);
        expect(text).toBe(
          name === `durable/${associationFileName(ledgerOf(child))}`
            ? `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: ledgerOf(child), transferred_from: { agent_id: childId(0x970), transcript_path: null } })}\n`
            : pointerText(entry.ledger, entry.id),
        );
      }
      // Released markers on every keeper and on the child, as OpenClaw's
      // would leave them: Claude Code's and Codex's reads never look.
      for (const ledger of [...keepers, ledgerOf(child)]) {
        writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${ledger}.forward.json`), RELEASED, { mode: 0o600 });
      }
      payOwn(env, parent);
      const { result: page, opened } = markersOpened(() => readCompletionObligations(parent, env));
      expect(page.filter((item) => item.ledger)).toHaveLength(64);
      expect(opened).toEqual([]);
      expect(Object.keys(entriesOf(env, parent))).toHaveLength(65);
    });

    it("counts every forwarding marker it reads toward the 256 entries one read examines, and reads a ledger's marker once per read (bounds)", () => {
      const env = freshEnv();
      const record = sealedRecord(env, "marker-budget");
      // 64 flagged pointers to 64 keepers, each with seven markers of its own
      // whose last ledger has none (no session runs again: the reader
      // follows). Each pointer and its seven markers are eight examined
      // entries, and the look past the seventh marker is made only below the
      // bound: 31 pointers are shown, and the 32nd's owner is not found
      // within 256 (its seven markers are read; the read is incomplete).
      const distinct = "f2-marker-budget-distinct";
      const separate = keepCopies(env, record, 64, "f2-marker-budget-separate");
      separate.forEach((keeper, index) => {
        let ledger = keeper;
        for (let hop = 1; hop <= 7; hop += 1) {
          const next = hash(`f2-marker-budget-separate-${index}-${hop}`).slice(0, 16);
          forwardTo(env, ledger, next);
          ledger = next;
        }
      });
      flaggedPointers(env, distinct, separate, record.id);
      const first = markersOpened(() => readCompletionObligations(distinct, env));
      console.info(`F2 marker budget, separate chains: ${first.result.length} shown, ${first.opened.length} markers read`);
      expect(first.result).toHaveLength(31);
      expect(first.opened).toHaveLength(32 * 7);
      // 64 keepers whose markers lead into one chain of six more: each
      // keeper's marker is read, the chain's once: 64 pointers shown.
      const shared = "f2-marker-budget-shared";
      const together = keepCopies(env, record, 64, "f2-marker-budget-together");
      const chain = Array.from({ length: 7 }, (_, hop) => hash(`f2-marker-budget-chain-${hop}`).slice(0, 16));
      for (const keeper of together) forwardTo(env, keeper, chain[0]);
      for (let hop = 0; hop < 6; hop += 1) forwardTo(env, chain[hop], chain[hop + 1]);
      flaggedPointers(env, shared, together, record.id);
      const second = markersOpened(() => readCompletionObligations(shared, env));
      console.info(`F2 marker budget, one chain: ${second.result.length} shown, ${second.opened.length} markers read`);
      expect(second.result).toHaveLength(64);
      expect(second.opened).toHaveLength(64 + 6);
      expect(new Set(second.opened).size).toBe(64 + 6);
    });

    it("moves each entry another live session asks for once, writing its copy there before it removes it: one write and one removal per entry (bounds, write-first)", () => {
      const env = freshEnv();
      const holder = "f2-move-once-holder";
      const owner = "f2-move-once-owner";
      const record = sealedRecord(env, "move-once");
      const keepers = keepCopies(env, record, 64, "f2-move-once-keeper");
      for (const keeper of keepers) forwardTo(env, keeper, ledgerOf(owner));
      writeFileSync(markerOf(env, owner), RELEASED, { mode: 0o600 });
      flaggedPointers(env, holder, keepers, record.id);
      const before = entriesOf(env, holder);
      const events = [];
      const rename = nodeFs.renameSync;
      const remove = nodeFs.rmSync;
      nodeFs.renameSync = function renamed(from, to, ...rest) {
        const result = rename.call(this, from, to, ...rest);
        events.push(["write", dirname(String(to)), basename(String(to))]);
        return result;
      };
      nodeFs.rmSync = function removed(path, ...rest) {
        events.push(["remove", dirname(String(path)), basename(String(path))]);
        return remove.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      let shown;
      try {
        shown = readCompletionObligations(holder, env);
      } finally {
        nodeFs.renameSync = rename;
        nodeFs.rmSync = remove;
        syncBuiltinESMExports();
      }
      expect(shown).toEqual([]);
      expect(entriesOf(env, holder)).toEqual({});
      const writes = events.filter(([kind]) => kind === "write");
      const removals = events.filter(([kind]) => kind === "remove");
      expect(writes.map(([, directory]) => directory)).toEqual(Array(64).fill(pointerHome(env, owner)));
      // Removals in pointer homes: the 64 entries the holder held, nothing else.
      const fromHomes = removals.filter(([, directory]) => directory.endsWith(".pointers"));
      expect(fromHomes.map(([, directory]) => directory)).toEqual(Array(64).fill(pointerHome(env, holder)));
      expect(fromHomes.map(([, , name]) => `durable/${name}`).sort()).toEqual(Object.keys(before).sort());
      for (const [, , name] of writes) {
        expect(events.findIndex(([kind, , entry]) => kind === "write" && entry === name)).toBeLessThan(
          events.findIndex(([kind, , entry]) => kind === "remove" && entry === name),
        );
      }
      expect(entriesOf(env, owner)).toEqual(before);
      expect(readCompletionObligations(owner, env).filter((item) => item.ledger)).toHaveLength(64);
    });

    it("leaves an entry where it is, never followed, and the read incomplete when the session that asks for it cannot take it, writes nothing through a link, and moves it once that session's homes are usable (write-first)", () => {
      const env = freshEnv();
      const top = "f2-own-refused-top";
      const pSession = "f2-own-refused-p";
      const cSession = "f2-own-refused-c";
      const gSession = "f2-own-refused-g";
      const view = viewer(env, { c: cSession }, ["refused"]);
      fillOwn(env, top);
      recordQueryFeedbackObligation(top, { available: true, query_id: "rq_counted" }, env);
      expect(existsSync(overflowFile(env, top))).toBe(true);
      endRun(env, top, childId(0x980), pSession);
      endRun(env, pSession, childId(0x981), cSession);
      capture(env, gSession, "refused");
      endRun(env, cSession, childId(0x982), gSession);
      payOwn(env, top);
      const before = entriesOf(env, top);
      expect(Object.keys(before)).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      // Both of P's pointer homes are links: the association cannot go there.
      const decoys = [join(env.XDG_STATE_HOME, "decoy-durable"), join(env.XDG_STATE_HOME, "decoy-temporary")];
      const homes = [pointerHome(env, pSession), temporaryHome(env, pSession)];
      homes.forEach((home, index) => {
        mkdirSync(decoys[index], { recursive: true, mode: 0o700 });
        mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
        symlinkSync(decoys[index], home);
      });
      expect(view(top)).toEqual([]);
      expect(entriesOf(env, top)).toEqual(before);
      expect(existsSync(overflowFile(env, top))).toBe(true);
      for (const decoy of decoys) expect(readdirSync(decoy)).toEqual([]);
      // P's homes are usable again: the next read moves it, and is complete.
      for (const home of homes) rmSync(home);
      expect(view(top)).toEqual([]);
      expect(entriesOf(env, top)).toEqual({});
      expect(existsSync(overflowFile(env, top))).toBe(false);
      expect(entriesOf(env, pSession)).toEqual(before);
      expect(view(pSession)).toEqual(["pref:refused@c"]);
    });

    it("moves or removes nothing while the durable root is refused: a temporary entry another live session asks for stays, never followed, until the root is usable", () => {
      const env = freshEnv();
      const holder = "f2-own-root-holder";
      const keeperSession = "f2-own-root-keeper";
      const record = sealedRecord(env, "own-root");
      const keeper = ledgerOf(keeperSession);
      const directory = join(retainedRoot(env), `${keeper}.obligations`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, recordFileName(record.id)), record.text, { mode: 0o600 });
      mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(markerOf(env, keeperSession), RELEASED, { mode: 0o600 });
      const temporary = temporaryHome(env, holder);
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const text = `${JSON.stringify({ version: "completion-obligation-pointer-v1", ledger: keeper, id: record.id, forwarded: true })}\n`;
      writeFileSync(join(temporary, pointerFileName(keeper, record.id)), text, { mode: 0o600 });
      withRefusedRoot(env, () => {
        expect(readCompletionObligations(holder, env)).toEqual([]);
      });
      expect(entriesOf(env, holder)).toEqual({ [`temporary/${pointerFileName(keeper, record.id)}`]: text });
      expect(readCompletionObligations(holder, env)).toEqual([]);
      expect(entriesOf(env, holder)).toEqual({});
      expect(readCompletionObligations(keeperSession, env)).toEqual([expect.objectContaining({ id: record.id })]);
    });

    it("leaves a flagged entry to the session that runs again when the keeper's markers reach it within eight, and follows the entry when they reach it only past eight (bounds, 8 markers)", () => {
      const env = freshEnv();
      const record = sealedRecord(env, "owner-hops");
      for (const [hops, shown] of [[7, 0], [8, 1]]) {
        // The keeper, then `hops` forwarding markers; the ledger the last one
        // names runs again (its marker is released). A read looks at no more
        // than eight markers for whose an entry is.
        const holder = `f2-owner-hops-holder-${hops}`;
        const [keeper] = keepCopies(env, record, 1, `f2-owner-hops-keeper-${hops}`);
        let ledger = keeper;
        for (let hop = 1; hop <= hops; hop += 1) {
          const next = hash(`f2-owner-hops-${hops}-${hop}`).slice(0, 16);
          forwardTo(env, ledger, next);
          ledger = next;
        }
        writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${ledger}.forward.json`), RELEASED, { mode: 0o600 });
        flaggedPointers(env, holder, [keeper], record.id);
        const before = entriesOf(env, holder);
        const { result, opened } = markersOpened(() => readCompletionObligations(holder, env));
        expect(result.map((item) => item.ledger)).toEqual(shown ? [keeper] : []);
        expect(opened).toHaveLength(8);
        // Within eight the entry goes, unchanged, to the session that runs
        // again; past eight it stays where it is, and the read follows it.
        expect(entriesOf(env, holder)).toEqual(shown ? before : {});
        expect(listed(join(retainedRoot(env), `${ledger}.pointers`))).toEqual(shown ? [] : [pointerFileName(keeper, record.id)]);
      }
    });

    it("removes nothing through a pointer home that becomes a link while its read decides whose an entry is: the decoy behind the link and the entry stay (write-first, lstat before removal)", () => {
      const env = freshEnv();
      const holder = "f2-own-swap-holder";
      const record = sealedRecord(env, "own-swap");
      // The keeper's session runs again, so the holder's read removes its
      // entry, after an lstat of the home and of the entry.
      const [keeper] = keepCopies(env, record, 1, "f2-own-swap-keeper");
      mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`), RELEASED, { mode: 0o600 });
      flaggedPointers(env, holder, [keeper], record.id);
      const home = pointerHome(env, holder);
      const name = pointerFileName(keeper, record.id);
      const text = readFileSync(join(home, name), "utf8");
      const away = `${home}.away`;
      const decoy = join(env.XDG_STATE_HOME, "decoy-swap");
      mkdirSync(decoy, { recursive: true, mode: 0o700 });
      writeFileSync(join(decoy, name), "decoy\n", { mode: 0o600 });
      // Another process swaps the home for a link after the read listed and
      // read the entry, while it reads the keeper's marker.
      const original = nodeFs.openSync;
      let swapped = false;
      nodeFs.openSync = function opening(path, ...rest) {
        if (!swapped && String(path).endsWith(".forward.json")) {
          swapped = true;
          renameSync(home, away);
          symlinkSync(decoy, home);
        }
        return original.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      let shown;
      try {
        shown = readCompletionObligations(holder, env);
      } finally {
        nodeFs.openSync = original;
        syncBuiltinESMExports();
      }
      expect(swapped).toBe(true);
      expect(shown).toEqual([]);
      expect(readFileSync(join(decoy, name), "utf8")).toBe("decoy\n");
      expect(readFileSync(join(away, name), "utf8")).toBe(text);
    });

    it("hands OpenClaw's entries over as they are, whichever session runs again: the hand-over opens no forwarding marker for them and leaves who is asked to the next asking read (bounds, hand-overs)", () => {
      const env = freshEnv();
      const parent = "f2-handover-owner-parent";
      const handoff = stopOf(parent, childId(0x9a0));
      const exiting = agentLedgerIdFor(handoff);
      const record = sealedRecord(env, "handover-owner");
      // Eight debts the ending subagent's ledger points to, whose keepers'
      // sessions run again (released markers).
      const keepers = keepCopies(env, record, 8, "f2-handover-owner-keeper");
      mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
      for (const keeper of keepers) writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`), RELEASED, { mode: 0o600 });
      flaggedPointers(env, exiting, keepers, record.id);
      const names = keepers.map((keeper) => pointerFileName(keeper, record.id)).sort();
      const { opened } = markersOpened(() => transferSubagentObligations(handoff, env, FORWARD));
      expect(opened).toEqual([]);
      expect(entriesOf(env, exiting)).toEqual({});
      expect(listed(pointerHome(env, parent)).sort()).toEqual(names);
      // The parent's own read then leaves each to the session that keeps it.
      expect(readCompletionObligations(parent, env)).toEqual([]);
      expect(entriesOf(env, parent)).toEqual({});
    });

    it("releases a session with bounded filesystem work: 15 calls however far its markers led, listing nothing and writing only its marker, so every association on the way stays for its holder's next read; a released marker is left as it is (bounds, R4C-1)", () => {
      for (const [hops, calls] of [[1, 15], [8, 15], [12, 15]]) {
        const env = freshEnv();
        const chain = Array.from({ length: hops + 1 }, (_, index) => `f2-release-cost-${hops}-${index}`);
        for (let index = 0; index < hops; index += 1) {
          forwardTo(env, ledgerOf(chain[index]), ledgerOf(chain[index + 1]));
          for (const home of [pointerHome(env, chain[index + 1]), temporaryHome(env, chain[index + 1])]) {
            mkdirSync(home, { recursive: true, mode: 0o700 });
            writeFileSync(
              join(home, associationFileName(ledgerOf(chain[0]))),
              `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: ledgerOf(chain[0]), transferred_from: null, forwarded: true })}\n`,
              { mode: 0o600 },
            );
          }
        }
        let released;
        const counts = countFilesystem(() => {
          released = releaseCompletionForward(chain[0], env);
        });
        console.info(`F2 release work, ${hops} hop(s): ${JSON.stringify(counts)}`);
        expect(released).toBe(true);
        expect(counts).toEqual({ calls, listed: 0, pointerListings: 0 });
        expect(readFileSync(markerOf(env, chain[0]), "utf8")).toBe(RELEASED);
        // Every association on the way stays, for its holder's next read.
        for (let index = 1; index <= hops; index += 1) {
          expect(existsSync(join(pointerHome(env, chain[index]), associationFileName(ledgerOf(chain[0]))))).toBe(true);
        }
        const again = countFilesystem(() => {
          released = releaseCompletionForward(chain[0], env);
        });
        expect(released).toBe(false);
        expect(again.listed + again.pointerListings).toBe(0);
        expect(readFileSync(markerOf(env, chain[0]), "utf8")).toBe(RELEASED);
      }
    });

    // Round 3 (R3C-1): only a prompt's or a stop's read decides who is asked
    // for a flagged entry, and only it moves or removes one. A run's other
    // reads (a debt recorded or looked up, the end of each tool call) ask
    // nothing: the run keeps the entry it was asked through until its next
    // prompt or stop, and its completion settles the debt once, where it is
    // kept.
    it("keeps a run that was asked on the entry it was asked through while a session between runs again: its tool calls move nothing, that session is not asked, and its completion settles the debt once, where it is kept (R3C-1, mid-read)", async () => {
      const env = freshEnv();
      const top = "f2-r3-mid-top";
      const pSession = "f2-r3-mid-p";
      const cSession = "f2-r3-mid-c";
      const gSession = "f2-r3-mid-g";
      endRun(env, top, childId(0x9b0), pSession);
      endRun(env, pSession, childId(0x9b1), cSession);
      // G ends late: the top holds an association to C's ledger.
      capture(env, gSession, "mid");
      endRun(env, cSession, childId(0x9b2), gSession);
      const before = entriesOf(env, top);
      expect(Object.keys(before)).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
      const asked = handlesIn(pendingCompletionRecoveryInstruction(top, env));
      expect(asked).toHaveLength(1);
      // P's session runs again while the top's run goes on. That run
      // retrieves the payload, makes another tool call and records a debt of
      // its own: nothing moves, and P is not asked.
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      const retrieved = await retrieve(env, asked[0]);
      observeSuccessfulCompletionTool(top, "get_pending_action_payload", asked[0], { status: "retrieved" }, env);
      observeSuccessfulCompletionTool(top, "exec", { command: "true" }, { ok: true }, env);
      recordQueryFeedbackObligation(top, { available: true, query_id: "rq_mid_top" }, env);
      expect(entriesOf(env, top)).toEqual(before);
      expect(entriesOf(env, pSession)).toEqual({});
      expect(handlesIn(pendingCompletionRecoveryInstruction(pSession, env))).toEqual([]);
      const completed = observeSuccessfulCompletionTool(top, "record_preference", retrieved.arguments, { recorded: true }, env);
      expect(completed.closed.map((item) => item.id)).toEqual([preferenceId("mid")]);
      expect(ownRecords(env, cSession)).toEqual([]);
      expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
      expect((await retrieve(env, asked[0])).status).toBe("not_found");
      for (const ledgerId of [pSession, top, cSession]) {
        expect(handlesIn(pendingCompletionRecoveryInstruction(ledgerId, env))).toEqual([]);
      }
    });

    // The same, read by read: every read that is not a prompt's or a stop's
    // asks nothing, whichever call ends in it (R3C-1), one case per read.
    const heldReads = [
      ["a query (query_skills: the debt it records)", (env, top) =>
        observeSuccessfulCompletionTool(top, "query_skills", { query: "deploy" }, { query_id: "rq_r3_held_query", skills: [], resources: [], query_feedback: { available: true, query_id: "rq_r3_held_query" } }, env)],
      ["a skill opened (get_skill: a use already owed for)", (env, top) =>
        observeSuccessfulCompletionTool(top, "get_skill", { query_id: "rq_r3_held_skill", result_id: "qres_r3_held_skill", slug: "held-skill" }, { ok: true }, env)],
      ["a capture (capture_learning: an equal debt already held)", (env, top) => capture(env, top, "held-capture")],
      ["feedback that asks for a remembrance (submit_feedback: an equal follow-up already held)", (env, top) =>
        observeSuccessfulCompletionTool(top, "submit_feedback", { query_id: "rq_r3_held_fu", result_id: "qres_r3_held_fu" }, { body: { next_step: { submit_remembrance_payload: { type: "skill_feedback", lesson: "Synthetic lesson: pin the fixture before comparing.", interaction: { query_id: "rq_r3_held_fu", result_id: "qres_r3_held_fu" } } } } }, env)],
      ["a contribution (submit_query_feedback: whether anything is left)", (env, top) =>
        observeSuccessfulCompletionTool(top, "submit_query_feedback", { query_id: "rq_r3_held_none" }, { accepted: true }, env)],
      // The two retained-hint returns: a response the MCP server gives for a
      // candidate kept on this machine, and the hint it opens shows that the
      // call took that return, not the end of the tool call.
      ["a private lesson kept on this machine (submit_private_lesson_candidate)", (env, top) => {
        const result = observeSuccessfulCompletionTool(top, "submit_private_lesson_candidate", {}, { body: { draft_id: "pld_r3heldlesson01", state: "retry_scheduled", status: "not_submitted", retained_locally: true } }, env);
        expect(result.opened.map((item) => `${item.kind}:${item.draft_id}`)).toEqual(["private_lesson:pld_r3heldlesson01"]);
        return result;
      }],
      ["a private skill kept on this machine (submit_private_skill_candidate)", (env, top) => {
        const result = observeSuccessfulCompletionTool(top, "submit_private_skill_candidate", {}, { body: { draft_id: "psd_r3heldskill01", state: "retry_scheduled", status: "not_submitted", retained_locally: true, next_action: { tool: "retry_private_skill_candidate", arguments: { draft_id: "psd_r3heldskill01" } } } }, env);
        expect(result.opened.map((item) => `${item.kind}:${item.draft_id}`)).toEqual(["private_skill:psd_r3heldskill01"]);
        return result;
      }],
      ["any other tool (exec)", (env, top) => observeSuccessfulCompletionTool(top, "exec", { command: "true" }, { ok: true }, env)],
      ["the engagement marked handled (markCurrentEngagementHandled)", (env, top) => {
        recordTaskEligibility(top, env);
        return markCurrentEngagementHandled(top, env);
      }],
    ];
    heldReads.forEach(([what, call], index) => {
      it(`moves nothing at ${what}: a run asked through an entry keeps it while a session between runs again, and that session is not asked (R3C-1)`, () => {
        const env = freshEnv();
        const top = `f2-r3-held-${index}-top`;
        const pSession = `f2-r3-held-${index}-p`;
        const cSession = `f2-r3-held-${index}-c`;
        const gSession = `f2-r3-held-${index}-g`;
        endRun(env, top, childId(0x9b4), pSession);
        endRun(env, pSession, childId(0x9b5), cSession);
        capture(env, gSession, `held-${index}`);
        endRun(env, cSession, childId(0x9b6), gSession);
        const before = entriesOf(env, top);
        expect(Object.keys(before)).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
        expect(handlesIn(pendingCompletionRecoveryInstruction(top, env))).toHaveLength(1);
        expect(releaseCompletionForward(pSession, env)).toBe(true);
        call(env, top);
        expect(entriesOf(env, top)).toEqual(before);
        expect(entriesOf(env, pSession)).toEqual({});
        expect(handlesIn(pendingCompletionRecoveryInstruction(pSession, env))).toEqual([]);
      });
    });

    // What (A) leaves open (R3C-1, keeper order; d-a.md residual 9): a run
    // already asked stays asked until it ends, and the keeper's own prompt
    // names its own records. Both are asked; whichever completes first
    // settles the debt once, where it is kept, and the other's completion
    // settles nothing here (its call still reaches the service).
    for (const first of ["asked run", "keeper"]) {
      it(`asks the run that was asked and the keeper's session that runs again meanwhile for one kept debt, and settles it once, where it is kept: the ${first} completes first and the other's completion settles nothing (R3C-1, keeper order: the window (A) leaves)`, async () => {
        const env = freshEnv();
        const tag = first === "keeper" ? "k" : "a";
        const top = `f2-r3-window-${tag}-top`;
        const cSession = `f2-r3-window-${tag}-c`;
        const gSession = `f2-r3-window-${tag}-g`;
        capture(env, gSession, "window");
        endRun(env, cSession, childId(0x9c1), gSession);
        endRun(env, top, childId(0x9c0), cSession);
        const asked = handlesIn(pendingCompletionRecoveryInstruction(top, env));
        expect(asked).toHaveLength(1);
        const retrieved = await retrieve(env, asked[0]);
        observeSuccessfulCompletionTool(top, "get_pending_action_payload", asked[0], { status: "retrieved" }, env);
        // C's session runs again while the top's run goes on: its prompt
        // names the same record.
        expect(releaseCompletionForward(cSession, env)).toBe(true);
        expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toEqual(asked);
        observeSuccessfulCompletionTool(top, "exec", { command: "true" }, { ok: true }, env);
        const order = first === "keeper" ? [cSession, top] : [top, cSession];
        const closed = order.map(
          (ledgerId) =>
            observeSuccessfulCompletionTool(ledgerId, "record_preference", retrieved.arguments, { recorded: true }, env).closed.length,
        );
        expect(closed).toEqual([1, 0]);
        expect(ownRecords(env, cSession)).toEqual([]);
        expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
        for (const ledgerId of [top, cSession]) {
          expect(handlesIn(pendingCompletionRecoveryInstruction(ledgerId, env))).toEqual([]);
        }
      });
    }

    // R4C-1 (round 4): the same window when the run was asked through an
    // association. The release of the session that runs again (the keeper,
    // or a session between) writes only its marker, so the association
    // stays until the asked run's session next reads at a prompt or stop:
    // the asked run's completion or decline settles through it once, where
    // the debt is kept, the other session's completion settles nothing, and
    // nobody is asked afterwards (the round-4 core reviewer's cases).
    const silentOr = (env, visible) => {
      if (!visible) delete env.REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY;
      return env;
    };
    const askedNow = (env, ledgers) => ledgers.map((ledgerId) => handlesIn(pendingCompletionRecoveryInstruction(ledgerId, env)).length);
    for (const visible of [true, false]) {
      for (const keeperActs of [true, false]) {
        it(`settles once, through the association it was asked through, a kept debt whose keeper's session runs again meanwhile, and asks nobody afterwards: the keeper ${keeperActs ? "completes it too" : "ends its run without acting"} (${visible ? "visible" : "silent"} mode; R4C-1, W1)`, async () => {
          const env = silentOr(freshEnv(), visible);
          const tag = `${visible ? "v" : "s"}${keeperActs ? "k" : "n"}`;
          const top = `f2-r4-aw-${tag}-top`;
          const pSession = `f2-r4-aw-${tag}-p`;
          const cSession = `f2-r4-aw-${tag}-c`;
          const gSession = `f2-r4-aw-${tag}-g`;
          endRun(env, top, childId(0xa00), pSession);
          endRun(env, pSession, childId(0xa01), cSession);
          // G ends after C and P: the top holds an association to C's ledger.
          capture(env, gSession, `aw-${tag}`);
          endRun(env, cSession, childId(0xa02), gSession);
          const before = entriesOf(env, top);
          expect(Object.keys(before)).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
          const asked = handlesIn(pendingCompletionRecoveryInstruction(top, env));
          expect(asked).toHaveLength(1);
          const retrieved = await retrieve(env, asked[0]);
          observeSuccessfulCompletionTool(top, "get_pending_action_payload", asked[0], { status: "retrieved" }, env);
          // C's session runs again while the top's run goes on: the top keeps
          // its association, and C's prompt names the same record (W1).
          expect(releaseCompletionForward(cSession, env)).toBe(true);
          expect(entriesOf(env, top)).toEqual(before);
          expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toEqual(asked);
          const completed = observeSuccessfulCompletionTool(top, "record_preference", retrieved.arguments, { recorded: true }, env);
          expect(completed.closed.map((item) => item.id)).toEqual([preferenceId(`aw-${tag}`)]);
          expect(ownRecords(env, cSession)).toEqual([]);
          if (keeperActs) {
            expect(observeSuccessfulCompletionTool(cSession, "record_preference", retrieved.arguments, { recorded: true }, env).closed).toEqual([]);
          } else {
            endRun(env, pSession, childId(0xa01), cSession);
          }
          expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
          expect((await retrieve(env, asked[0])).status).toBe("not_found");
          expect(askedNow(env, [top, pSession, cSession])).toEqual([0, 0, 0]);
        });
      }
    }
    for (const betweenActs of [true, false]) {
      it(`settles once, through the association it was asked through, a kept debt whose session between runs again meanwhile, and asks nobody afterwards: that session ${betweenActs ? "completes it too" : "ends its run without acting"} (R4C-1, W1)`, async () => {
        const env = freshEnv();
        const tag = `b${betweenActs ? "k" : "n"}`;
        const top = `f2-r4-aw-${tag}-top`;
        const pSession = `f2-r4-aw-${tag}-p`;
        const cSession = `f2-r4-aw-${tag}-c`;
        const gSession = `f2-r4-aw-${tag}-g`;
        endRun(env, top, childId(0xa10), pSession);
        // G ends during C's run (its record moves whole into C's ledger);
        // C ends after P: P points to it, and the top holds an association
        // to P's ledger.
        capture(env, gSession, `aw-${tag}`);
        endRun(env, cSession, childId(0xa12), gSession);
        endRun(env, pSession, childId(0xa11), cSession);
        const before = entriesOf(env, top);
        expect(Object.keys(before)).toEqual([`durable/${associationFileName(ledgerOf(pSession))}`]);
        const asked = handlesIn(pendingCompletionRecoveryInstruction(top, env));
        expect(asked).toHaveLength(1);
        const retrieved = await retrieve(env, asked[0]);
        observeSuccessfulCompletionTool(top, "get_pending_action_payload", asked[0], { status: "retrieved" }, env);
        expect(releaseCompletionForward(pSession, env)).toBe(true);
        expect(entriesOf(env, top)).toEqual(before);
        expect(handlesIn(pendingCompletionRecoveryInstruction(pSession, env))).toEqual(asked);
        const completed = observeSuccessfulCompletionTool(top, "record_preference", retrieved.arguments, { recorded: true }, env);
        expect(completed.closed.map((item) => item.id)).toEqual([preferenceId(`aw-${tag}`)]);
        expect(ownRecords(env, cSession)).toEqual([]);
        if (betweenActs) {
          expect(observeSuccessfulCompletionTool(pSession, "record_preference", retrieved.arguments, { recorded: true }, env).closed).toEqual([]);
        } else {
          endRun(env, top, childId(0xa10), pSession);
        }
        expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
        expect(askedNow(env, [top, pSession, cSession])).toEqual([0, 0, 0]);
      });
    }
    for (const visible of [true, false]) {
      it(`settles a decline once, through the association it was asked through, when the keeper's session runs again meanwhile, and asks nobody after the keeper's run ends (${visible ? "visible" : "silent"} mode; R4C-1, W1)`, () => {
        const env = silentOr(freshEnv(), visible);
        const tag = `d${visible ? "v" : "s"}`;
        const top = `f2-r4-ad-${tag}-top`;
        const pSession = `f2-r4-ad-${tag}-p`;
        const cSession = `f2-r4-ad-${tag}-c`;
        const gSession = `f2-r4-ad-${tag}-g`;
        endRun(env, top, childId(0xa20), pSession);
        endRun(env, pSession, childId(0xa21), cSession);
        capture(env, gSession, `ad-${tag}`);
        endRun(env, cSession, childId(0xa22), gSession);
        const asked = handlesIn(pendingCompletionRecoveryInstruction(top, env));
        expect(asked).toHaveLength(1);
        expect(releaseCompletionForward(cSession, env)).toBe(true);
        expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toEqual(asked);
        const declined = observeSuccessfulCompletionTool(top, "decline_pending_action", { action_id: asked[0].action_id, reason: "not_reusable" }, { declined: true }, env);
        expect(declined.closed.map((item) => item.id)).toEqual([preferenceId(`ad-${tag}`)]);
        expect(ownRecords(env, cSession)).toEqual([]);
        // The keeper's run ends without acting: nothing is left to hand up.
        endRun(env, pSession, childId(0xa21), cSession);
        expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(0);
        expect(askedNow(env, [top, pSession, cSession])).toEqual([0, 0, 0]);
      });
    }

    // R2A-24, load-bearing since R4C-1: a hand-over's first association, which
    // stays when its page cannot hand everything over, says it is OpenClaw's
    // like every entry that hand-over writes. C's run 2 ends while C's agent
    // ledger refuses its record home, so the fold cannot move C's debt and
    // leaves its association to C's session ledger there, and the hook stops
    // after the fold (the Gateway killed): the top reaches that agent ledger
    // through the onward association. Once C's session runs again, the top's
    // read leaves the debt to C and removes the association; were it not
    // flagged, the top would follow it as its own and be asked beside C.
    it("leaves to a session that runs again what the first association of its own fold reaches, when that fold could not hand everything over and the hand-up stopped there: the session above is not asked (R2A-24, R4C-1)", () => {
      const env = freshEnv();
      const top = "f2-r4-first-top";
      const cSession = "f2-r4-first-c";
      const agent = agentLedgerIdFor(stopOf(top, childId(0xa30)));
      // C's run 1 ends with nothing: its markers lead to the top.
      endRun(env, top, childId(0xa30), cSession);
      // C's session runs again and records a debt; C's agent ledger refuses
      // its record home (a file stands where that directory goes) while the
      // hook that ends C's run 2 folds, and stops.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      recordQueryFeedbackObligation(cSession, { available: true, query_id: "rq_r4_first" }, env);
      const refused = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(agent)}.obligations`);
      writeFileSync(refused, "not a directory\n", { mode: 0o600 });
      foldTurnLedgerIntoSession({ session_id: agent, turn_id: cSession }, env, FORWARD);
      rmSync(refused);
      expect(ownRecords(env, cSession)).toEqual(["rq_r4_first<none"]);
      expect(entriesOf(env, agent)).toEqual({
        [`durable/${associationFileName(ledgerOf(cSession))}`]:
          `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: ledgerOf(cSession), transferred_from: null, forwarded: true })}\n`,
      });
      expect(Object.keys(entriesOf(env, top))).toEqual([`durable/${associationFileName(ledgerOf(agent))}`]);
      // C's session runs again: the top's read leaves the debt to C.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(readCompletionObligations(top, env)).toEqual([]);
      expect(entriesOf(env, agent)).toEqual({});
      expect(pendingCompletionRecoveryInstruction(top, env) ?? "").not.toContain("rq_r4_first");
      expect(pendingCompletionRecoveryInstruction(cSession, env)).toContain("rq_r4_first");
    });

    // R4C-2: a stop's read decides who is asked, as a prompt's does (A2): in
    // visible mode the top's stop, while the session that keeps the debt
    // runs again, leaves the debt to that session and names nothing, whether
    // the top holds an association to the keeper's ledger (G ended after C)
    // or a pointer to what it keeps (G ended during C's run). The round-4
    // core reviewer's cases.
    for (const way of ["association", "pointer"]) {
      it(`leaves a debt to the keeper's session that runs again at the top's stop, which names nothing, when the top holds ${way === "association" ? "an association to the keeper's ledger" : "a pointer to what the keeper keeps"} (visible mode; R4C-2, A2)`, () => {
        const env = freshEnv();
        const tag = way === "association" ? "a" : "p";
        const top = `f2-r4-stop-${tag}-top`;
        const pSession = `f2-r4-stop-${tag}-p`;
        const cSession = `f2-r4-stop-${tag}-c`;
        const gSession = `f2-r4-stop-${tag}-g`;
        if (way === "association") {
          endRun(env, top, childId(0xa40), pSession);
          endRun(env, pSession, childId(0xa41), cSession);
          capture(env, gSession, `stop-${tag}`);
          endRun(env, cSession, childId(0xa42), gSession);
        } else {
          capture(env, gSession, `stop-${tag}`);
          endRun(env, cSession, childId(0xa42), gSession);
          endRun(env, top, childId(0xa40), cSession);
        }
        expect(Object.keys(entriesOf(env, top))).toHaveLength(1);
        expect(releaseCompletionForward(cSession, env)).toBe(true);
        expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toHaveLength(1);
        const decision = decideStop({ hook_event_name: "Stop", session_id: top }, { env });
        expect(decision.why).toBe("registry_not_used");
        expect(handlesIn(decision.reason)).toEqual([]);
        expect(entriesOf(env, top)).toEqual({});
        expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toHaveLength(1);
      });
    }

    // H4 F1 (round 4, R4C-7): 639298f2's OpenClaw adapter wrote its pointers
    // without the flag, under the same name and version as this branch does.
    // A hand-over writes its flagged pointer over such a pointer, so the
    // session above leaves the debt to the keeper's session once that runs
    // again, instead of following the earlier build's pointer as its own.
    it("writes a hand-over's flagged pointer over an unflagged one of the same name that an earlier build left, so the session above leaves the debt to the keeper's session that runs again (H4 F1, R4C-7)", () => {
      const env = freshEnv();
      const top = "f2-r4-upgrade-top";
      const cSession = "f2-r4-upgrade-c";
      const gSession = "f2-r4-upgrade-g";
      // G's kept preference lands in C's session ledger, which keeps it.
      capture(env, gSession, "upgrade");
      endRun(env, cSession, childId(0xa51), gSession);
      const id = preferenceId("upgrade");
      expect(ownRecords(env, cSession)).toEqual([`capture_next_action<${childId(0xa51)}`]);
      // The top holds the pointer an earlier build wrote for it, unflagged.
      const pointer = join(pointerHome(env, top), pointerFileName(ledgerOf(cSession), id));
      mkdirSync(pointerHome(env, top), { recursive: true, mode: 0o700 });
      writeFileSync(pointer, pointerText(ledgerOf(cSession), id), { mode: 0o600 });
      // C's run ends: its hand-over writes the pointer again, flagged.
      endRun(env, top, childId(0xa50), cSession);
      expect(readFileSync(pointer, "utf8")).toBe(flaggedPointerText(ledgerOf(cSession), id));
      // C's session runs again: the top's read leaves the debt to C.
      expect(releaseCompletionForward(cSession, env)).toBe(true);
      expect(readCompletionObligations(top, env)).toEqual([]);
      expect(entriesOf(env, top)).toEqual({});
      expect(handlesIn(pendingCompletionRecoveryInstruction(top, env))).toEqual([]);
      expect(handlesIn(pendingCompletionRecoveryInstruction(cSession, env))).toHaveLength(1);
    });

    // Core delta note R4C-D1 (round 4): at a subagent's finalize OpenClaw
    // runs decideStop's read, then the hand-up, then writePromptedCount,
    // whose prompted mark reads again (index.mjs). The hand-up writes the
    // subagent's forwarding marker, so a flagged pointer it leaves in the
    // subagent's ledger belongs to the session above, which runs again, by
    // the time the mark reads. The mark asks, as decideStop's read does: it
    // moves that pointer to the session above and stamps nothing on the
    // debt. P's run ended and P runs again; S, its subagent, holds 64 debts
    // of its own and 65 flagged pointers to kept preferences, and its
    // hand-up moves one page, so one pointer stays.
    it("moves to the session above, unstamped, the flagged pointer a subagent's hand-up left in its ledger, when that subagent's finalize marks its debts prompted (visible mode; R4C-D1, R4C-M03)", () => {
      const env = freshEnv();
      const top = "f2-r4-mark-top";
      const pSession = "f2-r4-mark-p";
      const sSession = "f2-r4-mark-s";
      // P's run 1 ends, and P's session runs again.
      endRun(env, top, childId(0xb0), pSession);
      expect(releaseCompletionForward(pSession, env)).toBe(true);
      // S: 64 debts of its own, and 65 subagents' kept preferences it cannot
      // take whole.
      fillOwn(env, sSession);
      for (let index = 0; index < 65; index += 1) {
        capture(env, `f2-r4-mark-k${index}`, `mark${index}`);
        endRun(env, sSession, childId(0xc00 + index), `f2-r4-mark-k${index}`);
      }
      expect(listed(pointerHome(env, sSession))).toHaveLength(65);
      // S's finalize, in index.mjs's order: decide, hand up, mark.
      const decision = decideStop(
        { session_id: sSession, turn_id: "run-s-1", stop_hook_active: false },
        { env },
      );
      expect(decision.why).toBe("prompt_pending_obligations");
      endRun(env, pSession, childId(0xb1), sSession);
      const left = listed(pointerHome(env, sSession));
      expect(left).toHaveLength(1);
      const entry = JSON.parse(readFileSync(join(pointerHome(env, sSession), left[0]), "utf8"));
      expect(entry.forwarded).toBe(true);
      writePromptedCount(sSession, decision.useCount, env);
      expect(listed(pointerHome(env, sSession))).toEqual([]);
      expect(listed(pointerHome(env, pSession))).toContain(left[0]);
      const record = JSON.parse(
        readFileSync(join(retainedRoot(env), `${entry.ledger}.obligations`, recordFileName(entry.id)), "utf8"),
      );
      expect(record.id).toBe(entry.id);
      expect(record.prompted_at ?? null).toBeNull();
    });

    // R3C-2: submit_remembrance settles what its session was asked for
    // (step 4): its look-up of the pending follow-ups reads as a completion
    // does, so nothing the session holds moves before it settles.
    const followup = (env, ledgerId, tag) => {
      const payload = {
        type: "skill_feedback",
        lesson: `Synthetic lesson ${tag}: pin the fixture before comparing.`,
        interaction: { query_id: `rq_${tag}`, result_id: `qres_${tag}` },
      };
      recordTaskEligibility(ledgerId, env);
      recordPostUseFeedbackObligation(ledgerId, { query_id: `rq_${tag}`, result_id: `qres_${tag}` }, env);
      const observed = observeSuccessfulCompletionTool(
        ledgerId,
        "submit_feedback",
        { query_id: `rq_${tag}`, result_id: `qres_${tag}` },
        { body: { next_step: { submit_remembrance_payload: payload } } },
        env,
      );
      expect(observed.pending).toEqual([expect.objectContaining({ kind: "remembrance_followup" })]);
      return payload;
    };
    const asksFor = (text, tag) =>
      String(text ?? "").includes(`query_id rq_${tag} and result_id qres_${tag}`) &&
      String(text).includes("call submit_remembrance");
    for (const way of ["pointer", "association"]) {
      it(`settles a nested kept follow-up its session was asked for through ${way === "pointer" ? "a pointer" : "an association"} when it submits the remembrance after a session below ran again: settled once, where it is kept, and asked of no one after (R3C-2, step 4)`, () => {
        const env = freshEnv();
        const tag = `r3_fu_${way}`;
        const top = `f2-r3-fu-${way}-top`;
        const pSession = `f2-r3-fu-${way}-p`;
        const cSession = `f2-r3-fu-${way}-c`;
        const gSession = `f2-r3-fu-${way}-g`;
        let payload;
        if (way === "pointer") {
          payload = followup(env, gSession, tag);
          endRun(env, cSession, childId(0x9d1), gSession);
          endRun(env, top, childId(0x9d0), cSession);
          expect(Object.keys(entriesOf(env, top))).toHaveLength(1);
        } else {
          endRun(env, top, childId(0x9d0), pSession);
          endRun(env, pSession, childId(0x9d1), cSession);
          payload = followup(env, gSession, tag);
          endRun(env, cSession, childId(0x9d2), gSession);
          expect(Object.keys(entriesOf(env, top))).toEqual([`durable/${associationFileName(ledgerOf(cSession))}`]);
        }
        expect(ownRecords(env, cSession)).toEqual([`rq_${tag}<${childId(way === "pointer" ? 0x9d1 : 0x9d2)}`]);
        expect(asksFor(pendingCompletionRecoveryInstruction(top, env), tag)).toBe(true);
        // The keeper's session (pointer) or the session between (association)
        // runs again before the top submits.
        expect(releaseCompletionForward(way === "pointer" ? cSession : pSession, env)).toBe(true);
        const submitted = observeSuccessfulCompletionTool(top, "submit_remembrance", payload, { accepted: true }, env);
        expect(submitted.closed.map((item) => item.kind)).toEqual(["remembrance_followup"]);
        expect(ownRecords(env, cSession)).toEqual([]);
        for (const ledgerId of [top, pSession, cSession]) {
          expect(asksFor(pendingCompletionRecoveryInstruction(ledgerId, env), tag)).toBe(false);
        }
      });
    }

    // K01: a walk cut at eight markers says nothing about the ledgers it
    // passed. One read meets two flagged pointers: E1, whose keeper K1 is
    // nine markers from a session that runs again (residual 13: followed),
    // then E2, whose keeper K2 is K1's second hop and seven markers from it.
    it("decides whose each flagged entry is from its own keeper: a walk cut at eight markers leaves the ledgers on it undecided, so an entry whose keeper lies on that walk still goes to the session that runs again within eight (K01)", () => {
      const env = freshEnv();
      const reader = "f2-r3-k01-reader";
      const record = sealedRecord(env, "k01");
      const [k1, k2] = keepCopies(env, record, 2, "f2-r3-k01-keeper");
      const hop = (index) => hash(`f2-r3-k01-hop-${index}`).slice(0, 16);
      const chain = [k1, hop(1), k2, hop(3), hop(4), hop(5), hop(6), hop(7), hop(8), hop(9)];
      for (let index = 0; index + 1 < chain.length; index += 1) forwardTo(env, chain[index], chain[index + 1]);
      writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${hop(9)}.forward.json`), RELEASED, { mode: 0o600 });
      // E1 in the reader's temporary home, examined first; E2 in its durable one.
      mkdirSync(temporaryHome(env, reader), { recursive: true, mode: 0o700 });
      writeFileSync(join(temporaryHome(env, reader), pointerFileName(k1, record.id)), flaggedPointerText(k1, record.id), { mode: 0o600 });
      flaggedPointers(env, reader, [k2], record.id);
      expect(readCompletionObligations(reader, env).map((item) => item.ledger)).toEqual([k1]);
      // E1 stays (promoted to the durable home); E2 went.
      expect(Object.values(entriesOf(env, reader))).toEqual([flaggedPointerText(k1, record.id)]);
      expect(listed(join(retainedRoot(env), `${hop(9)}.pointers`))).toEqual([pointerFileName(k2, record.id)]);
    });

    // K16: per examined foreign entry, at most one removal or move. An entry
    // whose keeper's own session runs again is removed; nothing is written.
    it("removes a flagged pointer when its keeper's own session runs again and writes nothing anywhere: neither of the keeper's pointer homes gains an entry (K16)", () => {
      const env = freshEnv();
      const holder = "f2-r3-k16-holder";
      const record = sealedRecord(env, "k16");
      const [keeper] = keepCopies(env, record, 1, "f2-r3-k16-keeper");
      mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`), RELEASED, { mode: 0o600 });
      flaggedPointers(env, holder, [keeper], record.id);
      expect(readCompletionObligations(holder, env)).toEqual([]);
      expect(entriesOf(env, holder)).toEqual({});
      expect(listed(join(retainedRoot(env), `${keeper}.pointers`))).toEqual([]);
      expect(listed(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.pointers`))).toEqual([]);
    });

    // K23a: a flagged pointer that cannot go to the session that asks for it
    // stays, and the read is incomplete (the association site is K23b, the
    // write-first case above).
    for (const where of ["its own home", "behind an association"]) {
      it(`leaves a flagged pointer the session that asks for it cannot take where it is, ${where}, and the read incomplete: ${where === "its own home" ? "the never-kept count stays" : "the association stays, and the pointer moves once that session's homes are usable"} (K23a)`, () => {
        const env = freshEnv();
        const tag = where === "its own home" ? "own" : "association";
        const reader = `f2-r3-k23a-${tag}-reader`;
        const record = sealedRecord(env, `k23a-${tag}`);
        const [keeper] = keepCopies(env, record, 1, `f2-r3-k23a-${tag}-keeper`);
        const pSession = `f2-r3-k23a-${tag}-p`;
        forwardTo(env, keeper, ledgerOf(pSession));
        writeFileSync(markerOf(env, pSession), RELEASED, { mode: 0o600 });
        // Both of P's pointer homes are links: nothing can be written there.
        const decoys = [join(env.XDG_STATE_HOME, "decoy-durable"), join(env.XDG_STATE_HOME, "decoy-temporary")];
        const homes = [pointerHome(env, pSession), temporaryHome(env, pSession)];
        homes.forEach((home, index) => {
          mkdirSync(decoys[index], { recursive: true, mode: 0o700 });
          mkdirSync(dirname(home), { recursive: true, mode: 0o700 });
          symlinkSync(decoys[index], home);
        });
        const name = pointerFileName(keeper, record.id);
        if (where === "its own home") {
          flaggedPointers(env, reader, [keeper], record.id);
          writeFileSync(overflowFile(env, reader), "1\n", { mode: 0o600 });
          expect(readCompletionObligations(reader, env)).toEqual([]);
          expect(Object.keys(entriesOf(env, reader))).toEqual([`durable/${name}`]);
          expect(existsSync(overflowFile(env, reader))).toBe(true);
          for (const decoy of decoys) expect(readdirSync(decoy)).toEqual([]);
          return;
        }
        const between = hash("f2-r3-k23a-between").slice(0, 16);
        mkdirSync(join(retainedRoot(env), `${between}.pointers`), { recursive: true, mode: 0o700 });
        writeFileSync(join(retainedRoot(env), `${between}.pointers`, name), flaggedPointerText(keeper, record.id), { mode: 0o600 });
        mkdirSync(pointerHome(env, reader), { recursive: true, mode: 0o700 });
        const association = `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: between, transferred_from: null, forwarded: true })}\n`;
        writeFileSync(join(pointerHome(env, reader), associationFileName(between)), association, { mode: 0o600 });
        expect(readCompletionObligations(reader, env)).toEqual([]);
        expect(entriesOf(env, reader)).toEqual({ [`durable/${associationFileName(between)}`]: association });
        expect(listed(join(retainedRoot(env), `${between}.pointers`))).toEqual([name]);
        for (const decoy of decoys) expect(readdirSync(decoy)).toEqual([]);
        for (const home of homes) rmSync(home);
        expect(readCompletionObligations(reader, env)).toEqual([]);
        expect(listed(pointerHome(env, pSession))).toEqual([name]);
        expect(listed(join(retainedRoot(env), `${between}.pointers`))).toEqual([]);
      });
    }

    // K24: the owner walk reads a marker within the 1,024-byte bound (R2-1).
    for (const [shape, size] of [["released", 1025], ["released", 1024], ["forwarding", 1025], ["forwarding", 1024]]) {
      const followed = size > 1024;
      it(`reads a ${shape} marker of ${size} bytes ${followed ? "not at all while it decides whose an entry is, so the entry is followed as for a keeper with no marker" : "while it decides whose an entry is, so the entry goes to the session that runs again"} (K24, R2-1)`, () => {
        const env = freshEnv();
        const reader = `f2-r3-k24-${shape}-${size}-reader`;
        const record = sealedRecord(env, `k24-${shape}-${size}`);
        const [keeper] = keepCopies(env, record, 1, `f2-r3-k24-${shape}-${size}-keeper`);
        const next = hash(`f2-r3-k24-${shape}-${size}-next`).slice(0, 16);
        const padded = (object) => {
          const text = JSON.stringify(object);
          return `${text}${" ".repeat(size - text.length - 1)}\n`;
        };
        mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
        if (shape === "released") {
          writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`), padded({ version: "completion-obligation-released-v1" }), { mode: 0o600 });
        } else {
          writeFileSync(
            join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`),
            padded({ version: "completion-obligation-forward-v1", ledger: next, transferred_from: null }),
            { mode: 0o600 },
          );
          writeFileSync(join(env.REMEMBRANCE_USAGE_DIR, `${next}.forward.json`), RELEASED, { mode: 0o600 });
        }
        expect(statSync(join(env.REMEMBRANCE_USAGE_DIR, `${keeper}.forward.json`)).size).toBe(size);
        flaggedPointers(env, reader, [keeper], record.id);
        expect(readCompletionObligations(reader, env).map((item) => item.ledger)).toEqual(followed ? [keeper] : []);
        expect(Object.keys(entriesOf(env, reader))).toHaveLength(followed ? 1 : 0);
        expect(listed(join(retainedRoot(env), `${next}.pointers`))).toEqual(
          !followed && shape === "forwarding" ? [pointerFileName(keeper, record.id)] : [],
        );
      });
    }

    // K18 (R3C-4): a session that runs again but cannot write its released
    // marker loses its forwarding marker all the same, so nothing is
    // forwarded through it; as with a lost released marker (residual 11),
    // the session above is asked too until the session's next end.
    it("removes the forwarding marker when its released marker cannot be written: the session above is asked too, as when a released marker is lost, nothing is lost, and the keeper's next end asks the session above alone (K18, R3C-4)", async () => {
      const env = freshEnv();
      const top = "f2-r3-unwritable-top";
      const cSession = "f2-r3-unwritable-c";
      const gSession = "f2-r3-unwritable-g";
      const view = viewer(env, { c: cSession }, ["unwritable"]);
      capture(env, gSession, "unwritable");
      endRun(env, cSession, childId(0x9e1), gSession);
      endRun(env, top, childId(0x9e0), cSession);
      expect(JSON.parse(readFileSync(markerOf(env, cSession), "utf8")).version).toBe("completion-obligation-forward-v1");
      const write = nodeFs.writeFileSync;
      let refused = 0;
      nodeFs.writeFileSync = function refusing(path, data, ...rest) {
        if (String(data) === RELEASED) {
          refused += 1;
          throw Object.assign(new Error("EIO: refused by the test"), { code: "EIO" });
        }
        return write.call(this, path, data, ...rest);
      };
      syncBuiltinESMExports();
      let released;
      try {
        released = releaseCompletionForward(cSession, env);
      } finally {
        nodeFs.writeFileSync = write;
        syncBuiltinESMExports();
      }
      expect(refused).toBe(1);
      expect(released).toBe(true);
      expect(existsSync(markerOf(env, cSession))).toBe(false);
      expect(view(top)).toEqual(["pref:unwritable@c"]);
      expect(view(cSession)).toEqual(["pref:unwritable"]);
      expect(inventoryRetainedKeyConsumers(env).consumers.total).toBe(1);
      endRun(env, top, childId(0x9e0), cSession);
      expect(JSON.parse(readFileSync(markerOf(env, cSession), "utf8")).version).toBe("completion-obligation-forward-v1");
      await recoverAndComplete(env, top, pendingCompletionRecoveryInstruction(top, env), (agentId) => {
        expect(agentId).toBe(childId(0x9e1));
        return "unwritable";
      });
    });

    // R3C-6: a move never writes over an entry of that name that names the
    // same ledger: the first holder's association stays as it is, and the
    // second's goes.
    it("keeps the association a session already holds when another holder's association to the same ledger moves there: the first stays as it is, the mover's goes, and the debt behind them is named once (R3C-6)", () => {
      const env = freshEnv();
      const owner = "f2-r3-collide-owner";
      const record = sealedRecord(env, "collide");
      const [kept] = keepCopies(env, record, 1, "f2-r3-collide-ledger");
      forwardTo(env, kept, ledgerOf(owner));
      writeFileSync(markerOf(env, owner), RELEASED, { mode: 0o600 });
      const name = associationFileName(kept);
      const texts = [0x9f1, 0x9f2].map(
        (agent) =>
          `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: kept, transferred_from: { agent_id: childId(agent), transcript_path: null }, forwarded: true })}\n`,
      );
      const holders = ["f2-r3-collide-first", "f2-r3-collide-second"];
      holders.forEach((holder, index) => {
        mkdirSync(pointerHome(env, holder), { recursive: true, mode: 0o700 });
        writeFileSync(join(pointerHome(env, holder), name), texts[index], { mode: 0o600 });
      });
      for (const holder of holders) {
        expect(readCompletionObligations(holder, env)).toEqual([]);
        expect(entriesOf(env, holder)).toEqual({});
        expect(entriesOf(env, owner)).toEqual({ [`durable/${name}`]: texts[0] });
      }
      expect(readCompletionObligations(owner, env).map((item) => item.id)).toEqual([record.id]);
    });

    // The rest of the rule, entry by entry: an entry of that name naming the
    // same ledger stays whatever its flag; one that names something else, or
    // cannot be read, is written over, as by every write (R3C-6).
    const flaggedAssociation = (ledger, agent) =>
      `${JSON.stringify({ version: "completion-obligation-association-v1", ledger, transferred_from: { agent_id: childId(agent), transcript_path: null }, forwarded: true })}\n`;
    for (const [what, kind, existingOf, stays] of [
      ["Claude Code's or Codex's association to the same ledger, without the flag", "association", (kept) => `${JSON.stringify({ version: "completion-obligation-association-v1", ledger: kept, transferred_from: null })}\n`, true],
      ["an association of that name that names another ledger", "association", () => flaggedAssociation(hash("f2-r3-collide-other").slice(0, 16), 0x9f3), false],
      ["an entry of that name that cannot be read as one", "association", () => "not an entry\n", false],
      ["a pointer of that name to another record of the same keeper", "pointer", (kept) => flaggedPointerText(kept, `${preferenceId("collide-other")}`), false],
    ]) {
      it(`${stays ? "keeps" : "writes over"} ${what} when a flagged ${kind} of that name moves there (R3C-6)`, () => {
        const env = freshEnv();
        const tag = `${kind}-${stays}-${what.length}`;
        const owner = `f2-r3-collide-${tag}-owner`;
        const holder = `f2-r3-collide-${tag}-holder`;
        const record = sealedRecord(env, `collide-${tag}`);
        const [kept] = keepCopies(env, record, 1, `f2-r3-collide-${tag}-ledger`);
        forwardTo(env, kept, ledgerOf(owner));
        writeFileSync(markerOf(env, owner), RELEASED, { mode: 0o600 });
        const name = kind === "association" ? associationFileName(kept) : pointerFileName(kept, record.id);
        const moving = kind === "association" ? flaggedAssociation(kept, 0x9f2) : flaggedPointerText(kept, record.id);
        const existing = existingOf(kept);
        for (const [ledgerId, text] of [[holder, moving], [owner, existing]]) {
          mkdirSync(pointerHome(env, ledgerId), { recursive: true, mode: 0o700 });
          writeFileSync(join(pointerHome(env, ledgerId), name), text, { mode: 0o600 });
        }
        expect(readCompletionObligations(holder, env)).toEqual([]);
        expect(entriesOf(env, holder)).toEqual({});
        expect(entriesOf(env, owner)).toEqual({ [`durable/${name}`]: stays ? existing : moving });
        expect(readCompletionObligations(owner, env).map((item) => item.id)).toEqual([record.id]);
      });
    }
  });
});
