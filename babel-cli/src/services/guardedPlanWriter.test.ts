import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { writeNewPlanWithDirectoryGuard } from './guardedPlanWriter.js'

function fixture() {
  const base = resolve(tmpdir()); const root = fs.mkdtempSync(join(base, 'babel-plan-writer-'))
  return { root, cleanup() { assert.ok(resolve(root).startsWith(`${base}${sep}`)); fs.rmSync(root, { recursive: true, force: true }) } }
}
const id = 'plan_11111111-1111-1111-1111-111111111111'

function assertPrivateDacl(root: string, path: string): void {
  const script = join(root, 'check-acl.ps1')
  fs.writeFileSync(script, `param([string]$Path)\n$ErrorActionPreference='Stop'\n$acl=Get-Acl -LiteralPath $Path\n$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))\n$actual=@($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)\n$expected=@($owner,'S-1-5-18' | Sort-Object -Unique)\nif (-not $acl.AreAccessRulesProtected -or ($actual -join ',') -ne ($expected -join ',') -or @($rules | Where-Object { $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl }).Count -ne 0) { exit 1 }\n`)
  const pwsh = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const executable = fs.existsSync(pwsh) ? pwsh : join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const check = childProcess.spawnSync(executable, ['-NoProfile', '-NonInteractive', '-File', script, path], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
  assert.equal(check.error, undefined); assert.equal(check.status, 0, 'Plan artifact DACL must be protected and restricted to owner and SYSTEM')
}

test('guarded Plan writer creates an exact new artifact without emitting its body', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; let helperOutput = ''
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args); child.stdout?.on('data', chunk => { helperOutput += String(chunk) }); child.stderr?.on('data', chunk => { helperOutput += String(chunk) }); return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
    assert.equal(result.status, 'committed', JSON.stringify(result))
    if (result.status === 'committed') {
      assert.equal(fs.existsSync(result.path), true, JSON.stringify(fs.readdirSync(join(f.root, 'plans'))))
      assert.equal(fs.readFileSync(result.path, 'utf8'), 'SYNTHETIC_PRIVATE_PLAN')
    }
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_PLAN/)
    assert.doesNotMatch(helperOutput, /SYNTHETIC_PRIVATE_PLAN/)
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan writer never overwrites an existing artifact', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture()
  try {
    const plans = join(f.root, 'plans'); fs.mkdirSync(plans); const target = join(plans, `${id}.json`); fs.writeFileSync(target, 'SYNTHETIC_EXISTING')
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_NEW' })
    assert.equal(result.status, 'unknown'); assert.equal(fs.readFileSync(target, 'utf8'), 'SYNTHETIC_EXISTING')
    if (result.status === 'unknown') assert.equal(fs.readFileSync(result.stagedPath, 'utf8'), 'SYNTHETIC_NEW')
  } finally { f.cleanup() }
})

