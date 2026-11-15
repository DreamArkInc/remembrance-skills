import { win32 } from "node:path";

// Returned instructions only: no process execution, body reads, or checker changes.
// Windows PowerShell 5.1 provides the .NET Framework File/Directory ACL methods.
export const WINDOWS_LOCAL_RECOVERY_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $encoded = [Environment]::GetEnvironmentVariable('REMEMBRANCE_WINDOWS_RECOVERY_TARGET','Process')
  if ($null -eq $encoded -or $encoded.Length -gt 12288 -or $encoded -notmatch '\A[A-Za-z0-9+/]*={0,2}\z') { throw 'Refused' }
  $bytes = [Convert]::FromBase64String($encoded)
  if ($bytes.Length -eq 0 -or $bytes.Length -gt 8192) { throw 'Refused' }
  $request = [System.Text.UTF8Encoding]::new($false,$true).GetString($bytes) | Microsoft.PowerShell.Utility\ConvertFrom-Json
  if ((@($request.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'kind,path,schema' -or $request.schema -ne 'windows-local-recovery-v1') { throw 'Refused' }
  $path = $request.path
  if ($path -isnot [string] -or $path.Length -gt 2048 -or $path -notmatch '\A[A-Za-z]:[\\/]' -or $path -match '[\x00-\x1f]' -or $path.Substring(2).Contains(':') -or @($path -split '[\\/]' | Where-Object { $_ -eq '..' }).Count -gt 0) { throw 'Refused' }
  if ($request.kind -notin @('file','directory')) { throw 'Refused' }
  $path = [IO.Path]::GetFullPath($path)
  $parent = [IO.Path]::GetDirectoryName($path)
  if ([string]::IsNullOrEmpty($parent) -or $parent -eq $path) { throw 'Refused' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value,'S-1-5-18','S-1-5-32-544')
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  function Snapshot([string]$name,[bool]$directory,[bool]$currentOwner,[bool]$private) {
    $attributes = [IO.File]::GetAttributes($name)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Refused' }
    $acl = if ($directory) { [IO.Directory]::GetAccessControl($name,$sections) } else { [IO.File]::GetAccessControl($name,$sections) }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (($currentOwner -and $owner -ne $sid.Value) -or (!$currentOwner -and $owner -notin $trusted)) { throw 'Refused' }
    $binary = $acl.GetSecurityDescriptorBinaryForm()
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($binary,0)
    if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -gt 128) { throw 'Refused' }
    # Numeric identity enumeration avoids account-name resolution/network lookup.
    $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if ($rules.Count -gt 128) { throw 'Refused' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @([Security.AccessControl.AceQualifier]::AccessAllowed,[Security.AccessControl.AceQualifier]::AccessDenied)) { throw 'Refused' }
      # AceFlags is byte-backed; use lossless integer operands for PS5 bitwise operations.
      $flags = [int]$ace.AceFlags
      $inheritance = [int][Security.AccessControl.AceFlags]::ObjectInherit -bor [int][Security.AccessControl.AceFlags]::ContainerInherit
      if ($currentOwner -and ($flags -band $inheritance) -ne 0) { throw 'Refused' }
      if (($flags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
      if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $ace.SecurityIdentifier.Value -notin $trusted) {
        $mask = [uint64]([int64]$ace.AccessMask -band 4294967295L)
        if (($private -and $mask -ne 0) -or (($mask -band 1343029590L) -ne 0)) { throw 'Refused' }
      }
    }
    return [Convert]::ToBase64String($binary)
  }
  function AssertEmptyDirectory([string]$name) {
    $enumerator = [IO.Directory]::EnumerateFileSystemEntries($name).GetEnumerator()
    try { if ($enumerator.MoveNext()) { throw 'Refused' } }
    finally { if ($enumerator -is [IDisposable]) { $enumerator.Dispose() } }
  }
  $directory = $request.kind -eq 'directory'
  $parentBefore = Snapshot $parent $true $false $false
  $targetBefore = Snapshot $path $directory $true $false
  if ($directory) { AssertEmptyDirectory $path }
  $replacement = if ($directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $replacement.SetOwner($sid)
  $replacement.SetAccessRuleProtection($true,$false)
  foreach ($principal in $trusted) {
    $numeric = New-Object Security.Principal.SecurityIdentifier($principal)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($numeric,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $replacement.AddAccessRule($rule)
  }
  # Recheck only exact-object/parent ACL metadata. No file body is opened.
  if ((Snapshot $parent $true $false $false) -ne $parentBefore -or (Snapshot $path $directory $true $false) -ne $targetBefore) { throw 'Refused' }
  if ($directory) { AssertEmptyDirectory $path; [IO.Directory]::SetAccessControl($path,$replacement) }
  else { [IO.File]::SetAccessControl($path,$replacement) }
  $null = Snapshot $path $directory $true $true
  if ((Snapshot $parent $true $false $false) -ne $parentBefore) { throw 'Refused' }
  [Console]::Out.WriteLine('Remembrance exact-object permissions restored. Rerun the indicated doctor or bootstrap tool.')
  exit 0
} catch {
  [Console]::Error.WriteLine('Remembrance permission recovery held. Review only this object and its immediate parent ownership/ACL metadata. Restoring folder permissions may affect existing children; obtain owner review and scoped consent before broader OS repair. Preserve existing data and trust history, then rerun doctor or bootstrap after authorized restoration.')
  exit 1
}
`.trim();

const instructions = "Run this fixed recipe through the normal host shell for the internally selected local path. It changes only permissions on a current-owned file or empty directory, reads no credential body, and performs no network requests. Rerun the indicated tool only after success.";
const refusal = "Use .NET GetAccessControl with Owner and Access sections, GetOwner(SecurityIdentifier), and GetAccessRules(true,true,SecurityIdentifier) to inspect only the selected object and immediate parent numeric ownership/ACL metadata (at most128 ACEs each). Read no file bodies or descendant content; prepare owner review. Restoring folder permissions may affect existing children. Obtain scoped owner consent before any broader OS repair, or restore original protection from an authorized known backup. Preserve data and trust history; rerun doctor/bootstrap after authorized restoration, not repeatedly during the hold.";

export function windowsLocalRecoveryStep(path, kind, tool) {
  if (typeof path !== "string" || path.length > 2048 || !/^[A-Za-z]:[\\/]/u.test(path) || /[\x00-\x1f]/u.test(path) || path.slice(2).includes(":") || path.split(/[\\/]/u).includes("..") ||
      !["file", "directory"].includes(kind) || !["get_connection_status", "bootstrap_agent_identity"].includes(tool)) throw new Error("Invalid Windows permission recovery target.");
  path = win32.normalize(path);
  if (win32.dirname(path) === path) throw new Error("Invalid Windows permission recovery target.");
  return {
    code: "restore_windows_private_permissions", execution: "normal_host_shell",
    executable: "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_LOCAL_RECOVERY_POWERSHELL, "utf16le").toString("base64")],
    environment: { REMEMBRANCE_WINDOWS_RECOVERY_TARGET: Buffer.from(JSON.stringify({ schema: "windows-local-recovery-v1", path, kind }), "utf8").toString("base64") },
    program: WINDOWS_LOCAL_RECOVERY_POWERSHELL, instructions,
    on_success: { tool, arguments: {} }, on_refusal: { code: "owner_review_required", instructions: refusal },
    history_limit: "Restoring current permissions does not assess past access or revoke previously opened foreign handles; it makes no retroactive confidentiality claim.",
  };
}
