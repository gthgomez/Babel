import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { launchBabelReviewChild } from './babelReviewChild.js'
import { restoreBabelReviewLauncherAuthority } from './babelReviewLauncherAuthority.js'
import {
  createReviewAuthoritySupervisor,
  type ReviewAuthorityCandidate,
  type ReviewTaskAllowance,
} from './reviewSupervisor.js'

const candidate: ReviewAuthorityCandidate = {
  repository: 'gthgomez/Babel',
  prNumber: 201,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  candidateDigest: 'c'.repeat(64),
}

const allowance: ReviewTaskAllowance = {
  allowanceId: 'externally-issued-review-allowance',
  taskId: 'pr-201',
  executionId: 'c5c15b39-8ca2-49a7-a347-5e1e8fb8fc52',
  startedAt: '2026-09-18T10:00:00.000Z',
  elapsedLimitMs: 25,
  evidenceLineage: ['owner-task', 'candidate-c'.repeat(2)],
}

test('real review launcher restores an external checkpoint and follows it without minting allowance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-launcher-authority-'))
  const output = join(root, 'result.json')
  const worker = join(root, 'worker.mts')
  const now = Date.now()
  createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate,
    allowance,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
  })
  writeFileSync(worker, `import { writeFileSync } from 'node:fs';
await new Promise(resolve => setTimeout(resolve, 180));
writeFileSync(process.env.BABEL_REVIEW_OUTPUT!, JSON.stringify({ completed: true }));
`)

  try {
    const runtime = restoreBabelReviewLauncherAuthority({
      jobDir: root,
      taskId: allowance.taskId,
      candidate,
    })
    assert.ok(runtime, 'external authority checkpoint must select follow-authority mode')
    assert.equal(runtime.executionId, allowance.executionId)
    assert.equal(runtime.hostLifetime.kind, 'follow_authority')
    assert.deepEqual(runtime.snapshot().allowance, allowance)
    assert.equal(runtime.snapshot().mutationReplayAllowed, false)

    const run = await launchBabelReviewChild({
      source: root,
      trustedRoot: root,
      output,
      runs: join(root, 'runs'),
      model: 'mimo-v2.5',
      worker,
      tsx: resolve(fileURLToPath(new URL('../..', import.meta.url)), 'node_modules/tsx/dist/cli.mjs'),
      timeoutMs: 50,
      hostLifetime: runtime.hostLifetime,
      authority: runtime.monitor,
      candidate: runtime.candidate,
    })
    assert.equal(run.exitCode, 0)
    assert.equal(run.artifact?.['completed'], true)
    assert.equal(runtime.snapshot().allowance.allowanceId, allowance.allowanceId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real controller source wires restored authority through renewal and publication fencing', () => {
  const controllerPath = resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'tools/babel-pr-review.mts')
  assert.equal(existsSync(controllerPath), true)
  const source = readFileSync(controllerPath, 'utf8')
  assert.match(source, /restoreBabelReviewLauncherAuthority/)
  assert.match(source, /hostLifetime:\s*authorityRuntime\.hostLifetime/)
  assert.match(source, /authorityRuntime\.renew/)
  assert.match(source, /authorityRuntime\.admitPublication/)
  assert.doesNotMatch(source, /createReviewAuthoritySupervisor/)
})

test('missing external checkpoint preserves finite compatibility without creating authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-launcher-finite-'))
  try {
    assert.equal(restoreBabelReviewLauncherAuthority({
      jobDir: root,
      taskId: allowance.taskId,
      candidate,
    }), null)
    assert.equal(existsSync(join(root, 'authority.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('launcher renewal fences a changed candidate and rejects later publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-launcher-stale-'))
  const now = Date.now()
  createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate,
    allowance,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
  })
  try {
    const runtime = restoreBabelReviewLauncherAuthority({ jobDir: root, taskId: allowance.taskId, candidate })
    assert.ok(runtime)
    const changed = { ...candidate, headSha: 'd'.repeat(40) }
    assert.throws(() => runtime.renew(changed), /CANDIDATE_CHANGED/)
    assert.throws(() => runtime.admitPublication(candidate), /CANDIDATE_CHANGED/)
    assert.equal(runtime.snapshot().terminalCause, 'candidate_changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
