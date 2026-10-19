// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PUBLIC_RELEASE_GATE_WORKFLOW_ID = 258744217
export const PUBLIC_RELEASE_GATE_WORKFLOW_NAME = 'Public Release Gate'

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

function resolveGithubRepo(root, remote, gitFn) {
  const remoteUrl = gitFn(root, ['remote', 'get-url', remote])
  try {
    return parseGithubRepoFromRemote(remoteUrl)
  } catch (error) {
    const gh = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (gh.status === 0 && gh.stdout) {
      const payload = JSON.parse(gh.stdout)
      if (typeof payload.nameWithOwner === 'string' && payload.nameWithOwner.includes('/')) {
        return payload.nameWithOwner
      }
    }
    throw error
  }
}

export function evaluatePublishedHeadGate(workflowRuns, publishedHeadSha) {
  const matching = workflowRuns.filter(
    (run) =>
      run.head_sha === publishedHeadSha &&
      (run.workflow_id === PUBLIC_RELEASE_GATE_WORKFLOW_ID ||
        run.name === PUBLIC_RELEASE_GATE_WORKFLOW_NAME),
  )
  if (matching.length === 0) {
    return { allow: true, reason: 'no Public Release Gate run for published head' }
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

function defaultGhGet(repo, query) {
  const args = ['api', '--method', 'GET', `repos/${repo}/actions/workflows/${PUBLIC_RELEASE_GATE_WORKFLOW_ID}/runs`]
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
 * Abort push when the published remote tip still has an in-flight Public Release Gate.
 */
export function assertBranchPriorGateComplete(root, remote = 'origin', deps = {}) {
  const gitFn = deps.git ?? git
  const ghGet = deps.ghGet ?? defaultGhGet

  const branch = gitFn(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!branch) {
    throw new Error('[pre-push] detached HEAD; checkout a branch before pushing')
  }

  const repo = resolveGithubRepo(root, remote, gitFn)

  gitFn(root, ['fetch', remote, branch])
  const publishedHeadSha = gitFn(root, ['rev-parse', `${remote}/${branch}`])

  const payload = ghGet(repo, { branch, per_page: '30' })
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : []
  const verdict = evaluatePublishedHeadGate(runs, publishedHeadSha)
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
