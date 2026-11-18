import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decidePipelineFinalCompletion } from './finalCompletion.js'
import type { ToolCallLog } from '../schemas/agentContracts.js'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-completion-'))
  writeFileSync(join(root, 'app.ts'), 'v1\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('Deep late write after a green verifier fails verification', () => {
  const { root, cleanup } = fixture()
  try {
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE',
      projectRoot: root,
      requiredVerifierCommands: ['npm test'],
      toolCallLog: <ToolCallLog[]>[
        { step: 1, tool: 'file_write', target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'test_run', target: 'npm test', exit_code: 0, stdout: 'ok', stderr: '', verified: true },
        { step: 3, tool: 'file_write', target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
      ],
    })
    assert.equal(result.status, 'REQUIRED_VERIFIER_MISSING')
    assert.equal(result.decision?.finalOutcome, 'UNVERIFIED_PATCH')
    assert.equal(result.finalRevision.status, 'stale')
    assert.deepEqual(result.finalRevision.stale_paths, ['app.ts'])
    assert.match(result.condition ?? '', /retained/)
  } finally {
    cleanup()
  }
})

test('matching no-late-write Deep control preserves verified completion', () => {
  const { root, cleanup } = fixture()
  try {
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE',
      projectRoot: root,
      requiredVerifierCommands: ['npm test'],
      toolCallLog: <ToolCallLog[]>[
        { step: 1, tool: 'file_write', target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'test_run', target: 'npm test', exit_code: 0, stdout: 'ok', stderr: '', verified: true },
      ],
    })
    assert.equal(result.status, 'COMPLETE')
    assert.equal(result.decision?.finalOutcome, 'VERIFIED_COMPLETE')
    assert.equal(result.finalRevision.status, 'verified')
    assert.equal(result.condition, null)
  } finally {
    cleanup()
  }
})

test('Deep read-only no-change is revoked by an external save', () => {
  const { root, cleanup } = fixture()
  try {
    const log: ToolCallLog[] = [{ step: 1, tool: 'file_read', target: 'app.ts', exit_code: 0, stdout: 'v1\n', stderr: '', verified: true, read_revision_hash: hash('v1\n') }]
    writeFileSync(join(root, 'app.ts'), 'v2\n')
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE_NO_MODIFICATION',
      projectRoot: root,
      requiredVerifierCommands: [],
      toolCallLog: log,
    })
    assert.equal(result.status, 'EXECUTOR_HALTED')
    assert.equal(result.finalRevision.status, 'stale')
    assert.deepEqual(result.finalRevision.stale_paths, ['app.ts'])
  } finally {
    cleanup()
  }
})

test('unrelated inspection does not disturb a verified Deep completion', () => {
  const { root, cleanup } = fixture()
  try {
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE',
      projectRoot: root,
      requiredVerifierCommands: ['npm test'],
      toolCallLog: <ToolCallLog[]>[
        { step: 1, tool: 'file_write', target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'test_run', target: 'npm test', exit_code: 0, stdout: 'ok', stderr: '', verified: true },
        { step: 3, tool: 'read_file', target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true, read_revision_hash: hash('v1\n') },
      ],
    })
    assert.equal(result.status, 'COMPLETE')
    assert.equal(result.finalRevision.status, 'verified')
  } finally {
    cleanup()
  }
})

