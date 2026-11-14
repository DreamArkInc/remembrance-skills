// The one storage accessor for a pending action's retained payload, kept on
// this machine so a later demand, after compaction or in a fresh process, can
// hand it back verbatim: for a remembrance follow-up, the exact
// next_step.submit_remembrance_payload a submit_feedback call returned; for a
// durable preference (capture_next_action), the exact record_preference
// arguments a capture_learning preference route returned. The hook core seals
// it when it records the debt and opens it when a demand shows it; the
// bundled MCP server's local get_pending_action_payload opens it for the
// agent that owes it. Node built-ins only; no network, no process access.
//
// On disk: owner decision 2 (Task 13) approved encrypted local retention with
// the plugin's existing local encryption, no new prompts, existing records
// readable and keys never switched; it set no expiry. A remembrance_followup
// or capture_next_action record whose payload is kept lives, until the
// action is resolved (completed, declined or withdrawn), in the durable
// per-user state directory:
// <state>/remembrance/private-learning-lifecycle/retained/<ledger>.obligations/<32 hex>.json
// (<state> is XDG_STATE_HOME or ~/.local/state; mode 0600, directories 0700,
// whole record at most 12 KiB). An earlier build kept it in the temporary
// usage directory, <usage dir>/<ledger>.obligations/<32 hex>.json, which the
// operating system may empty; both are read, and the hook moves such a
// record to the durable directory on its next read. Age never removes it.
// The record keeps the payload only as
//   local_resupply_envelope: { version "completion-resupply-envelope-v1",
//     algorithm "aes-256-gcm", key_source "os_keychain" | "mode_0600_file",
//     nonce (12 bytes), ciphertext, auth_tag (16 bytes), base64url }
// sealed with the private-learning outbox key named by key_source, over the
// UTF-8 JSON as returned, authenticated with the obligation id, which names
// the kind, and the payload digest: one kind's envelope never opens as the
// other's. A payload is kept whole or not at all; one that was not kept says
// why in local_resupply_payload_omitted ("too_large" or "key_unavailable").
// A follow-up an earlier build kept in plaintext (local_resupply_payload)
// stays readable here and is never rewritten; preference arguments were never
// kept in plaintext, and a plaintext copy beside one is never returned.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const RESUPPLY_ENVELOPE_VERSION = "completion-resupply-envelope-v1";
const OBLIGATION_VERSION = "completion-obligation-v1";
// The hook core's COMPLETION_OBLIGATION_MAX_BYTES.
const OBLIGATION_MAX_BYTES = 12 * 1024;
const LEDGER_ENTRY_LIMIT = 256;
const KEY_SOURCES = new Set(["os_keychain", "mode_0600_file"]);
// The kinds whose record can keep its payload sealed.
const RETAINED_KINDS = new Set(["remembrance_followup", "capture_next_action"]);
const HEX16 = /^[a-f0-9]{16}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

class ResupplyError extends Error {
  constructor(code) {
    super(`Retained payload unavailable: ${code}.`);
    this.name = "ResupplyError";
    this.code = code;
  }
}

// The hook core's payload digest: sorted-key JSON without the attestation
// flag an agent adds when it submits.
export function resupplyPayloadDigest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  try {
    const normalized = JSON.parse(JSON.stringify(payload));
    delete normalized.verified_attestation;
    return `sha256:${createHash("sha256")
      .update(JSON.stringify(sortKeys(normalized)), "utf8")
      .digest("hex")}`;
  } catch {
    return null;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortKeys(value[key]);
        return result;
      }, {});
  }
  return value;
}

function envelopeAad(obligation) {
  return Buffer.from(
    JSON.stringify({
      version: RESUPPLY_ENVELOPE_VERSION,
      obligation_id: obligation.id,
      payload_digest: obligation.payload_digest,
    }),
    "utf8",
  );
}

// `key` is { key: 32-byte Buffer, source }.
export function sealResupplyPayload(obligation, payload, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(envelopeAad(obligation));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    version: RESUPPLY_ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    key_source: key.source,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    auth_tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function normalizeResupplyEnvelope(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== RESUPPLY_ENVELOPE_VERSION ||
    value.algorithm !== "aes-256-gcm" ||
    !KEY_SOURCES.has(value.key_source) ||
    !base64urlOfLength(value.nonce, 12) ||
    !base64urlOfLength(value.auth_tag, 16) ||
    typeof value.ciphertext !== "string" ||
    !BASE64URL.test(value.ciphertext)
  ) {
    return null;
  }
  return {
    version: value.version,
    algorithm: value.algorithm,
    key_source: value.key_source,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    auth_tag: value.auth_tag,
  };
}

