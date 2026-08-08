import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  INSTRUCTION_MANIFEST_FILENAME,
  CHECKPOINT_JOURNAL_FILENAME,
  LiveSessionAuthorityError,
  TASK_CONTRACT_FILENAME,
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
  recoverCheckpointArtifacts,
} from './liveSessionBridge.js'

test('strict authority load distinguishes missing, corrupt, and tampered artifacts', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-live-authority-'))
  try {
    assert.throws(
      () => loadLiveSessionAuthorityStrict(runDir),
      (error: unknown) => error instanceof LiveSessionAuthorityError && error.code === 'LIVE_AUTHORITY_MISSING',
    )

    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: process.cwd(),
      task: 'synthetic authority test',
    })
    persistLiveSessionAuthority(runDir, authority)
    assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.frozen, true)

    writeFileSync(join(runDir, TASK_CONTRACT_FILENAME), '{broken', 'utf-8')
    assert.throws(
      () => loadLiveSessionAuthorityStrict(runDir),
      (error: unknown) => error instanceof LiveSessionAuthorityError && error.code === 'LIVE_AUTHORITY_CORRUPT',
    )

    persistLiveSessionAuthority(runDir, authority)
    const tampered = { ...authority.instructionManifest, manifest_hash: 'tampered' }
    writeFileSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME), JSON.stringify(tampered), 'utf-8')
    assert.throws(
      () => loadLiveSessionAuthorityStrict(runDir),
      (error: unknown) => error instanceof LiveSessionAuthorityError && error.code === 'LIVE_AUTHORITY_INVALID',
    )
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
})

test('checkpointParityEventLogStrict atomic commit and failure recovery', async () => {
  const {
    checkpointParityEventLogStrict,
  } = await import('./chatEngineParityBridge.js')
  const {
    createSessionEventLog,
  } = await import('./sessionEvents.js')
  const {
    createThreadEventLog,
  } = await import('./threadEventLog.js')
  const {
    createApprovalSession,
  } = await import('./approvalRequests.js')
  const {
    createProgressLedger,
  } = await import('./progressReceipt.js')
  const {
    initialAgentLoopState,
  } = await import('./agentLoopReducer.js')
  const {
    createEpisodeEventLog,
  } = await import('../evidence/episodeStream.js')
  const {
    THREAD_EVENT_LOG_FILENAME,
  } = await import('./threadEventLog.js')
  const {
    SESSION_EVENTS_FILENAME,
  } = await import('./sessionEvents.js')
  const {
    LIVE_SESSION_SNAPSHOT_FILENAME,
  } = await import('./liveSessionBridge.js')
  const { readFileSync, existsSync, readdirSync } = await import('node:fs')

  const assertNoBatchSidecars = (dir: string) => {
    const leftovers = readdirSync(dir).filter(
      (name) => name.endsWith('.tmp') || name.endsWith('.bak'),
    )
    assert.deepEqual(leftovers, [], `unexpected batch sidecars: ${leftovers.join(', ')}`)
  }

  const assertBlockedReceiptHonest = (receipt: {
    status: string
    artifacts: Array<{ status: string }>
  }) => {
    assert.equal(receipt.status, 'blocked')
    assert.ok(receipt.artifacts.length >= 1)
    assert.ok(
      receipt.artifacts.every((a) => a.status === 'blocked'),
      'blocked receipt must not report partial committed child artifacts',
    )
  }

  const runDir = mkdtempSync(join(tmpdir(), 'babel-atomic-chkpt-'))
  try {
    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: process.cwd(),
      task: 'atomic checkpoint test',
    })

    const rt = {
      loop: initialAgentLoopState(),
      progress: createProgressLedger(),
      eventLog: createThreadEventLog(),
      sessionEvents: createSessionEventLog(),
      episodeStream: createEpisodeEventLog(),
      approvalSession: createApprovalSession('test-thread-1'),
      turnId: 'turn-1',
      recoveryTried: false,
      lastFailover: null,
      liveAuthority: authority,
    }

    // 1. Initial happy-path checkpoint
    const initialReceipt = await checkpointParityEventLogStrict(rt, runDir)
    assert.equal(initialReceipt.status, 'committed')
    assert.ok(initialReceipt.artifacts.every((a) => a.status === 'committed'))
    assert.ok(existsSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME)))
    assert.ok(existsSync(join(runDir, TASK_CONTRACT_FILENAME)))
    assert.ok(existsSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME)))
    assert.ok(existsSync(join(runDir, THREAD_EVENT_LOG_FILENAME)))
    assert.ok(existsSync(join(runDir, SESSION_EVENTS_FILENAME)))
    assertNoBatchSidecars(runDir)

    const manifestBefore = readFileSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME), 'utf-8')
    const contractBefore = readFileSync(join(runDir, TASK_CONTRACT_FILENAME), 'utf-8')
    const threadBefore = readFileSync(join(runDir, THREAD_EVENT_LOG_FILENAME), 'utf-8')
    const sessionBefore = readFileSync(join(runDir, SESSION_EVENTS_FILENAME), 'utf-8')
    const flushedBefore = rt.sessionEvents.flushedThroughSeq
    const nextSeqBefore = rt.sessionEvents.nextSeq
    const eventsCountBefore = rt.sessionEvents.events.length

    // 2. Mid-commit failure that actually creates then unlinks a new primary.
    // Order: 0 manifest, 1 contract, 2 snapshot, 3 thread, 4 session.
    // Delete snapshot so index 2 has no .bak; inject at 3 so renames 0–2 succeed
    // (snapshot is newly created), then fail before thread rename → unlink snapshot.
    rmSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME), { force: true })
    assert.equal(existsSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME)), false)

    const failedReceipt = await checkpointParityEventLogStrict(rt, runDir, {
      injectCommitFailureAfter: 3,
    })

    assert.equal(failedReceipt.error, 'simulated_commit_failure')
    assertBlockedReceiptHonest(failedReceipt)

    // Existing primaries restored byte-equal (renamed then restored from .bak)
    assert.equal(readFileSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME), 'utf-8'), manifestBefore)
    assert.equal(readFileSync(join(runDir, TASK_CONTRACT_FILENAME), 'utf-8'), contractBefore)
    assert.equal(readFileSync(join(runDir, THREAD_EVENT_LOG_FILENAME), 'utf-8'), threadBefore)
    assert.equal(readFileSync(join(runDir, SESSION_EVENTS_FILENAME), 'utf-8'), sessionBefore)

    // Newly created snapshot (index 2, no pre-checkpoint .bak) must be unlinked
    assert.equal(existsSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME)), false)

    // Full memory cursor restore (events + nextSeq + flushedThroughSeq)
    assert.equal(rt.sessionEvents.events.length, eventsCountBefore)
    assert.equal(rt.sessionEvents.nextSeq, nextSeqBefore)
    assert.equal(rt.sessionEvents.flushedThroughSeq, flushedBefore)
    assertNoBatchSidecars(runDir)

    // 3. Staging failure leaves valid runDir primaries untouched and cleans memory
    const filePath = join(runDir, 'blocker_file.txt')
    writeFileSync(filePath, 'i am a file', 'utf-8')
    const invalidDir = join(filePath, 'child_dir')
    const stagingFailedReceipt = await checkpointParityEventLogStrict(rt, invalidDir)
    assertBlockedReceiptHonest(stagingFailedReceipt)
    assert.equal(readFileSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME), 'utf-8'), manifestBefore)
    assert.equal(rt.sessionEvents.events.length, eventsCountBefore)
    assert.equal(rt.sessionEvents.nextSeq, nextSeqBefore)
    assert.equal(rt.sessionEvents.flushedThroughSeq, flushedBefore)
    assertNoBatchSidecars(runDir)

    // 4. Happy path again after failures still commits cleanly (incl. recreated snapshot)
    const recovered = await checkpointParityEventLogStrict(rt, runDir)
    assert.equal(recovered.status, 'committed')
    assert.ok(existsSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME)))
    assertNoBatchSidecars(runDir)
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
})

