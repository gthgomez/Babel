import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mock, test } from 'node:test'
import { RevisionManager, compareRevisions, validateRevisionBoundReceipt } from './revisionBoundReceipt.js'

function fixture(run: (root: string, git: (args: string[]) => string) => void): void {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-physical-state-'))
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'absent-global-git-config') },
  })
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    git(['config', 'user.name', 'Fixture'])
    fs.writeFileSync(join(root, 'tracked.txt'), 'baseline\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-q', '-m', 'baseline'])
    run(root, git)
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const repositoryRevision = (root: string, required = true) =>
  RevisionManager.computeRevisionSync(root, [], {
    scope_kind: 'repository', git_binding: required ? 'required' : 'optional',
  })

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  test(`repository receipt sees physical edits concealed by ${flag}`, () => fixture((root, git) => {
    git(['update-index', flag, 'tracked.txt'])
    const before = repositoryRevision(root)
    fs.writeFileSync(join(root, 'tracked.txt'), 'concealed\n')
    assert.equal(git(['status', '--porcelain']), '')
    assert.equal(compareRevisions(before, repositoryRevision(root)).stale, true)
  }))
}

test('ignored eligible additions and deletions change the independently measured repository', () => fixture((root, git) => {
  fs.writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  git(['add', '.gitignore'])
  git(['commit', '-q', '-m', 'ignore fixture'])
  const before = repositoryRevision(root)
  fs.writeFileSync(join(root, 'ignored.txt'), 'input\n')
  assert.equal(git(['status', '--porcelain']), '')
  const added = repositoryRevision(root)
  assert.equal(compareRevisions(before, added).stale, true)
  fs.unlinkSync(join(root, 'ignored.txt'))
  assert.equal(compareRevisions(added, repositoryRevision(root)).stale, true)
}))

test('tracked deletion remains visible when Git hides it', () => fixture((root, git) => {
  git(['update-index', '--skip-worktree', 'tracked.txt'])
  const before = repositoryRevision(root)
  fs.unlinkSync(join(root, 'tracked.txt'))
  assert.equal(compareRevisions(before, repositoryRevision(root)).stale, true)
}))

test('a tracked path inside an excluded dependency tree refuses complete repository proof', () => fixture((root, git) => {
  fs.mkdirSync(join(root, 'node_modules'))
  fs.writeFileSync(join(root, 'node_modules', 'tracked.txt'), 'input\n')
  git(['add', '-f', 'node_modules/tracked.txt'])
  git(['commit', '-q', '-m', 'tracked dependency fixture'])
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
}))

test('incomplete filesystem enumeration cannot hide an existing tracked file', () => fixture((root) => {
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const original = mutableFs.opendirSync
  mock.method(mutableFs, 'opendirSync', ((candidate: fs.PathLike) => {
    const directory = original(candidate)
    if (resolve(String(candidate)) === root) {
      const read = directory.readSync.bind(directory)
      directory.readSync = () => {
        let entry: fs.Dirent | null
        do { entry = read() } while (entry?.name === 'tracked.txt')
        return entry
      }
    }
    return directory
  }) as typeof fs.opendirSync)
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
}))

test('enumeration failure refuses proof even with a valid Git HEAD', () => fixture((root) => {
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  mock.method(mutableFs, 'opendirSync', () => { throw new Error('unreadable fixture directory') })
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
  const unknown = repositoryRevision(root, false)
  assert.equal(compareRevisions(unknown, repositoryRevision(root, false)).stale, true)
  assert.notEqual(validateRevisionBoundReceipt({
    receiptId: 'fixture', command: 'check', exitCode: 0,
    boundRevision: unknown, stale: false,
  }).length, 0)
}))

test('repository measurement refuses oversized physical input before opening content', () => fixture((root) => {
  fs.writeFileSync(join(root, 'large.txt'), Buffer.alloc(1_000_001))
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const original = mutableFs.openSync
  let opened = false
  mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    opened = true
    return original(...args)
  }) as typeof fs.openSync)
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
  assert.equal(opened, false)
}))

test('clean tracked credential paths refuse binding before any content read', () => fixture((root, git) => {
  fs.writeFileSync(join(root, '.env'), 'public synthetic fixture\n')
  git(['add', '.env'])
  git(['commit', '-q', '-m', 'synthetic credential path'])
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const original = mutableFs.openSync
  let opened = false
  mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    opened = true
    return original(...args)
  }) as typeof fs.openSync)
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
  assert.equal(opened, false)
}))

