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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
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
  assertPrivateDirectory(dirname(dirname(path)));
  assertPrivateDirectory(dirname(path));
  const before = lstatSync(path);
  assertPrivateMarker(before);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    assertPrivateMarker(opened);
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
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

function removeExpiredMarker(path, marker, now) {
  if (Date.parse(marker.expires_at) > now) return false;
  rmSync(path, { force: true });
  return true;
}

function cleanupExpiredMarkers(directory, now) {
  const handle = opendirSync(directory);
  let markerCount = 0;
  let visited = 0;
  try {
    while (visited <= MAX_FEEDBACK_DENIAL_MARKERS) {
      const entry = handle.readSync();
      if (!entry) break;
      visited += 1;
      if (!entry.isFile() || !MARKER_NAME_PATTERN.test(entry.name)) continue;
      markerCount += 1;
      const digest = entry.name.slice(0, -".json".length);
      const path = join(directory, entry.name);
      try {
        if (removeExpiredMarker(path, readMarker(path, digest), now)) {
          markerCount -= 1;
        }
      } catch {
        // One corrupt marker cannot acknowledge or remove another event.
      }
    }
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
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
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
      rmSync(temporaryPath, { force: true });
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
