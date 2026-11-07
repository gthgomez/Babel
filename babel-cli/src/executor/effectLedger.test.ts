import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { appendFile, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  classifyIntendedWriteOutcome,
  findInterruptedEffects,
  loadEffectLedger,
  loadEffectLedgerWithDiagnostics,
  reconcileInterruptedEffect,
  recordEffectIntent,
  recordEffectTerminal,
} from './effectLedger.js'

test('shape-invalid terminal JSON cannot hide a durable interrupted intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-shape-'))
  try {
    const intent = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } })
    await appendFile(join(root, 'effect-ledger.jsonl'), `${JSON.stringify({ operationId: intent.operationId, status: 'completed' })}\n`)
    const loaded = loadEffectLedgerWithDiagnostics(root)
    assert.equal(loaded.corruptLines, 1)
    assert.deepEqual(findInterruptedEffects(loaded.records).map(record => record.operationId), [intent.operationId])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a terminal record with conflicting operation identity cannot hide the intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-conflict-'))
  try {
    const intent = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } })
    await appendFile(join(root, 'effect-ledger.jsonl'), `${JSON.stringify({ ...intent, toolName: 'different_tool', status: 'completed' })}\n`)
    const loaded = loadEffectLedgerWithDiagnostics(root)
    assert.equal(loaded.corruptLines, 1)
    assert.deepEqual(findInterruptedEffects(loaded.records).map(record => record.operationId), [intent.operationId])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('conflicting terminal outcomes degrade ledger history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-terminal-conflict-'))
  try {
    const intent = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } })
    recordEffectTerminal(root, intent, { status: 'completed', postImageHashes: { a: 'after' } })
    recordEffectTerminal(root, intent, { status: 'failed', error: 'synthetic conflict' })
    assert.equal(loadEffectLedgerWithDiagnostics(root).corruptLines, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('empty write observations cannot prove a no-op', () => {
  assert.equal(classifyIntendedWriteOutcome('expected', {}, {}), 'unverified')
  assert.equal(classifyIntendedWriteOutcome('expected', { target: 'before' }, {}), 'unverified')
})

test('effect ledger persists intent before terminal state and tolerates torn final lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-'))
  try {
    const intent = recordEffectIntent({
      runDir: root,
      sessionId: 'session-1',
      turnId: 'turn-1',
      mutationBatchId: 'batch-1',
      effectClass: 'reconcilable_mutation',
      toolName: 'write_file',
      targetPaths: ['a.txt'],
      preImageHashes: { 'a.txt': 'before' },
      intendedContent: 'after',
    })
    assert.equal(findInterruptedEffects(loadEffectLedger(root)).length, 1)

    recordEffectTerminal(root, intent, {
      status: 'completed',
      postImageHashes: { 'a.txt': 'after' },
    })
    assert.equal(findInterruptedEffects(loadEffectLedger(root)).length, 0)

    const ledgerPath = join(root, 'effect-ledger.jsonl')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(ledgerPath, '{"schemaVersion":1')
    assert.equal(loadEffectLedger(root).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('effect reconciliation retries only safe pre-image matches and recognizes post-images', () => {
  const base = {
    schemaVersion: 1 as const,
    operationId: 'op-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    mutationBatchId: 'batch-1',
    effectClass: 'reconcilable_mutation' as const,
    physicalSettlement: 'proven' as const,
    toolName: 'write_file',
    targetPaths: ['a.txt'],
    preImageHashes: { 'a.txt': 'before' },
    postImageHashes: { 'a.txt': 'after' },
    status: 'intent' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'before' }), 'retry_reconcilable')
  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'after' }), 'recovered_complete')
  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'other' }), 'workspace_conflict')
  assert.equal(
    reconcileInterruptedEffect({ ...base, effectClass: 'external_side_effect' }, { 'a.txt': 'before' }),
    'manual_review',
  )
})