function base64urlOfLength(value, bytes) {
  return (
    typeof value === "string" &&
    BASE64URL.test(value) &&
    Buffer.from(value, "base64url").length === bytes
  );
}

// The plaintext's byte length, which GCM keeps: no key needed.
export function resupplyEnvelopeBytes(envelope) {
  return Buffer.from(envelope.ciphertext, "base64url").length;
}

// `key` is the 32-byte Buffer of envelope.key_source. Returns the payload
// exactly as sealed, or throws a ResupplyError.
export function openResupplyEnvelope(obligation, key) {
  const envelope = normalizeResupplyEnvelope(
    obligation?.local_resupply_envelope,
  );
  if (!envelope) throw new ResupplyError("envelope_invalid");
  let text;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAAD(envelopeAad(obligation));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64url"));
    text = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ResupplyError("decryption_failed");
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ResupplyError("decryption_failed");
  }
  if (
    resupplyPayloadDigest(payload) !== obligation.payload_digest ||
    !RETAINED_KINDS.has(obligation.kind) ||
    obligation.id !== `${obligation.kind}:${obligation.payload_digest}`
  ) {
    throw new ResupplyError("digest_mismatch");
  }
  return payload;
}

function usageDirectory(env) {
  return env?.REMEMBRANCE_USAGE_DIR
    ? String(env.REMEMBRANCE_USAGE_DIR)
    : join(tmpdir(), `remembrance-usage-${localUsageOwnerId()}`);
}

// The per-user state root the private-learning outbox and its lifecycle use.
function stateRoot(env, homeDirectory = homedir()) {
  const configured = String(env?.XDG_STATE_HOME ?? "").trim();
  return configured || join(homeDirectory, ".local", "state");
}

// Where an unresolved action's retained payload lives: the durable ledgers,
// beside the private-learning obligations, one <ledger>.obligations
// directory per ledger, as in the usage directory.
export function retainedLedgerRoot(env, homeDirectory = homedir()) {
  return join(
    stateRoot(env, homeDirectory),
    "remembrance",
    "private-learning-lifecycle",
    "retained",
  );
}

// The durable roots of retained records, private-learning-lifecycle and its
// retained directory, are used only while each is absent or a real directory
// of this user that no other user can write: a symlink there is refused,
// never followed. The hook's writer and readers, get_pending_action_payload
// and the inventory below apply this same rule, so none of them uses a root
// another refuses. A record the hook cannot keep there stays in its
// temporary ledger. With `retained: false` only the lifecycle directory is
// checked, for the private-learning hints the hook keeps in it.
export function retainedRootsUsable(
  env,
  homeDirectory = homedir(),
  { retained = true } = {},
) {
  const lifecycle = join(
    stateRoot(env, homeDirectory),
    "remembrance",
    "private-learning-lifecycle",
  );
  for (const path of retained
    ? [lifecycle, join(lifecycle, "retained")]
    : [lifecycle]) {
    try {
      assertPrivateDirectory(path);
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }
  return true;
}

function currentUserId() {
  try {
    const uid = userInfo().uid;
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  } catch {
    // Non-POSIX runtimes use the same home hash as the hook core.
  }
  return null;
}

function localUsageOwnerId() {
  const uid = currentUserId();
  if (uid !== null) return `uid-${uid}`;
  return `home-${createHash("sha256")
    .update(homedir())
    .digest("hex")
    .slice(0, 16)}`;
}

function assertOwned(metadata) {
  const uid = currentUserId();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error("Local state is not owned by the current user.");
  }
}

function assertPrivateDirectory(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Local state is not a regular directory.");
  }
  assertOwned(metadata);
  if (currentUserId() !== null && (metadata.mode & 0o022) !== 0) {
    throw new Error("Local state directory is writable by another user.");
  }
}

// A file that is not a regular, private record of this user's, within its
// bound, cannot be one Remembrance wrote: it is refused unread, as unsafe.
// A refusal for its owner or mode alone says so (`access`): such a file can
// be a record whose owner or mode changed after it was written.
const UNSAFE_RECORD = "REMEMBRANCE_UNSAFE_RECORD";
const unsafeRecord = (message, access = false) =>
  Object.assign(new Error(message), { code: UNSAFE_RECORD, access });

