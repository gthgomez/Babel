import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, mock, test } from 'node:test'
import { RevisionManager, captureVerifierInputClosure, compareRevisions, discoverVerifierInputClosure } from './revisionBoundReceipt.js'

const BYTE_BUDGET_REASON = 'Input closure exceeds the proof byte budget'
const ENTRY_CAP_REASON = 'Input closure exceeds the repository entry cap'
const FILE_CAP_REASON = 'Input closure exceeds the file cap'
const SIZE_CAP_REASON = 'Input file exceeds the closure size cap'
const REPOSITORY_BUDGET = 128_000_000
const VERIFIER_BUDGET = 40_000_000
const PER_FILE_CAP = 1_000_000
const ENTRY_CAP = 20_000

function withTemp(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(join(tmpdir(), prefix))
  try {
    run(root)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function gitFixture(run: (root: string, git: (args: string[]) => string) => void): void {
  withTemp('babel-capture-budget-', (root) => {
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'absent-global-git-config') },
    })
    git(['init', '-q'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    git(['config', 'user.name', 'Fixture'])
    fs.writeFileSync(join(root, 'tracked.txt'), 'baseline\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-q', '-m', 'baseline'])
    run(root, git)
  })
}

function writeSparse(file: string, size: number): void {
  const fd = fs.openSync(file, 'w')
  try { fs.ftruncateSync(fd, size) }
  finally { fs.closeSync(fd) }
}

function pathCost(relative: string): number {
  return Buffer.byteLength(relative, 'utf8') + 1
}

/** Regular file whose size plus UTF-8 path metadata equals `contribution`. */
function writeContribution(root: string, relative: string, contribution: number): void {
  const size = contribution - pathCost(relative)
  assert.ok(size > 0 && size <= PER_FILE_CAP)
  writeSparse(join(root, relative), size)
  const stats = fs.lstatSync(join(root, relative))
  assert.equal(stats.isFile(), true)
  assert.equal(stats.isFIFO(), false)
  assert.equal(stats.size + pathCost(relative), contribution)
}

function boundaryName(index: number): string {
  return `c${String(index).padStart(3, '0')}`
}

function entryName(index: number): string {
  return String(index).padStart(5, '0')
}

