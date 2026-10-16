import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkpointParityEventLogStrict, createParityRuntime, CONTEXT_CHECKPOINT_FILENAME } from './chatEngineParityBridge.js'
import { prepareContextCheckpoint } from '../runtime/contextCheckpoints.js'
import { CHECKPOINT_JOURNAL_FILENAME, recoverCheckpointArtifacts, resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { persistThreadEventLog, recordAssistantMessage, serializeThreadEventLog, THREAD_EVENT_LOG_FILENAME } from './threadEventLog.js'

// The child parks at an observed filesystem publication boundary. The parent
// kills that exact process; no exception or graceful cleanup simulates death.
test('actual process kills preserve a coherent checkpoint generation across publication boundaries', { timeout: 240_000 }, async () => {
  const require = createRequire(import.meta.url)
  for (const phase of ['prepare', 'partial', 'install', 'history', 'commit', 'restore']) {
    const { root, runtime } = fixture()
    const ready = join(root, 'kill-ready')
    const expected = join(root, 'expected-next.json')
    const driver = join(root, 'kill-driver.mjs')
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<number | null> | undefined
    try {
      runtime.contextCheckpoint = installableContext(runtime.eventLog.thread_id)
      const first = await checkpointParityEventLogStrict(runtime, root)
      assert.equal(first.status, 'committed')
      const before = first.artifacts.map(a => ({ path: a.path!, bytes: readFileSync(a.path!, 'utf8') }))
      const bridge = new URL('./chatEngineParityBridge.ts', import.meta.url).href
      const live = new URL('./liveSessionBridge.ts', import.meta.url).href
      const thread = new URL('./threadEventLog.ts', import.meta.url).href
      const context = new URL('../runtime/contextCheckpoints.ts', import.meta.url).href
      writeFileSync(driver, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { checkpointParityEventLogStrict, createParityRuntime } = await import(${JSON.stringify(bridge)});
const { resolveLiveSessionAuthority, CHECKPOINT_JOURNAL_FILENAME } = await import(${JSON.stringify(live)});
const { recordAssistantMessage } = await import(${JSON.stringify(thread)});
const { prepareContextCheckpoint } = await import(${JSON.stringify(context)});
const root = ${JSON.stringify(root)};
const phase = ${JSON.stringify(phase)};
const runtime = createParityRuntime('fixture-thread');
runtime.liveAuthority = resolveLiveSessionAuthority({ mode: 'chat', projectRoot: root, task: 'checkpoint fixture' });
runtime.liveAuthority.taskModeHistory = { schema_version: 1, revisions: [runtime.liveAuthority.taskContract] };
runtime.contextCheckpoint = (${installableContext.toString()})(runtime.eventLog.thread_id);
runtime.contextCheckpoint = { ...runtime.contextCheckpoint, checkpointId: 'checkpoint-test-2' };
recordAssistantMessage(runtime.eventLog, 'turn', 'next durable generation');
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
let renames = 0;
const park = () => { originalWrite(${JSON.stringify(ready)}, phase); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); };
fs.renameSync = function(source, destination) {
  const result = originalRename.call(this, source, destination);
  if (String(destination).endsWith(CHECKPOINT_JOURNAL_FILENAME)) {
    const journal = JSON.parse(fs.readFileSync(destination, 'utf8'));
    if (phase === 'prepare' && journal.status === 'prepared' && !journal.backups_ready) park();
    if (journal.status === 'prepared' && journal.backups_ready) {
      originalWrite(${JSON.stringify(expected)}, JSON.stringify(journal.targets.map(filename => ({ filename, bytes: fs.readFileSync(root + '/' + filename + '.' + journal.batch_id + '.tmp', 'utf8') }))));
    }
    if (phase === 'commit' && journal.status === 'committed') park();
    return result;
  }
  renames++;
  if ((phase === 'partial' && renames === 2) || (phase === 'install' && String(destination).endsWith('context-checkpoint.json')) || (phase === 'history' && String(destination).endsWith('task-mode-history.json')) || (phase === 'restore' && renames === 4)) park();
  return result;
};
syncBuiltinESMExports();
await checkpointParityEventLogStrict(runtime, root, phase === 'restore' ? { injectCommitFailureAfter: 3 } : undefined);
throw Error('publication boundary not reached');
`)
      child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, driver], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr?.on('data', bytes => { stderr += String(bytes) })
      closed = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('close', code => resolve(code)) })
      const deadline = Date.now() + 45_000
      while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      assert.ok(existsSync(ready), `${phase} boundary not reached: ${stderr}`)
      assert.equal(readFileSync(ready, 'utf8'), phase)
      assert.equal(child.kill('SIGKILL'), true)
      await closed
      recoverCheckpointArtifacts(root)
      const next = phase === 'commit' ? JSON.parse(readFileSync(expected, 'utf8')) as Array<{ filename: string; bytes: string }> : []
      if (phase === 'commit') {
        assert.equal(JSON.parse(next.find(a => a.filename === CONTEXT_CHECKPOINT_FILENAME)!.bytes).checkpointId, 'checkpoint-test-2')
        assert.ok(next.find(a => a.filename === THREAD_EVENT_LOG_FILENAME)!.bytes.includes('next durable generation'))
      }
      for (const old of before) {
        const wanted = phase === 'commit' ? next.find(a => old.path.endsWith(a.filename))!.bytes : old.bytes
        assert.equal(readFileSync(old.path, 'utf8'), wanted, `${phase}: mixed generation at ${old.path}`)
      }
      assert.equal(existsSync(join(root, CHECKPOINT_JOURNAL_FILENAME)), false)
      assert.equal(readdirSync(root).some(name => /\.(tmp|bak)$/.test(name)), false)
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (closed) await closed
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-windows-checkpoint-'))
  const runtime = createParityRuntime('fixture-thread')
  runtime.liveAuthority = resolveLiveSessionAuthority({ mode: 'chat', projectRoot: root, task: 'checkpoint fixture' })
  runtime.liveAuthority.taskModeHistory = { schema_version: 1, revisions: [runtime.liveAuthority.taskContract] }
  return { root, runtime }
}

function installableContext(threadId: string) {
  const owner = { threadId, generation: 1, token: 'checkpoint-test-owner' }
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-test-1',
    owner,
    sessionId: threadId,
    turnId: 'turn-1',
    contextEpoch: 'epoch-1',
    sources: {
      resumed: false,
      task_contract: { goal: 'checkpoint fixture', acceptance_clause_ids: ['a'], contract_hash: 'contract' },
      working_state: { current_hypothesis: 'checkpoint is durable', unresolved_failures: [], next_experiment: 'resume' },
      workspace: {
        current_snapshot_revision: 'revision',
        capture_complete: true,
        coverage_ref: 'coverage',
        capture_provenance: 'current_capture',
        capture_epoch: 'epoch',
      },
      receipts: [{ receipt_id: 'receipt', identity: 'test', scope: 'targeted', stale: false, bound_revision: 'revision' }],
      budget: { owner: 'budget', remaining_allowance: 4, cancellation_owner: 'budget' },
      pending: [],
      route: { compiled_request_identity: 'request', tool_profile: 'native', model_route: 'test-model' },
      observations: [],
      legacy_observation_refs: [],
    },
  })
  assert.equal(prepared.status, 'prepared')
  if (prepared.status !== 'prepared') throw new Error('context preparation was blocked')
  return prepared.checkpoint
}

test('context checkpoint joins the strict batch and rolls back with it', async () => {
  const { root, runtime } = fixture()
  try {
    runtime.contextCheckpoint = installableContext(runtime.eventLog.thread_id)
    const initial = await checkpointParityEventLogStrict(runtime, root)
    assert.equal(initial.status, 'committed')
    const contextPath = join(root, CONTEXT_CHECKPOINT_FILENAME)
    const before = readFileSync(contextPath, 'utf8')
    runtime.contextCheckpoint = { ...runtime.contextCheckpoint, checkpointId: 'checkpoint-test-2' }
    const failed = await checkpointParityEventLogStrict(runtime, root, { injectCommitFailureAfter: 5 })
    assert.equal(failed.status, 'blocked')
    assert.equal(readFileSync(contextPath, 'utf8'), before)
    assert.equal(readdirSync(root).some(name => /\.(tmp|bak)$/.test(name)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('strict checkpoint recovers a transient thread-event rename failure before committing', async () => {
  const { root, runtime } = fixture()
  assert.equal((await checkpointParityEventLogStrict(runtime, root)).status, 'committed')
  const path = join(root, THREAD_EVENT_LOG_FILENAME)
  const before = readFileSync(path, 'utf8')
  recordAssistantMessage(runtime.eventLog, 'turn', 'new checkpoint')
  let threadAttempts = 0
  const receipt = await checkpointParityEventLogStrict(runtime, root, { renameOptions: {
    platform: 'win32', wait: () => {}, rename: (source, destination) => {
      if (destination === path && ++threadAttempts <= 2) {
        assert.equal(readFileSync(path, 'utf8'), before)
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      }
      renameSync(source, destination)
    },
  } })
  assert.equal(receipt.status, 'committed'); assert.equal(threadAttempts, 3)
  assert.equal(readFileSync(path, 'utf8'), serializeThreadEventLog(runtime.eventLog))
  assert.equal(readdirSync(root).some(name => /\.(tmp|bak)$/.test(name)), false)
})

test('permanent Windows checkpoint failure restores all old primary bytes and remains blocked', async () => {
  const { root, runtime } = fixture()
  const initial = await checkpointParityEventLogStrict(runtime, root)
  const before = initial.artifacts.map(artifact => ({ path: artifact.path!, bytes: readFileSync(artifact.path!) }))
  const cursor = runtime.sessionEvents.flushedThroughSeq
  recordAssistantMessage(runtime.eventLog, 'turn', 'must not commit')
  let attempts = 0
  const receipt = await checkpointParityEventLogStrict(runtime, root, { renameOptions: {
    platform: 'win32', wait: () => {}, rename: (source, destination) => {
      if (destination === join(root, THREAD_EVENT_LOG_FILENAME)) { attempts++; throw Object.assign(new Error('locked'), { code: 'EPERM' }) }
      renameSync(source, destination)
    },
  } })
  assert.equal(receipt.status, 'blocked'); assert.equal(attempts, 6)
  assert.ok(receipt.artifacts.every(artifact => artifact.status === 'blocked'))
  for (const artifact of before) assert.deepEqual(readFileSync(artifact.path), artifact.bytes)
  assert.equal(runtime.sessionEvents.flushedThroughSeq, cursor)
})

test('unawaited routine writes cannot overwrite a later strict checkpoint generation', async () => {
  const { root, runtime } = fixture()
  const path = join(root, THREAD_EVENT_LOG_FILENAME)
  for (let i = 0; i < 8; i++) {
    recordAssistantMessage(runtime.eventLog, 'turn', `before ${i}`)
    const prior = persistThreadEventLog(root, runtime.eventLog)
    // Promise compatibility must not leave an asynchronous write handle open.
    assert.equal(readFileSync(path, 'utf8'), serializeThreadEventLog(runtime.eventLog))
    recordAssistantMessage(runtime.eventLog, 'turn', `after ${i}`)
    assert.equal((await checkpointParityEventLogStrict(runtime, root)).status, 'committed')
    await prior
    assert.equal(readFileSync(path, 'utf8'), serializeThreadEventLog(runtime.eventLog))
  }
})

test('thread checkpoints support the long nested paths used by reviewer jobs', async () => {
  const { root, runtime } = fixture()
  const longRoot = join(root, 'a'.repeat(70), 'b'.repeat(70), 'c'.repeat(70))
  const path = join(longRoot, THREAD_EVENT_LOG_FILENAME)
  assert.ok(path.length > 260)
  await persistThreadEventLog(longRoot, runtime.eventLog)
  assert.equal((await checkpointParityEventLogStrict(runtime, longRoot)).status, 'committed')
  assert.equal(readFileSync(path, 'utf8'), serializeThreadEventLog(runtime.eventLog))
})

test('a lock during rollback retains journal and backups for later coherent recovery', async () => {
  const { root, runtime } = fixture()
  const initial = await checkpointParityEventLogStrict(runtime, root)
  const before = initial.artifacts.map(artifact => ({ path: artifact.path!, bytes: readFileSync(artifact.path!) }))
  recordAssistantMessage(runtime.eventLog, 'turn', 'interrupted generation')
  let rollingBack = false
  const receipt = await checkpointParityEventLogStrict(runtime, root, { renameOptions: {
    platform: 'win32', wait: () => {}, rename: (source, destination) => {
      if (destination === join(root, THREAD_EVENT_LOG_FILENAME)) rollingBack = true
      if (rollingBack) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
      renameSync(source, destination)
    },
  } })
  assert.equal(receipt.status, 'blocked')
  assert.ok(readdirSync(root).includes(CHECKPOINT_JOURNAL_FILENAME))
  assert.equal(readdirSync(root).filter(name => name.endsWith('.bak')).length, initial.artifacts.length)
  // Repeated restoration failures must retain every backup, even after an
  // earlier primary has already been restored successfully in each attempt.
  const lockedTarget = before[1]!.path
  const renameOptions = { platform: 'win32' as const, wait: () => {}, rename: (source: Parameters<typeof renameSync>[0], destination: Parameters<typeof renameSync>[1]) => {
    if (destination === lockedTarget) throw Object.assign(new Error('still locked'), { code: 'EPERM' })
    renameSync(source, destination)
  } }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => recoverCheckpointArtifacts(root, renameOptions), /still locked/)
    assert.ok(readdirSync(root).includes(CHECKPOINT_JOURNAL_FILENAME))
    assert.equal(readdirSync(root).filter(name => name.endsWith('.bak')).length, initial.artifacts.length)
    assert.deepEqual(readFileSync(before[0]!.path), before[0]!.bytes)
  }
  // The next strict checkpoint also attempts recovery; its failure must not
  // erase the pre-existing journal while cleaning up its own empty batch.
  const retry = await checkpointParityEventLogStrict(runtime, root, { renameOptions })
  assert.equal(retry.status, 'blocked')
  assert.ok(readdirSync(root).includes(CHECKPOINT_JOURNAL_FILENAME))
  assert.equal(readdirSync(root).filter(name => name.endsWith('.bak')).length, initial.artifacts.length)
  recoverCheckpointArtifacts(root)
  for (const artifact of before) assert.deepEqual(readFileSync(artifact.path), artifact.bytes)
  assert.equal(readdirSync(root).some(name => /\.(tmp|bak)$/.test(name)), false)
})

test('a failed rollback journal unlink leaves a cleanup-only marker, never a destructive prepared marker', async () => {
  const { root, runtime } = fixture()
  const initial = await checkpointParityEventLogStrict(runtime, root)
  const before = initial.artifacts.map(artifact => ({ path: artifact.path!, bytes: readFileSync(artifact.path!) }))
  const journal = join(root, CHECKPOINT_JOURNAL_FILENAME)
  recordAssistantMessage(runtime.eventLog, 'turn', 'rolled back generation')
  const receipt = await checkpointParityEventLogStrict(runtime, root, {
    injectCommitFailureAfter: 3,
    unlinkCheckpoint: path => {
      if (path === journal) throw Object.assign(new Error('journal sharing lock'), { code: 'EPERM' })
      unlinkSync(path)
    },
  })
  assert.equal(receipt.status, 'blocked')
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).status, 'committed')
  assert.equal(readdirSync(root).some(name => /\.(tmp|bak)$/.test(name)), false)
  recoverCheckpointArtifacts(root)
  for (const artifact of before) assert.deepEqual(readFileSync(artifact.path), artifact.bytes)
  assert.equal(readdirSync(root).includes(CHECKPOINT_JOURNAL_FILENAME), false)
})
