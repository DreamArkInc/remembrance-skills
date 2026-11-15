import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { assertWindowsFileIdentity, inspectWindowsPrivatePaths, inspectWindowsPrivateDirectoryPage, WINDOWS_ACL_LIMITS, WINDOWS_DIRECTORY_PAGE_LIMITS } from "./windows-file-security.mjs";

// Only callback-local proof is retained, never file contents or a TTL/path cache.
// The current owner, SYSTEM and administrators are trusted, as in the native
// ACL policy. Metadata invalidation observes their ordinary changes; ChangeTime
// is not an unforgeable security epoch or protection against previously granted
// foreign handles. Existing unsafe objects must not be repaired into this scope.
// Probe descriptors close before callbacks: Windows read handles can block
// atomic replacement. Every consuming reader still holds its own current fd.
const operations = new AsyncLocalStorage();
const directoryOperations = new AsyncLocalStorage();
const metadataFields = ["dev", "ino", "mode", "uid", "gid", "size", "nlink", "mtimeNs", "ctimeNs", "birthtimeNs"];
const refuse = () => { throw new Error("Windows private storage protection could not be verified."); };
const key = path => normalize(path).toLowerCase();
const missing = error => error?.code === "ENOENT";

function regular(metadata, kind) {
  return !metadata.isSymbolicLink() && (kind === "file" ? metadata.isFile() : metadata.isDirectory()) &&
    metadataFields.every(field => typeof metadata[field] === "bigint");
}
function sameMetadata(first, second, kind) {
  return regular(first, kind) && regular(second, kind) && metadataFields.every(field => first[field] === second[field]);
}
function closeProof(proof) {
  if (!proof) return;
  proof.records.clear();
}
function validateRequests(requests) {
  if (!Array.isArray(requests) || requests.length > WINDOWS_ACL_LIMITS.maxPaths) refuse();
  return requests.map(request => {
    if (!request || typeof request.path !== "string" || !["file", "directory"].includes(request.kind) ||
        Object.keys(request).sort().join(",") !== "kind,path") refuse();
    return { path: request.path, kind: request.kind };
  });
}
function createProof(requests) {
  const paths = new Map(), existing = [];
  const add = (path, kind, privacy) => {
    const prior = paths.get(key(path));
    if (prior && prior.kind !== kind) refuse();
    if (!prior || privacy === "private") paths.set(key(path), { path, kind, privacy });
    if (paths.size > WINDOWS_ACL_LIMITS.maxPaths) refuse();
  };
  for (const request of requests) {
    try { lstatSync(request.path, { bigint: true }); }
    catch (error) { if (missing(error)) continue; throw error; }
    existing.push(request);
    add(request.path, request.kind, "private");
    add(dirname(request.path), "directory", "integrity");
  }
  const proof = { records: new Map(), principal: null };
  const descriptors = new Map();
  try {
    for (const [identity, path] of paths) {
      const before = lstatSync(path.path, { bigint: true });
      if (!regular(before, path.kind)) refuse();
      const descriptor = openSync(path.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      // Probes live only through native ACL and same-handle identity binding.
      descriptors.set(identity, descriptor);
      proof.records.set(identity, { ...path, metadata: before });
      if (!sameMetadata(before, fstatSync(descriptor, { bigint: true }), path.kind)) refuse();
    }
    // Missing config/identity is a healthy uninitialized state, not an ACL error.
    if (!existing.length) return proof;
    const snapshot = inspectWindowsPrivatePaths(existing);
    if (snapshot?.protection !== "windows_dacl" || !/^S-1-(?:\d+-){1,14}\d+$/u.test(snapshot.current_sid ?? "") ||
        !Array.isArray(snapshot.entries) || snapshot.entries.length !== paths.size) refuse();
    proof.principal = snapshot.current_sid;
    const seen = new Set();
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry.path !== "string") refuse();
      const identity = key(entry.path), record = proof.records.get(identity);
      if (!record || seen.has(identity) || entry.kind !== record.kind || entry.privacy !== record.privacy) refuse();
      seen.add(identity);
      assertWindowsFileIdentity(entry, record.metadata, fstatSync(descriptors.get(identity), { bigint: true }));
      record.entry = entry;
    }
    if (!unchanged(proof)) refuse();
    return proof;
  } catch (error) { closeProof(proof); throw error; }
  finally {
    let closeFailed = false;
    for (const descriptor of descriptors.values()) {
      try { closeSync(descriptor); } catch { closeFailed = true; }
    }
    if (closeFailed) { closeProof(proof); refuse(); }
  }
}
function unchanged(proof) {
  for (const record of proof.records.values()) {
    try {
      if (!sameMetadata(record.metadata, lstatSync(record.path, { bigint: true }), record.kind)) return false;
    } catch { return false; }
  }
  return true;
}

