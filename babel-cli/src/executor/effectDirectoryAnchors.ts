import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, lstat, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface EffectDirectoryAnchors {
  path(path: string): string
  release(): Promise<void>
}

type ChildProcessSpawn = typeof spawn

let childProcessSpawn: ChildProcessSpawn = spawn

/** @internal Inject spawn for deterministic Windows helper lifecycle tests. */
export function __testSetChildProcessSpawn(factory: ChildProcessSpawn): void {
  childProcessSpawn = factory
}

/** @internal Restore production spawn hook after tests. */
export function __testResetChildProcessSpawn(): void {
  childProcessSpawn = spawn
}

/** Maximum UTF-8 bytes retained from helper stdout (not JavaScript string length). */
const WINDOWS_HELPER_STDOUT_BYTE_LIMIT = 1024

const ALLOWED_STAGE_LINES = new Set(['STAGE:boot', 'STAGE:typed', 'STAGE:open'])
const WINDOWS_ACQUIRE_TIMEOUT_MS = 15000

let windowsAcquireTimeoutMs = WINDOWS_ACQUIRE_TIMEOUT_MS

/** @internal Linux-only: shorten the deadline to test timeout cleanup shape, not Windows timing. */
export function __testSetWindowsAcquireTimeoutMs(timeoutMs: number): void {
  windowsAcquireTimeoutMs = timeoutMs
}

/** @internal Restore the production acquisition deadline after tests. */
export function __testResetWindowsAcquireTimeoutMs(): void {
  windowsAcquireTimeoutMs = WINDOWS_ACQUIRE_TIMEOUT_MS
}

// Node does not expose Windows directory sharing flags. This trusted helper
// opens directory-list/read-attribute handles without FILE_SHARE_DELETE, preventing
// ancestor rename/junction replacement until this owned helper exits.
const WINDOWS_LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('STAGE:boot')
[Console]::Out.Flush()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BabelDirectoryGuard {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  public static SafeFileHandle OpenDirectory(string name, out int error) {
    var handle = CreateFile(name, 129, 3, IntPtr.Zero, 3, 33554432, IntPtr.Zero);
    error = Marshal.GetLastWin32Error();
    return handle;
  }
}
'@
[Console]::Out.WriteLine('STAGE:typed')
[Console]::Out.Flush()
$handles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__BABEL_PATHS__')) | ConvertFrom-Json
  [Console]::Out.WriteLine('STAGE:open')
  [Console]::Out.Flush()
  foreach ($path in $request.paths) {
    [int]$nativeError = 0
    $handle = [BabelDirectoryGuard]::OpenDirectory($path, [ref]$nativeError)
    if ($handle.IsInvalid) { [Console]::Out.WriteLine('ERROR:' + $handles.Count + ':' + $nativeError); exit 1 }
    $handles.Add($handle)
  }
  [Console]::Out.WriteLine('READY:' + $handles.Count)
  [Console]::Out.Flush()
  [Diagnostics.Process]::GetProcessById(__BABEL_PARENT_PID__).WaitForExit()
} catch { [Console]::Out.WriteLine('ERROR:directory-handle'); exit 1 }
finally { foreach ($handle in $handles) { $handle.Dispose() } }
`

function ancestors(path: string): string[] {
  const result: string[] = []
  let current = resolve(path)
  while (true) {
    result.push(current)
    const parent = dirname(current)
    if (parent === current) return result
    current = parent
  }
}

/** @internal Expected READY line for injected Windows pin tests. */
export function __testWindowsReadyLineForBoundDirectories(boundDirectories: string[]): string {
  const directories = [...new Set(boundDirectories.map(path => resolve(path)).flatMap(ancestors))]
  return `READY:${directories.length}`
}

function windowsPowerShellExecutable(): string {
  const powerShell7 = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(powerShell7)) return powerShell7
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function spawnWindowsPowerShell(script: string): ChildProcess {
  const executable = windowsPowerShellExecutable()
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  const options: SpawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  // Direct spawn call site for host-process manifest scanning; tests inject via childProcessSpawn.
  if (childProcessSpawn === spawn) return spawn(executable, args, options)
  return childProcessSpawn(executable, args, options)
}

function takeStdoutLine(buffer: string): { line?: string; rest: string } {
  const newline = buffer.indexOf('\n')
  if (newline < 0) return { rest: buffer }
  const line = buffer.slice(0, newline).replace(/\r$/, '')
  return { line, rest: buffer.slice(newline + 1) }
}

function latestStage(transcript: string): string {
  const lines = transcript.split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('STAGE:')) return line.slice('STAGE:'.length)
  }
  return 'startup'
}

function appendBoundedUtf8(current: string, chunk: Buffer, limitBytes: number): string | undefined {
  const text = chunk.toString('utf8')
  const combined = current + text
  if (Buffer.byteLength(combined, 'utf8') > limitBytes) return undefined
  return combined
}

function classifyStdoutLine(line: string, readyLine: string): 'stage' | 'ready' | 'error' | 'invalid' {
  if (ALLOWED_STAGE_LINES.has(line)) return 'stage'
  if (line.startsWith('ERROR:')) return 'error'
  if (line.startsWith('READY:')) return line === readyLine ? 'ready' : 'invalid'
  return 'invalid'
}

function refuseLine(line: string): Error {
  return new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handles refused ${line.slice(0, 100)}`)
}

