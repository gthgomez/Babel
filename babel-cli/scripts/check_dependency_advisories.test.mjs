// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { verifyAdvisoryReview } from './check_dependency_advisories.mjs'

function fixture({ installed = '4.4.3', ranges = ['< 4.6.6'], decision = 'remediated', scopes = ['npm'], lockDigest, lineEndings = 'lf' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'babel-advisory-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'pkg'), { recursive: true })
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/zod': { version: installed } } }
  const lf = JSON.stringify(lock)
  const bytes = lineEndings === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
  writeFileSync(join(root, 'pkg/package-lock.json'), bytes)
  const reviewed = createHash('sha256').update(lf.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
  const review = {
    schemaVersion: 1,
    reviewedAt: '2026-11-18',
    locks: [{ path: 'pkg/package-lock.json', sha256: lockDigest ?? reviewed }],
    advisories: [{
      id: 'GHSA-fixture-0000-0001', severity: 'high', package: 'zod', ranges, fixedVersions: ['4.6.6'],
      artifactScopes: scopes, summary: 'fixture', exposure: 'fixture exposure', decision, rationale: 'fixture rationale',
      references: ['https://github.com/advisories/GHSA-fixture-0000-0001'],
      ...(decision === 'deferred' || decision === 'accepted_risk' ? { releaseImpact: 'fixture artifact stays unqualified' } : {}),
    }],
  }
  writeFileSync(join(root, 'config/dependency-advisory-review.json'), JSON.stringify(review))
  return root
}

test('real review passes the npm artifact scope it qualifies', () => {
  const result = verifyAdvisoryReview({ repoRoot: resolve(import.meta.dirname, '../..'), scope: 'npm' })
  assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
  assert.ok(result.checked >= 2)
})

test('real review keeps the deferred Electron advisory out of the npm qualification', () => {
  const npm = verifyAdvisoryReview({ repoRoot: resolve(import.meta.dirname, '../..'), scope: 'npm' })
  assert.equal(npm.status, 'PASS')
  const desktop = verifyAdvisoryReview({ repoRoot: resolve(import.meta.dirname, '../..'), scope: 'desktop' })
  assert.equal(desktop.status, 'FAIL')
  assert.match(desktop.problems.join('\n'), /GHSA-jr5w-w6x2-84p9: deferred blocks desktop qualification/)
})

test('a changed lock makes the review stale', () => {
  const root = fixture({ lockDigest: '0'.repeat(64) })
  try {
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems[0], /stale advisory review/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a CRLF checkout does not invalidate an LF-reviewed lock', () => {
  const root = fixture({ installed: '4.6.6', ranges: ['< 4.6.6'], lineEndings: 'crlf' })
  try {
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a CRLF checkout still detects changed lock content', () => {
  const root = fixture({ installed: '4.6.6', ranges: ['< 4.6.6'], lineEndings: 'crlf' })
  try {
    const lockPath = join(root, 'pkg/package-lock.json')
    writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('"4.6.6"', '"4.6.5"'))
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems[0], /stale advisory review/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('remediated fails while an affected version is still locked', () => {
  const root = fixture()
  try {
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems.join('\n'), /recorded remediated but an installed zod still matches/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('fixed version clears remediated, including comma-separated advisory ranges', () => {
  const root = fixture({ installed: '4.6.6', ranges: ['>= 4.0.0, < 4.6.6'] })
  try {
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('not_affected cannot hide an affected locked version', () => {
  const root = fixture({ decision: 'not_affected' })
  try {
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems.join('\n'), /recorded not_affected/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('deferred and accepted risk block only the artifact scopes they name', () => {
  for (const decision of ['deferred', 'accepted_risk']) {
    const root = fixture({ decision, scopes: ['desktop'] })
    try {
      const npm = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
      assert.equal(npm.status, 'PASS', decision)
      const desktop = verifyAdvisoryReview({ repoRoot: root, scope: 'desktop' })
      assert.equal(desktop.status, 'FAIL', decision)
      assert.match(desktop.problems.join('\n'), new RegExp(`${decision} blocks desktop qualification`))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('a package missing from every reviewed lock is a stale review', () => {
  const root = fixture({ installed: '9.9.9' })
  try {
    const reviewPath = join(root, 'config/dependency-advisory-review.json')
    const record = JSON.parse(readFileSync(reviewPath, 'utf8'))
    record.advisories[0].package = 'not-locked'
    writeFileSync(reviewPath, JSON.stringify(record))
    const result = verifyAdvisoryReview({ repoRoot: root, scope: 'npm' })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems.join('\n'), /not present in any reviewed lock/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
