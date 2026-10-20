// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLIC_RELEASE_GATE_WORKFLOW_ID = 258744217
export const PUBLIC_RELEASE_GATE_WORKFLOW_NAME = 'Public Release Gate'
export const PUBLIC_RELEASE_GATE_MAX_PAGES = 5

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

/** @returns {string} owner/repo */
export function parseGithubRepoFromRemote(remoteUrl) {
  const trimmed = remoteUrl.trim()
  if (!trimmed) throw new Error('[pre-push] origin URL is empty')
  const sanitized = trimmed.replace(/^https?:\/\/[^@/]+@github\.com\//i, 'https://github.com/')
  const ssh = sanitized.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (ssh) return ssh[1]
  const https = sanitized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (https) return https[1]
  throw new Error('[pre-push] origin is not a github.com repository URL')
}

/**
 * Resolve the GitHub repository for gate authorization from the named remote URL only.
 * Unparseable remotes fail closed; never substitute gh's default repository.
 */
export function resolveGithubRepoForGate(root, remote, gitFn) {
  const remoteUrl = gitFn(root, ['remote', 'get-url', remote])
  return parseGithubRepoFromRemote(remoteUrl)
}

/** Effective push destinations after url.*.pushInsteadOf (git remote get-url --push --all). */
export function gitRemoteGetPushUrlsAll(root, remote) {
  const result = spawnSync(
    'git',
    ['-C', root, 'remote', 'get-url', '--push', '--all', remote],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error || result.status !== 0) {
    throw new Error('[pre-push] branch gate preflight: push destination probe failed')
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Push must target the same GitHub repository as fetch for the named remote.
 * Requires exactly one effective push URL (no alternate-push); no URL values in errors.
 */
export function assertRemotePushFetchRepoAligned(
  root,
  remote,
  gitFn,
  getPushUrlsAll = gitRemoteGetPushUrlsAll,
) {
  const fetchRepo = resolveGithubRepoForGate(root, remote, gitFn)
  const pushUrls = getPushUrlsAll(root, remote)
  if (pushUrls.length !== 1) {
    throw new Error('[pre-push] branch gate preflight: ambiguous push destination for remote')
  }
  const pushRepo = parseGithubRepoFromRemote(pushUrls[0])
  if (pushRepo !== fetchRepo) {
    throw new Error(
      '[pre-push] branch gate preflight: push destination does not match fetch remote repository',
    )
  }
  return fetchRepo
}

export function parseRequiredTotalCount(value) {
  if (value === undefined || value === null) {
    throw new Error(
      '[pre-push] branch gate preflight: missing Public Release Gate workflow run total_count',
    )
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(
      '[pre-push] branch gate preflight: malformed Public Release Gate workflow run total_count',
    )
  }
  if (value < 0) {
    throw new Error(
      '[pre-push] branch gate preflight: malformed Public Release Gate workflow run total_count',
    )
  }
  return value
}

export function isPublicReleaseGateRun(run) {
  return (
    run.workflow_id === PUBLIC_RELEASE_GATE_WORKFLOW_ID ||
    run.name === PUBLIC_RELEASE_GATE_WORKFLOW_NAME
  )
}

/**
 * @returns {{ status: number, lines: Array<{ sha: string, ref: string }> }}
 */
export function parseLsRemoteOutput(stdout) {
  const lines = []
  for (const row of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = row.match(/^([0-9a-f]{40})\t(.+)$/)
    if (!match) {
      throw new Error('[pre-push] branch gate preflight: malformed ls-remote output')
    }
    lines.push({ sha: match[1], ref: match[2] })
  }
  return lines
}

/**
 * Probe an exact ref on a named remote. Exit code 2 means no matching ref (authenticated absence).
 */
export function gitLsRemoteExact(root, remote, ref) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-remote', '--exit-code', remote, ref],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error) {
    throw new Error('[pre-push] branch gate preflight: remote ref probe failed (network)')
  }
  const lines = parseLsRemoteOutput(result.stdout ?? '')
  if (result.status === 2) {
    if (lines.length > 0) {
      throw new Error('[pre-push] branch gate preflight: inconsistent ls-remote absence')
    }
    return { present: false, sha: null, status: 2 }
  }
  if (result.status !== 0) {
    throw new Error('[pre-push] branch gate preflight: remote ref probe failed (auth or network)')
  }
  if (lines.length !== 1 || lines[0].ref !== ref) {
    throw new Error('[pre-push] branch gate preflight: unexpected ls-remote ref binding')
  }
  return { present: true, sha: lines[0].sha, status: 0 }
}

export function evaluatePublishedHeadGate(workflowRuns, publishedHeadSha, options = {}) {
  const matching = workflowRuns.filter((run) => run.head_sha === publishedHeadSha)
  if (matching.length === 0) {
    if (options.branchHasAnyGateRuns === false) {
      return { allow: true, reason: 'no prior Public Release Gate on branch (first publication)' }
    }
    return {
      allow: false,
      reason: `no Public Release Gate run found for published head ${publishedHeadSha.slice(0, 7)}`,
    }
  }
  const active = matching.filter((run) => run.status !== 'completed')
  if (active.length > 0) {
    const first = active[0]
    return {
      allow: false,
      reason: `Public Release Gate run ${first.id} for ${publishedHeadSha.slice(0, 7)} is ${first.status}`,
      runId: first.id,
      status: first.status,
    }
  }
  return { allow: true, reason: 'Public Release Gate completed for published head', runs: matching }
}

const WORKFLOW_RUN_SHA_RE = /^[0-9a-f]{40}$/

function assertWorkflowRunShape(run, branch, repo) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('[pre-push] branch gate preflight: malformed workflow run entry')
  }
  const id = run.id
  if (
    id === undefined ||
    id === null ||
    (typeof id !== 'number' && typeof id !== 'string') ||
    String(id).length === 0
  ) {
    throw new Error('[pre-push] branch gate preflight: malformed workflow run entry')
  }
  if (typeof run.status !== 'string' || !run.status.trim()) {
    throw new Error('[pre-push] branch gate preflight: malformed workflow run entry')
  }
  if (typeof run.head_sha !== 'string' || !WORKFLOW_RUN_SHA_RE.test(run.head_sha)) {
    throw new Error('[pre-push] branch gate preflight: malformed workflow run entry')
  }
  if (run.head_branch !== undefined && run.head_branch !== branch) {
    throw new Error('[pre-push] branch gate preflight: workflow run branch binding mismatch')
  }
  const repository = run.repository
  if (repository && typeof repository === 'object' && typeof repository.full_name === 'string') {
    if (repository.full_name !== repo) {
      throw new Error('[pre-push] branch gate preflight: workflow run repository binding mismatch')
    }
  }
}

