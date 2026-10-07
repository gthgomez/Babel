import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { after, describe, test } from 'node:test'

import { captureChatVerifierReceipt } from './chatEngineVerifierAdapter.js'
import {
  bindChatVerifierReceipt,
  refreshChatVerifierReceiptStalenessSync,
  toExecutorVerifierReceipt,
} from '../evidence/chatRevisionBinding.js'

const temporaryRoots: string[] = []
const git = (root: string, args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-green-nochange-verifier-'))
  temporaryRoots.push(root)
  return root
}

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