function assertPrivateRecord(metadata, maxBytes = OBLIGATION_MAX_BYTES) {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > maxBytes
  ) {
    throw unsafeRecord("Local state record is unsafe.");
  }
  const uid = currentUserId();
  if (uid !== null && metadata.uid !== uid) {
    throw unsafeRecord("Local state is not owned by the current user.", true);
  }
  if (uid !== null && (metadata.mode & 0o077) !== 0) {
    throw unsafeRecord("Local state record permissions are not private.", true);
  }
}

function readRecord(path) {
  return JSON.parse(readRecordText(path, OBLIGATION_MAX_BYTES));
}

// One regular, private, user-owned file of at most `maxBytes`, never through
// a symlink, read in bounded chunks.
function readRecordText(path, maxBytes) {
  const before = lstatSync(path);
  assertPrivateRecord(before, maxBytes);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    assertPrivateRecord(opened, maxBytes);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("Local state record changed while opening.");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    if (total > maxBytes) {
      throw new Error("Local state record exceeds its size limit.");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

// What a retrieval says to do next, by kind and outcome; a retrieved payload's
// guidance also says who earned the action, as far as the record says.
const GUIDANCE = {
  remembrance_followup: {
    retrieved: {
      first_hand:
        "Nothing was sent. Call submit_remembrance with exactly this payload, unchanged, to complete the pending action.",
      second_hand:
        "Nothing was sent. A subagent earned this action and left it unpaid when it exited: submit it unchanged with submit_remembrance only if it is reusable, otherwise decline it with decline_pending_action.",
      subagent_identity_unavailable:
        "Nothing was sent. The host did not say whether you or a subagent earned this action: submit it unchanged with submit_remembrance only if it is reusable, otherwise decline it with decline_pending_action.",
      pre_agent_keying:
        "Nothing was sent. An earlier client recorded this action for the whole session, so a subagent may have earned it: submit it unchanged with submit_remembrance only if it is reusable, otherwise decline it with decline_pending_action.",
    },
    envelope_invalid:
      "The retained payload is malformed and is not returned. Submit it only if you still hold it verbatim, otherwise decline the action.",
    unavailable:
      "The payload is retained, encrypted, but the local private-learning key cannot be read now. Retry after it is available (for example once the login keychain is unlocked); otherwise submit it only if you still hold it verbatim, or decline the action.",
    refused:
      "The retained payload does not match its recorded digest and is not returned. Submit it only if you still hold it verbatim, otherwise decline the action.",
    not_retained:
      "This action's payload was never kept on this machine. Submit it only if you still hold it verbatim, otherwise decline the action.",
  },
  capture_next_action: {
    retrieved: {
      first_hand:
        "Nothing was recorded or applied. Call record_preference with exactly these arguments, unchanged, to complete the pending action.",
      second_hand:
        "Nothing was recorded or applied. A subagent captured this preference and left it unrecorded when it exited: call record_preference with exactly these arguments only if the user stated this preference, otherwise decline it with decline_pending_action.",
      subagent_identity_unavailable:
        "Nothing was recorded or applied. The host did not say whether you or a subagent captured this preference: call record_preference with exactly these arguments only if the user stated this preference, otherwise decline it with decline_pending_action.",
      pre_agent_keying:
        "Nothing was recorded or applied. An earlier client recorded this action for the whole session, so a subagent may have captured it: call record_preference with exactly these arguments only if the user stated this preference, otherwise decline it with decline_pending_action.",
    },
    envelope_invalid:
      "The retained arguments are malformed and are not returned. Call record_preference only with arguments you still hold verbatim, otherwise decline the action.",
    unavailable:
      "The arguments are retained, encrypted, but the local private-learning key cannot be read now. Retry after it is available (for example once the login keychain is unlocked); otherwise call record_preference only with arguments you still hold verbatim, or decline the action.",
    refused:
      "The retained arguments do not match their recorded digest and are not returned. Call record_preference only with arguments you still hold verbatim, otherwise decline the action.",
    not_retained:
      "This action's arguments were never kept on this machine. Call record_preference only with arguments you still hold verbatim, otherwise decline the action.",
  },
};

// As the demand labels it: who earned the action, as far as the record says.
function recordProvenance(record, transferred) {
  if (transferred) return "second_hand";
  if (record.subagent_identity === "unavailable") {
    return "subagent_identity_unavailable";
  }
  return record.agent_keyed === true ? "first_hand" : "pre_agent_keying";
}

function withoutPayload(status, input, extra) {
  return {
    status,
    action_id: input.action_id,
    ledger: input.ledger,
    ...extra,
    submitted: false,
    local_only: true,
  };
}

// For the bundled MCP server's get_pending_action_payload. Reads only the
// ledger the demand named and only a remembrance follow-up or a durable
// preference in it; private learning drafts live elsewhere and are never
// read. It returns a follow-up's payload as `payload` and a preference's
// record_preference arguments as `arguments`; it never submits or records
// either. `readKey(source)` resolves an existing private-learning key and
// never creates one.
export async function readPendingActionPayload(input, env, { readKey }) {
  const request = {
    action_id: String(input?.action_id ?? ""),
    ledger: String(input?.ledger ?? ""),
  };
  const notFound = withoutPayload("not_found", request, {
    guidance:
      "No pending action with this action_id is retained in this ledger. It may be closed, owned by another session or agent, or never recorded; do not guess its payload.",
  });
  if (!HEX16.test(request.action_id) || !HEX16.test(request.ledger)) {
    return notFound;
  }
  // The durable ledger first, then the temporary one an earlier build used.
  // Age never closes an action: only completing, declining or withdrawing
  // it does.
  let record = null;
  for (const directory of [
    ...(retainedRootsUsable(env)
      ? [join(retainedLedgerRoot(env), `${request.ledger}.obligations`)]
      : []),
    join(usageDirectory(env), `${request.ledger}.obligations`),
  ]) {
    try {
      assertPrivateDirectory(directory);
      for (const name of readdirSync(directory)
        .sort()
        .slice(0, LEDGER_ENTRY_LIMIT)) {
        if (
          !name.startsWith(request.action_id) ||
          !/^[a-f0-9]{32}\.json$/u.test(name)
        ) {
          continue;
        }
        try {
          const candidate = readRecord(join(directory, name));
          const idHash = createHash("sha256")
            .update(String(candidate?.id), "utf8")
            .digest("hex");
          if (
            candidate?.version === OBLIGATION_VERSION &&
            RETAINED_KINDS.has(candidate.kind) &&
            (candidate.kind !== "capture_next_action" ||
              candidate.action_tool === "record_preference") &&
            `${idHash.slice(0, 32)}.json` === name &&
            Number.isFinite(Date.parse(String(candidate?.created_at ?? "")))
          ) {
            record = candidate;
            break;
          }
        } catch {
          // One unreadable record must not answer for another.
        }
      }
    } catch {
      // A missing or unsafe ledger must not hide the other one.
    }
    if (record) break;
  }
  if (!record) return notFound;
  const preference = record.kind === "capture_next_action";
  const guidance = GUIDANCE[record.kind];
  const transferred =
    record.transferred_from && typeof record.transferred_from === "object"
      ? {
          agent_id: String(record.transferred_from.agent_id ?? ""),
          transcript_path:
            typeof record.transferred_from.transcript_path === "string"
              ? record.transferred_from.transcript_path
              : null,
        }
      : null;
  const described = {
    kind: record.kind,
    ...(preference
      ? { action_tool: "record_preference" }
      : {
          query_id:
            typeof record.query_id === "string" ? record.query_id : null,
          result_id:
            typeof record.result_id === "string" ? record.result_id : null,
        }),
    provenance: recordProvenance(record, transferred),
    transferred_from: transferred,
    payload_digest: record.payload_digest,
  };
  let payload = null;
  if (record.local_resupply_envelope) {
    const envelope = normalizeResupplyEnvelope(record.local_resupply_envelope);
    if (!envelope) {
      return withoutPayload("refused", request, {
        ...described,
        reason: "envelope_invalid",
        guidance: guidance.envelope_invalid,
      });
    }
    let key;
    try {
      key = await readKey(envelope.key_source);
    } catch (error) {
      return withoutPayload("unavailable", request, {
        ...described,
        reason: localKeyReason(error),
        // The outbox's own content-free recovery, when the reader gives one.
        ...(typeof error?.diagnostic === "function"
          ? { diagnostic: error.diagnostic() }
          : {}),
        guidance: guidance.unavailable,
      });
    }
    try {
      payload = openResupplyEnvelope(
        { ...record, local_resupply_envelope: envelope },
        key,
      );
    } catch (error) {
      return withoutPayload("refused", request, {
        ...described,
        reason: error?.code ?? "decryption_failed",
        guidance: guidance.refused,
      });
    }
  } else if (
    !preference &&
    record.local_resupply_payload &&
    typeof record.local_resupply_payload === "object" &&
    !Array.isArray(record.local_resupply_payload)
  ) {
    // A follow-up kept in plaintext by an earlier build: read as it is.
    if (
      resupplyPayloadDigest(record.local_resupply_payload) !==
        record.payload_digest ||
      record.id !== `remembrance_followup:${record.payload_digest}`
    ) {
      return withoutPayload("refused", request, {
        ...described,
        reason: "digest_mismatch",
        guidance: guidance.refused,
      });
    }
    payload = record.local_resupply_payload;
  } else {
    return withoutPayload("not_retained", request, {
      ...described,
      reason:
        record.local_resupply_payload_omitted === "too_large" ||
        record.local_resupply_payload_omitted === "key_unavailable"
          ? record.local_resupply_payload_omitted
          : "not_retained",
      guidance: guidance.not_retained,
    });
  }
  return {
    status: "retrieved",
    action_id: request.action_id,
    ledger: request.ledger,
    ...described,
    payload_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    [preference ? "arguments" : "payload"]: payload,
    submitted: false,
    local_only: true,
    guidance: guidance.retrieved[described.provenance],
  };
}

function localKeyReason(error) {
  const code = String(error?.reasonCode ?? error?.code ?? "");
  if (code.endsWith("key_missing")) return "local_key_missing";
  if (code.endsWith("key_invalid")) return "local_key_invalid";
  return "local_key_unavailable";
}

// Every retained consumer of the private-learning key on this machine, for
// the one decision a new key may never get wrong: whether something already
// sealed would be stranded by it. Hook core and the bundled MCP server share
// this function. It covers both private-learning outbox lanes, the durable
// private-learning obligations, the durable ledgers of unresolved actions'
// retained payloads, and the hook ledgers in the temporary usage directory.
// The work is bounded and synchronous: at most `ledgers` directories below
// those roots are listed and `files` files read, whatever they hold (a
// completion record is at most 12 KiB, a lane file at most the outbox
// bound), plus at most `ledgers` overflow counts of 4 KiB per ledger root
// for the doctor's report. A symlink is never followed. Whatever is left
// makes the inventory incomplete, counted by cause, so no decision rests on
// state left unread: bounded (past a bound), unreadable (a private file of
// this user's that could not be opened or read), unclassified (present but
// not provably a Remembrance record: not a regular private file of this
// user's within its bound, unparseable, or of no known kind) and unlisted (a
// directory refused: a symlink, another user's, writable by others, or not
// listable). Age is never a reason to skip a record. Counts, causes, areas
// and kinds only; no path or content.
export const INVENTORY_LIMITS = Object.freeze({
  ledgers: 4096,
  files: 8192,
});
// A lane file is read whole, as the outbox reads it, up to the outbox bound.
const LANE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const LEDGER_DIRECTORY = /^[a-f0-9]{16}\.obligations$/u;
const RECORD_FILE = /^[a-f0-9]{32}\.json$/u;
const OVERFLOW_FILE = /^[a-f0-9]{16}\.obligations-overflow\.json$/u;
const LANE_ENVELOPE_KINDS = new Map([
  ["private-lesson-outbox-envelope-v1", "private_lesson"],
  ["private-skill-outbox-envelope-v1", "private_skill"],
  ["private-skill-outbox-envelope-v2", "private_skill"],
]);
// Content-free records that never carry ciphertext, in either lane.
const LANE_KEY_FREE_VERSIONS = new Set([
  "private-lesson-outbox-submitted-v1",
  "private-lesson-outbox-deletion-v1",
  "private-lesson-policy-floor-v1",
  "private-lesson-policy-floor-v2",
  "private-skill-outbox-submitted-v1",
  "private-skill-outbox-deletion-v1",
  "private-skill-destination-audiences-v1",
  "private-outbox-capacity-v1",
  "private-outbox-lock-v2",
  // Lock records that earlier clients could leave behind.
  "private-outbox-lock-v1",
  "private-lesson-outbox-lock-v1",
]);
// Each lane's live lock, created and released between listing and reading.
const LIVE_LANE_LOCK_FILES = new Set([
  ".outbox.lock",
  ".private-skill-outbox.lock",
]);

export function inventoryRetainedKeyConsumers(
  env,
  { limits = INVENTORY_LIMITS, lanes, homeDirectory = homedir() } = {},
) {
  const kinds = {
    private_lesson: 0,
    private_skill: 0,
    remembrance_followup: 0,
    capture_next_action: 0,
  };
  const sources = { os_keychain: 0, mode_0600_file: 0 };
  const unretained = { count: 0, kinds: new Set() };
  const causes = {
    bounded: { count: 0, areas: new Set() },
    unreadable: { count: 0, areas: new Set() },
    unclassified: { count: 0, areas: new Set() },
    unlisted: { count: 0, areas: new Set() },
  };
  // Files and directories left, whatever the cause, as health reports them.
  let unclassified = 0;
  let unlisted = 0;
  let directories = 0;
  let files = 0;
  const lifecycle = join(
    stateRoot(env, homeDirectory),
    "remembrance",
    "private-learning-lifecycle",
  );
  const missing = (error) => error?.code === "ENOENT";
  const left = (area, cause) => {
    const entry = causes[cause];
    entry.count += 1;
    entry.areas.add(area);
  };
  const leftFile = (area, cause) => {
    left(area, cause);
    unclassified += 1;
  };
  const leftDirectory = (area, cause) => {
    left(area, cause);
    unlisted += 1;
  };
  // Why a file could not be classified: refused unread as unsafe, or read
  // and unparseable, it is no record Remembrance wrote; otherwise it could
  // not be read. A file named like a record that is refused for its owner or
  // mode alone may be one whose mode changed: unreadable, so the step shown
  // is to make it a user-owned 0600 file again, never to move it aside.
  const fileCause = (error, name) =>
    (error?.code === UNSAFE_RECORD &&
      !(error.access && RECORD_FILE.test(name))) ||
    error instanceof SyntaxError
      ? "unclassified"
      : "unreadable";
  const consumer = (kind, source) => {
    if (!(kind in kinds) || !(source in sources)) return false;
    kinds[kind] += 1;
    sources[source] += 1;
    return true;
  };
  // A file below a root, once the read bound allows it.
  const readFile = (area, path, maxBytes) => {
    if (files >= limits.files) {
      leftFile(area, "bounded");
      return null;
    }
    files += 1;
    return readRecordText(path, maxBytes);
  };
  const listDirectory = (path) => {
    assertPrivateDirectory(path);
    return readdirSync(path, { withFileTypes: true });
  };

  // A completion-obligation record: a sealed payload is a consumer of the
  // key its envelope names; a record without ciphertext needs no key.
  const ledgerRecord = (area, directory, name) => {
    let record;
    try {
      const text = readFile(area, join(directory, name), OBLIGATION_MAX_BYTES);
      if (text === null) return;
      record = JSON.parse(text);
    } catch (error) {
      if (!missing(error)) leftFile(area, fileCause(error, name));
      return;
    }
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.version !== OBLIGATION_VERSION
    ) {
      leftFile(area, "unclassified");
      return;
    }
    if (record.local_resupply_payload_omitted === "too_large") {
      unretained.count += 1;
      unretained.kinds.add(String(record.kind));
    }
    if (record.local_resupply_envelope == null) return;
    const envelope = normalizeResupplyEnvelope(record.local_resupply_envelope);
    if (
      !envelope ||
      !RETAINED_KINDS.has(record.kind) ||
      !consumer(record.kind, envelope.key_source)
    ) {
      leftFile(area, "unclassified");
    }
  };
  // A flat directory of completion-obligation records.
  const recordDirectory = (area, path, root) => {
    let entries;
    try {
      entries = listDirectory(path);
    } catch (error) {
      if (!(root && missing(error))) leftDirectory(area, "unlisted");
      return;
    }
    for (const entry of entries) {
      if (RECORD_FILE.test(entry.name)) {
        ledgerRecord(area, path, entry.name);
      }
    }
  };
  // A root holding one <ledger>.obligations directory per ledger.
  const ledgerRoot = (area, root) => {
    let entries;
    try {
      entries = listDirectory(root);
    } catch (error) {
      if (!missing(error)) leftDirectory(area, "unlisted");
      return;
    }
    const ledgers = entries
      .filter((entry) => LEDGER_DIRECTORY.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of ledgers) {
      if (directories >= limits.ledgers) {
        leftDirectory(area, "bounded");
        continue;
      }
      directories += 1;
      recordDirectory(area, join(root, name), false);
    }
    // Debts a full ledger could not record, for the doctor's report: at
    // most one count per listed ledger is read.
    let counts = 0;
    for (const entry of entries) {
      if (!OVERFLOW_FILE.test(entry.name) || counts >= limits.ledgers) continue;
      counts += 1;
      try {
        const value = JSON.parse(
          readRecordText(join(root, entry.name), 4096),
        );
        if (Number.isSafeInteger(value?.count) && value.count > 0) {
          unretained.count += value.count;
          for (const kind of Array.isArray(value.kinds) ? value.kinds : []) {
            unretained.kinds.add(String(kind));
          }
        }
      } catch {
        // A count that cannot be read only leaves the report short.
      }
    }
  };
  // An outbox lane, every level of it, classified by content.
  const lane = (area, path, root) => {
    let entries;
    try {
      if (!root) {
        if (directories >= limits.ledgers) {
          leftDirectory(area, "bounded");
          return;
        }
        directories += 1;
      }
      entries = listDirectory(path);
    } catch (error) {
      // Only a lane that was never created holds nothing.
      if (!(root && missing(error))) leftDirectory(area, "unlisted");
      return;
    }
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        lane(area, file, false);
        continue;
      }
      const liveLock = root && LIVE_LANE_LOCK_FILES.has(entry.name);
      let value;
      try {
        const text = readFile(area, file, LANE_FILE_MAX_BYTES);
        if (text === null) continue;
        // A live lock is empty until its holder writes the first record.
        if (liveLock && text === "") continue;
        value = JSON.parse(text);
      } catch (error) {
        // A live lock can be released between listing and reading.
        if (!(liveLock && missing(error))) {
          leftFile(area, fileCause(error, entry.name));
        }
        continue;
      }
      const kind =
        value && typeof value === "object" && !Array.isArray(value)
          ? LANE_ENVELOPE_KINDS.get(String(value.version))
          : undefined;
      if (
        kind &&
        value.encryption &&
        typeof value.encryption === "object" &&
        value.encryption.algorithm === "aes-256-gcm"
      ) {
        if (!consumer(kind, value.encryption.key_source)) {
          leftFile(area, "unclassified");
        }
      } else if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !LANE_KEY_FREE_VERSIONS.has(String(value.version)) ||
        Object.hasOwn(value, "encryption")
      ) {
        leftFile(area, "unclassified");
      }
    }
  };

  const outboxLanes = lanes ?? [
    join(stateRoot(env, homeDirectory), "remembrance", "private-lessons"),
    join(stateRoot(env, homeDirectory), "remembrance", "private-skills"),
  ];
  for (const path of outboxLanes) {
    lane(
      String(path).endsWith("private-skills")
        ? "private_skill_outbox"
        : "private_lesson_outbox",
      path,
      true,
    );
  }
  // The hook ledgers (the source) before the durable ones (the
  // destination): a sealed record a concurrent hook read promotes from the
  // temporary ledger to the durable one between the two scans is then seen
  // in the second at least. A subagent's record that moves to its parent's
  // durable ledger during the scan of that root can still be missed when the
  // parent's ledger sorts first; the transfer copies before it removes, so
  // only that window remains, and only while no key is readable.
  ledgerRoot("hook_ledgers", usageDirectory(env));
  // Refused, never followed, as the hook refuses it: a linked lifecycle
  // directory is named itself, and neither area below it is read.
  let lifecycleUsable = true;
  try {
    assertPrivateDirectory(lifecycle);
  } catch (error) {
    lifecycleUsable = missing(error);
    if (!lifecycleUsable) {
      leftDirectory("private_learning_lifecycle", "unlisted");
    }
  }
  if (lifecycleUsable) {
    recordDirectory("private_obligations", join(lifecycle, "obligations"), true);
    ledgerRoot("retained_ledgers", join(lifecycle, "retained"));
  }
  const total = Object.values(kinds).reduce((sum, count) => sum + count, 0);
  const sorted = (values) => [...values].sort();
  return {
    consumers: { total, kinds, sources },
    incomplete: unclassified > 0 || unlisted > 0,
    reasons: {
      unclassified,
      unlisted,
      areas: sorted(
        new Set(Object.values(causes).flatMap((cause) => [...cause.areas])),
      ),
      causes: Object.fromEntries(
        Object.entries(causes).map(([cause, value]) => [
          cause,
          { count: value.count, areas: sorted(value.areas) },
        ]),
      ),
    },
    unretained: { count: unretained.count, kinds: sorted(unretained.kinds) },
  };
}