/**
 * Validate one workflow-runs API page from the workflow-specific endpoint.
 */
export function validateWorkflowRunsPage(payload, { branch, repo, page, seenRunIds }) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.workflow_runs)) {
    throw new Error(
      '[pre-push] branch gate preflight: malformed Public Release Gate workflow run list from GitHub',
    )
  }
  const totalCount = parseRequiredTotalCount(payload.total_count)
  const batch = payload.workflow_runs
  for (const run of batch) {
    assertWorkflowRunShape(run, branch, repo)
    const runId = String(run.id)
    if (seenRunIds.has(runId)) {
      throw new Error('[pre-push] branch gate preflight: duplicate workflow run page')
    }
    seenRunIds.add(runId)
  }
  if (totalCount !== null && page === 1 && totalCount === 0 && batch.length > 0) {
    throw new Error(
      '[pre-push] branch gate preflight: inconsistent Public Release Gate workflow run total_count',
    )
  }
  return { batch, totalCount }
}

function assertCumulativeRunsWithinDeclaredTotal(fetchedCount, declaredTotalCount) {
  if (declaredTotalCount !== null && fetchedCount > declaredTotalCount) {
    throw new Error(
      '[pre-push] branch gate preflight: inconsistent Public Release Gate workflow run total_count',
    )
  }
}

function defaultGhGet(repo, query) {
  const args = [
    'api',
    '--method',
    'GET',
    `repos/${repo}/actions/workflows/${PUBLIC_RELEASE_GATE_WORKFLOW_ID}/runs`,
  ]
  for (const [key, value] of Object.entries(query)) {
    args.push('-f', `${key}=${value}`)
  }
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.error) {
    throw new Error('gh unavailable for branch gate preflight (push aborted)')
  }
  return JSON.parse(result.stdout.trim())
}

/**
 * @param {{ publishedHeadSha?: string, requireCompletePagination: boolean }} options
 */