test('an unchanged pre-image does not prove an interrupted mutation has physically settled', () => {
  const intent = {
    effectClass: 'reconcilable_mutation' as const,
    preImageHashes: { 'a.txt': 'before' },
    postImageHashes: { 'a.txt': 'after' },
  }
  assert.equal(reconcileInterruptedEffect(intent, { 'a.txt': 'before' }), 'manual_review')
  assert.equal(reconcileInterruptedEffect(intent, { 'a.txt': 'after' }), 'manual_review')
  assert.equal(reconcileInterruptedEffect({ ...intent, preImageHashes: {}, postImageHashes: {}, physicalSettlement: 'proven' }, {}), 'manual_review')
  assert.equal(reconcileInterruptedEffect({ effectClass: 'read_only', preImageHashes: {}, postImageHashes: {} }, {}), 'retry_reconcilable')
})

test('a delayed local write is not reconciled until its worker has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-late-worker-'))
  const target = join(root, 'target.txt')
  let worker: ReturnType<typeof spawn> | undefined
  try {
    await writeFile(target, 'before')
    worker = spawn(process.execPath, ['-e', "process.stdin.once('data', () => { require('node:fs').writeFileSync(process.argv[1], 'after'); }); process.stdin.resume()", target], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    await once(worker, 'spawn')
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const intent = { effectClass: 'reconcilable_mutation' as const, preImageHashes: { target: hash('before') }, postImageHashes: { target: hash('after') } }
    assert.equal(reconcileInterruptedEffect(intent, { target: hash(await readFile(target, 'utf8')) }), 'manual_review')
    worker.stdin?.end('go')
    const [code] = await once(worker, 'exit')
    assert.equal(code, 0)
    assert.equal(reconcileInterruptedEffect({ ...intent, physicalSettlement: 'proven' }, { target: hash(await readFile(target, 'utf8')) }), 'recovered_complete')
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill()
      await once(worker, 'exit').catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('effect ledger refuses a hard-linked outside artifact without appending to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-hardlink-'))
  try {
    const outside = join(root, 'outside.txt'); const run = join(root, 'run')
    const { mkdir } = await import('node:fs/promises'); await mkdir(run)
    await writeFile(outside, 'SYNTHETIC_RETAINED_OUTSIDE')
    await link(outside, join(run, 'effect-ledger.jsonl'))
    let failure: unknown
    try { recordEffectIntent({ runDir: run, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } }) } catch (error) { failure = error }
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE')
    assert.match(String(failure), /unsafe|link/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('effect ledger rejects a link swapped in immediately before append open', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-swap-'))
  try {
    const outside = join(root, 'outside.txt'); const run = join(root, 'run'); const ledger = join(run, 'effect-ledger.jsonl')
    const { mkdir } = await import('node:fs/promises'); await mkdir(run)
    await writeFile(outside, 'SYNTHETIC_RETAINED_OUTSIDE'); await writeFile(ledger, '')
    const original = fs.openSync; let swapped = false
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(path) === ledger) { swapped = true; fs.renameSync(ledger, join(root, 'original-ledger')); fs.linkSync(outside, ledger) }
      return original(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    let failure: unknown
    try { recordEffectIntent({ runDir: run, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } }) } catch (error) { failure = error }
    assert.equal(swapped, true); assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_RETAINED_OUTSIDE'); assert.match(String(failure), /unsafe|changed/i)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})

test('effect recovery refuses a hard-linked outside ledger before reading its records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-ingress-'))
  try {
    const outside = join(root, 'outside'); const run = join(root, 'run'); const { mkdir } = await import('node:fs/promises'); await mkdir(outside); await mkdir(run)
    recordEffectIntent({ runDir: outside, sessionId: 'SYNTHETIC_PRIVATE_LEDGER', mutationBatchId: 'batch', effectClass: 'read_only', toolName: 'file_read', targetPaths: ['a'], preImageHashes: {} })
    await link(join(outside, 'effect-ledger.jsonl'), join(run, 'effect-ledger.jsonl'))
    let loaded: ReturnType<typeof loadEffectLedgerWithDiagnostics> | undefined; let failure: unknown
    try { loaded = loadEffectLedgerWithDiagnostics(run) } catch (error) { failure = error }
    assert.doesNotMatch(JSON.stringify(loaded ?? null), /SYNTHETIC_PRIVATE_LEDGER/)
    assert.match(String(failure), /unsafe|link/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('oversized effect history fails closed instead of appearing empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-oversize-'))
  try {
    const ledger = join(root, 'effect-ledger.jsonl'); await writeFile(ledger, ''); fs.truncateSync(ledger, 16 * 1024 * 1024 + 1)
    assert.throws(() => loadEffectLedgerWithDiagnostics(root), /oversized/i)
    assert.throws(() => recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } }), /oversized/i)
    assert.equal(fs.statSync(ledger).size, 16 * 1024 * 1024 + 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('effect recovery rejects a ledger replaced before its checked open', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-read-swap-'))
  try {
    const outside = join(root, 'outside'); const run = join(root, 'run'); const { mkdir } = await import('node:fs/promises'); await mkdir(outside); await mkdir(run)
    recordEffectIntent({ runDir: outside, sessionId: 'SYNTHETIC_PRIVATE_LEDGER', mutationBatchId: 'batch', effectClass: 'read_only', toolName: 'file_read', targetPaths: ['a'], preImageHashes: {} })
    const ledger = join(run, 'effect-ledger.jsonl'); await writeFile(ledger, '')
    const original = fs.openSync; let swapped = false
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
      if (!swapped && String(path) === ledger) { swapped = true; fs.renameSync(ledger, join(root, 'original-ledger')); fs.linkSync(join(outside, 'effect-ledger.jsonl'), ledger) }
      return original(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    let loaded: ReturnType<typeof loadEffectLedgerWithDiagnostics> | undefined; let failure: unknown
    try { loaded = loadEffectLedgerWithDiagnostics(run) } catch (error) { failure = error }
    assert.equal(swapped, true); assert.doesNotMatch(JSON.stringify(loaded ?? null), /SYNTHETIC_PRIVATE_LEDGER/); assert.match(String(failure), /unsafe|linked|changed/i)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})

test('effect ledger rejects a regular file replaced between identity checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-stat-swap-'))
  try {
    const run = join(root, 'run'); const { mkdir } = await import('node:fs/promises'); await mkdir(run)
    const ledger = join(run, 'effect-ledger.jsonl'); const replacement = join(root, 'replacement.txt')
    await writeFile(ledger, ''); await writeFile(replacement, 'SYNTHETIC_RETAINED_REPLACEMENT')
    const original = fs.lstatSync; let swapped = false
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: any) => {
      const stat = original(path, options)
      if (!swapped && String(path) === ledger && !options?.bigint) {
        swapped = true; fs.renameSync(ledger, join(root, 'original-ledger')); fs.renameSync(replacement, ledger)
      }
      return stat
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    let failure: unknown
    try { recordEffectIntent({ runDir: run, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } }) } catch (error) { failure = error }
    assert.equal(swapped, true); assert.equal(await readFile(ledger, 'utf8'), 'SYNTHETIC_RETAINED_REPLACEMENT'); assert.match(String(failure), /unsafe|changed/i)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})

test('effect ledger refuses read and append when exact file identity is unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-no-identity-'))
  try {
    const ledger = join(root, 'effect-ledger.jsonl'); await writeFile(ledger, '')
    const original = fs.lstatSync
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: any) => {
      const stat = original(path, options)
      return String(path) === ledger && options?.bigint ? new Proxy(stat, { get(target, key, receiver) { return key === 'ino' ? 0n : Reflect.get(target, key, receiver) } }) : stat
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    assert.throws(() => loadEffectLedgerWithDiagnostics(root), /identity.*unavailable/i)
    assert.throws(() => recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch', effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: ['a'], preImageHashes: { a: 'before' } }), /unsafe/i)
    assert.equal((await readFile(ledger, 'utf8')), '')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})

test('missing ledger through a linked run directory is not reported as empty history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-linked-parent-'))
  try {
    const outside = join(root, 'outside'); const run = join(root, 'run'); const { mkdir, symlink } = await import('node:fs/promises'); await mkdir(outside)
    try { await symlink(outside, run, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('directory links unavailable'); return } throw error }
    assert.throws(() => loadEffectLedgerWithDiagnostics(run), /unsafe|link/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})