// Why no first key may be made, as content-free codes: "consumers" while a
// retained item needs a key that is missing, otherwise one "<cause>:<area>"
// for each cause and area the inventory could not account for. The hook
// keeps them on a debt whose payload it could not keep; the text both the
// bundled MCP server and the hooks show for them is the one below.
const HOLD_CAUSES = ["bounded", "unreadable", "unclassified", "unlisted"];
const HOLD_AREAS = {
  private_lesson_outbox: "~/.local/state/remembrance/private-lessons",
  private_skill_outbox: "~/.local/state/remembrance/private-skills",
  private_learning_lifecycle:
    "~/.local/state/remembrance/private-learning-lifecycle",
  private_obligations:
    "~/.local/state/remembrance/private-learning-lifecycle/obligations",
  retained_ledgers:
    "~/.local/state/remembrance/private-learning-lifecycle/retained",
  hook_ledgers: "the temporary usage directory",
};
const HOLD_CODE = new RegExp(
  `^(?:consumers|(?:${HOLD_CAUSES.join("|")}):(?:${Object.keys(HOLD_AREAS).join("|")}))$`,
  "u",
);

export const RESTORE_ORIGINAL_KEY =
  "Restore the original key: the login Keychain item or the 0600 key file private-lesson-outbox.key in the Remembrance config directory. A new key cannot read retained items, so none is made.";

