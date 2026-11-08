import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, linkSync, writeSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireEffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js'

/** A staged file is retained on uncertain termination; callers must not retry blindly. */
export type GuardedPlanWriteResult =
  | { status: 'committed'; path: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; stagedPath: string; path: string; diagnostic?: string }

// This narrow helper owns the directory handles and the file write in the same
// process. Payload bytes travel over stdin, never in arguments or output.
const WINDOWS_PLAN_WRITE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class BabelPrivatePlanWrite {
  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint attr, creationLow, creationHigh, accessLow, accessHigh, writeLow, writeHigh, serial, sizeHigh, sizeLow, links, indexHigh, indexLow; }
  [StructLayout(LayoutKind.Sequential)] public struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr data,uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder path,uint length,uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
  public static SafeFileHandle OpenDir(string path, bool create, out Info info) {
    info = new Info();
    var h = CreateFile(path, create ? 162u : 160u, 3, IntPtr.Zero, 3, 35651584, IntPtr.Zero);
    if (h.IsInvalid || !GetFileInformationByHandle(h, out info)) { h.Dispose(); throw new System.IO.IOException("directory handle unavailable"); }
    if ((info.attr & 1024) != 0 || (info.attr & 16) == 0) { h.Dispose(); throw new System.IO.IOException("linked or invalid directory"); }
    return h;
  }
  public static SafeFileHandle CreateStage(string path, string ownerSid) {
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;FA;;;" + ownerSid + ")(A;;FA;;;SY)", 1, out descriptor, out size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    IntPtr attributes = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityAttributes)));
    try {
      var value = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = 0 };
      Marshal.StructureToPtr(value, attributes, false);
      var h = CreateFile(path, 1073807360, 0, attributes, 1, 128, IntPtr.Zero);
      if (h.IsInvalid) { h.Dispose(); throw new System.IO.IOException("stage unavailable"); }
      return h;
    } finally { Marshal.FreeHGlobal(attributes); LocalFree(descriptor); }
  }
  public static void RenameNoReplace(SafeFileHandle file, string name) {
    byte[] bytes = Encoding.Unicode.GetBytes(name);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = IntPtr.Size == 8 ? 16 : 8;
    int nameOffset = IntPtr.Size == 8 ? 20 : 12;
    // Include an explicit UTF-16 terminator; the byte length excludes it.
    int length = nameOffset + bytes.Length + 2;
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      for (int i = 0; i < length; i++) Marshal.WriteByte(buffer, i, 0);
      // The destination is an absolute path under the held directory.
      Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
      Marshal.WriteInt32(buffer, lengthOffset, bytes.Length);
      Marshal.Copy(bytes, 0, IntPtr.Add(buffer, nameOffset), bytes.Length);
      if (!SetFileInformationByHandle(file, 3, buffer, (uint)length)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void VerifyFinalPath(SafeFileHandle file, string expected) {
    var path = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(file, path, (uint)path.Capacity, 0);
    if (length == 0 || length >= path.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    string actual = path.ToString();
    if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) actual = @"\\" + actual.Substring(8);
    else if (actual.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) actual = actual.Substring(4);
    if (!String.Equals(System.IO.Path.GetFullPath(actual), System.IO.Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new System.IO.IOException("renamed file path differs");
  }
}
'@
$handles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
$started = $false
try {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { throw 'missing request' }
  $request = $line | ConvertFrom-Json
  $root = [IO.Path]::GetFullPath([string]$request.root)
  $name = [string]$request.name
  $temp = [string]$request.temp
  if ($name -notmatch '^plan_[a-f0-9-]{36}\.json$' -or $temp -notmatch '^plan_[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$') { throw 'invalid name' }
  $dirs = New-Object 'System.Collections.Generic.List[string]'
  $current = $root
  while ($true) { $dirs.Insert(0, $current); $parent = [IO.Directory]::GetParent($current); if ($null -eq $parent) { break }; $current = $parent.FullName }
  $rootInfo = [BabelPrivatePlanWrite+Info]::new()
  foreach ($dir in $dirs) { $info = [BabelPrivatePlanWrite+Info]::new(); $handles.Add([BabelPrivatePlanWrite]::OpenDir($dir, $false, [ref]$info)); $rootInfo = $info }
  $inode = ([uint64]$rootInfo.indexHigh -shl 32) -bor [uint64]$rootInfo.indexLow
  if ([string]$rootInfo.serial -ne [string]$request.device -or [string]$inode -ne [string]$request.inode) { throw 'directory identity changed' }
  $plans = Join-Path $root 'plans'
  [IO.Directory]::CreateDirectory($plans) | Out-Null
  $plansInfo = [BabelPrivatePlanWrite+Info]::new()
  $plansHandle = [BabelPrivatePlanWrite]::OpenDir($plans, $true, [ref]$plansInfo)
  $handles.Add($plansHandle)
  $tempPath = Join-Path $plans $temp; $finalPath = Join-Path $plans $name
  $bytes = [Convert]::FromBase64String([string]$request.content)
  $started = $true
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $file = [BabelPrivatePlanWrite]::CreateStage($tempPath, $ownerSid)
  $stream = [IO.FileStream]::new($file, [IO.FileAccess]::Write)
  try {
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    [Console]::Out.WriteLine('STAGED'); [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -ne 'COMMIT') { throw 'commit not admitted' }
    [BabelPrivatePlanWrite]::RenameNoReplace($file, $finalPath)
    [BabelPrivatePlanWrite]::VerifyFinalPath($file, $finalPath)
  } finally { $stream.Dispose() }
  [Console]::Out.WriteLine('COMMITTED'); [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'ACK') { throw 'acknowledgement missing' }
} catch {
  $cause = $_.Exception
  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
  if ($cause -is [ComponentModel.Win32Exception]) { [Console]::Out.WriteLine('NATIVE:' + $cause.NativeErrorCode) }
  else { [Console]::Out.WriteLine('ERROR:' + $cause.GetType().FullName) }
  if ($started) { [Console]::Out.WriteLine('UNKNOWN') } else { [Console]::Out.WriteLine('REJECTED') }
  [Console]::Out.Flush(); exit 1
} finally { foreach ($handle in $handles) { $handle.Dispose() } }
`

/**
 * POSIX writer: hold the plans directory open, stage with exclusive create,
 * fsync, then publish with a no-replace link and remove the staged name.
 */
async function writePosixPlanWithDirectoryGuard(input: {
  stateRoot: string; planId: string; content: string; signal?: AbortSignal
}): Promise<GuardedPlanWriteResult> {
  if (!/^plan_[a-f0-9-]{36}$/.test(input.planId) || Buffer.byteLength(input.content, 'utf8') > 2 * 1024 * 1024) {
    return { status: 'rejected', reason: 'Invalid or oversized Plan artifact.' }
  }
  input.signal?.throwIfAborted()
  const root = resolve(input.stateRoot)
  const name = `${input.planId}.json`
  const temp = `${name}.${randomUUID()}.tmp`
  const plans = join(root, 'plans')
  const path = join(plans, name); const stagedPath = join(plans, temp)
  let anchors: Awaited<ReturnType<typeof acquireEffectDirectoryAnchors>> | undefined
  try {
    const info = lstatSync(root, { bigint: true })
    const normalize = (value: string) => value.toLowerCase()
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n || normalize(realpathSync(root)) !== normalize(root)) {
      return { status: 'rejected', reason: 'Unsafe Plan state directory.' }
    }
    mkdirSync(plans, { recursive: true, mode: 0o700 })
    const plansInfo = lstatSync(plans, { bigint: true })
    if (!plansInfo.isDirectory() || plansInfo.isSymbolicLink() || normalize(realpathSync(plans)) !== normalize(plans)) {
      return { status: 'rejected', reason: 'Unsafe Plan state directory.' }
    }
    if (existsSync(path)) return { status: 'rejected', reason: 'Plan artifact already exists.' }
    anchors = await acquireEffectDirectoryAnchors([plans])
    const staged = anchors.path(stagedPath); const final = anchors.path(path)
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      writeSync(fd, input.content, null, 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    if (input.signal?.aborted) {
      try { unlinkSync(staged) } catch { /* retained staging is reported by the caller */ }
      input.signal.throwIfAborted()
    }
    anchors.path(join(plans, '__babel_plan_commit_anchor__'))
    try { linkSync(staged, final) }
    catch (error) {
      try { unlinkSync(staged) } catch { /* best effort */ }
      const code = (error as NodeJS.ErrnoException).code
      return code === 'EEXIST'
        ? { status: 'rejected', reason: 'Plan artifact already exists.' }
        : { status: 'unknown', stagedPath, path }
    }
    try { unlinkSync(join(plans, temp)) } catch { /* the published link is authoritative */ }
    const published = statSync(final)
    const expectedSize = Buffer.byteLength(input.content, 'utf8')
    if (!published.isFile() || published.isSymbolicLink() || published.size !== expectedSize) {
      return { status: 'unknown', stagedPath, path }
    }
    return { status: 'committed', path }
  } catch (error) {
    try { unlinkSync(join(plans, temp)) } catch { /* no staged artifact */ }
    if (input.signal?.aborted) input.signal.throwIfAborted()
    if (error instanceof Error && 'code' in error) return { status: 'rejected', reason: 'Plan state directory or writer is unavailable.' }
    throw error
  } finally { await anchors?.release() }
}

/** Windows-only candidate for creating a new private Plan artifact, not yet wired to product paths. */
export async function writeNewPlanWithDirectoryGuard(input: {
  stateRoot: string; planId: string; content: string; signal?: AbortSignal
}): Promise<GuardedPlanWriteResult> {
  if (process.platform !== 'win32') return writePosixPlanWithDirectoryGuard(input)
  if (!/^plan_[a-f0-9-]{36}$/.test(input.planId) || Buffer.byteLength(input.content, 'utf8') > 2 * 1024 * 1024) return { status: 'rejected', reason: 'Invalid or oversized Plan artifact.' }
  input.signal?.throwIfAborted()
  const root = resolve(input.stateRoot)
  const name = `${input.planId}.json`
  const temp = `${name}.${randomUUID()}.tmp`
  const path = join(root, 'plans', name); const stagedPath = join(root, 'plans', temp)
  let child: ChildProcessWithoutNullStreams | undefined
  let close: Promise<number | null> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const info = lstatSync(root, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino <= 0n || realpathSync(root).toLowerCase() !== root.toLowerCase()) return { status: 'rejected', reason: 'Unsafe Plan state directory.' }
    const pwsh = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    const executable = existsSync(pwsh) ? pwsh : join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['SystemRoot', 'WINDIR', 'ProgramFiles', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key]
    child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PLAN_WRITE_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
    const ownedChild = child
    close = new Promise<number | null>(done => { ownedChild.once('error', () => {}); ownedChild.once('close', code => done(code)) })
    child.stderr.on('error', () => ownedChild.kill()); child.stderr.resume()
    child.stdout.on('error', () => ownedChild.kill()); child.stdin.on('error', () => ownedChild.kill())
    let output = ''; let commitRequested = false; let acknowledged = false; let rejected = false; let timedOut = false
    abort = () => { ownedChild.kill() }
    input.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { timedOut = true; ownedChild.kill() }, 30_000)
    ownedChild.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 4096) { ownedChild.kill(); return }
      const lines = output.split(/\r?\n/)
      try {
        if (lines.includes('STAGED') && !commitRequested && !input.signal?.aborted) { commitRequested = true; ownedChild.stdin.write('COMMIT\n') }
        if (lines.includes('COMMITTED') && !acknowledged && !input.signal?.aborted) { acknowledged = true; ownedChild.stdin.write('ACK\n') }
      } catch { ownedChild.kill() }
      if (lines.includes('REJECTED')) rejected = true
    })
    child.stdin.write(`${JSON.stringify({ root, name, temp, device: String(info.dev), inode: String(info.ino), content: Buffer.from(input.content, 'utf8').toString('base64') })}\n`)
    if (input.signal?.aborted) child.kill()
    const code = await close
    if (code === 0 && output.split(/\r?\n/).includes('COMMITTED')) return { status: 'committed', path }
    if (rejected && !commitRequested && !timedOut) return { status: 'rejected', reason: 'Plan directory or identity was rejected.' }
    const diagnostic = output.split(/\r?\n/).find(line => /^(?:NATIVE:\d+|ERROR:[A-Za-z0-9_.]+)$/.test(line))
    return { status: 'unknown', stagedPath, path, ...(diagnostic ? { diagnostic } : {}) }
  } catch {
    if (child) { child.kill(); if (close) await close; return { status: 'unknown', stagedPath, path } }
    return { status: 'rejected', reason: 'Plan state directory or writer is unavailable.' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) input.signal?.removeEventListener('abort', abort)
  }
}
