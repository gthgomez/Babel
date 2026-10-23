import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { after, describe, mock, test, type TestContext } from 'node:test'

import { captureChatVerifierReceipt, captureCompletionWorkspaceRevisionHash, prepareKernelVerifierInput, refreshChatCompletionVerifierCurrency, shouldReuseCachedVerifierReceipt } from './chatEngineVerifierAdapter.js'
import { evaluateCompletionGateForEngine } from './completionGatePolicy.js'
import {
  bindChatVerifierReceipt,
  refreshChatVerifierReceiptStalenessSync,
  toExecutorVerifierReceipt,
} from '../evidence/chatRevisionBinding.js'

const temporaryRoots: string[] = []
const git = (root: string, args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

test('completion refresh checks each receipt object once per invocation and observes later changes', async () => {
  const root = project()
  const file = join(root, 'value.txt')
  writeFileSync(file, 'original\n')
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root, command: 'npm test', exitCode: 0, summary: 'green',
    mutationPaths: ['value.txt'], stdout: '# tests 1\n# skipped 0',
  })
  assert.ok(receipt)
  const other = structuredClone(receipt)
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const open = mutableFs.openSync
  let opens = 0
  mock.method(mutableFs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
    if (path === file) opens++
    return (open as (...values: unknown[]) => unknown)(path, ...args)
  }) as typeof fs.openSync)
  syncBuiltinESMExports()
  try {
    refreshChatCompletionVerifierCurrency({ projectRoot: root }, true, receipt, [])
    const singleOpens = opens
    assert.ok(singleOpens > 0, 'the real bound file is checked')
    opens = 0
    refreshChatCompletionVerifierCurrency({ projectRoot: root }, true, receipt, [receipt, receipt])
    assert.equal(opens, singleOpens, 'repeated aliases do not repeat filesystem proof')
    opens = 0
    refreshChatCompletionVerifierCurrency({ projectRoot: root }, true, receipt, [other])
    assert.equal(opens, singleOpens * 2, 'distinct receipt objects each retain their own proof')
    writeFileSync(file, 'changed\n')
    refreshChatCompletionVerifierCurrency({ projectRoot: root }, true, receipt, [receipt, other])
    assert.equal(receipt.stale, true)
    assert.equal(other.stale, true)
  } finally { mock.restoreAll(); syncBuiltinESMExports() }
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-green-nochange-verifier-'))
  temporaryRoots.push(root)
  return root
}

for (const repositoryScope of [false, true]) {
  test(`live completion hash uses the verifier's ${repositoryScope ? 'repository' : 'file-set'} scope`, async () => {
    const root = repositoryScope ? largeProject() : project()
    writeFileSync(join(root, 'changed.txt'), 'current\n')
    writeFileSync(join(root, 'dependency.txt'), 'original dependency\n')
    initializeGit(root)
    const receipt = await captureChatVerifierReceipt({
      projectRoot: root, command: 'npm test', exitCode: 0, summary: 'green',
      mutationPaths: ['changed.txt'], stdout: '# tests 1\n# skipped 0',
    })
    assert.ok(receipt)
    assert.equal(receipt.boundRevision?.scope?.kind, repositoryScope ? 'repository' : 'files')
    const captured = captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['changed.txt'], receipt)
    assert.equal(captured, receipt.boundRevision?.compositeTreeHash)
    assert.equal(
      captureCompletionWorkspaceRevisionHash({ projectRoot: root }, [join(root, 'changed.txt')], receipt), captured,
      'governed mutation events report absolute paths',
    )
    const kernel = prepareKernelVerifierInput(receipt, [receipt])
    const decide = (revisionHash: string | undefined) => evaluateCompletionGateForEngine({
      turnType: 'completion', taskIntent: 'execute', task: 'Fix changed.txt and run npm test before completing.',
      taskClass: 'general_swe', lastVerifierReceipt: receipt,
      executedVerifierLedger: kernel.executedVerifierLedger, verifierEvidenceErrors: kernel.verifierEvidenceErrors,
      requiredVerifierCommands: ['npm test'], projectTestCommands: ['npm test'],
      toolCallLog: [
        { tool: 'write_file', target: 'changed.txt', exit_code: 0, effect_status: 'confirmed_change' },
        { tool: 'test_run', target: 'npm test', exit_code: 0 },
      ],
      ...(revisionHash ? { currentWorkspaceRevisionHash: revisionHash } : {}),
    })
    assert.equal(decide(captured), 'allow')
    writeFileSync(join(root, 'dependency.txt'), 'changed dependency\n')
    const changed = captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['changed.txt'], receipt)
    assert.notEqual(
      changed, captured,
      'an unchanged edited file cannot hide a changed verifier input',
    )
    assert.equal(decide(changed), 'reject')
  })
}