function currentRecord(record) {
  if (!record?.entry) return false;
  try { return sameMetadata(record.metadata, lstatSync(record.path, { bigint: true }), record.kind); }
  catch { return false; }
}
function directoryRecord(scope, path) {
  for (let current = scope; current?.active; current = current.parent) {
    const record = current.records.get(key(path));
    if (record) return { scope: current, record };
  }
  return null;
}
function bindRecord(path, kind, metadata, entry, privacy = "private") {
  let descriptor;
  try {
    if (!metadata || !regular(metadata, kind) || !entry) return null;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    assertWindowsFileIdentity(entry, metadata, opened);
    if (!sameMetadata(metadata, opened, kind) || !sameMetadata(metadata, lstatSync(path, { bigint: true }), kind)) return null;
    return { path, kind, privacy, metadata, entry };
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function inheritedPrivateRecord(scope, path, kind) {
  const found = directoryRecord(scope, path), parent = directoryRecord(scope, dirname(path));
  return found?.record.kind === kind && found.record.privacy === "private" && currentRecord(found.record) &&
    parent?.record.kind === "directory" && currentRecord(parent.record) ? found.record : null;
}

/** Metadata-only inventory scope, bounded by the caller's existing namespace snapshot.
 * Native page order never changes callback order. Each read checks only its row and
 * immediate parent; no whole-inventory scan occurs at consumption or after awaits.
 */
export function withWindowsPrivateDirectoryReadOperation(directory, originalNames, callback) {
  if (process.platform !== "win32") return callback();
  if (typeof directory !== "string" || !Array.isArray(originalNames) || !originalNames.every(name => typeof name === "string")) refuse();
  const parent = directoryOperations.getStore();
  // A nested pass over this same directory stays inside the existing snapshot.
  // Newly created names receive the ordinary scalar proof at consumption.
  for (let current = parent; current?.active; current = current.parent) if (key(current.directory) === key(directory)) return callback();
  const scope = { directory, parent, active: true, records: new Map(), principal: parent?.principal ?? null };
  const inherited = inheritedPrivateRecord(parent, directory, "directory");
  if (!originalNames.length && !inherited) return callback();
  try {
  const before = new Map();
  for (const name of originalNames) {
    if (!name || name.length > 255 || [".", ".."].includes(name) || /[\\/:\x00-\x1f]/u.test(name)) continue;
    const path = join(directory, name), identity = key(path);
    if (before.has(identity)) refuse();
    let metadata = null;
    try { metadata = lstatSync(path, { bigint: true }); } catch { /* Per-row current reads preserve existing absence/error handling. */ }
    before.set(identity, { path, metadata });
  }
  const small = before.size > 0 && before.size <= Math.floor((WINDOWS_ACL_LIMITS.maxPaths - 2) / 2);
  let batch = null;
  if (small) {
    const requests = [...before.values()].filter(item => item.metadata && (item.metadata.isFile() || item.metadata.isDirectory()))
      .map(item => ({ path: item.path, kind: item.metadata.isDirectory() ? "directory" : "file" }));
    try { batch = createProof([{ path: directory, kind: "directory" }, ...requests]); }
    catch { /* A bad row must not deny a healthy sibling. */ }
  }
  if (inherited) scope.records.set(key(directory), inherited);
  else {
    const proof = batch ?? createProof([{ path: directory, kind: "directory" }]);
    if (scope.principal && proof.principal !== scope.principal) refuse();
    scope.principal = proof.principal;
    for (const [identity, record] of proof.records) scope.records.set(identity, record);
  }
  if (small) {
    // Small selected snapshots avoid inspecting an otherwise large directory.
    // A rejected batch falls back per row, bounded by this same small batch.
    for (const expected of before.values()) {
      const kind = expected.metadata?.isDirectory() ? "directory" : "file";
      let entry = batch?.records.get(key(expected.path))?.entry;
      if (!batch && expected.metadata) try {
        const proof = createProof([{ path: expected.path, kind }]);
        if (proof.principal !== scope.principal) refuse();
        entry = proof.records.get(key(expected.path))?.entry;
      } catch { /* Retain this row's unavailable proof only. */ }
      const record = bindRecord(expected.path, kind, expected.metadata, entry);
      scope.records.set(key(expected.path), record ?? { path: expected.path, kind, privacy: "private", metadata: expected.metadata, entry: null });
    }
    if (batch && batch.principal !== scope.principal) refuse();
  } else if (before.size) {
    let after = "";
    do {
      // Directory proof is independently bound on each page; unrelated additions
      // do not invalidate names that were already in the caller's snapshot.
      const directoryBefore = lstatSync(directory, { bigint: true }), parentPath = dirname(directory), parentBefore = lstatSync(parentPath, { bigint: true });
      const page = inspectWindowsPrivateDirectoryPage(directory, after, WINDOWS_DIRECTORY_PAGE_LIMITS.count);
      if (page.current_sid !== scope.principal) refuse();
      for (const [index, metadata] of [directoryBefore, parentBefore].entries()) {
        const path = index ? parentPath : directory, record = bindRecord(path, "directory", metadata, page.entries[index], index ? "integrity" : "private");
        if (!record) {
          const proof = createProof([{ path: directory, kind: "directory" }]);
          if (proof.principal !== scope.principal) refuse();
          for (const [identity, fresh] of proof.records) scope.records.set(identity, fresh);
          break;
        }
        scope.records.set(key(path), record);
      }
      for (const row of page.rows) {
        const expected = before.get(key(join(directory, row.name)));
        if (!expected) continue;
        const kind = expected.metadata?.isDirectory() ? "directory" : "file";
        const record = bindRecord(expected.path, kind, expected.metadata, row.entry);
        scope.records.set(key(expected.path), record ?? { path: expected.path, kind, privacy: "private", metadata: expected.metadata, entry: null });
      }
      if (!page.has_more) break;
      after = page.next_after;
    } while (true);
  }
  } catch {
    // Optimization setup cannot change per-record availability or invoke work
    // twice. Existing scalar readers still enforce ACL/identity before content.
    scope.records.clear();
    return callback();
  }
  const finish = () => { scope.active = false; scope.records.clear(); };
  try {
    const result = directoryOperations.run(scope, callback);
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(finish);
    finish(); return result;
  } catch (error) { finish(); throw error; }
}

function assertDirectoryRead(scope, path, kind, before, opened) {
  let found = directoryRecord(scope, path), parent = directoryRecord(scope, dirname(path));
  if (found?.record.privacy !== "private" || found.record.kind !== kind) return false;
  const record = found.record;
  if (!record.entry && record.metadata && sameMetadata(record.metadata, before, kind) && parent && currentRecord(parent.record)) refuse();
  if (!currentRecord(record) || !parent || !currentRecord(parent.record)) {
    // Requalify only the changed target and parent, never all sibling records.
    const proof = createProof([{ path, kind }]);
    if (scope.principal && proof.principal !== scope.principal) refuse();
    for (const [identity, fresh] of proof.records) scope.records.set(identity, fresh);
    found = directoryRecord(scope, path); parent = directoryRecord(scope, dirname(path));
  }
  if (!found || !parent || !currentRecord(parent.record)) refuse();
  assertWindowsFileIdentity(found.record.entry, before, opened);
  if (!sameMetadata(before, opened, kind) || !sameMetadata(found.record.metadata, opened, kind)) refuse();
  return true;
}

/** One bounded logical operation. The callback must await all of its work. */
export function withWindowsPrivateReadOperation(requests, callback) {
  if (process.platform !== "win32") return callback();
  const bounded = validateRequests(requests);
  const scope = { requests: bounded, proof: createProof(bounded), active: true, failed: false };
  const finish = () => { scope.active = false; closeProof(scope.proof); };
  try {
    const result = operations.run(scope, callback);
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(finish);
    finish(); return result;
  } catch (error) { finish(); throw error; }
}

/** Called only after the reader has opened its own current, bounded descriptor. */
export function assertWindowsPrivateRead(path, kind, before, opened) {
  if (process.platform !== "win32") refuse();
  const directoryScope = directoryOperations.getStore();
  if (directoryScope?.active && assertDirectoryRead(directoryScope, path, kind, before, opened)) return;
  let scope = operations.getStore();
  if (!scope?.active) scope = null;
  if (scope?.failed) refuse();
  let proof;
  try {
    if (scope && scope.requests.some(request => key(request.path) === key(path) && request.kind === kind)) {
      const record = scope.proof.records.get(key(path));
      if (!record || record.privacy !== "private" || record.kind !== kind || !unchanged(scope.proof)) {
        const priorPrincipal = scope.proof.principal;
        closeProof(scope.proof);
        scope.proof = createProof(scope.requests);
        if (priorPrincipal && scope.proof.principal !== priorPrincipal) refuse();
      }
      proof = scope.proof;
    }
    let record = proof?.records.get(key(path));
    if (!record || record.privacy !== "private" || record.kind !== kind) {
      // An unrequested path gets a fresh proof, never grows an operation cache.
      proof = createProof([{ path, kind }]);
      record = proof.records.get(key(path));
    }
    if (!record || !regular(before, kind) || !regular(opened, kind)) refuse();
    assertWindowsFileIdentity(record.entry, before, opened);
    if (!sameMetadata(before, opened, kind) || !sameMetadata(record.metadata, opened, kind)) refuse();
  } catch (error) {
    if (scope) { scope.failed = true; closeProof(scope.proof); }
    throw error;
  } finally {
    if (proof && proof !== scope?.proof) closeProof(proof);
  }
}
