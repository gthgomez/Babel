// License: Apache-2.0 — see LICENSE
/**
 * Read-only agent helper: reports configured hook ownership (execution unverified),
 * runs existing staged/cheap validators, and compares local HEAD to ls-remote for the
 * current branch. Not merge authority; full push scans stay in validate-push-candidates.mjs.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightPushCandidates, verifyStagedManifest } from './validate-push-candidates.mjs'

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0 || r.error) throw new Error('git read failed')
  return r.stdout.trim()
}

/** Configured hooksPath label only; never infer that hooks actually run on commit/push. */
export function describeHookOwnership(root) {
  const get = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8', windowsHide: true })
  const raw = get.status === 0 ? get.stdout.trim() : ''
  if (!raw) {
    return { hooksPath: 'unset', hookExecutionVerified: false }
  }
  const hooksDir = resolve(root, '.githooks')
  const configured = raw.startsWith('/') || /^[A-Za-z]:[/\\]/.test(raw) ? resolve(raw) : resolve(root, raw)
  const hooksPath = configured === hooksDir ? 'repo:.githooks' : 'host-managed'
  return { hooksPath, hookExecutionVerified: false }
}

/** merge-base --is-ancestor: true/false, or null when Git lacks objects to decide. */
export function queryIsAncestor(root, maybeAncestor, descendant) {
  const r = spawnSync(
    'git',
    ['-C', root, 'merge-base', '--is-ancestor', maybeAncestor, descendant],
    { encoding: 'utf8', windowsHide: true },
  )
  if (r.status === 0) return true
  if (r.status === 1) return false
  return null
}

export function diagnoseBranchPublicationFrontier(root, remote, branch, { localSha } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('unsupported remote name')
  if (!/^[A-Za-z0-9/._-]+$/.test(branch) || branch.includes('..')) throw new Error('unsupported branch name')
  const headSha = localSha ?? git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const advertised = spawnSync(
    'git',
    ['-C', root, 'ls-remote', '--refs', remote, `refs/heads/${branch}`],
    { encoding: 'utf8', windowsHide: true },
  )
  if (advertised.status !== 0) throw new Error('remote advertisement unavailable')
  const line = advertised.stdout.trim().split('\n').find(Boolean)
  if (!line) {
    return { status: 'unpublished', localSha: headSha, remoteTip: null, remote, branch }
  }
  const match = line.match(/^([a-f0-9]{40})\trefs\/heads\/.+$/)
  if (!match) throw new Error('invalid remote advertisement')
  const remoteTip = match[1]
  if (remoteTip === headSha) {
    return { status: 'aligned', localSha: headSha, remoteTip, remote, branch }
  }
  const remoteContainsLocal = queryIsAncestor(root, headSha, remoteTip)
  const localContainsRemote = queryIsAncestor(root, remoteTip, headSha)
  if (remoteContainsLocal === null || localContainsRemote === null) {
    return {
      status: 'unknown',
      localSha: headSha,
      remoteTip,
      remote,
      branch,
      hint: 'Ancestry evidence unavailable (missing objects); fetch or reconcile before treating divergence as proven.',
    }
  }
  let status = 'diverged'
  if (remoteContainsLocal && !localContainsRemote) status = 'remote_ahead'
  else if (localContainsRemote && !remoteContainsLocal) status = 'local_ahead'
  return {
    status,
    localSha: headSha,
    remoteTip,
    remote,
    branch,
    hint: 'After any remote tip exists, use additive commits and a normal push; fetch and reconcile before rewriting.',
  }
}

function resolvePublicationRemote(root, branch) {
  const configured = spawnSync('git', ['-C', root, 'config', '--get', `branch.${branch}.remote`], { encoding: 'utf8', windowsHide: true })
  return configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : 'origin'
}

function emitHookOwnership(root) {
  const report = describeHookOwnership(root)
  console.error(`[publication-surface] core.hooksPath=${report.hooksPath}`)
  console.error('[publication-surface] hook_execution=unverified')
  console.error('[publication-surface] configured ownership does not prove hooks run; use explicit CLI checks below')
}

export function assertPublicationFrontierAllowsPush(root, { localSha } = {}) {
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const remote = resolvePublicationRemote(root, branch)
  const report = diagnoseBranchPublicationFrontier(root, remote, branch, { localSha })
  console.error(`[publication-surface] branch=${report.branch} status=${report.status}`)
  console.error(`[publication-surface] local=${report.localSha} remote_tip=${report.remoteTip ?? 'none'}`)
  if (report.hint) console.error(`[publication-surface] ${report.hint}`)
  if (report.status === 'remote_ahead' || report.status === 'diverged') {
    throw new Error('remote publication frontier differs; fetch and reconcile before push')
  }
  return report
}

async function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const argv = process.argv.slice(2)
  emitHookOwnership(root)
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.error(`Usage:
  node tools/verify-changed-publication-surface.mjs [--staged-only]
  node tools/verify-changed-publication-surface.mjs --candidate <40-hex-sha>
--candidate must equal current HEAD; cheap preflight runs, then branch frontier check.
Delegates manifest/AGENTS budget to validate-push-candidates.mjs.
Full push validation (public-content, gitleaks): validate-push-candidates.mjs <remote>`)
    return
  }
  if (argv[0] === '--candidate') {
    const sha = argv[1]
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('exact candidate sha required')
    const headSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    if (sha !== headSha) {
      throw new Error('candidate must match current HEAD for branch frontier diagnostic')
    }
    await preflightPushCandidates([sha], root, line => console.error(line))
    assertPublicationFrontierAllowsPush(root, { localSha: sha })
    console.error(`[publication-surface] candidate ${sha} cheap preflight and frontier complete`)
    return
  }
  await verifyStagedManifest(root)
  console.error('[publication-surface] staged cheap preflight complete (existing validator)')
  if (argv[0] !== '--staged-only') assertPublicationFrontierAllowsPush(root)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[publication-surface] ${error.message}`)
    process.exitCode = 1
  })
}
