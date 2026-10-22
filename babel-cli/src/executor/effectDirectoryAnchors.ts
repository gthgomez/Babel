import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, lstat, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface EffectDirectoryAnchors {
  path(path: string): string
  release(): Promise<void>
}

// Allow bounded cold startup before the managed Windows guard acknowledges readiness.
const WINDOWS_ANCHOR_STARTUP_TIMEOUT_MS = 60_000

// Node does not expose Windows directory sharing flags. This trusted helper
// opens traverse/read-attribute handles without FILE_SHARE_DELETE, preventing
// ancestor rename/junction replacement until this owned helper exits.
// Ancestors can allow traversal and attributes while denying directory listing.
// Attribute-only handles do not enforce delete sharing on empty directories.
const WINDOWS_LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BabelDirectoryGuard {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  public static SafeFileHandle OpenDirectory(string name, out int error) {
    var handle = CreateFile(name, 160, 3, IntPtr.Zero, 3, 33554432, IntPtr.Zero);
    error = Marshal.GetLastWin32Error();
    return handle;
  }
}
'@
$handles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__BABEL_PATHS__')) | ConvertFrom-Json
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

async function pinWindowsDirectories(paths: string[]): Promise<EffectDirectoryAnchors> {
  const directories = [...new Set(paths.flatMap(ancestors))].sort((a, b) => a.length - b.length)
  const powerShell7 = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const executable = existsSync(powerShell7) ? powerShell7
    : join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = WINDOWS_LOCK_SCRIPT.replace('__BABEL_PATHS__', Buffer.from(JSON.stringify({ paths: directories }), 'utf8').toString('base64'))
    .replace('__BABEL_PARENT_PID__', String(process.pid))
  const readyLine = `READY:${directories.length}`
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let diagnostic = ''
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, 1000) })
  let exited = false
  const exit = new Promise<void>(resolveExit => {
    child.once('exit', () => { exited = true; resolveExit() })
    child.once('error', () => { exited = true; resolveExit() })
  })
  try {
    await new Promise<void>((ready, reject) => {
      let output = ''
      const timeout = setTimeout(() => { child.kill(); reject(new Error('EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handle acquisition timed out')) }, WINDOWS_ANCHOR_STARTUP_TIMEOUT_MS)
      const finish = (error?: Error): void => { clearTimeout(timeout); error ? reject(error) : ready() }
      child.once('error', () => finish(new Error('EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows helper unavailable')))
      child.once('exit', () => { if (!output.startsWith(readyLine)) finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handles refused ${output.trim() || diagnostic}`)) })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.trim() === readyLine) finish()
        else if (output.includes('\n') || output.length > 1024) finish(new Error(`EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handles refused ${output.trim().slice(0, 100)}`))
      })
    })
    return {
      path: path => {
        if (exited || !paths.includes(dirname(path))) throw new Error('EFFECT_DIRECTORY_ANCHOR_LOST')
        return path
      },
      release: async () => { if (!exited) child.kill(); await exit },
    }
  } catch (error) {
    child.kill(); await exit
    throw error
  }
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