test('checkpoint recovery restores the last coherent generation after process interruption', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-checkpoint-recovery-'))
  try {
    const target = 'live-session-snapshot.json'
    const batchId = 'batch-recovery'
    writeFileSync(join(runDir, target), 'new-generation', 'utf-8')
    writeFileSync(join(runDir, `${target}.${batchId}.bak`), 'old-generation', 'utf-8')
    writeFileSync(join(runDir, `${target}.${batchId}.tmp`), 'staged-generation', 'utf-8')
    writeFileSync(
      join(runDir, CHECKPOINT_JOURNAL_FILENAME),
      JSON.stringify({
        schema_version: 1,
        batch_id: batchId,
        status: 'prepared',
        backups_ready: true,
        targets: [target],
      }),
      'utf-8',
    )

    recoverCheckpointArtifacts(runDir)

    assert.equal(readFileSync(join(runDir, target), 'utf-8'), 'old-generation')
    assert.equal(existsSync(join(runDir, CHECKPOINT_JOURNAL_FILENAME)), false)
    assert.equal(existsSync(join(runDir, `${target}.${batchId}.bak`)), false)
    assert.equal(existsSync(join(runDir, `${target}.${batchId}.tmp`)), false)
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
})

test('checkpoint recovery restores every rename boundary and rejects unsafe journals', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-checkpoint-boundaries-'))
  const targets = [
    INSTRUCTION_MANIFEST_FILENAME,
    TASK_CONTRACT_FILENAME,
    'live-session-snapshot.json',
    'thread_events.json',
    'session-events.jsonl',
  ]
  try {
    for (let interruptedAfter = 0; interruptedAfter < targets.length; interruptedAfter += 1) {
      const batchId = `batch-${interruptedAfter}`
      for (let index = 0; index < targets.length; index += 1) {
        const target = join(runDir, targets[index]!)
        writeFileSync(target, `old-${index}`, 'utf-8')
        writeFileSync(`${target}.${batchId}.bak`, `old-${index}`, 'utf-8')
        if (index > interruptedAfter) {
          writeFileSync(`${target}.${batchId}.tmp`, `new-${index}`, 'utf-8')
        } else {
          writeFileSync(target, `new-${index}`, 'utf-8')
        }
      }
      writeFileSync(
        join(runDir, CHECKPOINT_JOURNAL_FILENAME),
        JSON.stringify({
          schema_version: 1,
          batch_id: batchId,
          status: 'prepared',
          backups_ready: true,
          targets,
        }),
        'utf-8',
      )

      recoverCheckpointArtifacts(runDir)

      for (let index = 0; index < targets.length; index += 1) {
        assert.equal(readFileSync(join(runDir, targets[index]!), 'utf-8'), `old-${index}`)
      }
      assert.equal(existsSync(join(runDir, CHECKPOINT_JOURNAL_FILENAME)), false)
    }

    writeFileSync(
      join(runDir, CHECKPOINT_JOURNAL_FILENAME),
      JSON.stringify({
        schema_version: 1,
        batch_id: 'unsafe',
        status: 'prepared',
        backups_ready: true,
        targets: ['..\\outside.txt'],
      }),
      'utf-8',
    )
    assert.throws(
      () => recoverCheckpointArtifacts(runDir),
      (error: unknown) =>
        error instanceof LiveSessionAuthorityError && error.code === 'CHECKPOINT_JOURNAL_INVALID',
    )
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
})
