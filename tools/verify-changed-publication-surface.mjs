// License: Apache-2.0 — see LICENSE
/**
 * Agent-callable execution checks for changed publication surface.
 * Distinct from scripts/agent-preflight.ps1 (readiness/planning JSON only).
 * Does not run candidate TypeScript or install hooks.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTERACTIVE_STACK_BUDGET } from './agents-interactive-budget.mjs'
import { preflightPushCandidates, verifyStagedManifest } from './validate-push-candidates.mjs'

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0 || r.error) throw new Error('git read failed')
  return r.stdout.trim()
}

export function diagnoseBranchPublicationFrontier(root, remote, branch) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('unsupported remote name')
  if (!/^[A-Za-z0-9/._-]+$/.test(branch) || branch.includes('..')) throw new Error('unsupported branch name')
  const localSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const advertised = spawnSync(
    'git',
    ['-C', root, 'ls-remote', '--refs', remote, `refs/heads/${branch}`],
    { encoding: 'utf8', windowsHide: true },
  )
  if (advertised.status !== 0) throw new Error('remote advertisement unavailable')
  const line = advertised.stdout.trim().split('\n').find(Boolean)
  if (!line) {
    return { status: 'unpublished', localSha, remoteTip: null, remote, branch }
  }
  const match = line.match(/^([a-f0-9]{40})\trefs\/heads\/.+$/)
  if (!match) throw new Error('invalid remote advertisement')
  const remoteTip = match[1]
  if (remoteTip === localSha) {
    return { status: 'aligned', localSha, remoteTip, remote, branch }
  }
  const remoteContainsLocal = spawnSync(
    'git',
    ['-C', root, 'merge-base', '--is-ancestor', localSha, remoteTip],
    { windowsHide: true },
  ).status === 0
  const localContainsRemote = spawnSync(
    'git',
    ['-C', root, 'merge-base', '--is-ancestor', remoteTip, localSha],
    { windowsHide: true },
  ).status === 0
  let status = 'diverged'
  if (remoteContainsLocal && !localContainsRemote) status = 'remote_ahead'
  else if (localContainsRemote && !remoteContainsLocal) status = 'local_ahead'
  return {
    status,
    localSha,
    remoteTip,
    remote,
    branch,
    hint: 'After any remote tip exists, use additive commits and a normal push; fetch and reconcile before rewriting.',
  }
}

/** Parse one git pre-push record line into advertised local/ref update semantics. */
export function parsePushRecordLine(line) {
  const fields = line.trim().split(/\s+/)
  if (fields.length !== 4 || !fields[2].startsWith('refs/')) throw new Error('malformed push record')
  const [localSha, , ref, previousSha] = fields
  if (!/^[a-f0-9]{40}$/.test(localSha) || !/^[a-f0-9]{40}$/.test(previousSha)) throw new Error('malformed push sha')
  return { localSha, ref, previousSha, isDelete: /^0+$/.test(localSha) }
}

function printFrontierReport(report) {
  console.error(`[publication-surface] branch=${report.branch} status=${report.status}`)
  console.error(`[publication-surface] local=${report.localSha} remote_tip=${report.remoteTip ?? 'none'}`)
  if (report.hint) console.error(`[publication-surface] ${report.hint}`)
  if (report.status === 'remote_ahead' || report.status === 'diverged') {
    throw new Error('remote publication frontier differs; fetch and reconcile before push')
  }
}

async function runStagedChecks(root) {
  await verifyStagedManifest(root)
  console.error('[publication-surface] staged policy integrity verified')
  console.error(`[publication-surface] staged AGENTS.md within interactive budget (${INTERACTIVE_STACK_BUDGET})`)
}

async function runCandidatePreflight(root, sha) {
  await preflightPushCandidates([sha], root, line => console.error(line))
  console.error(`[publication-surface] candidate ${sha} manifest and AGENTS budget verified`)
}

async function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const argv = process.argv.slice(2)
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.error(`Usage:
  node tools/verify-changed-publication-surface.mjs [--staged-only]
  node tools/verify-changed-publication-surface.mjs --candidate <40-hex-sha>
  node tools/verify-changed-publication-surface.mjs --push-records < remote.txt
Cheap execution checks only (manifest + committed AGENTS budget + frontier).
Full push validation remains: node tools/validate-push-candidates.mjs <remote`)
    return
  }
  if (argv[0] === '--candidate') {
    const sha = argv[1]
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('exact candidate sha required')
    await runCandidatePreflight(root, sha)
    return
  }
  if (argv[0] === '--push-records') {
    const records = readFileSync(0, 'utf8')
    for (const line of records.split(/\r?\n/).filter(Boolean)) {
      const rec = parsePushRecordLine(line)
      console.error(
        `[publication-surface] push_record ref=${rec.ref} new=${rec.localSha} old=${rec.previousSha}`,
      )
    }
    return
  }
  await runStagedChecks(root)
  if (argv[0] !== '--staged-only') {
    try {
      const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      const remote = upstream.split('/')[0]
      const branch = upstream.slice(remote.length + 1)
      printFrontierReport(diagnoseBranchPublicationFrontier(root, remote, branch))
    } catch {
      console.error('[publication-surface] no upstream configured; skipped remote frontier check')
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[publication-surface] ${error.message}`)
    process.exitCode = 1
  })
}