describe('repository capture budget', { concurrency: false }, () => {
  test('repository capture above 40 MB and below 128 MB stays fresh for a concealed edit; verifier caps do not', () => gitFixture((root, git) => {
    fs.writeFileSync(join(root, '.gitignore'), 'payload/\n')
    git(['add', '.gitignore'])
    git(['commit', '-q', '-m', 'ignore payloads'])
    fs.mkdirSync(join(root, 'payload'))
    // Each payload contributes exactly 1_000_000 (size + path bytes). Root
    // entries are tracked.txt (21), .gitignore (20), and payload/ (8). Those
    // are admitted before any payload, so the 41st file is still under 40 MB
    // and the fresh walk crosses 40 MB on a later payload. 41 payloads stay
    // under 128 MB.
    const payloads = 41
    for (let index = 0; index < payloads; index += 1) {
      const relative = `payload/p${String(index).padStart(2, '0')}`
      writeContribution(root, relative, PER_FILE_CAP)
    }
    const eligible = (21 + 20 + 8) + (payloads * PER_FILE_CAP)
    assert.ok(eligible > VERIFIER_BUDGET && eligible < REPOSITORY_BUDGET)

    assert.deepEqual(discoverVerifierInputClosure(root, false), { mode: 'unsupported', reason: FILE_CAP_REASON })
    assert.deepEqual(discoverVerifierInputClosure(root, true), { mode: 'unsupported', reason: BYTE_BUDGET_REASON })

    const before = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository', git_binding: 'required',
    })
    assert.equal(typeof before.gitCommitHash, 'string')
    git(['update-index', '--skip-worktree', 'tracked.txt'])
    fs.writeFileSync(join(root, 'tracked.txt'), 'concealed\n')
    assert.equal(git(['status', '--porcelain']), '')
    const after = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository', git_binding: 'required',
    })
    assert.equal(compareRevisions(before, after).stale, true)
  }))

  test('repository aggregate equal to the budget, including path metadata, succeeds', { timeout: 20_000 }, () => withTemp('babel-capture-boundary-', (root) => {
    // 128 files named c000..c127. Path cost is 5, so size 999_995 makes each
    // file contribute 1_000_000. 128 * 1_000_000 = 128_000_000 exactly.
    const names = Array.from({ length: 128 }, (_, index) => boundaryName(index))
    for (const relative of names) writeContribution(root, relative, PER_FILE_CAP)
    const bound = captureVerifierInputClosure(root, true, names)
    assert.equal(bound.mode, 'bound')
    if (bound.mode !== 'bound') return
    assert.equal(bound.reuseEligible, false)
    assert.deepEqual(bound.paths, [...names].sort())
    assert.equal(Object.getPrototypeOf(bound.digests), null)
    assert.deepEqual(discoverVerifierInputClosure(root, true), { mode: 'unsupported', reason: BYTE_BUDGET_REASON })
  }))

  test('one byte over the repository aggregate refuses before any content read', { timeout: 8_000 }, () => withTemp('babel-capture-boundary-over-', (root) => {
    // 127 full units + a file one byte smaller + directory "d" (path cost 2)
    // = 128_000_001. Every admitted root entry costs at least 2, so the sum
    // exceeds the budget only when the last root entry is admitted. The FIFO
    // lives in that directory: a content read would block in readSync, and a
    // completed walk would report the unsupported-entry reason instead.
    const names: string[] = []
    for (let index = 0; index < 127; index += 1) {
      const relative = boundaryName(index)
      names.push(relative)
      writeContribution(root, relative, PER_FILE_CAP)
    }
    const last = boundaryName(127)
    names.push(last)
    writeContribution(root, last, PER_FILE_CAP - 1)
    fs.mkdirSync(join(root, 'd'))
    execFileSync('mkfifo', [join(root, 'd', 'p')])
    assert.equal(fs.lstatSync(join(root, 'd', 'p')).isFIFO(), true)
    assert.equal(pathCost('d'), 2)
    const result = captureVerifierInputClosure(root, true, [...names, 'd'])
    assert.deepEqual(result, { mode: 'unsupported', reason: BYTE_BUDGET_REASON })
  }))

  test('a file over 1_000_000 refuses before content open under the 128 MB envelope', () => withTemp('babel-capture-per-file-', (root) => {
    writeSparse(join(root, 'big.bin'), PER_FILE_CAP + 1)
    fs.writeFileSync(join(root, 'small.txt'), 'ok\n')
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const original = mutableFs.openSync
    let opened = false
    mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      opened = true
      return original(...args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    const result = captureVerifierInputClosure(root, true, ['big.bin', 'small.txt'])
    assert.deepEqual(result, { mode: 'unsupported', reason: SIZE_CAP_REASON })
    assert.equal(opened, false)
  }))

  test('20_000 empty root files are admitted and one more refuses before reads', { timeout: 20_000 }, () => withTemp('babel-capture-entries-', (root) => {
    // The capture root is not an admitted relative path, and this tree has no
    // directory entries, so 20_000 empty files are exactly 20_000 eligible
    // entries. Five-character names cost 6 bytes each (120_000, then 120_006),
    // far under the 40 MB verifier envelope, so the entry cap cannot lose to
    // the byte budget.
    const admitted: string[] = []
    for (let index = 0; index < ENTRY_CAP; index += 1) {
      const relative = entryName(index)
      admitted.push(relative)
      fs.writeFileSync(join(root, relative), Buffer.alloc(0))
    }
    const within = captureVerifierInputClosure(root, true, admitted)
    assert.equal(within.mode, 'bound')
    if (within.mode === 'bound') {
      assert.equal(within.paths.length, ENTRY_CAP)
      assert.equal(within.reuseEligible, false)
      assert.equal(Object.getPrototypeOf(within.digests), null)
    }

    const extra = entryName(ENTRY_CAP)
    fs.writeFileSync(join(root, extra), Buffer.alloc(0))
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const originalOpen = mutableFs.openSync
    const originalRead = mutableFs.readSync
    let opened = false
    let read = false
    mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      opened = true
      return originalOpen(...args)
    }) as typeof fs.openSync)
    mock.method(mutableFs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
      read = true
      return originalRead(...args)
    }) as typeof fs.readSync)
    syncBuiltinESMExports()
    const over = captureVerifierInputClosure(root, true, [...admitted, extra])
    assert.deepEqual(over, { mode: 'unsupported', reason: ENTRY_CAP_REASON })
    assert.equal(opened, false)
    assert.equal(read, false)
  }))
})