test('pipeline final verifier contract downgrades a post-test write and keeps the positive control', async () => {
  const { buildVerifierContractArtifacts } = await import('../services/requiredVerifierContract.js')
  const { buildPipelineFinalTerminalState } = await import('./finalization.js')
  const task = 'Repair src/math.cjs. Run node --test math.test.cjs before completing.'
  const base = (late: boolean) => [
    { step: 1, tool: 'test_run' as const, target: 'node --test math.test.cjs', exit_code: 1, stdout: 'red', stderr: '', verified: false },
    { step: 2, tool: 'file_write' as const, target: 'src/math.cjs', exit_code: 0, stdout: '', stderr: '', verified: true },
    { step: 3, tool: 'test_run' as const, target: 'node --test math.test.cjs', exit_code: 0, stdout: 'green', stderr: '', verified: true },
    ...(late ? [{ step: 4, tool: 'file_write' as const, target: 'src/math.cjs', exit_code: 0, stdout: '', stderr: '', verified: true }] : []),
  ]
  const lateArtifacts = buildVerifierContractArtifacts({ task, toolCallLog: base(true), runDir: '/tmp', requirePostMutationVerification: true })
  assert.equal(lateArtifacts.summary.verifierCompletionSatisfied, false)
  assert.equal(lateArtifacts.summary.completionBlockingStatus, 'REQUIRED_VERIFIER_MISSING')
  const lateState = buildPipelineFinalTerminalState({
    resultStatus: 'COMPLETE',
    verifierContractSummary: lateArtifacts.summary,
    terminalContext: {
      toolCallLog: base(true), condition: null, failureCapsulePath: null, repairAttemptTimelinePath: null,
      attemptSafetySummaryPath: null, attemptSafetySummary: null, rollbackSummaryPath: null,
      rollbackSummary: null, worktreeSafetySummaryPath: null, worktreeSafetySummary: null,
    },
  })
  assert.equal(lateState.status, 'REQUIRED_VERIFIER_MISSING')

  const control = buildVerifierContractArtifacts({ task, toolCallLog: base(false), runDir: '/tmp', requirePostMutationVerification: true })
  assert.equal(control.summary.verifierCompletionSatisfied, true)
  const controlState = buildPipelineFinalTerminalState({
    resultStatus: 'COMPLETE',
    verifierContractSummary: control.summary,
    terminalContext: {
      toolCallLog: base(false), condition: null, failureCapsulePath: null, repairAttemptTimelinePath: null,
      attemptSafetySummaryPath: null, attemptSafetySummary: null, rollbackSummaryPath: null,
      rollbackSummary: null, worktreeSafetySummaryPath: null, worktreeSafetySummary: null,
    },
  })
  assert.equal(controlState.status, 'COMPLETE')
})

test('Chat pipeline read-only no-change is revoked by an external save', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ step: 1, tool: 'file_read' as const, target: 'app.ts', exit_code: 0, stdout: 'v1\n', stderr: '', verified: true, read_revision_hash: hash('v1\n') }]
    writeFileSync(join(root, 'app.ts'), 'v2\n')
    const result = decidePipelineFinalCompletion({
      mode: 'chat',
      status: 'COMPLETE_NO_MODIFICATION',
      projectRoot: root,
      requiredVerifierCommands: [],
      toolCallLog: log,
    })
    assert.equal(result.status, 'EXECUTOR_HALTED')
    assert.equal(result.finalRevision.status, 'stale')
    assert.deepEqual(result.finalRevision.stale_paths, ['app.ts'])
  } finally {
    cleanup()
  }
})

test('READ_ONLY_NO_MODIFICATION cannot preserve a stale witness', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ step: 1, tool: 'file_read' as const, target: 'app.ts', exit_code: 0, stdout: 'v1\n', stderr: '', verified: true, read_revision_hash: hash('v1\n') }]
    writeFileSync(join(root, 'app.ts'), 'v2\n')
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'READ_ONLY_NO_MODIFICATION',
      projectRoot: root,
      requiredVerifierCommands: [],
      toolCallLog: log,
    })
    assert.equal(result.status, 'EXECUTOR_HALTED')
    assert.equal(result.finalRevision.status, 'stale')
  } finally {
    cleanup()
  }
})

test('bound session verifier (gradle test) agrees with a satisfied plan summary', () => {
  const { root, cleanup } = fixture()
  try {
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE',
      projectRoot: root,
      requiredVerifierCommands: ['gradle test'],
      toolCallLog: [
        { step: 1, tool: 'file_write' as const, target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
        { step: 2, tool: 'shell_exec' as const, target: 'gradle test', exit_code: 0, stdout: 'BUILD SUCCESSFUL', stderr: '', verified: true, processExecuted: true, processCompleted: true },
      ],
    })
    assert.equal(result.status, 'COMPLETE')
    assert.equal(result.finalRevision.status, 'verified')
    assert.equal(result.decision?.finalOutcome, 'VERIFIED_COMPLETE')
  } finally {
    cleanup()
  }
})

test('Deep writes without a required verifier stay explicitly unverified, not verified', () => {
  const { root, cleanup } = fixture()
  try {
    const result = decidePipelineFinalCompletion({
      mode: 'deep',
      status: 'COMPLETE',
      projectRoot: root,
      requiredVerifierCommands: [],
      toolCallLog: [
        { step: 1, tool: 'file_write' as const, target: 'app.ts', exit_code: 0, stdout: '', stderr: '', verified: true },
      ],
    })
    assert.equal(result.status, 'COMPLETE')
    assert.equal(result.finalRevision.status, 'unverified')
    assert.equal(result.decision?.finalOutcome, 'UNVERIFIED_PATCH')
    assert.equal(result.decision?.allowed, true)
  } finally {
    cleanup()
  }
})