export function collectPublicReleaseGateRuns(repo, branch, ghGet, options) {
  const runs = []
  const seenRunIds = new Set()
  let declaredTotalCount = null
  let skippedCountEqualityForFoundHeadEarlyStop = false
  for (let page = 1; page <= PUBLIC_RELEASE_GATE_MAX_PAGES; page += 1) {
    const payload = ghGet(repo, { branch, per_page: '100', page: String(page) })
    const validated = validateWorkflowRunsPage(payload, {
      branch,
      repo,
      page,
      seenRunIds,
    })
    if (page === 1 && validated.totalCount !== null) {
      declaredTotalCount = validated.totalCount
    } else if (
      validated.totalCount !== null &&
      declaredTotalCount !== null &&
      validated.totalCount !== declaredTotalCount
    ) {
      throw new Error(
        '[pre-push] branch gate preflight: inconsistent Public Release Gate workflow run total_count',
      )
    }
    const batch = validated.batch
    runs.push(...batch)
    assertCumulativeRunsWithinDeclaredTotal(runs.length, declaredTotalCount)
    if (batch.length < 100) break
    if (options.requireCompletePagination) {
      if (page === PUBLIC_RELEASE_GATE_MAX_PAGES) {
        throw new Error(
          '[pre-push] branch gate preflight: incomplete Public Release Gate history pagination',
        )
      }
      continue
    }
    const publishedHeadSha = options.publishedHeadSha
    const hasHead =
      typeof publishedHeadSha === 'string' &&
      batch.some((run) => run.head_sha === publishedHeadSha)
    if (hasHead) {
      if (batch.length === 100) {
        skippedCountEqualityForFoundHeadEarlyStop = true
      }
      break
    }
  }
  if (
    !skippedCountEqualityForFoundHeadEarlyStop &&
    declaredTotalCount !== null &&
    runs.length !== declaredTotalCount
  ) {
    throw new Error(
      '[pre-push] branch gate preflight: incomplete Public Release Gate workflow run evidence',
    )
  }
  return runs
}

function branchHasAnyGateRuns(runs) {
  return runs.length > 0
}

function assertRemoteBranchTipUnchanged(
  lsRemoteFn,
  root,
  remote,
  remoteBranchRef,
  expectedSha,
  branch,
) {
  const probe = lsRemoteFn(root, remote, remoteBranchRef)
  if (!probe.present || probe.sha !== expectedSha) {
    throw new Error(
      `[pre-push] branch ${branch} remote tip changed during gate preflight (retry push)`,
    )
  }
}

function assertRemoteReachable(root, remote, lsRemoteFn) {
  const headRef = 'HEAD'
  const head = lsRemoteFn(root, remote, headRef)
  if (head.status !== 0 || !head.present || !head.sha) {
    throw new Error('[pre-push] branch gate preflight: remote reachability probe failed')
  }
}

/**
 * Abort push when the published remote tip still has an in-flight Public Release Gate.
 */
export function assertBranchPriorGateComplete(root, remote = 'origin', deps = {}) {
  const gitFn = deps.git ?? git
  const ghGet = deps.ghGet ?? defaultGhGet
  const lsRemoteFn = deps.lsRemote ?? gitLsRemoteExact

  const branch = gitFn(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!branch) {
    throw new Error('[pre-push] detached HEAD; checkout a branch before pushing')
  }

  const getPushUrlsAll = deps.getPushUrlsAll ?? gitRemoteGetPushUrlsAll
  const repo = assertRemotePushFetchRepoAligned(root, remote, gitFn, getPushUrlsAll)
  const remoteBranchRef = `refs/heads/${branch}`

  assertRemoteReachable(root, remote, lsRemoteFn)

  const branchProbe = lsRemoteFn(root, remote, remoteBranchRef)

  if (!branchProbe.present) {
    const runs = collectPublicReleaseGateRuns(repo, branch, ghGet, {
      requireCompletePagination: true,
    })
    if (branchHasAnyGateRuns(runs)) {
      throw new Error(
        `[pre-push] branch ${branch} remote ref is absent but Public Release Gate history exists`,
      )
    }
    const branchProbeAfterHistory = lsRemoteFn(root, remote, remoteBranchRef)
    if (branchProbeAfterHistory.present) {
      throw new Error(
        `[pre-push] branch ${branch} remote ref appeared during gate preflight (retry push)`,
      )
    }
    const verdict = evaluatePublishedHeadGate(runs, '0'.repeat(40), {
      branchHasAnyGateRuns: false,
    })
    if (!verdict.allow) {
      throw new Error(`[pre-push] branch ${branch} ${verdict.reason}`)
    }
    return
  }

  const tipBeforeFetch = branchProbe.sha
  gitFn(root, ['fetch', remote, branch])
  const tipAfterFetch = gitFn(root, ['rev-parse', `${remote}/${branch}`])
  if (tipBeforeFetch !== tipAfterFetch) {
    throw new Error(
      `[pre-push] branch ${branch} remote tip changed during gate preflight (retry push)`,
    )
  }

  const runs = collectPublicReleaseGateRuns(repo, branch, ghGet, {
    publishedHeadSha: tipAfterFetch,
    requireCompletePagination: false,
  })
  assertRemoteBranchTipUnchanged(
    lsRemoteFn,
    root,
    remote,
    remoteBranchRef,
    tipBeforeFetch,
    branch,
  )
  const verdict = evaluatePublishedHeadGate(runs, tipAfterFetch, {
    branchHasAnyGateRuns: branchHasAnyGateRuns(runs),
  })
  if (!verdict.allow) {
    throw new Error(`[pre-push] branch ${branch} ${verdict.reason}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])
    assertBranchPriorGateComplete(root, process.argv[2] || 'origin')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
