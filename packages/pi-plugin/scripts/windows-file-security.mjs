// Native Windows ACL prototype only. Not wired into production storage yet.
// A snapshot is not a cache or a replacement for lstat/open/fstat identity checks.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

// C15 measured first .NET compilation at 5143ms, repeated checks at 523ms.
// Scalar/create checks admit that bounded cold start; pages retain their 3s budget.
export const WINDOWS_ACL_LIMITS = Object.freeze({ maxPaths: 32, inputBytes: 16384, metadataChars: 21848, environmentChars: 32767, outputBytes: 131072, timeoutMs: 8000 });
export const WINDOWS_DIRECTORY_PAGE_LIMITS = Object.freeze({ count: 1024, outputBytes: 8 * 1024 * 1024, timeoutMs: 3000 });
const SCHEMA = "windows-private-paths-v1";
const METADATA_FIELD = "REMEMBRANCE_WINDOWS_PRIVATE_PATHS";
const SID = /^S-1-(?:\d+-){1,14}\d+$/u;
const INTEGER = /^(?:0|[1-9]\d{0,19})$/u;
const ADMIN_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);
const INTEGRITY_RIGHTS = 0x500d0156n; // Generic all/write, deletion, WRITE_DAC/OWNER and directory writes.
const ISSUED = new WeakMap(); // Issuance only: no path cache, TTL or retained file handles.
const refuse = () => { throw new Error("Windows private storage protection could not be verified."); };

