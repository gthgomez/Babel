import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendBabelReviewAdjudication, BabelReviewAdjudicationInput, parseBabelReviewAdjudication, readBabelReviewAdjudications } from './babelReviewAdjudication.js'

const input = {
  execution_id: 'review-123', candidate: { repository: 'example/repo', pr_number: 4, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) },
  subject: { kind: 'finding', id: 'c'.repeat(64) }, outcome: 'confirmed',
  evidence: [{ kind: 'test', ref: 'artifact:tests/regression-result.json' }],
}
const state = () => mkdtempSync(join(tmpdir(), 'babel-adjudication-'))

test('stores strict operator labels keyed to exact candidate and finding without granting approval', () => {
  const root = state()
  let scanned = ''
  const record = appendBabelReviewAdjudication(root, input, { scan: json => { scanned = json } })
  assert.equal(record.authority, 'operator_recorded_not_independently_verified')
  assert.equal(record.candidate.head_sha, input.candidate.head_sha)
  assert.deepEqual(parseBabelReviewAdjudication(JSON.parse(scanned)), record)
  assert.deepEqual(readBabelReviewAdjudications(root), { records: [record], invalid_records: 0 })
  assert.throws(() => BabelReviewAdjudicationInput.parse({ ...input, approved: true }))
  assert.throws(() => BabelReviewAdjudicationInput.parse({ ...input, evidence: [] }))
  assert.throws(() => BabelReviewAdjudicationInput.parse({ ...input, outcome: 'missed_defect' }))
})

test('rejects credential-risk, traversal and credential-bearing evidence references', () => {
  for (const ref of ['artifact:../auth.json', 'artifact:.env', 'artifact:sub/.git/config', 'artifact:C:/private', 'https://token@github.com/example/repo/pull/4', 'https://github.com/example/repo/pull/4?token=secret', 'file:///private/auth.json']) {
    assert.throws(() => BabelReviewAdjudicationInput.parse({ ...input, evidence: [{ kind: 'test', ref }] }))
  }
})

test('failed scans write nothing and UUID collisions never replace prior records', () => {
  const root = state()
  assert.throws(() => appendBabelReviewAdjudication(root, input, { scan() { throw new Error('SCAN_FAILED') } }), /SCAN_FAILED/)
  assert.equal(existsSync(join(root, 'adjudications')), false)
  const id = '11111111-1111-4111-8111-111111111111'
  appendBabelReviewAdjudication(root, input, { scan() {}, createId: () => id })
  const path = join(root, 'adjudications', id + '.json')
  const before = readFileSync(path)
  assert.throws(() => appendBabelReviewAdjudication(root, { ...input, outcome: 'false_positive' }, { scan() {}, createId: () => id }))
  assert.deepEqual(readFileSync(path), before)
  assert.ok(readdirSync(join(root, 'adjudications')).some(name => name.endsWith('.tmp')))
})

test('refuses Git state and linked state ancestors', () => {
  const root = state()
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true })
  assert.throws(() => appendBabelReviewAdjudication(root, input, { scan() {} }), /STATE_INSIDE_CANDIDATE_WORKTREE/)
  const outside = state()
  const target = state()
  const link = join(outside, 'linked')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => appendBabelReviewAdjudication(join(link, 'records'), input, { scan() {} }), /STATE_SYMLINK_DENIED/)
})

test('retains malformed adjudications and ignores unrelated files', () => {
  const root = state()
  mkdirSync(join(root, 'adjudications'))
  const path = join(root, 'adjudications', '11111111-1111-4111-8111-111111111111.json')
  writeFileSync(path, '{partial')
  writeFileSync(join(root, 'adjudications', 'auth.json'), 'must not be read as a quality record')
  assert.deepEqual(readBabelReviewAdjudications(root), { records: [], invalid_records: 1 })
  assert.equal(readFileSync(path, 'utf8'), '{partial')
})
