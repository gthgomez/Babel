import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FINAL_REVISION_CONTRACT_VERSION,
  evaluateFinalRevisionWitness,
  hashFinalRevisionFile,
  untestedPathsAfterLastGreenVerifier,
} from './finalRevision.js'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-'))
  writeFileSync(join(root, 'app.ts'), 'export const value = 1\n')
  writeFileSync(join(root, 'app.test.ts'), 'test\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('inspection-only no-change is verified while the inspected bytes are unchanged', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ tool: 'read_file', target: 'app.ts', exit_code: 0, read_revision_hash: hash('export const value = 1\n') }]
    const witness = evaluateFinalRevisionWitness({ projectRoot: root, toolCallLog: log })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'inspection_reads')
    assert.equal(witness.contract, FINAL_REVISION_CONTRACT_VERSION)
  } finally {
    cleanup()
  }
})

test('external editor save after inspection invalidates no-change without deleting bytes', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ tool: 'read_file', target: 'app.ts', exit_code: 0, read_revision_hash: hash('export const value = 1\n') }]
    writeFileSync(join(root, 'app.ts'), 'export const value = 2\n')
    const witness = evaluateFinalRevisionWitness({ projectRoot: root, toolCallLog: log })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'inspected_bytes_changed_before_publication')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
    // User-owned bytes remain on disk; the witness never edits them.
    assert.equal(hashFinalRevisionFile(root, 'app.ts'), hash('export const value = 2\n'))
  } finally {
    cleanup()
  }
})

test('a write after the required green verifier is stale (Deep late-write)', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'mutation_after_required_verifier')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
    assert.deepEqual(untestedPathsAfterLastGreenVerifier(log), ['app.ts'])
  } finally {
    cleanup()
  }
})

test('matching no-late-write control reaches verified completion', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'required_verifier')
    assert.deepEqual(witness.stale_paths, [])
  } finally {
    cleanup()
  }
})

test('read-only shell inspection after the verifier does not fake a late write', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'shell_exec', target: 'npm test', exit_code: 0 },
      { tool: 'shell_exec', target: 'git diff', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
  } finally {
    cleanup()
  }
})

test('missing required verifier is unverified, never verified', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'file_write', target: 'app.ts', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('host-bound verifier revision mismatch is stale', () => {
  const { root, cleanup } = fixture()
  try {
    const bound = {
      schema_version: 1 as const,
      contract: FINAL_REVISION_CONTRACT_VERSION,
      scope: { kind: 'files' as const, paths: ['app.ts'] },
      git_commit_hash: null,
      composite_tree_hash: '0'.repeat(64),
      captured_at: 1,
      snapshot_complete: true,
    }
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'test_run', target: 'npm test', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
      verifierBoundRevision: bound,
    })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'final_revision_changed_after_verifier')
  } finally {
    cleanup()
  }
})

test('a host-proven no-op write after the verifier does not invalidate proof', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
      { tool: 'file_write', target: 'app.ts', exit_code: 0, effect_status: 'confirmed_no_change' },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
    assert.deepEqual(witness.stale_paths, [])
  } finally {
    cleanup()
  }
})
