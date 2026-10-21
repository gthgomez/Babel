import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerRunOutput, readRunOutput, MAX_RUN_OUTPUT_BYTES, MAX_ARTIFACT_CHARS } from './runOutputArtifacts.js'
import { admitProjectContentRead } from '../chatReadOnly.js'

const owner = { sessionId: 'session', taskOwnerId: 'task-owner', acceptedTaskId: 'task' }

test('default artifact pages advertise continuation until the final line', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-default-page-'))
  try {
    const artifact = registerRunOutput({ runDir, owner, content: Array.from({ length: 500 }, (_, index) => `diagnostic ${index + 1}`).join('\n'), tool: 'test_run', callId: 'default-page' })
    const first = readRunOutput({ runDir, owner, artifactId: artifact.id })
    assert.match(first, /TRUNCATED: continue with start_line: 201/)
    const second = readRunOutput({ runDir, owner, artifactId: artifact.id, startLine: 201 })
    assert.match(second, /TRUNCATED: continue with start_line: 401/)
    const final = readRunOutput({ runDir, owner, artifactId: artifact.id, startLine: 401 })
    assert.match(final, /500: diagnostic 500/)
    assert.doesNotMatch(final, /TRUNCATED/)
    assert.doesNotMatch(readRunOutput({ runDir, owner, artifactId: artifact.id, endLine: 10 }), /TRUNCATED/)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('column continuation preserves following short lines and their search matches', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-next-line-'))
  try {
    const artifact = registerRunOutput({ runDir, owner, content: `${'x'.repeat(20000)}\nIMPORTANT_DIAGNOSTIC`, tool: 'test_run', callId: 'continuation' })
    const first = readRunOutput({ runDir, owner, artifactId: artifact.id })
    const marker = /continue with start_line: (\d+), start_column: (\d+)/.exec(first)
    assert.ok(marker)
    const continuation = { runDir, owner, artifactId: artifact.id, startLine: Number(marker[1]), startColumn: Number(marker[2]) }
    assert.match(readRunOutput(continuation), /2: IMPORTANT_DIAGNOSTIC/)
    assert.match(readRunOutput({ ...continuation, query: 'IMPORTANT_DIAGNOSTIC' }), /2: IMPORTANT_DIAGNOSTIC/)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('line prefixes cannot exceed the declared evidence-body character bound', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-prefix-bound-'))
  try {
    const artifact = registerRunOutput({ runDir, owner, content: `${'x'.repeat(15995)}\nsecond line`, tool: 'run_command', callId: 'boundary' })
    const result = readRunOutput({ runDir, owner, artifactId: artifact.id })
    const body = result.split('\n').filter(line => /^\d+: /.test(line)).join('\n')
    assert.ok(body.length <= MAX_ARTIFACT_CHARS, `evidence body length ${body.length}`)
    assert.match(result, /TRUNCATED: continue with start_line: 2/)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('artifact storage never expands project roots and rejects redirected directories and resource excess', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-output-containment-'))
  try {
    const project = join(root, 'project'); mkdirSync(project)
    const runDir = join(root, 'run'); mkdirSync(runDir)
    const artifact = registerRunOutput({ runDir, owner, content: 'private-output', tool: 'test_run', callId: 'call' })
    const storage = join(runDir, 'tool-output-artifacts')
    assert.equal(admitProjectContentRead(project, join(storage, `${artifact.id}.log`)).ok, false)
    assert.throws(() => registerRunOutput({ runDir, owner, content: 'x'.repeat(MAX_RUN_OUTPUT_BYTES + 1), tool: 'test_run', callId: 'oversize' }), /RESOURCE_BOUND/)
    const redirectedRun = join(root, 'redirected'); mkdirSync(redirectedRun)
    symlinkSync(storage, join(redirectedRun, 'tool-output-artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => readRunOutput({ runDir: redirectedRun, owner, artifactId: artifact.id }), /DENIED/)
    assert.throws(() => registerRunOutput({ runDir: redirectedRun, owner, content: 'not enrolled', tool: 'test_run', callId: 'redirected' }), /DENIED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('search exposes a diagnostic after 16000 characters on one line and supports column continuation', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-longline-'))
  try {
    const artifact = registerRunOutput({ runDir, owner, content: `${'x'.repeat(20000)}LATE_DIAGNOSTIC${'y'.repeat(20000)}`, tool: 'run_command', callId: 'long-line' })
    assert.equal(readRunOutput({ runDir, owner, artifactId: artifact.id, query: 'LATE_DIAGNOSTIC' }).includes('LATE_DIAGNOSTIC'), true)
    const second = readRunOutput({ runDir, owner, artifactId: artifact.id, startLine: 1, startColumn: 20001 })
    assert.equal(second.includes('LATE_DIAGNOSTIC'), true)
    assert.match(second, /start_column/)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('registered immutable output supports bounded middle search and cold continuation', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-'))
  try {
    const body = Array.from({ length: 500 }, (_, index) => index === 250 ? 'MIDDLE_SENTINEL' : `line ${index}`).join('\n')
    const artifact = registerRunOutput({ runDir, owner, content: body, tool: 'test_run', callId: 'call' })
    const cold = readRunOutput({ runDir, owner: { ...owner }, artifactId: artifact.id, query: 'MIDDLE_SENTINEL' })
    assert.match(cold, /251: MIDDLE_SENTINEL/)
    assert.match(cold, new RegExp(artifact.sha256))
    assert.match(cold, /test_run/)
    assert.doesNotMatch(readRunOutput({ runDir, owner, artifactId: artifact.id, startLine: 900 }), /MIDDLE_SENTINEL/)
    const bounded = readRunOutput({ runDir, owner, artifactId: artifact.id, startLine: 1, endLine: 500 })
    assert.match(bounded, /TRUNCATED/)
    assert.ok(bounded.length < 20000)
    const cancel = new AbortController(); cancel.abort()
    assert.throws(() => readRunOutput({ runDir, owner, artifactId: artifact.id, signal: cancel.signal }), /cancel/i)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('unregistered, replaced, other-owner and symlink output never leaks bytes', async t => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-output-denied-'))
  try {
    const artifact = registerRunOutput({ runDir, owner, content: 'registered', tool: 'test_run', callId: 'call' })
    const sensitive = join(runDir, 'unregistered-sensitive.log')
    writeFileSync(sensitive, 'UNREGISTERED_PRIVATE_BYTES')
    for (const artifactId of ['../unregistered-sensitive.log', sensitive, '00000000-0000-0000-0000-000000000000']) {
      assert.throws(() => readRunOutput({ runDir, owner, artifactId }), error =>
        error instanceof Error && !error.message.includes('UNREGISTERED_PRIVATE_BYTES'))
    }
    for (const other of [{ ...owner, taskOwnerId: 'other' }, { ...owner, sessionId: 'other' }, { ...owner, acceptedTaskId: 'replacement' }]) {
      assert.throws(() => readRunOutput({ runDir, owner: other, artifactId: artifact.id }), /denied/i)
    }
    const contentPath = join(runDir, 'tool-output-artifacts', `${artifact.id}.log`)
    writeFileSync(contentPath, 'REPLACED_PRIVATE_BYTES')
    assert.throws(() => readRunOutput({ runDir, owner, artifactId: artifact.id }), /identity/i)
    rmSync(contentPath)
    await t.test('file symlink escape', t => {
      try { symlinkSync(sensitive, contentPath) } catch (error) {
        if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        t.skip('host does not grant file symlink creation'); return
      }
      assert.throws(() => readRunOutput({ runDir, owner, artifactId: artifact.id }), /denied/i)
    })
    assert.equal(readFileSync(sensitive, 'utf8'), 'UNREGISTERED_PRIVATE_BYTES')
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})
