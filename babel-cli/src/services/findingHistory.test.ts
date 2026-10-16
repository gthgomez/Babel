import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStructuredFinding } from './structuredFinding.js'
import { reconcileFindingHistory, readFindingDependencyChanges } from './findingHistory.js'
import { parseBabelReviewAdjudication } from './babelReviewAdjudication.js'

const first = createStructuredFinding({ candidateDigest: 'a'.repeat(64), executionId: 'first', reviewerId: 'reviewer',
  category: 'correctness', severity: 'P1', path: 'src/a.ts', line: 10, symbol: 'load',
  defectClass: 'empty_input', behavior: 'throws on empty input', claim: 'src/a.ts:10 throws on empty input' })
const candidate = { repository: 'example/repo', prNumber: 1, headSha: 'a'.repeat(40), changedPaths: [] as string[] }

test('revision history retains immutable observations and never infers fixed from disappearance', () => {
  const original = reconcileFindingHistory({ ...candidate, findings: [first] })
  const moved = createStructuredFinding({ candidateDigest: 'b'.repeat(64), executionId: 'second', reviewerId: 'reviewer',
    category: 'correctness', severity: 'P1', path: 'src/a.ts', line: 30, symbol: 'load',
    defectClass: 'empty_input', behavior: 'throws on empty input', claim: 'src/a.ts:30 throws on empty input' })
  const next = reconcileFindingHistory({ ...candidate, headSha: 'b'.repeat(40), findings: [moved], previous: original })
  assert.equal(next.defects.length, 1)
  assert.equal(next.defects[0]!.state, 'still_open')
  assert.equal(next.defects[0]!.observations.length, 2)
  assert.equal(original.defects[0]!.observations.length, 1)
  assert.equal(reconcileFindingHistory({ ...candidate, findings: [], previous: next }).defects[0]!.state, 'not_observed')
})

test('actual Git rename includes the removed dependency path for invalidation', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-finding-rename-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Babel test',
    '-c', 'user.email=babel-test@example.invalid', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } })
  git(['init', '--quiet'])
  writeFileSync(join(root, 'old.ts'), 'export const value = 1;\n')
  git(['add', 'old.ts'])
  git(['commit', '--quiet', '-m', 'initial fixture'])
  const before = git(['rev-parse', 'HEAD']).trim()
  renameSync(join(root, 'old.ts'), join(root, 'new.ts'))
  git(['add', '--all'])
  git(['commit', '--quiet', '-m', 'rename dependency'])
  const head = git(['rev-parse', 'HEAD']).trim()
  assert.match(git(['diff', '--name-status', before, head]), /^R100/)
  assert.deepEqual(readFindingDependencyChanges(git, before, head).sort(), ['new.ts', 'old.ts'])
})

test('operator dismissals keep reasons/evidence and reopen when dependencies change', () => {
  const adjudication = parseBabelReviewAdjudication({ schema_version: 1, kind: 'babel_review_adjudication',
    id: '11111111-1111-4111-8111-111111111111', recorded_at: '2026-10-16T12:00:00Z', authority: 'operator_recorded_not_independently_verified',
    execution_id: 'first', candidate: { repository: 'example/repo', pr_number: 1, base_sha: 'c'.repeat(40), head_sha: candidate.headSha },
    subject: { kind: 'finding', id: first.finding_instance_id }, outcome: 'false_positive',
    evidence: [{ kind: 'review', ref: 'artifact:review.json' }],
    defect_lifecycle: { state: 'dismissed', reason: 'caller excludes empty input', dependency_paths: ['src/caller.ts'] },
  })
  const dismissed = reconcileFindingHistory({ ...candidate, findings: [first], adjudications: [adjudication] })
  assert.equal(dismissed.defects[0]!.state, 'dismissed')
  const reopened = reconcileFindingHistory({ ...candidate, headSha: 'b'.repeat(40), findings: [], previous: dismissed, changedPaths: ['src/caller.ts'] })
  assert.equal(reopened.defects[0]!.state, 'reopened')
  assert.equal(reconcileFindingHistory({ ...candidate, headSha: 'c'.repeat(40), findings: [], previous: reopened }).defects[0]!.state, 'reopened')
  assert.equal(reopened.defects[0]!.resolution?.reason, 'caller excludes empty input')
  assert.equal(reopened.defects[0]!.resolution?.authority, 'operator_recorded_not_independently_verified')
})
