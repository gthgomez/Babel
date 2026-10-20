// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PUBLIC_RELEASE_GATE_WORKFLOW_ID,
  PUBLIC_RELEASE_GATE_MAX_PAGES,
  assertBranchPriorGateComplete,
  collectPublicReleaseGateRuns,
  evaluatePublishedHeadGate,
  parseGithubRepoFromRemote,
  parseLsRemoteOutput,
  resolveGithubRepoForGate,
  assertRemotePushFetchRepoAligned,
  validateWorkflowRunsPage,
} from './assert-branch-prior-gate-complete.mjs'

const REMOTE = 'origin'
const REPO = 'gthgomez/Babel'
const BRANCH = 'cursor/test-branch'
const REMOTE_REF = `refs/heads/${BRANCH}`
const TIP = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

function gateRun(overrides = {}) {
  return {
    id: 1,
    status: 'completed',
    head_sha: TIP,
    workflow_id: PUBLIC_RELEASE_GATE_WORKFLOW_ID,
    name: 'Public Release Gate',
    head_branch: BRANCH,
    ...overrides,
  }
}

function gateRunPage(runs, totalCount = runs.length) {
  return { workflow_runs: runs, total_count: totalCount }
}

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
  const ghPages = overrides.ghPages ?? [gateRunPage([])]
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
      if (overrides.lsRemote) {
        return overrides.lsRemote(root, remote, ref)
      }
      if (remote !== REMOTE) throw new Error('wrong remote')
      if (ref === 'HEAD') return lsRemoteHeadOk()
      if (ref === REMOTE_REF) {
        return overrides.branchProbe ?? lsRemoteBranchPresent()
      }
      throw new Error(`unexpected ls-remote ref ${ref}`)
    },
    ghGet: (repo, query) => {
      if (repo !== REPO) {
        throw new Error(`ghGet bound to wrong repository: ${repo}`)
      }
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

  it('resolveGithubRepoForGate binds only to the configured remote URL', () => {
    const root = process.cwd()
    const repo = resolveGithubRepoForGate(root, REMOTE, (r, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return 'git@github.com:gthgomez/Babel.git'
      }
      throw new Error('unexpected git')
    })
    assert.equal(repo, REPO)
  })

  it('fails closed on unparseable remote URL without gh default-repository fallback', () => {
    const root = process.cwd()
    let ghWorkflowQuery = false
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, {
          git: (r, args) => {
            if (args[0] === 'symbolic-ref') return BRANCH
            if (args[0] === 'remote' && args[1] === 'get-url') {
              return 'https://example.com/not-github.git'
            }
            throw new Error('unexpected git')
          },
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return lsRemoteHeadOk()
            return lsRemoteBranchAbsent()
          },
          ghGet: () => {
            ghWorkflowQuery = true
            return { workflow_runs: [] }
          },
        }),
      /not a github.com repository URL/,
    )
    assert.equal(ghWorkflowQuery, false)
  })

  it('does not authorize first publication via an unrelated default gh repository', () => {
    const root = process.cwd()
    const configuredRepo = 'gthgomez/Babel'
    const wrongDefaultRepo = 'other-org/wrong-default'
    let workflowRepo = null
    assert.doesNotThrow(() =>
      assertBranchPriorGateComplete(root, REMOTE, {
        git: (r, args) => {
          if (args[0] === 'symbolic-ref') return BRANCH
          if (args[0] === 'remote' && args[1] === 'get-url') {
            return `git@github.com:${configuredRepo}.git`
          }
          throw new Error('unexpected git')
        },
        lsRemote: (r, remote, ref) => {
          if (ref === 'HEAD') return lsRemoteHeadOk()
          if (ref === REMOTE_REF) return lsRemoteBranchAbsent()
          throw new Error('unexpected ref')
        },
        ghGet: (repo) => {
          workflowRepo = repo
          if (repo === wrongDefaultRepo) {
            return { workflow_runs: [] }
          }
          if (repo === configuredRepo) {
            return { workflow_runs: [], total_count: 0 }
          }
          throw new Error(`unexpected workflow repo ${repo}`)
        },
      }),
    )
    assert.equal(workflowRepo, configuredRepo)
    assert.notEqual(workflowRepo, wrongDefaultRepo)
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
        ghPages: [gateRunPage([])],
      })),
    )
  })

  it('blocks absent remote ref when Public Release Gate history exists on the branch', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [gateRunPage([gateRun()], 1)],
        })),
      /absent but Public Release Gate history exists/,
    )
  })

  it('treats any validated workflow-endpoint row as gate history without producer name matching', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [
            gateRunPage(
              [{ id: 1, status: 'completed', head_sha: TIP, head_branch: BRANCH }],
              1,
            ),
          ],
        })),
      /absent but Public Release Gate history exists/,
    )
  })

  it('fails closed on missing total_count for first-publication history proof', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [{ workflow_runs: [] }],
        })),
      /missing Public Release Gate workflow run total_count/,
    )
  })

  it('fails closed on null or non-integer total_count for first-publication history proof', () => {
    const root = process.cwd()
    for (const total_count of [null, 1.5, -1, Number.NaN]) {
      assert.throws(
        () =>
          assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
            branchProbe: lsRemoteBranchAbsent(),
            ghPages: [{ workflow_runs: [], total_count }],
          })),
        /malformed Public Release Gate workflow run total_count|missing Public Release Gate workflow run total_count/,
      )
    }
  })

  it('fails closed on malformed workflow run entries instead of granting no-history', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [{ workflow_runs: [{}], total_count: 0 }],
        })),
      /malformed workflow run entry/,
    )
  })

  it('fails closed when total_count disagrees with returned workflow rows', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [gateRunPage([gateRun()], 2)],
        })),
      /incomplete Public Release Gate workflow run evidence/,
    )
  })

  it('fails closed on duplicate workflow run ids across pages', () => {
    const seenRunIds = new Set(['99'])
    assert.throws(
      () =>
        validateWorkflowRunsPage(gateRunPage([gateRun({ id: 99 })]), {
          branch: BRANCH,
          repo: REPO,
          page: 2,
          seenRunIds,
        }),
      /duplicate workflow run page/,
    )
  })

  it('fails closed when remote branch ref appears after workflow history lookup', () => {
    const root = process.cwd()
    let branchRefProbes = 0
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchAbsent(),
          ghPages: [gateRunPage([])],
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return lsRemoteHeadOk()
            if (ref === REMOTE_REF) {
              branchRefProbes += 1
              return branchRefProbes === 1 ? lsRemoteBranchAbsent() : lsRemoteBranchPresent()
            }
            throw new Error('unexpected ref')
          },
        })),
      /remote ref appeared during gate preflight/,
    )
  })

  it('fails closed on workflow run branch binding mismatch', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        collectPublicReleaseGateRuns(
          REPO,
          BRANCH,
          () => gateRunPage([gateRun({ head_branch: 'other-branch' })]),
          { requireCompletePagination: true },
        ),
      /branch binding mismatch/,
    )
  })

  it('fails closed on workflow run repository binding mismatch', () => {
    assert.throws(
      () =>
        collectPublicReleaseGateRuns(
          REPO,
          BRANCH,
          () =>
            gateRunPage([
              gateRun({ repository: { full_name: 'other-org/wrong-default' } }),
            ]),
          { requireCompletePagination: true },
        ),
      /repository binding mismatch/,
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
    const pages = Array.from({ length: PUBLIC_RELEASE_GATE_MAX_PAGES }, (_, pageIndex) => {
      const fullPage = Array.from({ length: 100 }, (_, i) =>
        gateRun({ id: pageIndex * 100 + i + 1, head_sha: 'b'.repeat(40) }),
      )
      return gateRunPage(fullPage, PUBLIC_RELEASE_GATE_MAX_PAGES * 100)
    })
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

  it('fails closed when existing remote tip changes after workflow history lookup', () => {
    const root = process.cwd()
    const sha = TIP
    let branchRefProbes = 0
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, makeExistingBranchDeps({
          branchProbe: lsRemoteBranchPresent(sha),
          tipAfterFetch: sha,
          ghPages: [gateRunPage([], 0)],
          lsRemote: (r, remote, ref) => {
            if (ref === 'HEAD') return lsRemoteHeadOk()
            if (ref === REMOTE_REF) {
              branchRefProbes += 1
              return branchRefProbes === 1
                ? lsRemoteBranchPresent(sha)
                : lsRemoteBranchPresent('e'.repeat(40))
            }
            throw new Error('unexpected ref')
          },
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
            gateRunPage([
              gateRun({
                id: 39252099671,
                status: 'in_progress',
                head_sha: sha,
                head_branch: BRANCH,
              }),
            ], 1),
          ],
        })),
      /is in_progress/,
    )
  })

  it('allows existing-head early stop when page is full but total_count exceeds fetched rows', () => {
    const root = process.cwd()
    const sha = TIP
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      gateRun({
        id: i + 1,
        head_sha: i === 50 ? sha : 'b'.repeat(40),
      }),
    )
    let ghCalls = 0
    assert.doesNotThrow(() =>
      assertBranchPriorGateComplete(root, REMOTE, {
        ...makeExistingBranchDeps({
          branchProbe: lsRemoteBranchPresent(sha),
          tipAfterFetch: sha,
        }),
        ghGet: (repo) => {
          ghCalls += 1
          if (repo !== REPO) throw new Error('wrong repo')
          return gateRunPage(fullPage, 150)
        },
      }),
    )
    assert.equal(ghCalls, 1)
  })

  it('fails closed when pushurl targets a different repository than fetch url', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertBranchPriorGateComplete(root, REMOTE, {
          ...makeExistingBranchDeps({ branchProbe: lsRemoteBranchAbsent() }),
          configGetAll: () => ['git@github.com:other-org/other-repo.git'],
        }),
      /push destination does not match fetch remote repository/,
    )
  })

  it('fails closed on ambiguous multiple pushurl destinations', () => {
    const root = process.cwd()
    assert.throws(
      () =>
        assertRemotePushFetchRepoAligned(
          root,
          REMOTE,
          (r, args) => {
            if (args[0] === 'remote' && args[1] === 'get-url') {
              return `git@github.com:${REPO}.git`
            }
            throw new Error('unexpected git')
          },
          () => [
            'git@github.com:gthgomez/Babel.git',
            'git@github.com:other-org/other-repo.git',
          ],
        ),
      /ambiguous push destination/,
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
          gateRunPage([
            gateRun({
              id: 39250306347,
              head_sha: sha,
              head_branch: BRANCH,
            }),
          ], 1),
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
      return gateRunPage([gateRun({ id: 1, head_sha: sha })], 1)
    }, { publishedHeadSha: sha, requireCompletePagination: false })
    assert.equal(calls, 1)
    assert.equal(runs.length, 1)
  })
})
