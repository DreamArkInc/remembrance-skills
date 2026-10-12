// The 1,024-byte bound on what a read follows (Codex Task 15 review F2,
// R-W2 round 2 R2-1): a valid association and a valid forwarding marker,
// each padded with trailing whitespace to one byte past the bound, are
// skipped, so nothing behind them is named, the read stays incomplete and
// nothing is drained or removed; the same files at exactly 1,024 bytes are
// followed. Shared by the canonical hook core's tests and the OpenClaw copy's,
// so each copy's bound is pinned. Only content-free debts: no key is needed.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

const BOUND = 1024;
const hash = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");
const ledgerOf = (id) => hash(id).slice(0, 16);
const listed = (directory) => (existsSync(directory) ? readdirSync(directory) : []);

// `value` as one JSON line, then spaces up to exactly `bytes`.
function padTo(path, value, bytes) {
  const text = `${JSON.stringify(value)}\n`;
  const length = Buffer.byteLength(text, "utf8");
  if (length > bytes) throw new Error(`fixture: ${length} > ${bytes}`);
  const padded = `${text}${" ".repeat(bytes - length)}`;
  writeFileSync(path, padded, { mode: 0o600 });
  expect(statSync(path).size).toBe(bytes);
  return padded;
}

export function checkPointerBound({
  agentLedgerIdFor,
  readCompletionObligations,
  recordQueryFeedbackObligation,
  transferSubagentObligations,
}) {
  const root = mkdtempSync(join(tmpdir(), "remembrance-pointer-bound-"));
  const envFor = (name) => ({
    REMEMBRANCE_USAGE_DIR: join(root, name, "usage"),
    XDG_STATE_HOME: join(root, name, "state"),
    XDG_CONFIG_HOME: join(root, name, "config"),
    REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
  });
  const pointerHome = (env, ledgerId) =>
    join(
      env.XDG_STATE_HOME,
      "remembrance",
      "private-learning-lifecycle",
      "retained",
      `${ledgerOf(ledgerId)}.pointers`,
    );
  const queryIds = (items) => items.map((item) => [item.query_id, item.ledger]);
  try {
    // An association: the parent's one action never kept (its 65th debt,
    // counted) stays counted until a complete read finds nothing left; the
    // keeper holds one content-free debt the association reaches.
    const env = envFor("association");
    const parent = "pointer-bound-parent";
    const keeper = "pointer-bound-keeper";
    for (let index = 0; index < 65; index += 1) {
      recordQueryFeedbackObligation(
        parent,
        { available: true, query_id: `rq_own_${index}` },
        env,
      );
    }
    const own = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(parent)}.obligations`);
    for (const name of listed(own)) rmSync(join(own, name));
    const count = join(
      env.REMEMBRANCE_USAGE_DIR,
      `${ledgerOf(parent)}.obligations-overflow.json`,
    );
    expect(existsSync(count)).toBe(true);
    recordQueryFeedbackObligation(
      keeper,
      { available: true, query_id: "rq_kept" },
      env,
    );
    const kept = join(env.REMEMBRANCE_USAGE_DIR, `${ledgerOf(keeper)}.obligations`);
    expect(listed(kept)).toHaveLength(1);
    mkdirSync(pointerHome(env, parent), { recursive: true, mode: 0o700 });
    const association = join(
      pointerHome(env, parent),
      `${hash(`association:${ledgerOf(keeper)}`).slice(0, 32)}.json`,
    );
    const associationValue = {
      version: "completion-obligation-association-v1",
      ledger: ledgerOf(keeper),
      transferred_from: null,
    };
    // One byte past the bound: skipped, and the read is not complete.
    let text = padTo(association, associationValue, BOUND + 1);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(count)).toBe(true);
    expect(readFileSync(association, "utf8")).toBe(text);
    expect(listed(kept)).toHaveLength(1);
    // At the bound: followed.
    padTo(association, associationValue, BOUND);
    expect(queryIds(readCompletionObligations(parent, env))).toEqual([
      ["rq_kept", ledgerOf(keeper)],
    ]);
    expect(existsSync(count)).toBe(true);
    // The keeper's own session settles its debt. Past the bound, nothing
    // is drained: the count and the association stay; at the bound the read
    // is complete, so both go.
    for (const name of listed(kept)) rmSync(join(kept, name));
    text = padTo(association, associationValue, BOUND + 1);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(count)).toBe(true);
    expect(readFileSync(association, "utf8")).toBe(text);
    padTo(association, associationValue, BOUND);
    expect(readCompletionObligations(parent, env)).toEqual([]);
    expect(existsSync(count)).toBe(false);
    expect(existsSync(association)).toBe(false);

    // A forwarding marker: a subagent session that handed over to the top
    // session; a nested subagent's late end hands into it, and the ledger
    // its marker leads to gets an association to it.
    const markers = envFor("marker");
    const top = "pointer-bound-top";
    const session = "pointer-bound-session";
    mkdirSync(markers.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
    const marker = join(
      markers.REMEMBRANCE_USAGE_DIR,
      `${ledgerOf(session)}.forward.json`,
    );
    const markerValue = {
      version: "completion-obligation-forward-v1",
      ledger: ledgerOf(top),
      transferred_from: null,
    };
    const nestedEnd = (agentId, queryId) => {
      const stop = {
        hook_event_name: "SubagentStop",
        session_id: session,
        agent_id: agentId,
      };
      recordQueryFeedbackObligation(
        agentLedgerIdFor(stop),
        { available: true, query_id: queryId },
        markers,
      );
      transferSubagentObligations(stop, markers, { forward: true });
    };
    // One byte past the bound: not followed. The debt waits in the session
    // it was handed into; the top session gets nothing and names nothing.
    text = padTo(marker, markerValue, BOUND + 1);
    nestedEnd("b0000000000000001", "rq_nested_first");
    expect(listed(pointerHome(markers, top))).toEqual([]);
    expect(readCompletionObligations(top, markers)).toEqual([]);
    expect(queryIds(readCompletionObligations(session, markers, { pointers: false }))).toEqual([
      ["rq_nested_first", undefined],
    ]);
    expect(readFileSync(marker, "utf8")).toBe(text);
    // At the bound: followed. The top session gets the association and
    // names both debts, kept in that session's ledger.
    padTo(marker, markerValue, BOUND);
    nestedEnd("b0000000000000002", "rq_nested_second");
    expect(listed(pointerHome(markers, top))).toEqual([
      `${hash(`association:${ledgerOf(session)}`).slice(0, 32)}.json`,
    ]);
    expect(queryIds(readCompletionObligations(top, markers)).sort()).toEqual([
      ["rq_nested_first", ledgerOf(session)],
      ["rq_nested_second", ledgerOf(session)],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
