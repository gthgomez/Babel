// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.error) throw new Error('git read failed')
  return result.stdout.trim()
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.error) {
    throw new Error('gh unavailable for branch gate preflight (push aborted)')
  }
  return result.stdout.trim()
}

/**
 * Abort push when the current branch still has an in-flight GitHub Actions gate.
 * Allows push when no prior run exists (new branch) or the latest run is terminal.
 */
export function assertBranchPriorGateComplete(root, remote = 'origin') {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return
  const remoteUrl = git(root, ['remote', 'get-url', remote])
  const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i)
  if (!match) return
  const repo = match[1]
  const json = gh([
    'api',
    `repos/${repo}/actions/runs`,
    '-f',
    `branch=${branch}`,
    '-f',
    'per_page=1',
  ])
  const payload = JSON.parse(json)
  const run = payload.workflow_runs?.[0]
  if (!run) return
  const status = run.status
  if (status === 'completed') return
  throw new Error(
    `[pre-push] branch ${branch} gate run ${run.id} is ${status}; wait for completion before pushing`,
  )
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
