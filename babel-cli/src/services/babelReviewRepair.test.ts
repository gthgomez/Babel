import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyBabelRepairProposal, parseBabelRepairProposal } from './babelReviewRepair.js'

const proposal = { summary: 'Correct arithmetic', edits: [{ path: 'add.ts', old_text: 'a - b', new_text: 'a + b' }] }
const payload = (value: unknown) => ({ mode: 'chat', terminal_outcome: 'NO_CHANGE_REQUIRED', answer: { answer: JSON.stringify(value) } })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-repair-test-'))
  const git = (args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', windowsHide: true })
  git(['init', '--quiet'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(root, 'add.ts'), 'export const add = (a, b) => a - b\n')
  writeFileSync(join(root, 'other.ts'), 'export const untouched = true\n')
  git(['add', 'add.ts', 'other.ts'])
  git(['-c', 'user.name=Repair Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
  return { root, git, input: { worktree: root, expectedHead: git(['rev-parse', 'HEAD']).trim(), scope: ['add.ts', 'other.ts'], proposal } }
}

test('accepts strict completed chat proposals without claiming verification', () => {
  assert.deepEqual(parseBabelRepairProposal(payload(proposal), ['add.ts']), proposal)
  for (const terminal_outcome of ['VERIFIED_COMPLETE', 'ENV_BLOCKED', 'UNVERIFIED_PATCH']) assert.throws(() => parseBabelRepairProposal({ ...payload(proposal), terminal_outcome }, ['add.ts']), /CHAT_REPAIR_NOT_COMPLETED/)
  assert.throws(() => parseBabelRepairProposal(payload({ ...proposal, approved: true }), ['add.ts']))
})

test('rejects unsafe, secret, out-of-scope and duplicate target paths', () => {
  for (const path of ['../add.ts', 'a/../add.ts', '/add.ts', 'C:/add.ts', 'a\\b', '.git/config', '.env', 'nested/auth.json', 'NUL.ts', 'bad.', 'a\u0000b']) {
    assert.throws(() => parseBabelRepairProposal(payload({ ...proposal, edits: [{ ...proposal.edits[0], path }] }), [path]), /REPAIR_PATH_DENIED/)
  }
  assert.throws(() => parseBabelRepairProposal(payload(proposal), ['other.ts']), /REPAIR_PATH_DENIED/)
  assert.throws(() => parseBabelRepairProposal(payload({ ...proposal, edits: [proposal.edits[0], proposal.edits[0]] }), ['add.ts']), /REPAIR_DUPLICATE_PATH/)
})

test('applies a unique exact replacement to the clean exact head only', () => {
  const { root, input, git } = fixture()
  const result = applyBabelRepairProposal(input)
  assert.equal(readFileSync(join(root, 'add.ts'), 'utf8'), 'export const add = (a, b) => a + b\n')
  assert.equal(result.status, 'UNVERIFIED_REPAIR')
  assert.deepEqual(result.requires, ['deterministic_checks', 'fresh_independent_review_of_new_head'])
  assert.equal(git(['rev-parse', 'HEAD']).trim(), input.expectedHead)
  assert.equal(git(['diff', '--cached', '--name-only']).trim(), '')
})

test('rejects head, staged, source and ignored-file drift before writing', () => {
  for (const drift of ['head', 'index', 'source', 'untracked', 'ignored']) {
    const { root, input, git } = fixture()
    const before = readFileSync(join(root, 'add.ts'))
    if (drift === 'head') input.expectedHead = 'a'.repeat(40)
    if (drift === 'index') { writeFileSync(join(root, 'other.ts'), 'changed'); git(['add', 'other.ts']) }
    if (drift === 'source') writeFileSync(join(root, 'other.ts'), 'changed')
    if (drift === 'untracked') writeFileSync(join(root, 'extra.ts'), 'new')
    if (drift === 'ignored') { writeFileSync(join(root, '.git', 'info', 'exclude'), 'ignored.txt\n'); writeFileSync(join(root, 'ignored.txt'), 'new') }
    assert.throws(() => applyBabelRepairProposal(input), /REPAIR_(HEAD_CHANGED|DIRTY_INDEX|SOURCE_CHANGED|DIRTY_WORKTREE)/)
    assert.deepEqual(readFileSync(join(root, 'add.ts')), before)
  }
})

test('prevalidates every edit and rejects missing or repeated matches without partial writes', () => {
  for (const old_text of ['not present', 't']) {
    const { root, input } = fixture()
    const before = readFileSync(join(root, 'add.ts'))
    const invalid = { ...proposal, edits: [...proposal.edits, { path: 'other.ts', old_text, new_text: 'x' }] }
    assert.throws(() => applyBabelRepairProposal({ ...input, proposal: invalid }), /REPAIR_MATCH_NOT_UNIQUE/)
    assert.deepEqual(readFileSync(join(root, 'add.ts')), before)
  }
})

test('rejects a missing/deleted target and empty resulting file', () => {
  const { root, input } = fixture()
  assert.throws(() => applyBabelRepairProposal({ ...input, scope: [...input.scope, 'removed.ts'], proposal: { ...proposal, edits: [{ path: 'removed.ts', old_text: 'x', new_text: 'y' }] } }), /REPAIR_BINARY_OR_MISSING_FILE/)
  assert.throws(() => applyBabelRepairProposal({ ...input, proposal: { ...proposal, edits: [{ path: 'add.ts', old_text: readFileSync(join(root, 'add.ts'), 'utf8'), new_text: '' }] } }), /REPAIR_INVALID_RESULT/)
})

test('rejects hard-linked target files without mutating the other link', () => {
  const { root, input } = fixture()
  const external = mkdtempSync(join(tmpdir(), 'babel-repair-link-'))
  const link = join(external, 'linked.ts')
  linkSync(join(root, 'add.ts'), link)
  const before = readFileSync(link)
  assert.throws(() => applyBabelRepairProposal(input), /REPAIR_NONREGULAR_FILE/)
  assert.deepEqual(readFileSync(link), before)
})

test('rejects linked target paths when host symlink creation is available', t => {
  const { root, input } = fixture()
  const external = mkdtempSync(join(tmpdir(), 'babel-repair-symlink-'))
  const actual = join(external, 'actual.ts')
  renameSync(join(root, 'add.ts'), actual)
  try { symlinkSync(actual, join(root, 'add.ts'), 'file') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Host does not permit symlink creation'); return }
    throw error
  }
  const before = readFileSync(actual)
  assert.throws(() => applyBabelRepairProposal(input), /REPAIR_SYMLINK_DENIED/)
  assert.deepEqual(readFileSync(actual), before)
})

test('rejects binary results and oversized proposals', () => {
  const { input } = fixture()
  assert.throws(() => applyBabelRepairProposal({ ...input, proposal: { ...proposal, edits: [{ ...proposal.edits[0], new_text: 'a\0b' }] } }), /REPAIR_INVALID_RESULT/)
  assert.throws(() => parseBabelRepairProposal(payload({ ...proposal, edits: [{ ...proposal.edits[0], new_text: 'x'.repeat(2 * 1024 * 1024) }] }), ['add.ts']), /REPAIR_SIZE_LIMIT/)
})