test('guarded Plan writer refuses a linked plans directory', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture()
  try {
    const state = join(f.root, 'state'); const outside = join(f.root, 'outside'); fs.mkdirSync(state); fs.mkdirSync(outside)
    const link = join(state, 'plans'); fs.symlinkSync(outside, link, 'junction')
    try { const result = await writeNewPlanWithDirectoryGuard({ stateRoot: state, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' }); assert.equal(result.status, 'rejected'); assert.deepEqual(fs.readdirSync(outside), []) }
    finally { fs.unlinkSync(link) }
  } finally { f.cleanup() }
})

test('guarded Plan writer must not commit a replaced staged file', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; let attempted = false; let replaced = false
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.on('data', chunk => {
        if (!attempted && String(chunk).includes('STAGED')) {
          attempted = true
          const plans = join(f.root, 'plans'); const temp = fs.readdirSync(plans).find(name => name.endsWith('.tmp'))
          assert.ok(temp)
          try { fs.renameSync(join(plans, temp), join(f.root, 'original-stage')); fs.writeFileSync(join(plans, temp), 'SYNTHETIC_REPLACEMENT'); replaced = true }
          catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
        }
      })
      return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
    assert.equal(attempted, true); assert.equal(replaced, false)
    assert.equal(result.status, 'committed', JSON.stringify(result))
    if (result.status === 'committed') {
      assert.equal(fs.existsSync(result.path), true, JSON.stringify(fs.readdirSync(join(f.root, 'plans'))))
      assert.equal(fs.readFileSync(result.path, 'utf8'), 'SYNTHETIC_PRIVATE_PLAN')
    }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan writer retains the staged artifact when cancelled before commit', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; const controller = new AbortController(); let staged = false
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.on('data', chunk => { if (!staged && String(chunk).includes('STAGED')) { staged = true; controller.abort() } })
      return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN', signal: controller.signal })
    assert.equal(staged, true); assert.equal(result.status, 'unknown'); assert.equal(fs.existsSync(join(f.root, 'plans', `${id}.json`)), false)
    if (result.status === 'unknown') { assert.equal(fs.readFileSync(result.stagedPath, 'utf8'), 'SYNTHETIC_PRIVATE_PLAN'); assertPrivateDacl(f.root, result.stagedPath) }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan writer rejects a state-root junction swapped before helper launch', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; let swapped = false
  try {
    const state = join(f.root, 'state'); const outside = join(f.root, 'outside'); fs.mkdirSync(state); fs.mkdirSync(outside)
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      if (!swapped) { swapped = true; fs.renameSync(state, join(f.root, 'original-state')); fs.symlinkSync(outside, state, 'junction') }
      return original(...args)
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    try {
      const result = await writeNewPlanWithDirectoryGuard({ stateRoot: state, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
      assert.equal(swapped, true); assert.equal(result.status, 'rejected'); assert.deepEqual(fs.readdirSync(outside), [])
    } finally { if (swapped) fs.unlinkSync(state) }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan writer does not pass unrelated synthetic environment secrets to its helper', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; const previous = process.env['SYNTHETIC_PLAN_WRITER_SECRET']; let observed = false
  try {
    process.env['SYNTHETIC_PLAN_WRITER_SECRET'] = 'SYNTHETIC_ENV_SECRET'
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined
      observed = true; assert.equal(options?.env?.['SYNTHETIC_PLAN_WRITER_SECRET'], undefined)
      return original(...args)
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'safe plan' })
    assert.equal(observed, true); assert.equal(result.status, 'committed', JSON.stringify(result))
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); if (previous === undefined) delete process.env['SYNTHETIC_PLAN_WRITER_SECRET']; else process.env['SYNTHETIC_PLAN_WRITER_SECRET'] = previous; f.cleanup() }
})

test('guarded Plan writer reports unknown if its acknowledgement is lost after commit', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; let killed = false
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.on('data', chunk => { if (!killed && String(chunk).includes('COMMITTED')) { killed = true; child.kill() } })
      return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
    assert.equal(killed, true); assert.equal(result.status, 'unknown')
    assert.equal(fs.readFileSync(join(f.root, 'plans', `${id}.json`), 'utf8'), 'SYNTHETIC_PRIVATE_PLAN')
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan writer rejects an ordinary state directory replaced before helper launch', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const original = childProcess.spawn; let swapped = false
  try {
    const state = join(f.root, 'state'); fs.mkdirSync(state); fs.writeFileSync(join(state, 'retained.txt'), 'SYNTHETIC_RETAINED')
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      if (!swapped) { swapped = true; fs.renameSync(state, join(f.root, 'original-state')); fs.mkdirSync(state) }
      return original(...args)
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: state, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
    assert.equal(swapped, true); assert.equal(result.status, 'rejected'); assert.deepEqual(fs.readdirSync(state), [])
    assert.equal(fs.readFileSync(join(f.root, 'original-state', 'retained.txt'), 'utf8'), 'SYNTHETIC_RETAINED')
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})

test('guarded Plan artifact has a protected owner-and-system DACL', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture()
  try {
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'SYNTHETIC_PRIVATE_PLAN' })
    assert.equal(result.status, 'committed', JSON.stringify(result)); if (result.status !== 'committed') return
    assertPrivateDacl(f.root, result.path)
  } finally { f.cleanup() }
})

test('guarded Plan writer handles spaces, quotes and Unicode without changing the body', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture()
  try {
    const state = join(f.root, "state with spaces' café"); fs.mkdirSync(state)
    const result = await writeNewPlanWithDirectoryGuard({ stateRoot: state, planId: id, content: 'SYNTHETIC café\nsecond line' })
    assert.equal(result.status, 'committed', JSON.stringify(result))
    if (result.status === 'committed') assert.equal(fs.readFileSync(result.path, 'utf8'), 'SYNTHETIC café\nsecond line')
  } finally { f.cleanup() }
})

test('guarded Plan writer does not start when already cancelled', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded writer'); return }
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error('SYNTHETIC_CANCELLED'))
  try {
    await assert.rejects(writeNewPlanWithDirectoryGuard({ stateRoot: f.root, planId: id, content: 'safe plan', signal: controller.signal }), /SYNTHETIC_CANCELLED/)
    assert.equal(fs.existsSync(join(f.root, 'plans')), false)
  } finally { f.cleanup() }
})