export function retainedKeyHoldCodes(inventory) {
  if (inventory.consumers.total > 0) return ["consumers"];
  return HOLD_CAUSES.flatMap((cause) =>
    (inventory.reasons.causes?.[cause]?.areas ?? []).map(
      (area) => `${cause}:${area}`,
    ),
  ).filter((code) => HOLD_CODE.test(code));
}

export function normalizeRetainedKeyHoldCodes(value) {
  if (!Array.isArray(value)) return null;
  const codes = [
    ...new Set(
      value.filter((code) => typeof code === "string" && HOLD_CODE.test(code)),
    ),
  ].slice(0, HOLD_CAUSES.length * Object.keys(HOLD_AREAS).length + 1);
  return codes.length ? codes : null;
}

const thousands = (value) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

// What clears a hold, by cause, naming each directory without a user path.
// Never "restore the original key" unless a retained item needs it.
export function retainedKeyHoldRemediation(codes) {
  const held = normalizeRetainedKeyHoldCodes(codes) ?? [];
  if (held.includes("consumers")) return RESTORE_ORIGINAL_KEY;
  const named = new Set();
  const where = (cause) => {
    const areas = held
      .filter((code) => code.startsWith(`${cause}:`))
      .map((code) => code.slice(cause.length + 1));
    for (const area of areas) named.add(area);
    const directories = areas.map((area) => HOLD_AREAS[area]);
    return directories.length > 1
      ? `${directories.slice(0, -1).join(", ")} and ${directories.at(-1)}`
      : (directories[0] ?? "");
  };
  const sentences = [];
  const bounded = where("bounded");
  if (bounded) {
    sentences.push(
      `The inventory reached its bound (${thousands(INVENTORY_LIMITS.files)} files, ${thousands(INVENTORY_LIMITS.ledgers)} ledger directories) before it had read everything in ${bounded}. Complete or decline the pending actions Remembrance lists in the sessions that keep them (decline_pending_action declines one), which removes their records and, once a ledger is empty, its directory, then retry; a record without a payload also leaves 7 days after it was made, when its session's hooks next run, and empty directories named <16 hex>.obligations that an earlier build left there can be removed by hand.`,
    );
  }
  const unreadable = where("unreadable");
  if (unreadable) {
    sentences.push(
      `Files in ${unreadable} could not be read: make them user-owned 0600 files again, or move aside those Remembrance did not write, then retry.`,
    );
  }
  const unclassified = where("unclassified");
  if (unclassified) {
    sentences.push(
      `Move aside files in ${unclassified} that Remembrance did not write (for example .DS_Store), and make a file Remembrance wrote whose owner or mode changed a user-owned 0600 file again instead of moving it aside, then retry.`,
    );
  }
  const unlisted = where("unlisted");
  if (unlisted) {
    sentences.push(
      `A directory at or in ${unlisted} could not be listed safely (a symlink, another user's, or writable by others): move aside what Remembrance did not create and keep the rest user-owned with mode 0700, then retry.`,
    );
  }
  if ([...named].some((area) => area !== "hook_ledgers")) {
    sentences.push("(~/.local/state is $XDG_STATE_HOME when that is set.)");
  }
  if (named.has("hook_ledgers")) {
    sentences.push(
      "(The temporary usage directory is $REMEMBRANCE_USAGE_DIR, or remembrance-usage-uid-<uid> in the system temporary directory.)",
    );
  }
  return [
    "The retained-item inventory could not account for everything, and an item it missed may need an earlier key.",
    ...sentences,
  ].join(" ");
}