test('file scope stays narrow when unrelated repository input exceeds the physical cap', () => fixture((root) => {
  fs.writeFileSync(join(root, 'large.txt'), Buffer.alloc(1_000_001))
  const revision = () => RevisionManager.computeRevisionSync(root, ['tracked.txt'], { git_binding: 'required' })
  assert.equal(compareRevisions(revision(), revision()).stale, false)
}))

test('leaf symlink targets are metadata bound without reading their outside content', { skip: platform() === 'win32' }, () => fixture((root) => {
  const outside = fs.mkdtempSync(join(tmpdir(), 'babel-physical-outside-'))
  try {
    const target = join(outside, 'input.txt')
    fs.writeFileSync(target, 'outside input\n')
    const before = repositoryRevision(root)
    fs.unlinkSync(join(root, 'tracked.txt'))
    fs.symlinkSync(target, join(root, 'tracked.txt'))
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const original = mutableFs.openSync
    let openedOutside = false
    mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      if (resolve(String(args[0])) === target) openedOutside = true
      return original(...args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    const linked = repositoryRevision(root)
    assert.equal(compareRevisions(before, linked).stale, true)
    fs.writeFileSync(target, 'outside changed\n')
    assert.equal(compareRevisions(linked, repositoryRevision(root)).stale, false)
    fs.unlinkSync(join(root, 'tracked.txt'))
    fs.symlinkSync(join(outside, 'other.txt'), join(root, 'tracked.txt'))
    assert.equal(compareRevisions(linked, repositoryRevision(root)).stale, true)
    assert.equal(openedOutside, false)
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
}))

test('hidden tracked paths through a symlink parent refuse binding before input reads', { skip: platform() === 'win32' }, () => fixture((root, git) => {
  fs.mkdirSync(join(root, 'src'))
  fs.writeFileSync(join(root, 'src', 'input.txt'), 'input\n')
  git(['add', 'src/input.txt'])
  git(['commit', '-q', '-m', 'parent fixture'])
  git(['update-index', '--skip-worktree', 'src/input.txt'])
  const outside = fs.mkdtempSync(join(tmpdir(), 'babel-physical-parent-'))
  try {
    fs.writeFileSync(join(outside, 'input.txt'), 'outside input\n')
    fs.rmSync(join(root, 'src'), { recursive: true })
    fs.symlinkSync(outside, join(root, 'src'))
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const original = mutableFs.openSync
    let opened = false
    mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      opened = true
      return original(...args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    assert.throws(() => repositoryRevision(root), /tree cannot be established/)
    assert.equal(opened, false)
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
}))

test('an omitted Git enumeration path still cannot hide physical tracked bytes', () => fixture((root) => {
  const mutableProcess = (childProcess as unknown as { default: typeof childProcess }).default
  const original = mutableProcess.execFileSync
  mock.method(mutableProcess, 'execFileSync', ((...args: Parameters<typeof execFileSync>) => {
    if (Array.isArray(args[1]) && args[1][0] === 'ls-files') return ''
    return original(...args)
  }) as typeof execFileSync)
  syncBuiltinESMExports()
  const before = repositoryRevision(root)
  fs.writeFileSync(join(root, 'tracked.txt'), 'physical change\n')
  assert.equal(compareRevisions(before, repositoryRevision(root)).stale, true)
}))

test('malformed Git enumeration refuses complete physical proof', () => fixture((root) => {
  const mutableProcess = (childProcess as unknown as { default: typeof childProcess }).default
  const original = mutableProcess.execFileSync
  mock.method(mutableProcess, 'execFileSync', ((...args: Parameters<typeof execFileSync>) => {
    if (Array.isArray(args[1]) && args[1][0] === 'ls-files') return 'incomplete index'
    return original(...args)
  }) as typeof execFileSync)
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
}))

test('content read failure makes optional capture unusable as a current receipt', () => fixture((root) => {
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  mock.method(mutableFs, 'openSync', () => { throw Object.assign(new Error('unreadable input'), { code: 'EACCES' }) })
  syncBuiltinESMExports()
  assert.throws(() => repositoryRevision(root), /tree cannot be established/)
  const unknown = repositoryRevision(root, false)
  assert.equal(unknown.gitCommitHash, null)
  assert.equal(RevisionManager.isReceiptStaleSync({
    receiptId: 'fixture', command: 'check', exitCode: 0, boundRevision: unknown, stale: false,
  }, root).stale, true)
}))

test('physical root identity prevents repository proof reuse at a different root', () => fixture((first) => fixture((second) => {
  // Copy the immutable identity: the same HEAD and bytes at another root still
  // belong to a separate measurement environment.
  fs.rmSync(join(second, '.git'), { recursive: true })
  fs.cpSync(join(first, '.git'), join(second, '.git'), { recursive: true })
  const before = repositoryRevision(first)
  const after = repositoryRevision(second)
  assert.equal(before.gitCommitHash, after.gitCommitHash)
  assert.equal(compareRevisions(before, after).stale, true)
})))

test('a parent swapped during file opening cannot read outside bytes', { skip: platform() === 'win32' }, () => fixture((root, git) => {
  fs.mkdirSync(join(root, 'src'))
  fs.writeFileSync(join(root, 'src', 'input.txt'), 'input\n')
  git(['add', 'src/input.txt'])
  git(['commit', '-q', '-m', 'parent race fixture'])
  const outside = fs.mkdtempSync(join(tmpdir(), 'babel-physical-race-'))
  try {
    fs.writeFileSync(join(outside, 'input.txt'), 'other\n')
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const open = mutableFs.openSync
    const read = mutableFs.readSync
    let outsideDescriptor: number | undefined
    let readOutside = false
    mock.method(mutableFs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      if (resolve(String(args[0])) === join(root, 'src', 'input.txt')) {
        fs.renameSync(join(root, 'src'), join(root, 'original-src'))
        fs.symlinkSync(outside, join(root, 'src'))
        outsideDescriptor = open(...args)
        return outsideDescriptor
      }
      return open(...args)
    }) as typeof fs.openSync)
    mock.method(mutableFs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] === outsideDescriptor) readOutside = true
      return read(...args)
    }) as typeof fs.readSync)
    syncBuiltinESMExports()
    assert.throws(() => repositoryRevision(root), /tree cannot be established/)
    assert.equal(readOutside, false)
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
}))