test('live completion hash refuses missing scope and mutations outside a file receipt', async () => {
  const root = project()
  writeFileSync(join(root, 'checked.txt'), 'checked\n')
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root, command: 'npm test', exitCode: 0, summary: 'green',
    mutationPaths: ['checked.txt'], stdout: '# tests 1\n# skipped 0',
  })
  assert.ok(receipt?.boundRevision)
  assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['checked.txt'], null), undefined)
  const legacy = structuredClone(receipt)
  delete legacy.boundRevision!.scope
  assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['checked.txt'], legacy), undefined)
  writeFileSync(join(root, 'unbound.txt'), 'another mutation\n')
  assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['unbound.txt'], receipt), undefined)
  assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, [join(root, '..', 'outside.txt')], receipt), undefined)
  assert.throws(() => captureCompletionWorkspaceRevisionHash({ projectRoot: root }, ['../outside.txt'], receipt), /traverses the repository/)
  assert.throws(() => captureCompletionWorkspaceRevisionHash({}, ['checked.txt'], receipt), /explicit conversation scope or absolute project root/)
})

function createFileSymlink(t: TestContext, target: string, path: string): boolean {
  try { symlinkSync(target, path, 'file'); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '') && process.env['BABEL_REQUIRE_SYMLINK_FIXTURE'] !== '1') {
      t.skip('Windows file symlink creation unavailable; physical target rejection remains unqualified here')
      return false
    }
    throw error
  }
}

async function assertNoCredentialContentReads(projectRoot: string, mutation: string): Promise<void> {
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const originalRead = mutableFs.readFileSync
  const originalOpen = mutableFs.openSync
  let contentReads = 0
  mock.method(mutableFs, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    if (String(args[0]).startsWith(projectRoot)) contentReads++
    return originalRead(...args)
  })
  mock.method(mutableFs, 'openSync', (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]).startsWith(projectRoot)) contentReads++
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await captureChatVerifierReceipt({
        projectRoot, command: 'npm test', exitCode: 0, summary: 'green',
        mutationPaths: [mutation], stdout: '# tests 1\n# skipped 0',
    }) === null, true)
    assert.equal(contentReads, 0)
  } finally { mock.restoreAll(); syncBuiltinESMExports() }
}

test('credential mutation scope refuses lexical targets before content reads', async () => {
  const root = project()
  writeFileSync(join(root, '.env'), 'SYNTHETIC_CANARY')
  await assertNoCredentialContentReads(root, '.env')
})

test('credential mutation scope refuses physical aliases before content reads', async t => {
  const root = project()
  writeFileSync(join(root, '.env'), 'SYNTHETIC_CANARY')
  if (!createFileSymlink(t, join(root, '.env'), join(root, 'ordinary.txt'))) return
  await assertNoCredentialContentReads(root, 'ordinary.txt')
})

