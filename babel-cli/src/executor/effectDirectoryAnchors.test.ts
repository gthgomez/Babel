import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { acquireEffectDirectoryAnchors, type EffectDirectoryAnchors } from './effectDirectoryAnchors.js'

test('directory anchors retain the original parent across replacement attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-directory-anchor-'))
  const parent = join(root, 'parent')
  const moved = join(root, 'moved')
  await mkdir(parent)
  const target = join(parent, 'file')
  if (process.platform !== 'win32') await writeFile(target, 'original')
  let anchors: Awaited<ReturnType<typeof acquireEffectDirectoryAnchors>> | undefined
  try {
    anchors = await acquireEffectDirectoryAnchors([parent])
    if (process.platform === 'win32') {
      assert.equal(anchors.path(target), target)
      // Keep the directory empty: attribute-only handles can block a nonempty
      // directory incidentally while permitting replacement of an empty one.
      await assert.rejects(rename(parent, moved), (error: NodeJS.ErrnoException) =>
        ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? ''))
    } else {
      await rename(parent, moved)
      await mkdir(parent)
      await writeFile(target, 'replacement')
      assert.equal(await readFile(anchors.path(target), 'utf8'), 'original')
      assert.equal(await readFile(target, 'utf8'), 'replacement')
    }
    await anchors.release()
    anchors = undefined
    if (process.platform === 'win32') await rename(parent, moved)
  } finally {
    await anchors?.release()
    await rm(root, { recursive: true, force: true })
  }
})

const windowsOnly = {
  skip: process.platform === 'win32' ? false : 'Windows native directory sharing requires Windows',
  timeout: 30_000,
}

function fixture() {
  const temporary = fs.realpathSync.native(tmpdir())
  const root = fs.mkdtempSync(join(temporary, 'babel-directory-anchors-'))
  const leaf = join(root, 'leaf')
  fs.mkdirSync(leaf)
  fs.writeFileSync(join(leaf, 'owned.txt'), 'owned')
  const renameRoundTrip = (path: string): boolean => {
    assert.ok(path === root || path === leaf)
    for (const target of [path, `${path}-moved`]) {
      assert.ok(resolve(target).toLowerCase().startsWith(`${temporary}${sep}`.toLowerCase()))
    }
    assert.equal(fs.existsSync(`${path}-moved`), false)
    try { fs.renameSync(path, `${path}-moved`) }
    catch (error) {
      assert.ok(['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false
    }
    fs.renameSync(`${path}-moved`, path)
    return true
  }
  const cleanup = (): void => {
    const physical = fs.realpathSync.native(root)
    assert.ok(physical.toLowerCase().startsWith(`${temporary}${sep}`.toLowerCase()))
    fs.rmSync(physical, { recursive: true, force: true })
  }
  return { root, leaf, renameRoundTrip, cleanup }
}

// Independent native holder: DELETE access with all sharing enabled. It must
// prevent a deny-delete anchor from being acquired, without blocking renames itself.
async function holdDeleteAccess(path: string): Promise<() => Promise<void>> {
  const preferred = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const executable = fs.existsSync(preferred) ? preferred
    : join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BabelAnchorTestDeleteHolder {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path, 'utf8').toString('base64')}'))
$handle = [BabelAnchorTestDeleteHolder]::CreateFile($path, 65536, 7, [IntPtr]::Zero, 3, 33554432, [IntPtr]::Zero)
try {
  if ($handle.IsInvalid) { exit 1 }
  [Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $handle.Dispose() }
`
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const exit = new Promise<void>(done => { child.once('exit', () => done()); child.once('error', () => done()) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((ready, reject) => {
      let output = ''
      timer = setTimeout(() => reject(new Error('Native test holder did not become ready')), 15_000)
      child.once('error', () => reject(new Error('Native test holder unavailable')))
      child.once('exit', () => reject(new Error('Native test holder exited before readiness')))
      child.stdout.on('data', chunk => { output += String(chunk); if (output.trim() === 'READY') ready() })
    })
    return async () => { child.stdin.end('\n'); await exit }
  } catch (error) { child.kill(); await exit; throw error }
  finally { if (timer) clearTimeout(timer) }
}

test('Windows directory anchors prevent leaf and ancestor rename until released', windowsOnly, async () => {
  const f = fixture()
  let anchors: EffectDirectoryAnchors | undefined
  try {
    assert.equal(f.renameRoundTrip(f.leaf), true)
    assert.equal(f.renameRoundTrip(f.root), true)
    anchors = await acquireEffectDirectoryAnchors([f.leaf])
    assert.equal(f.renameRoundTrip(f.leaf), false)
    assert.equal(f.renameRoundTrip(f.root), false)
    assert.equal(fs.readFileSync(anchors.path(join(f.leaf, 'owned.txt')), 'utf8'), 'owned')
    await anchors.release()
    assert.throws(() => anchors!.path(join(f.leaf, 'owned.txt')), /EFFECT_DIRECTORY_ANCHOR_LOST/)
    assert.equal(f.renameRoundTrip(f.leaf), true)
    assert.equal(f.renameRoundTrip(f.root), true)
  } finally { await anchors?.release(); f.cleanup() }
})

test('Windows directory anchors refuse an already open DELETE handle', windowsOnly, async () => {
  const f = fixture()
  let releaseHolder: (() => Promise<void>) | undefined
  let unexpected: EffectDirectoryAnchors | undefined
  try {
    releaseHolder = await holdDeleteAccess(f.leaf)
    assert.equal(f.renameRoundTrip(f.leaf), true)
    await assert.rejects(async () => { unexpected = await acquireEffectDirectoryAnchors([f.leaf]) },
      error => /EFFECT_DIRECTORY_ANCHOR_UNAVAILABLE: Windows handles refused ERROR:\d+:32/.test(String(error)))
  } finally { await unexpected?.release(); await releaseHolder?.(); f.cleanup() }
})
