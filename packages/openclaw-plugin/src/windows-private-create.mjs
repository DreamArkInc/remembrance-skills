import { closeSync, constants, fstatSync, lstatSync, openSync, rmdirSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { assertWindowsFileIdentity, createWindowsPrivatePath, inspectWindowsCreationParent, inspectWindowsPrivatePaths } from "./windows-file-security.mjs";

const MAX_CREATED_DIRECTORIES = 16;
const refuse = () => { throw new Error("Windows private storage protection could not be verified."); };
const absent = error => error?.code === "ENOENT";
function checkedPath(path) {
  if (process.platform !== "win32" || typeof path !== "string" || path.length > 2048 || !isAbsolute(path) ||
      /^[\\/]{2}/u.test(path) || /[\x00-\x1f]/u.test(path) || path.slice(2).includes(":") || path.split(/[\\/]/u).includes("..")) refuse();
  return normalize(path);
}
function same(entry, stat) {
  return entry && typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint" &&
    String(stat.dev) === entry.volume_serial && String(stat.ino) === entry.file_id;
}
function correctType(stat, kind) {
  return !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile());
}
function bindDirectory(entry) {
  const before = lstatSync(entry.path, { bigint: true });
  if (!correctType(before, "directory")) refuse();
  const fd = openSync(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertWindowsFileIdentity(entry, before, fstatSync(fd, { bigint: true }));
    assertWindowsFileIdentity(entry, before, lstatSync(entry.path, { bigint: true }));
  } finally { closeSync(fd); }
}
function inspectPrivateDirectory(path) {
  const entry = inspectWindowsPrivatePaths([{ path, kind: "directory" }]).entries[0];
  if (!entry || entry.path !== path || entry.kind !== "directory" || entry.privacy !== "private") refuse();
  bindDirectory(entry);
  return entry;
}
function createEmptyFile(path) {
  const parent = inspectPrivateDirectory(dirname(path));
  const created = createWindowsPrivatePath({ path, kind: "file" }, parent);
  if (!created || created.created !== true || created.entry.path !== path || created.entry.kind !== "file" || created.entry.privacy !== "private") refuse();
  return created;
}
function validateFile(created, before, opened, after) {
  for (const stat of [before, opened, after]) if (!correctType(stat, "file") || stat.size !== 0n || stat.nlink !== 1n) refuse();
  // Identity is bound here before any writable handle is returned.
  assertWindowsFileIdentity(created.entry, before, opened);
  assertWindowsFileIdentity(created.entry, opened, after);
  bindDirectory(created.parent);
}
function removeOwnedEmptyFile(path, entry) {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (same(entry, metadata) && correctType(metadata, "file") && metadata.size === 0n && metadata.nlink === 1n) unlinkSync(path);
  } catch { /* Never delete an unknown, changed or nonempty candidate. */ }
}

/** Return a new empty writable fd only after native protection and Node identity checks. */
export function openWindowsPrivateFileSync(value) {
  const path = checkedPath(value), created = createEmptyFile(path);
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    descriptor = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    validateFile(created, before, fstatSync(descriptor, { bigint: true }), lstatSync(path, { bigint: true }));
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    removeOwnedEmptyFile(path, created.entry);
    throw error;
  }
}

/** Async caller handle; protection and the same identity gate precede its first write. */
export async function openWindowsPrivateFile(value) {
  const path = checkedPath(value), created = createEmptyFile(path);
  let handle;
  try {
    const before = lstatSync(path, { bigint: true });
    handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    validateFile(created, before, await handle.stat({ bigint: true }), lstatSync(path, { bigint: true }));
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    removeOwnedEmptyFile(path, created.entry);
    throw error;
  }
}

/** Create at most sixteen missing directories, protecting each at native creation. */
export function ensureWindowsPrivateDirectorySync(value) {
  const target = checkedPath(value), missing = [], created = [];
  let cursor = target;
  while (true) {
    try {
      const stat = lstatSync(cursor, { bigint: true });
      if (!correctType(stat, "directory")) refuse();
      break;
    } catch (error) {
      if (!absent(error)) throw error;
      missing.push(cursor);
      if (missing.length > MAX_CREATED_DIRECTORIES) refuse();
      const parent = dirname(cursor); if (parent === cursor) refuse(); cursor = parent;
    }
  }
  if (!missing.length) { inspectPrivateDirectory(target); return; }
  let parent = inspectWindowsCreationParent(cursor);
  bindDirectory(parent);
  try {
    for (const path of missing.reverse()) {
      let result;
      try { result = createWindowsPrivatePath({ path, kind: "directory" }, parent); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        parent = inspectPrivateDirectory(path); continue;
      }
      created.push(result.entry);
      if (result.entry.path !== path || result.entry.kind !== "directory" || result.entry.privacy !== "private") refuse();
      bindDirectory(result.parent); bindDirectory(result.entry);
      parent = result.entry;
    }
  } catch (error) {
    for (const entry of created.reverse()) {
      try { const stat = lstatSync(entry.path, { bigint: true }); if (same(entry, stat) && correctType(stat, "directory")) rmdirSync(entry.path); }
      catch { /* Nonempty or replaced directories are retained. */ }
    }
    throw error;
  }
}

export async function ensureWindowsPrivateDirectory(path) { ensureWindowsPrivateDirectorySync(path); }
