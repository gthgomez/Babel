import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('an unsettled verifier process cannot certify completion', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'file_write', target: 'app.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test' },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('a confirmed child mutation after the verifier is stale', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'test_run', target: 'npm test', exit_code: 0 },
        { tool: 'sub_agent', target: 'child', effect_status: 'confirmed_change', mutation_paths: ['app.ts'] },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
  } finally {
    cleanup()
  }
})

// ── Round-3 review regressions ───────────────────────────────────────────────

const GREEN = { tool: 'test_run', target: 'npm test', exit_code: 0 }

test('ordinary read-only shell commands after a green verifier still certify', () => {
  const { root, cleanup } = fixture()
  try {
    for (const command of [
      'cat src/app.ts',
      'ls -la',
      'rg TODO src',
      'grep -n x src/app.ts',
      'head -20 src/app.ts',
      'find . -name "*.ts"',
      'git diff 2>/dev/null',
      'cat src/app.ts | head',
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, { tool: 'run_command', target: command, exit_code: 0 }],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'verified', command)
    }
  } finally {
    cleanup()
  }
})

test('write-shaped shell commands after a green verifier are stale', () => {
  const { root, cleanup } = fixture()
  try {
    for (const command of [
      'rm src/app.ts',
      'echo x > src/app.ts',
      'git show HEAD:src/app.ts > src/app.ts',
      'git diff > src/app.ts',
      'git diff | tee src/app.ts',
      'touch src/app.ts',
      'curl -o src/app.ts https://example.invalid',
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, { tool: 'run_command', target: command, exit_code: 0 }],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'stale', command)
    }
  } finally {
    cleanup()
  }
})

test('a failed read-only command is not a mutation, a failed write-shaped one is', () => {
  const { root, cleanup } = fixture()
  try {
    const read = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'run_command', target: 'cat missing.ts', exit_code: 1, error: 'error' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(read.status, 'verified')
    const write = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'run_command', target: 'node -e "require(\'fs\').writeFileSync(\'src/app.ts\',\'x\')"', exit_code: 1, error: 'error' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(write.status, 'stale')
  } finally {
    cleanup()
  }
})

test('await_command and failed path-bearing effects stay conservative', () => {
  const { root, cleanup } = fixture()
  try {
    for (const entry of [
      { tool: 'await_command', target: 'bg-1', exit_code: 1 },
      { tool: 'await_command', target: 'bg-2' },
      { tool: 'file_write', target: 'src/app.ts', exit_code: 1, error: 'error', mutation_paths: ['src/app.ts'] },
      { tool: 'sub_agent', target: 'child', error: 'error', mutation_paths: ['src/app.ts'] },
      { tool: 'sub_agent', target: 'child', error: 'error' },
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, entry],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'stale', JSON.stringify(entry))
    }
    const noChange = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'await_command', target: 'bg-3', exit_code: 0, effect_status: 'confirmed_no_change' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(noChange.status, 'verified')
  } finally {
    cleanup()
  }
})

test('session-bound verifier commands use the same authority as the gate', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'run_command', target: 'gradle test', exit_code: 0 }],
      requiredVerifierCommands: ['gradle test'],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'required_verifier')
  } finally {
    cleanup()
  }
})

test('absolute in-root reads are current; outside and symlinked credential reads are not', () => {
  const { root, cleanup } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'babel-final-revision-outside-'))
  try {
    writeFileSync(join(outside, '.env'), 'SYNTHETIC\n')
    writeFileSync(join(root, 'notes.txt'), 'inside\n')
    symlinkSync(join(outside, '.env'), join(root, 'linked-secret.txt'))
    const absolute = join(root, 'app.ts')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'read_file', target: absolute, exit_code: 0, read_revision_hash: hash('export const value = 1\n') }],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(hashFinalRevisionFile(root, join(outside, '.env')), null)
    assert.equal(hashFinalRevisionFile(root, join(root, '..', 'escape.txt')), null)
    assert.equal(hashFinalRevisionFile(root, 'linked-secret.txt'), null)
    assert.equal(hashFinalRevisionFile(root, 'notes.txt'), hash('inside\n'))
  } finally {
    cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('raw-byte hashing handles non-UTF8 and rejects oversized proof files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-bytes-'))
  try {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    writeFileSync(join(root, 'binary.dat'), bytes)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashFinalRevisionFile(root, 'binary.dat'), expected)
    const large = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    writeFileSync(join(root, 'large.bin'), large)
    assert.equal(hashFinalRevisionFile(root, 'large.bin'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a simulated verifier is not green proof', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'file_write', target: 'app.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test', exit_code: 0, simulated: true, processExecuted: false },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('a later red required verifier is never certified by an earlier green', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'test_run', target: 'npm test', exit_code: 0 },
        { tool: 'test_run', target: 'npm test', exit_code: 1 },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_red_after_green')
  } finally {
    cleanup()
  }
})