function initializeGit(root: string): void {
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'fixture@example.test'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) {
    const result = git(root, args)
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

after(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('green verifier receipts for inspected no-change tasks', { concurrency: false }, () => {
  test('empty file scope remains rejected without the explicit no-change route', async () => {
    const root = project()
    writeFileSync(join(root, 'verify.mjs'), 'console.log("green")\n')

    await assert.rejects(captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
    }), /Revision-bound file scope must not be empty/)
  })

  test('explicit green no-change receipt binds current dirty and untracked repository bytes', async () => {
    const root = project()
    writeFileSync(join(root, 'verify.mjs'), 'console.log("initial")\n')
    writeFileSync(join(root, 'tracked-input.txt'), 'baseline\n')
    initializeGit(root)
    writeFileSync(join(root, 'verify.mjs'), 'console.log("dirty before capture")\n')
    writeFileSync(join(root, 'untracked-input.txt'), 'untracked baseline\n')

    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.ok(receipt, 'a Git-backed repository scope can represent a green no-change verifier')
    assert.deepEqual(receipt.boundRevision?.scope, { kind: 'repository' })
    assert.ok(receipt.boundRevision?.gitCommitHash, 'the complete repository content binding has a Git baseline')

    writeFileSync(join(root, 'verify.mjs'), 'console.log("changed dirty input")\n')
    const trackedChange = refreshChatVerifierReceiptStalenessSync(root, receipt)
    assert.equal(trackedChange?.stale, true, 'dirty tracked bytes are bound, not only their Git status')

    const refreshed = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.ok(refreshed)
    writeFileSync(join(root, 'untracked-input.txt'), 'changed untracked input\n')
    const untrackedChange = refreshChatVerifierReceiptStalenessSync(root, refreshed)
    assert.equal(untrackedChange?.stale, true, 'existing untracked bytes are bound into repository scope')
  })

  test('repository-scoped green evidence is unavailable without content-bound Git state', async () => {
    const root = project()
    writeFileSync(join(root, 'verify.mjs'), 'console.log("green")\n')

    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.equal(receipt, null, 'a path-only fallback hash cannot authorize green completion')

    const unverified = await bindChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exit_code: 0,
      summary: 'ok',
      mutationPaths: [],
      scopeKind: 'repository',
    })
    assert.equal(unverified.boundRevision?.gitCommitHash, null)
    const adapted = toExecutorVerifierReceipt(unverified)
    assert.equal(adapted.ok, false, 'canonical evidence adaptation also rejects no-Git repository scope')
    if (!adapted.ok) assert.ok(adapted.errors.some((error) => /content-bound Git tree/i.test(error)))

    writeFileSync(join(root, 'verify.mjs'), 'console.log("changed after unverified receipt")\n')
    assert.equal(refreshChatVerifierReceiptStalenessSync(root, unverified)?.stale, true,
      'unknown repository content state is conservatively rejected at completion')
  })

  test('nested repository-scope receipt currency binds A→B changes inside the project only', async () => {
    const repositoryRoot = project()
    const projectRoot = join(repositoryRoot, 'packages', 'app')
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(projectRoot, 'checked.txt'), 'baseline\n')
    writeFileSync(join(repositoryRoot, 'outside.txt'), 'outside baseline\n')
    initializeGit(repositoryRoot)

    writeFileSync(join(projectRoot, 'checked.txt'), 'dirty A\n')
    const receipt = await captureChatVerifierReceipt({
      projectRoot,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.ok(receipt, 'nested Git projects can capture content-bound repository receipts')
    writeFileSync(join(projectRoot, 'checked.txt'), 'dirty B\n')
    assert.equal(refreshChatVerifierReceiptStalenessSync(projectRoot, receipt)?.stale, true,
      'currency refresh detects byte changes when a tracked file stays dirty')

    const freshReceipt = await captureChatVerifierReceipt({
      projectRoot,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: [],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.ok(freshReceipt)
    writeFileSync(join(repositoryRoot, 'outside.txt'), 'outside changed\n')
    assert.equal(refreshChatVerifierReceiptStalenessSync(projectRoot, freshReceipt)?.stale, false,
      'nested repository receipt currency excludes bytes outside the project root')
  })

  test('valid non-Git file-scoped verifier receipts remain adaptable', async () => {
    const root = project()
    writeFileSync(join(root, 'checked.txt'), 'checked bytes\n')
    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: ['checked.txt'],
    })
    assert.ok(receipt)
    assert.equal(receipt.boundRevision?.gitCommitHash, null)
    assert.deepEqual(receipt.boundRevision?.scope, { kind: 'files', paths: ['checked.txt'] })
    assert.equal(toExecutorVerifierReceipt(receipt).ok, true,
      'the Git requirement applies only to whole-repository scope')
  })

  test('the no-change option cannot convert nonempty mutation paths to repository scope', async () => {
    const root = project()
    writeFileSync(join(root, 'changed.txt'), 'current\n')
    initializeGit(root)

    const receipt = await captureChatVerifierReceipt({
      projectRoot: root,
      command: 'npm test',
      exitCode: 0,
      summary: 'ok',
      mutationPaths: ['changed.txt'],
      allowRepositoryScopeForGreenNoChange: true,
    })
    assert.ok(receipt)
    assert.deepEqual(receipt.boundRevision?.scope, { kind: 'files', paths: ['changed.txt'] })
  })
})


