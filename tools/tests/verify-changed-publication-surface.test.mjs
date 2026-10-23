import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPublicationFrontierAllowsPush,
  describeHookOwnership,
  diagnoseBranchPublicationFrontier,
  queryIsAncestor,
} from '../verify-changed-publication-surface.mjs'
import { parsePrePushRecordLine } from '../validate-push-candidates.mjs'
import { coveredPaths } from '../policy-integrity-manifest.mjs'
import { dirname } from 'node:path'

const local = 'a'.repeat(40)
const prev = 'b'.repeat(40)
const zeros = '0'.repeat(40)

test('parsePrePushRecordLine accepts revision expressions and deletion records', () => {
  assert.deepEqual(parsePrePushRecordLine(`refs/heads/x ${local} refs/heads/x ${prev}`), {
    localRef: 'refs/heads/x', localSha: local, remoteRef: 'refs/heads/x', remoteSha: prev, isDelete: false,
  })
  assert.deepEqual(parsePrePushRecordLine(`HEAD ${local} refs/heads/main ${zeros}`), {
    localRef: 'HEAD', localSha: local, remoteRef: 'refs/heads/main', remoteSha: zeros, isDelete: false,
  })
  assert.deepEqual(parsePrePushRecordLine(`HEAD~1 ${local} refs/heads/main ${prev}`), {
    localRef: 'HEAD~1', localSha: local, remoteRef: 'refs/heads/main', remoteSha: prev, isDelete: false,
  })
  assert.deepEqual(parsePrePushRecordLine(`(delete) ${zeros} refs/tags/v1.0 ${prev}`), {
    localRef: '(delete)', localSha: zeros, remoteRef: 'refs/tags/v1.0', remoteSha: prev, isDelete: true,
  })
})

test('parsePrePushRecordLine rejects malformed remote ref and shas', () => {
  assert.throws(() => parsePrePushRecordLine(`HEAD ${local} main ${prev}`), /malformed push record/)
  assert.throws(() => parsePrePushRecordLine(`HEAD short refs/heads/x ${prev}`), /malformed push sha/)
  assert.throws(() => parsePrePushRecordLine(`HEAD ${local} refs/heads/x short`), /malformed push sha/)
  assert.throws(() => parsePrePushRecordLine(`HEAD ${local} refs/heads/x`), /malformed push record/)
})

test('describeHookOwnership reports configured label only; execution always unverified', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hook-ownership-'))
  try {
    spawnSync('git', ['-C', root, 'init', '-q'], { windowsHide: true })
    assert.deepEqual(describeHookOwnership(root), { hooksPath: 'unset', hookExecutionVerified: false })
    spawnSync('git', ['-C', root, 'config', 'core.hooksPath', '.githooks'], { windowsHide: true })
    const report = describeHookOwnership(root)
    assert.equal(report.hooksPath, 'repo:.githooks')
    assert.equal(report.hookExecutionVerified, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diagnoseBranchPublicationFrontier reports local_ahead vs aligned tips', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-frontier-'))
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  try {
    git('init', '-q')
    git('commit', '--allow-empty', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-qm', 'two')
    const two = git('rev-parse', 'HEAD')
    const bare = mkdtempSync(join(tmpdir(), 'babel-frontier-remote-'))
    spawnSync('git', ['init', '--bare', '-q', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'push', '-q', 'origin', `HEAD:refs/heads/feature`], { windowsHide: true })
    git('reset', '--hard', one)
    const behind = diagnoseBranchPublicationFrontier(root, 'origin', 'feature')
    assert.equal(behind.status, 'remote_ahead')
    assert.equal(behind.remoteTip, two)
    assert.equal(behind.localSha, one)
    git('reset', '--hard', two)
    git('commit', '--allow-empty', '-qm', 'three')
    const ahead = diagnoseBranchPublicationFrontier(root, 'origin', 'feature')
    assert.equal(ahead.status, 'local_ahead')
    assert.equal(ahead.remoteTip, two)
    git('reset', '--hard', two)
    assert.equal(diagnoseBranchPublicationFrontier(root, 'origin', 'feature').status, 'aligned')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing ancestry objects yield unknown, not proven divergence', () => {
  const bare = mkdtempSync(join(tmpdir(), 'babel-frontier-unknown-remote-'))
  const publisher = mkdtempSync(join(tmpdir(), 'babel-frontier-unknown-publisher-'))
  const root = mkdtempSync(join(tmpdir(), 'babel-frontier-unknown-'))
  const gitIn = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  try {
    spawnSync('git', ['init', '--bare', '-q', bare], { windowsHide: true })
    gitIn(publisher, 'init', '-q')
    gitIn(publisher, 'commit', '--allow-empty', '-qm', 'remote-only')
    const remoteTip = gitIn(publisher, 'rev-parse', 'HEAD')
    spawnSync('git', ['-C', publisher, 'push', '-q', bare, 'HEAD:refs/heads/feature'], { windowsHide: true })
    gitIn(root, 'init', '-q')
    gitIn(root, 'commit', '--allow-empty', '-qm', 'local-only')
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'checkout', '-qb', 'feature'], { windowsHide: true })
    assert.equal(queryIsAncestor(root, gitIn(root, 'rev-parse', 'HEAD'), remoteTip), null)
    const report = diagnoseBranchPublicationFrontier(root, 'origin', 'feature')
    assert.equal(report.status, 'unknown')
    assert.equal(report.remoteTip, remoteTip)
    assert.notEqual(report.status, 'diverged')
  } finally {
    rmSync(bare, { recursive: true, force: true })
    rmSync(publisher, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI --candidate requires HEAD and runs frontier before success', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-publication-cli-'))
  const helper = fileURLToPath(new URL('../verify-changed-publication-surface.mjs', import.meta.url))
  const manifestTool = fileURLToPath(new URL('../policy-integrity-manifest.mjs', import.meta.url))
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${join(root, 'hooks')}`, '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  try {
    for (const path of coveredPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      copyFileSync(fileURLToPath(new URL('../../' + path, import.meta.url)), join(root, path))
    }
    spawnSync(process.execPath, [manifestTool, 'generate', '--repo-root', root], { windowsHide: true })
    git('init', '-q')
    git('add', '--all')
    git('commit', '-qm', 'baseline')
    const head = git('rev-parse', 'HEAD')
    const bare = mkdtempSync(join(tmpdir(), 'babel-publication-cli-remote-'))
    spawnSync('git', ['init', '--bare', '-q', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'checkout', '-qb', 'feature'], { windowsHide: true })
    const mismatch = spawnSync(process.execPath, [helper, '--candidate', 'b'.repeat(40)], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /must match current HEAD/)
    const ok = spawnSync(process.execPath, [helper, '--candidate', head], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stderr, /frontier complete/)
    assert.match(ok.stderr, /status=unpublished/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assertPublicationFrontierAllowsPush fails on proven remote_ahead', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-frontier-block-'))
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  try {
    git('init', '-q')
    git('commit', '--allow-empty', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-qm', 'two')
    const bare = mkdtempSync(join(tmpdir(), 'babel-frontier-block-remote-'))
    spawnSync('git', ['init', '--bare', '-q', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', bare], { windowsHide: true })
    spawnSync('git', ['-C', root, 'push', '-q', 'origin', 'HEAD:refs/heads/feature'], { windowsHide: true })
    git('reset', '--hard', one)
    spawnSync('git', ['-C', root, 'checkout', '-B', 'feature'], { windowsHide: true })
    assert.throws(() => assertPublicationFrontierAllowsPush(root), /remote publication frontier differs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
