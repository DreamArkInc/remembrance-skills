import { assertWindowsPrivateRead, withWindowsPrivateReadOperation, withWindowsPrivateDirectoryReadOperation } from "./windows-private-read.mjs";
import { ensureWindowsPrivateDirectorySync, openWindowsPrivateFileSync } from "./windows-private-create.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo, platform } from "node:os";
import { dirname, join } from "node:path";

const FEEDBACK_DENIAL_VERSION = "feedback-denial-acknowledgement-v1";
const FEEDBACK_DENIAL_SUBDIRECTORY = "feedback-denials";
const FEEDBACK_DENIAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FEEDBACK_IDENTIFIER_LENGTH = 512;
const MAX_FEEDBACK_DENIAL_MARKER_BYTES = 1024;
const MAX_FEEDBACK_DENIAL_MARKERS = 512;
const MARKER_NAME_PATTERN = /^[a-f0-9]{64}\.json$/u;

class FeedbackDenialStorageError extends Error {
  constructor() {
    super("The host-policy denial acknowledgement could not be persisted.");
    this.name = "FeedbackDenialStorageError";
    this.code = "feedback_denial_acknowledgement_failed";
    this.status = "acknowledgement_failed";
    this.acknowledged = false;
    this.submitted = false;
    this.local_only = true;
  }
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort();
  const expectedKeys =
    input.tool === "submit_feedback"
      ? ["query_id", "reason", "result_id", "tool"]
      : ["query_id", "reason", "tool"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    !["submit_query_feedback", "submit_feedback"].includes(input.tool) ||
    input.reason !== "host_policy_denied" ||
    !validIdentifier(input.query_id)
  ) {
    return null;
  }
  if (input.tool === "submit_feedback") {
    if (!validIdentifier(input.result_id)) return null;
    return {
      tool: input.tool,
      query_id: input.query_id,
      result_id: input.result_id,
      reason: input.reason,
    };
  }
  if ("result_id" in input) return null;
  return {
    tool: input.tool,
    query_id: input.query_id,
    reason: input.reason,
  };
}

function validIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FEEDBACK_IDENTIFIER_LENGTH
  );
}

function exactEventDigest(input) {
  const fields = [input.tool, input.query_id, input.result_id ?? ""];
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    hash.update(String(bytes.length), "utf8");
    hash.update(":", "utf8");
    hash.update(bytes);
    hash.update(";", "utf8");
  }
  return hash.digest("hex");
}

function localUsageOwnerId() {
  const uid = currentUserId();
  if (uid !== null) return `uid-${uid}`;
  return `home-${createHash("sha256")
    .update(homedir())
    .digest("hex")
    .slice(0, 16)}`;
}

function currentUserId() {
  try {
    const uid = userInfo().uid;
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  } catch {
    // Non-POSIX runtimes fall back to the same home hash as hook-core.
  }
  return null;
}

function usageDirectory(env) {
  return env?.REMEMBRANCE_USAGE_DIR
    ? String(env.REMEMBRANCE_USAGE_DIR)
    : join(tmpdir(), `remembrance-usage-${localUsageOwnerId()}`);
}

function markerDirectory(env) {
  return join(usageDirectory(env), FEEDBACK_DENIAL_SUBDIRECTORY);
}

function markerPath(input, env) {
  return join(markerDirectory(env), `${exactEventDigest(input)}.json`);
}

function isPosix() {
  return currentUserId() !== null;
}

function assertCurrentOwner(uid) {
  const currentUid = currentUserId();
  if (currentUid !== null && uid !== currentUid) {
    throw new Error("Local state is not owned by the current user.");
  }
}

function ensurePrivateDirectory(path) {
  if (platform() === "win32") { ensureWindowsPrivateDirectorySync(path); return; }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Local state is not a regular directory.");
  }
  assertCurrentOwner(metadata.uid);
  if (isPosix() && (metadata.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
    const repaired = lstatSync(path);
    assertCurrentOwner(repaired.uid);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error("Local state directory permissions are not private.");
    }
  }
}

function assertPrivateDirectory(path) {
  if (platform() === "win32") {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("Local state is not a regular directory.");
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { assertWindowsPrivateRead(path, "directory", before, fstatSync(descriptor, { bigint: true })); }
    finally { closeSync(descriptor); }
    return;
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Local state is not a regular directory.");
  }
  assertCurrentOwner(metadata.uid);
  if (isPosix() && (metadata.mode & 0o022) !== 0) {
    throw new Error("Local state directory is writable by another user.");
  }
}

function assertPrivateMarker(metadata) {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_FEEDBACK_DENIAL_MARKER_BYTES
  ) {
    throw new Error("Local state marker is unsafe.");
  }
  assertCurrentOwner(metadata.uid);
  if (isPosix() && (metadata.mode & 0o077) !== 0) {
    throw new Error("Local state marker permissions are not private.");
  }
}