test('repository-scoped capture refuses divergent credential-class paths before content binding', async () => {
  const root = project()
  writeFileSync(join(root, 'input.txt'), 'public synthetic input\n')
  initializeGit(root)
  mkdirSync(join(root, 'secrets'))
  writeFileSync(join(root, 'secrets', 'fixture.txt'), 'synthetic private input\n')
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root, command: 'npm test', exitCode: 0, summary: 'green', mutationPaths: [],
    allowRepositoryScopeForGreenNoChange: true,
  })
  assert.equal(receipt === null, true)
})


function largeProject(): string {
  const root = project()
  for (let index = 0; index < 41; index++) writeFileSync(join(root, `aa${String(index).padStart(2, '0')}.txt`), 'baseline\n')
  return root
}

const freshLargeInput = (root: string) => ({
  projectRoot: root, command: 'npm test', exitCode: 0,
  summary: '# tests 1\n# skipped 0', stdout: '# tests 1\n# skipped 0', mutationPaths: ['aa00.txt'],
})

describe('complete fresh proof beyond the cache discovery file limit', { concurrency: false }, () => {
  test('41-file Git project keeps complete fresh proof current while refusing cache reuse', async () => {
    const root = largeProject()
    initializeGit(root)
    const receipt = await captureChatVerifierReceipt(freshLargeInput(root))
    assert.ok(receipt)
    assert.equal(refreshChatVerifierReceiptStalenessSync(root, receipt)?.stale, false)
    assert.equal(shouldReuseCachedVerifierReceipt(root, receipt), false)
    writeFileSync(join(root, 'aa40.txt'), 'changed outside mutation scope\n')
    assert.equal(refreshChatVerifierReceiptStalenessSync(root, receipt)?.stale, true)
  })

  test('ignored eligible inputs remain bound into fresh proof currency', async () => {
    const root = largeProject()
    writeFileSync(join(root, '.gitignore'), 'zzignored/\n')
    mkdirSync(join(root, 'zzignored'))
    writeFileSync(join(root, 'zzignored', 'input.txt'), 'ignored baseline\n')
    initializeGit(root)
    const receipt = await captureChatVerifierReceipt(freshLargeInput(root))
    assert.ok(receipt)
    assert.equal(refreshChatVerifierReceiptStalenessSync(root, receipt)?.stale, false)
    writeFileSync(join(root, 'zzignored', 'input.txt'), 'ignored changed\n')
    assert.equal(refreshChatVerifierReceiptStalenessSync(root, receipt)?.stale, true)
  })

  test('a symlink after41 ordinary files cannot gain fresh proof trust', async t => {
    const root = largeProject()
    const outside = project()
    writeFileSync(join(outside, 'input.txt'), 'outside baseline\n')
    if (!createFileSymlink(t, join(outside, 'input.txt'), join(root, 'zz-link.txt'))) return
    initializeGit(root)
    assert.equal(await captureChatVerifierReceipt(freshLargeInput(root)) === null, true)
  })

  test('large nonGit input still cannot obtain fallback authority', async () => {
    const root = largeProject()
    assert.equal(await captureChatVerifierReceipt(freshLargeInput(root)) === null, true)
  })

  test('metadata admission rejects unreadable inputs after41 files before content access', async () => {
    const root = largeProject()
    const unreadable = join(realpathSync.native(root), 'zz-unreadable.txt')
    writeFileSync(join(root, 'zz-unreadable.txt'), 'synthetic unavailable input\n')
    initializeGit(root)
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const access = mutableFs.accessSync
    const read = mutableFs.readFileSync
    const open = mutableFs.openSync
    let admissionDenied = false
    let contentReads = 0
    mock.method(mutableFs, 'accessSync', ((file: fs.PathLike, mode?: number) => {
      if (file === unreadable) {
        admissionDenied = true
        throw Object.assign(new Error('synthetic admission denial'), { code: 'EACCES' })
      }
      return access(file, mode)
    }) as typeof fs.accessSync)
    const isProjectPath = (file: unknown): boolean =>
      typeof file === 'string' && file.startsWith(`${realpathSync.native(root)}${sep}`)
    mock.method(mutableFs, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (isProjectPath(file)) contentReads++
      return (read as (...values: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.readFileSync)
    mock.method(mutableFs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
      if (isProjectPath(file)) contentReads++
      return (open as (...values: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    try {
      assert.equal(await captureChatVerifierReceipt(freshLargeInput(root)) === null, true)
      assert.equal(admissionDenied, true, 'the unreadable physical path is denied during metadata admission')
      assert.equal(contentReads, 0, 'metadata denial happens before any project content reads')
    } finally { mock.restoreAll(); syncBuiltinESMExports() }
  })

  test('ignored credential path after41 files is refused without opening any project content', async () => {
    const root = largeProject()
    writeFileSync(join(root, '.gitignore'), '.env\n')
    initializeGit(root)
    writeFileSync(join(root, '.env'), 'synthetic credential canary\n')
    const mutableFs = (fs as unknown as { default: typeof fs }).default
    const read = mutableFs.readFileSync
    const open = mutableFs.openSync
    let contentReads = 0
    mock.method(mutableFs, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(root)) contentReads++
      return (read as (...values: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.readFileSync)
    mock.method(mutableFs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(root)) contentReads++
      return (open as (...values: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    try {
      assert.equal(await captureChatVerifierReceipt(freshLargeInput(root)) === null, true)
      assert.equal(contentReads, 0)
    } finally { mock.restoreAll(); syncBuiltinESMExports() }
  })
})


test('physical credential-class project root is denied through a directory alias before content access', async () => {
  const privateRoot = join(project(), 'secrets', 'synthetic-project')
  mkdirSync(privateRoot, { recursive: true })
  for (let index = 0; index < 41; index++) writeFileSync(join(privateRoot, `aa${String(index).padStart(2, '0')}.txt`), 'public synthetic input\n')
  initializeGit(privateRoot)
  const alias = join(project(), 'alias')
  symlinkSync(privateRoot, alias, 'junction')
  const mutableFs = (fs as unknown as { default: typeof fs }).default
  const open = mutableFs.openSync
  let contentOpens = 0
  mock.method(mutableFs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
    if (typeof file === 'string' && (file.startsWith(alias) || file.startsWith(privateRoot))) contentOpens++
    return (open as (...values: unknown[]) => unknown)(file, ...args)
  }) as typeof fs.openSync)
  syncBuiltinESMExports()
  try {
    assert.equal(await captureChatVerifierReceipt(freshLargeInput(alias)) === null, true)
    assert.equal(contentOpens, 0)
  } finally { mock.restoreAll(); syncBuiltinESMExports() }
})