// Fixed script only. No caller data becomes PowerShell/C# source or argv.
// GetSecurityInfo and GetFileInformationByHandle inspect the SAME open handle.
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('WINDOWS_ACL_PHASE:started')
$phase='environment_read'
try {
  [Console]::Error.WriteLine('WINDOWS_ACL_PHASE:environment_read')
  $line = [Environment]::GetEnvironmentVariable('REMEMBRANCE_WINDOWS_PRIVATE_PATHS','Process')
  if ($null -eq $line -or $line.Length -gt 21848 -or $line -notmatch '\A[A-Za-z0-9+/]*={0,2}\z') { throw 'Invalid metadata' }
  $bytes = [Convert]::FromBase64String($line)
  if ($bytes.Length -eq 0 -or $bytes.Length -gt 16384) { throw 'Invalid metadata body' }
  $request = [System.Text.UTF8Encoding]::new($false,$true).GetString($bytes) | Microsoft.PowerShell.Utility\ConvertFrom-Json
  if ($request.schema -ne 'windows-private-paths-v1' -or @($request.paths).Count -gt 32) { throw 'Invalid request' }
  $phase='compile'
  [Console]::Error.WriteLine('WINDOWS_ACL_PHASE:compile')
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
public sealed class RemembranceAclAce {
  public string sid; public string type; public string mask; public bool inherit_only; public bool callback;
}
public sealed class RemembranceAclEntry {
  public string path; public string kind; public bool reparse; public string owner_sid;
  public bool null_dacl; public bool persistent_acls; public string volume_serial; public string file_id;
  public RemembranceAclAce[] aces; public string acl_fingerprint;
}
public static class RemembranceAclSnapshot {
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, IntPtr volumeName, uint volumeNameSize, out uint serial, out uint maximumName, out uint flags, IntPtr filesystemName, uint filesystemNameSize);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, uint type, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreatePrivateFile(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
  const uint CREATE_NEW = 1;
  static void MatchParent(RemembranceAclEntry row, string sid, bool requirePrivate, string volume, string id, string fingerprint) {
    if (row.kind != "directory" || row.reparse || row.null_dacl || !row.persistent_acls || (requirePrivate && row.owner_sid != sid) || row.volume_serial != volume || row.file_id != id || row.acl_fingerprint != fingerprint) throw new InvalidOperationException();
  }
  public static RemembranceAclEntry[] Create(string path, string kind, string parent, string volume, string id, string fingerprint) {
    string sid = WindowsIdentity.GetCurrent().User.Value;
    // Keep the immediate parent handle open without share-delete/write throughout creation.
    using (var handle = CreateFileW(parent, 0x20080, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInfo held;
      if (!GetFileInformationByHandle(handle, out held) || held.Volume.ToString(CultureInfo.InvariantCulture) != volume || (((ulong)held.IndexHigh << 32) | held.IndexLow).ToString(CultureInfo.InvariantCulture) != id || (held.Attributes & 1024) != 0 || (held.Attributes & 16) == 0) throw new InvalidOperationException();
      MatchParent(Read(new string[] { parent })[0], sid, kind == "file", volume, id, fingerprint);
      string inherit = kind == "directory" ? "OICI" : "";
      string sddl = "O:" + sid + "D:P(A;" + inherit + ";FA;;;" + sid + ")(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;BA)";
      IntPtr descriptor; uint size;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        var attrs = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor=descriptor, Inherit=0 };
        if (kind == "directory") {
          if (!CreateDirectoryW(path, ref attrs)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } else if (kind == "file") {
          using (var child = CreatePrivateFile(path, 0x20080, 1, ref attrs, CREATE_NEW, 0x00200000, IntPtr.Zero)) {
            if (child.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
          }
        } else throw new InvalidOperationException();
      } finally { LocalFree(descriptor); }
      var result = Read(new string[] { path, parent });
      MatchParent(result[1], sid, kind == "file", volume, id, fingerprint);
      return result;
    }
  }
  public static RemembranceAclEntry[] Read(string[] paths) {
    var handles = new List<SafeFileHandle>(); var rows = new List<RemembranceAclEntry>();
    try {
      foreach (var path in paths) {
        // READ_CONTROL|READ_ATTRIBUTES; share read only, open existing, inspect reparse point itself.
        var handle = CreateFileW(path, 0x20080, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new InvalidOperationException(); }
        handles.Add(handle); FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new InvalidOperationException();
        uint serial, maximumName, filesystemFlags;
        if (!GetVolumeInformationByHandleW(handle, IntPtr.Zero, 0, out serial, out maximumName, out filesystemFlags, IntPtr.Zero, 0) || serial != info.Volume) throw new InvalidOperationException();
        IntPtr owner, group, dacl, sacl, descriptor;
        if (GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new InvalidOperationException();
        try {
          uint length = GetSecurityDescriptorLength(descriptor);
          if (length == 0 || length > 65536) throw new InvalidOperationException();
          var bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
          var sd = new RawSecurityDescriptor(bytes, 0); var aces = new List<RemembranceAclAce>();
          var canonical = new byte[sd.BinaryLength]; sd.GetBinaryForm(canonical, 0);
          string fingerprint;
          using (var hash = SHA256.Create()) fingerprint = BitConverter.ToString(hash.ComputeHash(canonical)).Replace("-", "").ToLowerInvariant();
          if (sd.DiscretionaryAcl != null) {
            if (sd.DiscretionaryAcl.Count > 128) throw new InvalidOperationException();
            foreach (GenericAce item in sd.DiscretionaryAcl) {
              var ace = item as CommonAce;
              if (ace == null) throw new InvalidOperationException();
              string type = ace.AceQualifier == AceQualifier.AccessAllowed ? "allow" : ace.AceQualifier == AceQualifier.AccessDenied ? "deny" : "unknown";
              aces.Add(new RemembranceAclAce { sid=ace.SecurityIdentifier.Value, type=type,
                mask=unchecked((uint)ace.AccessMask).ToString(CultureInfo.InvariantCulture),
                inherit_only=(ace.AceFlags & AceFlags.InheritOnly) != 0, callback=ace.IsCallback });
            }
          }
          rows.Add(new RemembranceAclEntry { path=path, kind=(info.Attributes & 16) != 0 ? "directory" : "file",
            reparse=(info.Attributes & 1024) != 0, owner_sid=sd.Owner == null ? null : sd.Owner.Value,
            null_dacl=sd.DiscretionaryAcl == null, persistent_acls=(filesystemFlags & 8) != 0, volume_serial=info.Volume.ToString(CultureInfo.InvariantCulture),
            file_id=(((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(CultureInfo.InvariantCulture), acl_fingerprint=fingerprint, aces=aces.ToArray() });
        } finally { LocalFree(descriptor); }
      }
      return rows.ToArray();
    } finally { foreach (var handle in handles) handle.Dispose(); }
  }
  public static object Page(string dir,string after,int count) {
    if(count<1||count>1024||after.Length>255)throw new InvalidOperationException();
    var directory=Read(new string[]{dir,System.IO.Path.GetDirectoryName(dir)});
    foreach(var p in directory)if(p.reparse||p.kind!="directory")throw new InvalidOperationException();
    var paths=new List<string>(System.IO.Directory.EnumerateFileSystemEntries(dir));
    paths.Sort(StringComparer.Ordinal);var rows=new List<object>();string next=after;bool more=false;long cost=0;
    foreach(var path in paths){string name=System.IO.Path.GetFileName(path);if(StringComparer.Ordinal.Compare(name,after)<=0)continue;
      if(rows.Count==count){more=true;break;}RemembranceAclEntry entry=null;
      try{entry=Read(new string[]{path})[0];}catch{}
      long size=2048+6L*(name.Length+path.Length);
      if(entry!=null){size+=6L*(entry.owner_sid??"").Length;foreach(var ace in entry.aces)size+=256+6L*ace.sid.Length;}
      if(rows.Count>0&&cost+size>6291456){more=true;break;}
      rows.Add(new{name=name,entry=entry,unavailable=entry==null});cost+=size;next=name;
    }
    return new{rows=rows.ToArray(),after=after,next_after=next,has_more=more,directory=directory};
  }
}
'@
  $phase='inspect'
  [Console]::Error.WriteLine('WINDOWS_ACL_PHASE:inspect')
  $paths = @($request.paths | ForEach-Object { [string]$_.path })
  if ($request.verb -eq 'create-private-file' -or $request.verb -eq 'create-private-directory') {
    $phase='create'
    [Console]::Error.WriteLine('WINDOWS_ACL_PHASE:create')
    if (@($request.paths).Count -ne 2) { throw 'Invalid create request' }
    $kind = if ($request.verb -eq 'create-private-file') { 'file' } else { 'directory' }
    $entries=@([RemembranceAclSnapshot]::Create($paths[0],$kind,$paths[1],[string]$request.expected_parent.volume_serial,[string]$request.expected_parent.file_id,[string]$request.expected_parent.acl_fingerprint))
    $result=@{ schema='windows-private-paths-v1'; current_sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries=$entries; created=$true; verb=$request.verb }
  } elseif ($request.verb -eq 'inspect-directory-page') {
    $result=@{schema='windows-private-paths-v1';current_sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;page=[RemembranceAclSnapshot]::Page($paths[0],[string]$request.after_name,[int]$request.page_count)}
  } elseif ($null -eq $request.verb) {
    $result = @{ schema='windows-private-paths-v1'; current_sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries=@([RemembranceAclSnapshot]::Read([string[]]$paths)) }
  } else { throw 'Invalid verb' }
  $outputBytes = [System.Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 8 -Compress))
  if($outputBytes.Length -gt 8388608){throw 'Output bound exceeded'}
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($outputBytes,0,$outputBytes.Length)
  $stdout.Flush()
  exit 0
} catch {
  $failure=$_.Exception
  for($i=0;$i -lt 8 -and $null -ne $failure.InnerException;$i++) { $failure=$failure.InnerException }
  $win32 = if ($failure -is [System.ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { -1 }
  [Console]::Error.WriteLine('WINDOWS_ACL_ERROR:{"phase":"'+$phase+'","type":"'+$failure.GetType().FullName+'","hresult":'+$failure.HResult+',"win32":'+$win32+'}')
  exit 1
}
`;
// Fixed whitespace/comment removal keeps the literal program within CreateProcess's
// command-line limit. No executable source is decoded, loaded or generated at runtime.
const ENCODED_SCRIPT = Buffer.from(POWERSHELL.split("\n").filter(line => !/^\s*\/\//u.test(line)).map(line => line.trim()).filter(Boolean).join("\n"), "utf16le").toString("base64");

function privatePath(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z]:[\\/]/u.test(value) ||
      /[\x00-\x1f]/u.test(value) || value.slice(2).includes(":") || value.split(/[\\/]/u).includes("..")) refuse();
  return win32.normalize(value);
}

function pathBatch(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > WINDOWS_ACL_LIMITS.maxPaths) refuse();
  const entries = new Map();
  const add = (path, kind, privacy) => {
    const key = path.toLowerCase(), prior = entries.get(key);
    if (prior && prior.kind !== kind) refuse();
    if (!prior || privacy === "private") entries.set(key, { path, kind, privacy });
    if (entries.size > WINDOWS_ACL_LIMITS.maxPaths) refuse();
  };
  for (const request of requests) {
    if (!request || !["file", "directory"].includes(request.kind)) refuse();
    const path = privatePath(request.path);
    add(path, request.kind, "private");
    const parent = win32.dirname(path);
    if (parent === path) refuse();
    add(parent, "directory", "integrity");
  }
  return [...entries.values()];
}

function validateSnapshot(raw, paths) {
  if (!raw || raw.schema !== SCHEMA || !SID.test(raw.current_sid ?? "") ||
      !Array.isArray(raw.entries) || raw.entries.length !== paths.length) refuse();
  const trusted = new Set([...ADMIN_SIDS, raw.current_sid]);
  return paths.map((expected, index) => {
    const row = raw.entries[index];
    if (!row || row.path !== expected.path || row.kind !== expected.kind || row.reparse !== false || row.null_dacl !== false || row.persistent_acls !== true ||
        !SID.test(row.owner_sid ?? "") || !(expected.privacy === "private" ? row.owner_sid === raw.current_sid : trusted.has(row.owner_sid)) ||
        !INTEGER.test(row.volume_serial ?? "") || !INTEGER.test(row.file_id ?? "") || BigInt(row.file_id) === 0n || !/^[a-f0-9]{64}$/u.test(row.acl_fingerprint ?? "") ||
        !Array.isArray(row.aces) || row.aces.length > 128) refuse();
    for (const ace of row.aces) {
      if (!ace || !SID.test(ace.sid ?? "") || !["allow", "deny"].includes(ace.type) ||
          (ace.callback !== undefined && ace.callback !== false) ||
          typeof ace.inherit_only !== "boolean" || !INTEGER.test(ace.mask ?? "") || BigInt(ace.mask) > 0xffffffffn) refuse();
      if (ace.type === "allow" && !ace.inherit_only && !trusted.has(ace.sid) &&
          (expected.privacy === "private" ? BigInt(ace.mask) !== 0n : (BigInt(ace.mask) & INTEGRITY_RIGHTS) !== 0n)) refuse();
    }
    const entry = Object.freeze({ path: expected.path, kind: expected.kind, privacy: expected.privacy,
      volume_serial: row.volume_serial, file_id: row.file_id, acl_fingerprint: row.acl_fingerprint });
    ISSUED.set(entry, raw.current_sid);
    return entry;
  });
}

function validateEnvironment(env) {
  const entries = Object.entries(env);
  if (entries.some(([key, value]) => typeof value !== "string" || value.includes("\0") || key.length + value.length + 2 > WINDOWS_ACL_LIMITS.environmentChars) ||
      entries.reduce((sum, [key, value]) => sum + key.length + value.length + 2, 1) > WINDOWS_ACL_LIMITS.environmentChars) refuse();
  return env;
}

function bootstrapEnvironment(dependencies) {
  const source = dependencies.environment ?? process.env;
  const systemRoot = privatePath(source.SystemRoot ?? "");
  const home = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const temp = privatePath(dependencies.tempDirectory ?? tmpdir());
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: temp, TMP: temp,
    ComSpec: win32.join(systemRoot, "System32", "cmd.exe"), ProgramFiles: privatePath(source.ProgramFiles ?? ""),
    USERPROFILE: privatePath(source.USERPROFILE ?? ""), APPDATA: privatePath(source.APPDATA ?? ""), LOCALAPPDATA: privatePath(source.LOCALAPPDATA ?? ""),
    PATH: [win32.join(systemRoot, "System32"), systemRoot, win32.join(systemRoot, "System32", "Wbem"), home].join(";"),
    PSModulePath: win32.join(home, "Modules") };
  return validateEnvironment(env);
}

// Trust the existing Windows agent process's OS bootstrap locations, never model/tool arguments.
export function windowsPrivatePathBootstrap() {
  if (process.platform !== "win32") refuse();
  return bootstrapEnvironment({ environment: process.env, tempDirectory: tmpdir() });
}

function runWithDependencies(paths, dependencies, extras = {}, accept = () => {}) {
  if ((dependencies.platform ?? process.platform) !== "win32") refuse();
  const env = bootstrapEnvironment(dependencies);
  const body = Buffer.from(JSON.stringify({ schema: SCHEMA, paths, ...extras }), "utf8");
  if (body.length > WINDOWS_ACL_LIMITS.inputBytes) refuse();
  const metadata = body.toString("base64");
  if (metadata.length > WINDOWS_ACL_LIMITS.metadataChars) refuse();
  env[METADATA_FIELD] = metadata;
  validateEnvironment(env);
  let phase = "native_process";
  const outputBytes = extras.verb === "inspect-directory-page" ? WINDOWS_DIRECTORY_PAGE_LIMITS.outputBytes : WINDOWS_ACL_LIMITS.outputBytes;
  const timeout = extras.verb === "inspect-directory-page" ? WINDOWS_DIRECTORY_PAGE_LIMITS.timeoutMs : WINDOWS_ACL_LIMITS.timeoutMs;
  const executable = win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-EncodedCommand", ENCODED_SCRIPT];
  if (`"${executable}" ${args.join(" ")}`.length >= 32767) refuse();
  try {
    const output = (dependencies.execFile ?? execFileSync)(
      executable, args,
      { encoding: "utf8", timeout, maxBuffer: outputBytes,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env },
    );
    phase = "response";
    if (typeof output !== "string" || Buffer.byteLength(output) > outputBytes) refuse();
    const raw = JSON.parse(output.replace(/^\uFEFF/u, ""));
    phase = "acl_policy";
    const accepted = accept(raw);
    if (accepted !== undefined) return accepted;
    return Object.freeze({ protection: "windows_dacl", current_sid: raw.current_sid, entries: Object.freeze(validateSnapshot(raw, paths)) });
  } catch (error) {
    const failure = new Error("Windows private storage protection could not be verified.");
    const stderr = String(error?.stderr ?? "");
    const markers = [...stderr.matchAll(/WINDOWS_ACL_PHASE:(started|environment_read|compile|inspect|create)/gu)];
    failure.diagnostic = { phase, last_child_phase: markers.at(-1)?.[1] ?? null,
      code: /^[A-Z0-9_]{1,32}$/u.test(error?.code ?? "") ? error.code : null,
      status: Number.isInteger(error?.status) ? error.status : null,
      signal: /^SIG[A-Z]{1,16}$/u.test(error?.signal ?? "") ? error.signal : null };
    const detail = /WINDOWS_ACL_ERROR:(\{[^\r\n]{1,1024}\})/u.exec(stderr);
    if (detail) try {
      const value = JSON.parse(detail[1]);
      if (["environment_read", "compile", "inspect", "create"].includes(value.phase) && /^[A-Za-z0-9_.]{1,160}$/u.test(value.type) && Number.isInteger(value.hresult)) {
        failure.diagnostic.exception = { phase: value.phase, type: value.type, hresult: value.hresult };
        if (value.phase === "create" && value.type === "System.ComponentModel.Win32Exception" && [80, 183].includes(value.win32)) failure.code = "EEXIST";
      }
    } catch { /* Raw native diagnostics are not exposed. */ }
    throw failure;
  }
}

function inspectWithDependencies(requests, dependencies) {
  return runWithDependencies(pathBatch(requests), dependencies);
}

function directoryPageWithDependencies(directory, after, count, dependencies) {
  const path = privatePath(directory), paths = pathBatch([{ path, kind: "directory" }]);
  const validName = name => typeof name === "string" && name.length > 0 && name.length <= 255 && ![".", ".."].includes(name) && !/[\\/:\x00-\x1f]/u.test(name);
  if ((after !== "" && !validName(after)) || !Number.isSafeInteger(count) || count < 1 || count > WINDOWS_DIRECTORY_PAGE_LIMITS.count) refuse();
  return runWithDependencies(paths, dependencies, { verb: "inspect-directory-page", after_name: after, page_count: count }, raw => {
    const page = raw?.page;
    if (!page || page.after !== after || !Array.isArray(page.rows) || page.rows.length > count || typeof page.has_more !== "boolean" ||
        (page.has_more && !page.rows.length) || page.next_after !== (page.rows.at(-1)?.name ?? after)) refuse();
    const entries = validateSnapshot({ ...raw, entries: page.directory }, paths);
    let prior = after;
    const rows = page.rows.map(row => {
      if (!row || !validName(row.name) || row.name <= prior || typeof row.unavailable !== "boolean" || (row.unavailable && row.entry !== null)) refuse();
      prior = row.name;
      let entry = null;
      if (!row.unavailable) try {
        entry = validateSnapshot({ ...raw, entries: [row.entry] }, [{ path: win32.join(path, row.name), kind: row.entry?.kind, privacy: "private" }])[0];
        if (!["file", "directory"].includes(entry.kind)) refuse();
      } catch { /* A rejected row never poisons healthy siblings. */ }
      return Object.freeze({ name: row.name, entry, unavailable: entry === null });
    });
    return Object.freeze({ protection: "windows_dacl", current_sid: raw.current_sid, entries: Object.freeze(entries), rows: Object.freeze(rows), next_after: page.next_after, has_more: page.has_more });
  });
}

export function inspectWindowsPrivateDirectoryPage(directory, after = "", count = WINDOWS_DIRECTORY_PAGE_LIMITS.count) {
  return directoryPageWithDependencies(directory, after, count, { platform: process.platform, environment: process.env, tempDirectory: tmpdir(), execFile: execFileSync });
}
export function inspectWindowsPrivateDirectoryPageForTests(directory, after, count, dependencies) {
  return directoryPageWithDependencies(directory, after, count, dependencies);
}

function createWithDependencies(request, parent, dependencies) {
  if (!request || Object.keys(request).sort().join(",") !== "kind,path" || !["file", "directory"].includes(request.kind)) refuse();
  const path = privatePath(request.path);
  if (!parent || !ISSUED.has(parent) || (request.kind === "file" && parent.privacy !== "private") || parent.kind !== "directory" || win32.dirname(path) !== parent.path) refuse();
  const paths = [{ path, kind: request.kind, privacy: "private" }, { path: parent.path, kind: "directory", privacy: parent.privacy }];
  const verb = `create-private-${request.kind}`;
  const result = runWithDependencies(paths, dependencies, { verb, expected_parent: {
    volume_serial: parent.volume_serial, file_id: parent.file_id, acl_fingerprint: parent.acl_fingerprint,
  } }, raw => {
    if (raw.created !== true || raw.verb !== verb || raw.current_sid !== ISSUED.get(parent)) refuse();
    const after = raw.entries?.[1];
    if (!after || after.volume_serial !== parent.volume_serial || after.file_id !== parent.file_id || after.acl_fingerprint !== parent.acl_fingerprint) refuse();
  });
  return Object.freeze({ created: true, protection: "windows_dacl", entry: result.entries[0], parent: result.entries[1] });
}

/** Create an empty private object atomically; callers bind returned IDs before writing content. */
export function createWindowsPrivatePath(request, privateParent) {
  return createWithDependencies(request, privateParent, { platform: process.platform, environment: process.env, tempDirectory: tmpdir(), execFile: execFileSync });
}

export function createWindowsPrivatePathForTests(request, privateParent, dependencies) {
  return createWithDependencies(request, privateParent, dependencies);
}

/** Fixed production entry: callers supply paths only, never executors or environments. */
export function inspectWindowsPrivatePaths(requests) {
  return inspectWithDependencies(requests, { platform: process.platform, environment: process.env, tempDirectory: tmpdir(), execFile: execFileSync });
}

/** Directory creation alone may use a parent with read/traverse grants to others. */
export function inspectWindowsCreationParent(path) {
  return runWithDependencies([{ path: privatePath(path), kind: "directory", privacy: "integrity" }],
    { platform: process.platform, environment: process.env, tempDirectory: tmpdir(), execFile: execFileSync }).entries[0];
}

// Unit seam follows the existing keychain test pattern; never called by storage consumers.
export function inspectWindowsPrivatePathsForTests(requests, dependencies) {
  return inspectWithDependencies(requests, dependencies);
}

/** Match ACL-handle identity to both caller observations; callers must use bigint stats. */
export function assertWindowsFileIdentity(entry, before, opened) {
  if (!entry || !INTEGER.test(entry.volume_serial ?? "") || !INTEGER.test(entry.file_id ?? "") || BigInt(entry.file_id) === 0n) refuse();
  for (const metadata of [before, opened]) {
    if (!metadata || typeof metadata.dev !== "bigint" || typeof metadata.ino !== "bigint" ||
        metadata.dev !== BigInt(entry.volume_serial) || metadata.ino !== BigInt(entry.file_id)) refuse();
  }
}
