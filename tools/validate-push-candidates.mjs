// License: Apache-2.0 — see LICENSE
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || r.error) throw new Error('push object unavailable or Git read failed')
  return r.stdout.trim()
}

/** Resolve pre-push ref/SHA records to committed objects, without using HEAD or the index. */
export function collectPushCandidates(records, root, remote) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('unsupported remote name')
  const commits = new Set()
  for (const line of records.split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/)
    // Git can report a revision expression (for example HEAD~1), and uses
    // (delete) for local deletions. Names are metadata; only exact SHAs execute.
    if (fields.length !== 4 || !fields[2].startsWith('refs/') ||
      ![fields[1], fields[3]].every(s => /^[a-f0-9]{40}$/.test(s))) throw new Error('malformed push record')
    const [, local, , previous] = fields
    if (/^0+$/.test(local)) continue
    const tip = git(root, ['rev-parse', '--verify', `${local}^{commit}`])
    const args = ['rev-list', tip]
    if (!/^0+$/.test(previous)) args.push('^' + git(root, ['rev-parse', '--verify', `${previous}^{commit}`]))
    else args.push('--not', `--remotes=${remote}`)
    // Validate even an already-reachable tip being sent to a different ref.
    commits.add(tip)
    for (const sha of git(root, args).split('\n').filter(Boolean)) commits.add(sha)
  }
  return [...commits]
}

function run(binary, args, root, label, timeout = 120000) {
  const r = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    timeout, maxBuffer: 16 * 1024 * 1024 })
  // Failure diagnostics can contain rejected source; withhold scanner/validator output.
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out (output withheld)`)
  if (r.status !== 0 || r.error) throw new Error(`${label} rejected candidate (output withheld)`)
}

export function assertExportableCandidate(root, sha) {
  const paths = git(root, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean)
  for (const path of paths) {
    const foldedPath = path.toLowerCase()
    const leaf = foldedPath.split('/').at(-1)
    if (leaf === '.env' || (leaf.startsWith('.env.') && leaf !== '.env.example') ||
        /(^|\/)\.codex\/(auth\.json|\.env)$/.test(foldedPath)) {
      throw new Error('credential-class committed path rejected before export')
    }
  }
}

/** Validate exported committed contents with host-side validators, without running candidate scripts. */
export function validatePushCandidates(records, root, remote) {
  const commits = collectPushCandidates(records, root, remote)
  if (!commits.length) return
  const tools = dirname(fileURLToPath(import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'babel-push-check-'))
  try {
    const scanner = spawnSync('gitleaks', ['version'], { encoding: 'utf8', windowsHide: true })
    if (scanner.error) console.error('[pre-push] gitleaks unavailable; local secret scan unavailable (CI remains authoritative)')
    else if (scanner.status !== 0) throw new Error('gitleaks setup failed (output withheld)')
    for (const sha of commits) {
      assertExportableCandidate(root, sha)
      const archive = join(scratch, 'candidate.zip')
      const snapshot = join(scratch, 'snapshot')
      git(root, ['archive', '--format=zip', `--output=${archive}`, sha])
      run('pwsh', ['-NoProfile', '-Command', '& { param($archive,$target) Expand-Archive -LiteralPath $archive -DestinationPath $target }', archive, snapshot], root, 'archive export')
      run('pwsh', ['-NoProfile', '-File', join(tools, 'check-public-content-policy.ps1'), '-RepoRoot', snapshot,
        '-PolicyPath', join(tools, 'security/public-content-policy.json'), '-SourceRepository', root, '-SourceCommit', sha], root, 'public content policy', 300000)
      run(process.execPath, [join(tools, 'policy-integrity-manifest.mjs'), 'verify', '--repo-root', snapshot], root, 'policy integrity')
      if (!scanner.error) run('gitleaks', ['dir', '--redact', '--no-banner', snapshot], root, 'secret scan')
      rmSync(snapshot, { recursive: true, force: true })
      console.log(`[pre-push] verified committed candidate ${sha}`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { validatePushCandidates(readFileSync(0, 'utf8'), git(process.cwd(), ['rev-parse', '--show-toplevel']), process.argv[2] || 'origin') }
  catch (error) { console.error(`[pre-push] ${error.message}`); process.exitCode = 1 }
}
