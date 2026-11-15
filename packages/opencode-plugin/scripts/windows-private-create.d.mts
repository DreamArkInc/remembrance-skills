import type { FileHandle } from "node:fs/promises";
/** Empty private file only; caller owns body write, flush, publication and close. */
export function openWindowsPrivateFileSync(path: string): number;
export function openWindowsPrivateFile(path: string): Promise<FileHandle>;
/** At most sixteen newly created directory components; existing target must be private. */
export function ensureWindowsPrivateDirectorySync(path: string): void;
export function ensureWindowsPrivateDirectory(path: string): Promise<void>;