test('file scope admits every named credential path before reading any named input', () => fixture((root) => {
  fs.writeFileSync(join(root, '.env'), 'public synthetic fixture\n')
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const read = mutableFs.readFileSync
  let readInput = false
  mock.method(mutableFs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
    readInput = true
    return read(...args)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
  assert.throws(() => RevisionManager.computeRevisionSync(root, ['tracked.txt', '.env']), /credential/)
  assert.equal(readInput, false)
}))

test('a tracked reserved object-key filename remains physically bound with hidden Git edits', () => fixture((root, git) => {
  fs.writeFileSync(join(root, '__proto__'), 'baseline\n')
  git(['add', '__proto__'])
  git(['commit', '-q', '-m', 'reserved filename fixture'])
  git(['update-index', '--skip-worktree', '__proto__'])
  const before = repositoryRevision(root)
  fs.writeFileSync(join(root, '__proto__'), 'concealed\n')
  assert.equal(git(['status', '--porcelain']), '')
  assert.equal(compareRevisions(before, repositoryRevision(root)).stale, true)
}))

test('reserved object-key directory names cannot disappear from physical type evidence', () => fixture((root) => {
  const before = repositoryRevision(root)
  fs.mkdirSync(join(root, '__proto__'))
  const withDirectory = repositoryRevision(root)
  assert.equal(compareRevisions(before, withDirectory).stale, true)
  fs.rmdirSync(join(root, '__proto__'))
  fs.writeFileSync(join(root, '__proto__'), 'physical file\n')
  assert.equal(compareRevisions(withDirectory, repositoryRevision(root)).stale, true)
}))

test('named file evidence preserves reserved keys for currency and refuses unsupported certification', () => fixture((root) => {
  fs.writeFileSync(join(root, '__proto__'), 'baseline\n')
  const revision = () => RevisionManager.computeRevisionSync(root, ['__proto__'], { git_binding: 'required' })
  const before = revision()
  assert.equal(Object.hasOwn(before.fileHashes, '__proto__'), true)
  // The installed record schema deliberately omits __proto__ during parsing.
  // Currency still measures it, while certification must refuse that omission.
  assert.notEqual(validateRevisionBoundReceipt({
    receiptId: 'fixture', command: 'check', exitCode: 0, boundRevision: before, stale: false,
  }).length, 0)
  fs.writeFileSync(join(root, '__proto__'), 'modified\n')
  assert.equal(compareRevisions(before, revision()).stale, true)
}))