/** Process every complete line currently in pending; fail-closed on protocol violations. */
function processPendingStdoutLines(
  pending: string,
  readyLine: string,
): { pending: string; ready?: true; error?: Error } {
  let afterReady = false
  let rest = pending
  while (true) {
    const { line, rest: next } = takeStdoutLine(rest)
    if (line === undefined) {
      if (afterReady) {
        if (rest.length > 0) {
          return { pending: rest, error: refuseLine(rest) }
        }
        return { pending: rest, ready: true }
      }
      return { pending: rest }
    }
    rest = next
    if (!afterReady) {
      const kind = classifyStdoutLine(line, readyLine)
      if (kind === 'invalid' || kind === 'error') return { pending: rest, error: refuseLine(line) }
      if (kind === 'ready') {
        afterReady = true
        continue
      }
      continue
    }
    return { pending: rest, error: refuseLine(line) }
  }
}

async function waitForWindowsReadyLine(
  child: ChildProcess,
  readyLine: string,
  state: { pending: string; transcript: string; diagnostic: string; exited: boolean; ready: boolean },
): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let finished = false
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      child.stdout?.off('data', onStdout)
      error ? reject(error) : resolveReady()
    }
    const timeout = setTimeout(() => {
      child.kill()
      const stage = latestStage(state.transcript)
      const detail = state.transcript.trim() || state.diagnostic.trim() || 'no helper output'
      finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handle acquisition timed out (last stage: ${stage}): ${detail.slice(0, 200)}`))
    }, windowsAcquireTimeoutMs)
    const onStdout = (chunk: Buffer): void => {
      const nextTranscript = appendBoundedUtf8(state.transcript, chunk, WINDOWS_HELPER_STDOUT_BYTE_LIMIT)
      if (nextTranscript === undefined) {
        child.kill()
        finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows helper stdout exceeded ${WINDOWS_HELPER_STDOUT_BYTE_LIMIT}-byte bound`))
        return
      }
      state.transcript = nextTranscript
      const nextPending = appendBoundedUtf8(state.pending, chunk, WINDOWS_HELPER_STDOUT_BYTE_LIMIT)
      if (nextPending === undefined) {
        child.kill()
        finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows helper stdout exceeded ${WINDOWS_HELPER_STDOUT_BYTE_LIMIT}-byte bound`))
        return
      }
      state.pending = nextPending
      const parsed = processPendingStdoutLines(state.pending, readyLine)
      state.pending = parsed.pending
      if (parsed.error) {
        child.kill()
        finish(parsed.error)
        return
      }
      if (parsed.ready) {
        state.ready = true
        finish()
      }
    }
    child.stdout?.on('data', onStdout)
    child.once('error', () => finish(new Error('EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows helper unavailable')))
    child.once('exit', () => {
      if (state.ready) {
        finish()
        return
      }
      finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handles refused ${state.transcript.trim() || state.diagnostic}`))
    })
  })
}

async function pinWindowsDirectories(paths: string[]): Promise<EffectDirectoryAnchors> {
  const directories = [...new Set(paths.flatMap(ancestors))].sort((a, b) => a.length - b.length)
  const readyLine = `READY:${directories.length}`
  const script = WINDOWS_LOCK_SCRIPT.replace('__BABEL_PATHS__', Buffer.from(JSON.stringify({ paths: directories }), 'utf8').toString('base64'))
    .replace('__BABEL_PARENT_PID__', String(process.pid))
  const child = spawnWindowsPowerShell(script)
  const state = { pending: '', transcript: '', diagnostic: '', exited: false, ready: false }
  child.stderr?.on('data', (chunk: Buffer) => {
    state.diagnostic = (state.diagnostic + chunk.toString('utf8')).slice(0, 1000)
  })
  const exit = new Promise<void>(resolveExit => {
    child.once('exit', () => { state.exited = true; resolveExit() })
    child.once('error', () => { state.exited = true; resolveExit() })
  })
  try {
    await waitForWindowsReadyLine(child, readyLine, state)
    let killRequested = false
    return {
      path: path => {
        if (state.exited || !paths.includes(dirname(path))) throw new Error('EFFECT_DIRECTORY_ANCHOR_LOST')
        return path
      },
      release: async () => {
        if (!killRequested) {
          killRequested = true
          if (!state.exited) child.kill()
        }
        await exit
      },
    }
  } catch (error) {
    if (!state.exited) child.kill()
    await exit
    throw error
  }
}

/** @internal Exercise the production Windows pin path on Linux via spawn injection. */
export async function __testPinWindowsDirectories(boundDirectories: string[]): Promise<EffectDirectoryAnchors> {
  return pinWindowsDirectories(boundDirectories.map(path => resolve(path)))
}

/** Bind path operations to stable directories instead of check/use pathnames. */
export async function acquireEffectDirectoryAnchors(paths: string[]): Promise<EffectDirectoryAnchors> {
  const directories = [...new Set(paths.map(path => resolve(path)))]
  if (process.platform === 'win32') return pinWindowsDirectories(directories)
  const handles = new Map<string, FileHandle>()
  try {
    for (const path of directories) {
      const before = await lstat(path)
      const handle = await open(path, 'r')
      handles.set(path, handle)
      const observed = await handle.stat()
      if (!observed.isDirectory() || observed.ino !== before.ino || observed.dev !== before.dev) throw new Error('EFFECT_DIRECTORY_ANCHOR_LOST')
      const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
      const anchored = await stat(join(fdRoot, String(handle.fd)))
      if (anchored.ino !== observed.ino || anchored.dev !== observed.dev) throw new Error('EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE')
    }
    return {
      path: path => {
        const handle = handles.get(dirname(path))
        if (!handle) throw new Error('EFFECT_DIRECTORY_ANCHOR_LOST')
        return join(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd', String(handle.fd), basename(path))
      },
      release: async () => { for (const handle of handles.values()) await handle.close(); handles.clear() },
    }
  } catch (error) {
    await Promise.allSettled([...handles.values()].map(handle => handle.close()))
    throw error
  }
}
