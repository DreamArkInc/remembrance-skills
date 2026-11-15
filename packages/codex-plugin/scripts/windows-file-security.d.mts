export interface WindowsPrivatePathRequest { path: string; kind: "file" | "directory" }
export interface WindowsPrivatePathEntry extends WindowsPrivatePathRequest {
  readonly privacy: "private" | "integrity";
  readonly volume_serial: string;
  readonly file_id: string;
  readonly acl_fingerprint: string;
}
export interface WindowsPrivatePathSnapshot {
  readonly protection: "windows_dacl";
  readonly current_sid: string;
  readonly entries: readonly WindowsPrivatePathEntry[];
}
export const WINDOWS_ACL_LIMITS: Readonly<{ maxPaths: number; inputBytes: number; metadataChars: number; environmentChars: number; outputBytes: number; timeoutMs: number }>;
export const WINDOWS_DIRECTORY_PAGE_LIMITS: Readonly<{ count: number; outputBytes: number; timeoutMs: number }>;
export function inspectWindowsPrivateDirectoryPage(directory: string, after?: string, count?: number): WindowsPrivatePathSnapshot & Readonly<{
  rows: readonly Readonly<{ name: string; entry: WindowsPrivatePathEntry | null; unavailable: boolean }>[];
  next_after: string; has_more: boolean;
}>;
export function inspectWindowsPrivatePaths(requests: readonly WindowsPrivatePathRequest[]): WindowsPrivatePathSnapshot;
export function inspectWindowsCreationParent(path: string): WindowsPrivatePathEntry;
export function windowsPrivatePathBootstrap(): Record<string, string>;
export function assertWindowsFileIdentity(entry: WindowsPrivatePathEntry, before: {dev: bigint; ino: bigint}, opened: {dev: bigint; ino: bigint}): void;
export function createWindowsPrivatePath(request: WindowsPrivatePathRequest, privateParent: WindowsPrivatePathEntry): Readonly<{
  created: true; protection: "windows_dacl"; entry: WindowsPrivatePathEntry; parent: WindowsPrivatePathEntry;
}>;