function readBoundedDescriptor(descriptor) {
  const chunks = [];
  let total = 0;
  while (total <= MAX_FEEDBACK_DENIAL_MARKER_BYTES) {
    const chunk = Buffer.allocUnsafe(
      Math.min(1024, MAX_FEEDBACK_DENIAL_MARKER_BYTES + 1 - total),
    );
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_FEEDBACK_DENIAL_MARKER_BYTES) {
    throw new Error("Local state marker exceeds its size limit.");
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readMarker(path, expectedDigest) {
  if (platform() === "win32") return withWindowsPrivateReadOperation([
    { path: dirname(dirname(path)), kind: "directory" },
    { path: dirname(path), kind: "directory" },
    { path, kind: "file" },
  ], () => readMarkerChecked(path, expectedDigest));
  return readMarkerChecked(path, expectedDigest);
}

function readMarkerChecked(path, expectedDigest, validatedMetadata = null) {
  assertPrivateDirectory(dirname(dirname(path)));
  assertPrivateDirectory(dirname(path));
  const windows = platform() === "win32";
  const before = windows ? lstatSync(path, { bigint: true }) : lstatSync(path);
  assertPrivateMarker(before);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = windows ? fstatSync(descriptor, { bigint: true }) : fstatSync(descriptor);
    assertPrivateMarker(opened);
    if (windows) assertWindowsPrivateRead(path, "file", before, opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("Local state marker changed while opening.");
    }
    const parsed = JSON.parse(readBoundedDescriptor(descriptor));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== FEEDBACK_DENIAL_VERSION ||
      parsed.event_digest !== `sha256:${expectedDigest}` ||
      typeof parsed.acknowledged_at !== "string" ||
      typeof parsed.expires_at !== "string" ||
      !Number.isFinite(Date.parse(parsed.acknowledged_at)) ||
      !Number.isFinite(Date.parse(parsed.expires_at))
    ) {
      throw new Error("Local state marker is malformed.");
    }
    if (validatedMetadata && windows) {
      const after = fstatSync(descriptor, { bigint: true });
      // Bind the expiry decision to the actual consuming FD's pre-read tuple.
      // A concurrent update during parsing never becomes a deletion candidate.
      if (sameMarkerTuple(opened, after) && opened.nlink === 1n) validatedMetadata(markerTuple(opened));
    }
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

const MARKER_IDENTITY_FIELDS = ["dev", "ino", "mode", "uid", "gid", "size", "nlink", "mtimeNs", "ctimeNs", "birthtimeNs"];
function markerTuple(metadata) { return Object.freeze(Object.fromEntries(MARKER_IDENTITY_FIELDS.map(field => [field, metadata[field]]))); }
function sameMarkerTuple(first, second) {
  return MARKER_IDENTITY_FIELDS.every(field => typeof first[field] === "bigint" && first[field] === second[field]);
}
function ownedExpiryCandidate(metadata, expected) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n && sameMarkerTuple(expected, metadata);
}

// Windows only: read every marker in original iterator order before deleting
// independent expired rows. Store metadata, never marker bodies, across phases.
// This is an observed-identity check under the private-parent model, not CAS.
function flushWindowsExpiredMarkers(directory, expectedDirectory, candidates) {
  if (candidates.length === 0) return 0;
  const before = lstatSync(directory, { bigint: true });
  const parent = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let removed = 0;
  try {
    const opened = fstatSync(parent, { bigint: true });
    assertWindowsPrivateRead(directory, "directory", before, opened);
    const checkParent = () => {
      const current = lstatSync(directory, { bigint: true }), held = fstatSync(parent, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expectedDirectory.dev || current.ino !== expectedDirectory.ino || held.dev !== current.dev || held.ino !== current.ino) throw new Error("Local acknowledgement parent changed.");
    };
    checkParent();
    for (const candidate of candidates) {
      checkParent();
      let descriptor;
      try {
        if (!ownedExpiryCandidate(lstatSync(candidate.path, { bigint: true }), candidate.metadata)) continue;
        descriptor = openSync(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        if (!ownedExpiryCandidate(fstatSync(descriptor, { bigint: true }), candidate.metadata)) continue;
      } catch { continue; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      // Windows must release the file probe before unlink. Keep a final narrow
      // path/parent check; replaced or updated records remain available.
      checkParent();
      try {
        if (!ownedExpiryCandidate(lstatSync(candidate.path, { bigint: true }), candidate.metadata)) continue;
        rmSync(candidate.path, { force: true }); removed += 1;
      } catch { /* Preserve unknown or changed candidates. */ }
    }
    checkParent();
    return removed;
  } finally { closeSync(parent); }
}

function removeExpiredMarker(path, marker, now) {
  if (Date.parse(marker.expires_at) > now) return false;
  rmSync(path, { force: true });
  return true;
}

function windowsPrivateDirectorySnapshot(directory) {
  if (platform() !== "win32") return [];
  try { return readdirSync(directory); } catch { return []; }
}

function cleanupExpiredMarkers(directory, now) {
  const windows = platform() === "win32";
  const expectedDirectory = windows ? lstatSync(directory, { bigint: true }) : null;
  const expired = [];
  const handle = opendirSync(directory);
  let markerCount = 0;
  let visited = 0;
  try {
    withWindowsPrivateReadOperation([{ path: dirname(directory), kind: "directory" }], () => withWindowsPrivateDirectoryReadOperation(directory, windowsPrivateDirectorySnapshot(directory), () => {
while (visited <= MAX_FEEDBACK_DENIAL_MARKERS) {
      const entry = handle.readSync();
      if (!entry) break;
      visited += 1;
      if (!entry.isFile() || !MARKER_NAME_PATTERN.test(entry.name)) continue;
      markerCount += 1;
      const digest = entry.name.slice(0, -".json".length);
      const path = join(directory, entry.name);
      try {
        if (windows) {
          let metadata = null;
          const marker = readMarkerChecked(path, digest, verified => { metadata = verified; });
          if (Date.parse(marker.expires_at) <= now && metadata && expired.length < MAX_FEEDBACK_DENIAL_MARKERS) expired.push({ path, metadata });
        } else if (removeExpiredMarker(path, readMarkerChecked(path, digest), now)) {
          markerCount -= 1;
        }
      } catch {
        // One corrupt marker cannot acknowledge or remove another event.
      }
    }

}));
    if (windows) markerCount -= flushWindowsExpiredMarkers(directory, expectedDirectory, expired);
    if (visited > MAX_FEEDBACK_DENIAL_MARKERS) {
      throw new Error("Local acknowledgement storage exceeds its entry limit.");
    }
  } finally {
    handle.closeSync();
  }
  if (markerCount >= MAX_FEEDBACK_DENIAL_MARKERS) {
    throw new Error("Local acknowledgement storage is full.");
  }
}

function writeMarkerAtomically(path, marker) {
  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor, owned;
  try {
    descriptor = platform() === "win32" ? openWindowsPrivateFileSync(temporaryPath) : openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    owned = fstatSync(descriptor, { bigint: true });
    writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence failure.
      }
    }
    try {
      // An exclusive-create collision owns nothing. Never delete an unknown,
      // replaced, linked, or nonempty candidate while preserving the failure.
      if (owned) {
        const current = lstatSync(temporaryPath, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && current.nlink === 1n && current.size === 0n) rmSync(temporaryPath, { force: true });
      }
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
}

export function acknowledgeFeedbackDenial(input, env = process.env) {
  const normalized = normalizeInput(input);
  if (!normalized) {
    throw new TypeError("Invalid feedback denial acknowledgement input.");
  }
  const digest = exactEventDigest(normalized);
  const directory = markerDirectory(env);
  const path = markerPath(normalized, env);
  const now = Date.now();
  try {
    ensurePrivateDirectory(usageDirectory(env));
    ensurePrivateDirectory(directory);
    cleanupExpiredMarkers(directory, now);
    try {
      const existing = readMarker(path, digest);
      if (Date.parse(existing.expires_at) > now) {
        return {
          status: "acknowledged_host_denial",
          acknowledged: true,
          submitted: false,
          local_only: true,
          already_acknowledged: true,
          expires_at: existing.expires_at,
        };
      }
      rmSync(path, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const acknowledgedAt = new Date(now).toISOString();
    const expiresAt = new Date(
      now + FEEDBACK_DENIAL_RETENTION_MS,
    ).toISOString();
    writeMarkerAtomically(path, {
      version: FEEDBACK_DENIAL_VERSION,
      event_digest: `sha256:${digest}`,
      acknowledged_at: acknowledgedAt,
      expires_at: expiresAt,
    });
    const persisted = readMarker(path, digest);
    if (Date.parse(persisted.expires_at) <= now) {
      throw new Error("Local acknowledgement expired before persistence.");
    }
    return {
      status: "acknowledged_host_denial",
      acknowledged: true,
      submitted: false,
      local_only: true,
      already_acknowledged: false,
      expires_at: persisted.expires_at,
    };
  } catch (error) {
    throw new FeedbackDenialStorageError();
  }
}

export function feedbackDenialAcknowledged(input, env = process.env) {
  const normalized = normalizeInput(input);
  if (!normalized) return false;
  const digest = exactEventDigest(normalized);
  const path = markerPath(normalized, env);
  try {
    const marker = readMarker(path, digest);
    const now = Date.now();
    if (removeExpiredMarker(path, marker, now)) return false;
    return true;
  } catch {
    return false;
  }
}
