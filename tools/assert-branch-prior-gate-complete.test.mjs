// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PUBLIC_RELEASE_GATE_WORKFLOW_ID,
  PUBLIC_RELEASE_GATE_MAX_PAGES,
  assertBranchPriorGateComplete,
  collectPublicReleaseGateRuns,
  evaluatePublishedHeadGate,
  gitLsRemoteExact,
  parseGithubRepoFromRemote,
  parseLsRemoteOutput,
} from './assert-branch-prior-gate-complete.mjs'

const REMOTE = 'origin'
const REPO = 'gthgomez/Babel'
const BRANCH = 'cursor/test-branch'
const REMOTE_REF = `refs/heads/${BRANCH}`
const TIP = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

function lsRemoteHeadOk() {
  return { present: true, sha: 'a'.repeat(40), status: 0 }
}

function lsRemoteBranchAbsent() {
  return { present: false, sha: null, status: 2 }
}

function lsRemoteBranchPresent(sha = TIP) {
  return { present: true, sha, status: 0 }
}

function makeExistingBranchDeps(overrides = {}) {
  const ghPages = overrides.ghPages ?? [{ workflow_runs: [] }]
  let ghCall = 0
  return {
    git: (root, args) => {
      if (args[0] === 'symbolic-ref') return BRANCH
      if (args[0] === 'remote' && args[1] === 'get-url') return `git@github.com:${REPO}.git`
      if (args[0] === 'fetch') return ''
      if (args[0] === 'rev-parse' && args[1] === `${REMOTE}/${BRANCH}`) {
        return overrides.tipAfterFetch ?? TIP
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    },
    lsRemote: (root, remote, ref) => {
      if (remote !== REMOTE) throw new Error('wrong remote')
      if (ref === 'HEAD') return lsRemoteHeadOk()
      if (ref === REMOTE_REF) {
        return overrides.branchProbe ?? lsRemoteBranchPresent()
      }
      throw new Error(`unexpected ls-remote ref ${ref}`)
    },
    ghGet: () => {
      const page = ghPages[ghCall]
      if (!page) throw new Error('ghGet called too many times')
      ghCall += 1
      if (overrides.ghThrow) throw new Error('gh api failure')
      return page
    },
    ...overrides.deps,
  }
}

describe('assert-branch-prior-gate-complete', () => {
  it('parses github ssh and https remotes without credentials', () => {
    assert.equal(parseGithubRepoFromRemote('git@github.com:gthgomez/Babel.git'), REPO)
    assert.equal(parseGithubRepoFromRemote('https://github.com/gthgomez/Babel'), REPO)
  })

  it('sanitizes embedded credentials on github https remotes', () => {
    assert.equal(
      parseGithubRepoFromRemote('https://user:token@github.com/gthgomez/Babel.git'),
      REPO,
    )
    assert.throws(() => parseGithubRepoFromRemote('https://gitlab.com/gthgomez/Babel.git'))
  })

  it('parses ls-remote lines and rejects malformed output', () => {
    assert.deepEqual(parseLsRemoteOutput(`${TIP}\t${REMOTE_REF}`), [
      { sha: TIP, ref: REMOTE_REF },
    ])
    assert.throws(() => parseLsRemoteOutput('not-a-sha\trefs/heads/x'), /malformed ls-remote/)
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

  it('allows true first publication when remote branch ref is absent with empty gate history', () => {
    const root = process.cwd()
    assert.doesNotThrow(() =>
      assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
        branchProbe: lsRemoteBranchAbsent(),
        ghPages: [{ workflow_runs: [] }],
      })),
    )
  })

  it('blocks absent remote ref when Public Release Gate history exists on the branch', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [
            {
              workflow_runs: [
                {
                  id: 1,
                  status: 'completed',
                  head_sha: TIP,
                  workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
                  name: 'Public Release Gate',
                },
              ],
            },
          ],
        })),
      /absent but Public Release Gate history exists/,
    )
  })

  it('fails closed when remote reachability probe fails', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, {
          git: (r, args) => {
            if (args[0] === 'symbolic-ref') return BRANCH
            if (args[0] === 'remote') return `git@github.com:${REPO}.git`
            throw new Error('unexpected git')
          },
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return { present: false, sha: null, status: 128 }
            return lsRemoteBranchAbsent()
          },
          ghGet: () => ({ workflow_runs: [] }),
        }),
      /reachability probe failed/,
    )
  })

  it('fails closed on branch ls-remote auth or network errors', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, {
          git: (r, args) => {
            if (args[0] === 'symbolic-ref') return BRANCH
            if (args[0] === 'remote') return `git@github.com:${REPO}.git`
            throw new Error('unexpected git')
          },
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return lsRemoteHeadOk()
            throw new Error('[pre-push] branch gate preflight: remote ref probe failed (auth or network)')
          },
          ghGet: () => ({ workflow_runs: [] }),
        }),
      /remote ref probe failed/,
    )
  })

  it('fails closed when ls-remote returns an unexpected ref binding', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, {
          git: (r, args) => {
            if (args[0] === 'symbolic-ref') return BRANCH
            if (args[0] === 'remote') return `git@github.com:${REPO}.git`
            throw new Error('unexpected git')
          },
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return lsRemoteHeadOk()
            if (ref === REMOTE_REF) {
              throw new Error(
                '[pre-push] branch gate preflight: unexpected ls-remote ref binding',
              )
            }
            throw new Error('unexpected ref')
          },
          ghGet: () => ({ workflow_runs: [] }),
        }),
      /unexpected ls-remote ref binding/,
    )
  })

  it('fails closed when GitHub workflow run payload is malformed', () => {
    const root = process.cwd()
    assert.throws(() =>
      assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
        ghPages: [{}],
      })),
    )
  })

  it('fails closed when gh api errors during gate history fetch', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghThrow: true,
        })),
      /gh api failure/,
    )
  })

  it('fails closed on incomplete pagination for first publication', () => {
    const root = process.cwd()
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      status: 'completed',
      head_sha: 'b'.repeat(40),
      workflow_id: 999,
      name: 'Auxiliary',
    }))
    const pages = Array.from({ length: PUBLIC_RELEASE_GATE_MAX_PAGES }, () => ({
      workflow_runs: fullPage,
    }))
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: pages,
        })),
      /incomplete Public Release Gate history pagination/,
    )
  })

  it('fails closed on remote tip race between ls-remote and fetch', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          tipAfterFetch: 'c'.repeat(40),
        })),
      /remote tip changed during gate preflight/,
    )
  })

  it('blocks pending Public Release Gate on existing published head', () => {
    const root = process.cwd()
    const sha = 'a7f61057b500d4bb8da067bc96c7232486aed3f9'
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchPresent(sha),
          tipAfterFetch: sha,
          ghPages: [
            {
              workflow_runs: [
                {
                  id: 39252099671,
                  status: 'in_progress',
                  head_sha: sha,
                  workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
                  name: 'Public Release Gate',
                },
              ],
            },
          ],
        })),
      /is in_progress/,
    )
  })

  it('allows completed Public Release Gate on existing published head', () => {
    const root = process.cwd()
    const sha = '9b4a513453cf0814b40df658ca0f13189fcd2004'
    assert.doesNotThrow(() =>
      assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
        branchProbe: lsRemoteBranchPresent(sha),
        tipAfterFetch: sha,
        ghPages: [
          {
            workflow_runs: [
              {
                id: 39250306347,
                status: 'completed',
                head_sha: sha,
                workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
                name: 'Public Release Gate',
              },
            ],
          },
        ],
      })),
    )
  })

  it('fails closed on detached HEAD', () => {
    const root = process.cwd()
    assert.throws(() =>
      assertBranchPriorGateComplete(root, REMOTE, {
        git: () => '',
        ghGet: () => ({ workflow_runs: [] }),
      }),
    )
  })

  it('collectPublicReleaseGateRuns stops early for existing head when published tip is found', () => {
    const sha = TIP
    let calls = 0
    const runs = collectPublicReleaseGateRuns(REPO, BRANCH, () => {
      calls += 1
      return {
        workflow_runs: [
          { id: 1, head_sha: sha, workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID, name: 'Public Release Gate' },
        ],
      }
    }, { publishedHeadSha: sha, requireCompletePagination: false })
    assert.equal(calls, 1)
    assert.equal(runs.length, 1)
  })
})
