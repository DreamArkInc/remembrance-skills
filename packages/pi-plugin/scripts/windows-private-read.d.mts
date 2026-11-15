import type { BigIntStats } from "node:fs";
export type WindowsPrivateReadRequest = { path: string; kind: "file" | "directory" };
/** Callback-local metadata/proof only. Native-binding probe fds close before callback entry. */
export function withWindowsPrivateReadOperation<T>(requests: readonly WindowsPrivateReadRequest[], callback: () => T): T;
/** Exact caller namespace snapshot, metadata only; original callback order is unchanged. */
export function withWindowsPrivateDirectoryReadOperation<T>(directory: string, originalNames: readonly string[], callback: () => T): T;
/** The caller must hold its actual consuming fd through the complete current-content read. */
export function assertWindowsPrivateRead(path: string, kind: "file" | "directory", before: BigIntStats, opened: BigIntStats): void;
