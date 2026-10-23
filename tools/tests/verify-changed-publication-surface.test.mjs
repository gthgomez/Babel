import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeHookOwnership, diagnoseBranchPublicationFrontier } from '../verify-changed-publication-surface.mjs'
import { parsePrePushRecordLine } from '../validate-push-candidates.mjs'

test('parsePrePushRecordLine matches git pre-push stdin field order', () => {
  const local = 'a'.repeat(40)
  const prev = 'b'.repeat(40)
  const parsed = parsePrePushRecordLine(`refs/heads/x ${local} refs/heads/x ${prev}`)
  assert.equal(parsed.localSha, local)
  assert.equal(parsed.remoteSha, prev)
  assert.equal(parsed.localRef, 'refs/heads/x')
})

test('describeHookOwnership never labels repo .githooks as host-managed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hook-ownership-'))
  try {
    spawnSync('git', ['-C', root, 'init', '-q'], { windowsHide: true })
    spawnSync('git', ['-C', root, 'config', 'core.hooksPath', '.githooks'], { windowsHide: true })
    const report = describeHookOwnership(root)
    assert.equal(report.hooksPath, 'repo:.githooks')
    assert.equal(report.babelHooksActive, true)
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
