// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PUBLIC_RELEASE_GATE_WORKFLOW_ID,
  assertBranchPriorGateComplete,
  evaluatePublishedHeadGate,
  parseGithubRepoFromRemote,
} from './assert-branch-prior-gate-complete.mjs'

describe('assert-branch-prior-gate-complete', () => {
  it('parses github ssh and https remotes without credentials', () => {
    assert.equal(parseGithubRepoFromRemote('git@github.com:gthgomez/Babel.git'), 'gthgomez/Babel')
    assert.equal(parseGithubRepoFromRemote('https://github.com/gthgomez/Babel'), 'gthgomez/Babel')
  })

  it('sanitizes embedded credentials on github https remotes', () => {
    assert.equal(
      parseGithubRepoFromRemote('https://user:token@github.com/gthgomez/Babel.git'),
      'gthgomez/Babel',
    )
    assert.throws(() => parseGithubRepoFromRemote('https://gitlab.com/gthgomez/Babel.git'))
  })

  it('blocks when Public Release Gate is in progress for published head', () => {
    const sha = 'a7f61057b500d4bb8da067bc96c7232486aed3f9'
    const verdict = evaluatePublishedHeadGate(
      [
        {
          id: 39252099671,
          status: 'in_progress',
          head_sha: sha,
          workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
          name: 'Public Release Gate',
        },
      ],
      sha,
    )
    assert.equal(verdict.allow, false)
  })

  it('allows when Public Release Gate completed for published head', () => {
    const sha = '9b4a513453cf0814b40df658ca0f13189fcd2004'
    const verdict = evaluatePublishedHeadGate(
      [
        {
          id: 39250306347,
          status: 'completed',
          head_sha: sha,
          workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
          name: 'Public Release Gate',
        },
      ],
      sha,
    )
    assert.equal(verdict.allow, true)
  })

  it('fails closed when only unrelated workflow runs exist for the published head', () => {
    const sha = 'abc123'
    const verdict = evaluatePublishedHeadGate(
      [{ id: 1, status: 'in_progress', head_sha: sha, workflow_id: 999, name: 'Auxiliary' }],
      sha,
      { branchHasAnyGateRuns: true },
    )
    assert.equal(verdict.allow, false)
  })

  it('allows first publication when the branch has no Public Release Gate history', () => {
    const sha = 'abc123'
    const verdict = evaluatePublishedHeadGate([], sha, { branchHasAnyGateRuns: false })
    assert.equal(verdict.allow, true)
  })

  it('fails closed on detached HEAD', () => {
    const root = process.cwd()
    assert.throws(() =>
      assertBranchPriorGateComplete(root, 'origin', {
        git: () => '',
        ghGet: () => ({ workflow_runs: [] }),
      }),
    )
  })
})
