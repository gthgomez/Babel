// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { assertBranchPriorGateComplete } from './assert-branch-prior-gate-complete.mjs'

describe('assert-branch-prior-gate-complete', () => {
  it('invokes gh api with GET method', () => {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
    const branch = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).stdout.trim()
    const remoteUrl = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).stdout.trim()
    const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i)
    assert.ok(match)
    const repo = match[1]
    const result = spawnSync(
      'gh',
      ['api', '--method', 'GET', `repos/${repo}/actions/runs`, '-f', `branch=${branch}`, '-f', 'per_page=1'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.ok(Array.isArray(payload.workflow_runs))
  })

  it('allows push when latest run is completed', () => {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
    assertBranchPriorGateComplete(root, 'origin')
  })
})
