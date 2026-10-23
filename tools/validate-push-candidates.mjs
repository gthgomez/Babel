// License: Apache-2.0 — see LICENSE
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCommittedInventory, readCommittedBlobs } from './committed-object-reader.mjs'
import { coveredPaths, verifyPolicyManifest } from './policy-integrity-manifest.mjs'
import { assertRemotePushFetchRepoAligned } from './assert-branch-prior-gate-complete.mjs'
import { createPublicContentWorker } from './public-content-worker.mjs'
import { assertInteractiveAgentsBudget } from './agents-interactive-budget.mjs'

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], { input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0 || r.error) throw new Error('push object unavailable or Git read failed')
  return r.stdout.trim()
}

/** Resolve pre-push ref/SHA records to committed objects, without using HEAD or the index. */
export function collectPushCandidates(records, root, remote, { publishedTips = [] } = {}) {
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
    const excluded = []
    if (!/^0+$/.test(previous)) excluded.push(git(root, ['rev-parse', '--verify', `${previous}^{commit}`]))
    if (publishedTips.some(sha => !/^[a-f0-9]{40}$/.test(sha))) throw new Error('invalid publication frontier')
    excluded.push(...publishedTips)
    // Validate even an already-reachable tip being sent to a different ref.
    commits.add(tip)
    // Stdin avoids Windows command-line limits on repositories with many refs.
    const revisions = [tip, ...excluded.map(sha => '^' + sha)].join('\n') + '\n'
    for (const sha of git(root, ['rev-list', '--stdin'], revisions).split('\n').filter(Boolean)) commits.add(sha)
  }
  return [...commits]
}

/** Remote advertisement, not mutable/stale remote-tracking refs, defines published history. */
export function readPublishedTips(root, remote) {
  const advertised = git(root, ['ls-remote', '--refs', remote, 'refs/heads/*', 'refs/tags/*'])
  const ids = [...new Set(advertised.split('\n').filter(Boolean).map(row => {
    const match = row.match(/^([a-f0-9]{40})\trefs\/(?:heads|tags)\/.+$/)
    if (!match) throw new Error('invalid destination advertisement')
    return match[1]
  }))]
  if (!ids.length) return []
  const known = spawnSync('git', ['-C', root, 'cat-file', '--batch-check'], { input: ids.join('\n') + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (known.error || known.status !== 0) throw new Error('publication frontier unavailable')
  const rows = known.stdout.trim().split('\n')
  if (rows.length !== ids.length) throw new Error('publication frontier incomplete')
  return rows.flatMap((row, index) => {
    const fields = row.trim().split(' ')
    if (fields[0] !== ids[index] || !['missing', 'commit', 'tag', 'tree', 'blob'].includes(fields[1])) throw new Error('invalid publication frontier object')
    return ['commit', 'tag'].includes(fields[1]) ? [fields[0]] : []
  })
}

/** Observe local object work as well as child validators; never echo source. */
export async function observeValidationWork(label, work, emit = console.error, heartbeatMs = 10000) {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('invalid progress interval')
  const started = performance.now()
  emit(`[pre-push] ${label} started`)
  const heartbeat = setInterval(() => emit(`[pre-push] ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}`), heartbeatMs)
  let status = 'failed'
  try {
    const value = await work()
    status = 'complete'
    return value
  } finally {
    clearInterval(heartbeat)
    emit(`[pre-push] ${label} finished elapsed_ms=${Math.round(performance.now() - started)} status=${status}`)
  }
}

export async function runValidationStage(binary, args, root, label, emit = console.error, timeout = 120000) {
  const started = performance.now()
  emit(`[pre-push] ${label} started`)
  const child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  let size = 0, expired = false, overflow = false
  child.stdout.on('data', chunk => {
    size += chunk.length
    if (size <= 2 * 1024 * 1024) chunks.push(chunk)
    else { overflow = true; child.kill() }
  })
  child.stderr.resume()
  const timer = setTimeout(() => { expired = true; child.kill() }, timeout)
  const heartbeat = setInterval(() => emit(`[pre-push] ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}`), 10000)
  try {
    const outcome = await new Promise(resolve => {
      child.once('error', () => resolve({ code: null, failed: true }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    emit(`[pre-push] ${label} finished elapsed_ms=${Math.round(performance.now() - started)} exit=${outcome.code ?? 'unavailable'} signal=${outcome.signal ?? 'none'}`)
    if (expired || overflow || outcome.failed || outcome.code !== 0 || outcome.signal) {
      // Report only bounded structural identifiers. Rejected text and paths may contain secrets.
      let findings = []
      try { findings = JSON.parse(Buffer.concat(chunks).toString('utf8')).findings ?? [] } catch {}
      for (const finding of findings.slice(0, 20)) {
        if (/^PC(?:ONT|FG)\d{3}$/.test(finding.id) && Number.isSafeInteger(finding.line)) {
          const pathId = createHash('sha256').update(String(finding.path)).digest('hex').slice(0, 16)
          emit(`[pre-push] finding rule=${finding.id} path_sha256=${pathId} line=${finding.line}`)
        }
      }
      throw new Error(`${label} ${expired ? 'timed out' : overflow ? 'output limit exceeded' : 'rejected candidate'} (source withheld)`)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { clearTimeout(timer); clearInterval(heartbeat) }
}

async function scanPublicContent(worker, snapshot, sha, emit) {
  const label = `${sha.slice(0, 12)} public-content`
  const started = performance.now()
  emit(`[pre-push] ${label} started`)
  const heartbeat = setInterval(() => emit(`[pre-push] ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}`), 10000)
  let expired = false
  const timeout = setTimeout(() => { expired = true; worker.close() }, 900000)
  try {
    const response = await worker.check(snapshot, sha)
    emit(`[pre-push] ${label} finished elapsed_ms=${Math.round(performance.now() - started)} exit=${response.exitCode}`)
    if (response.exitCode !== 0 || response.result.status === 'fail') {
      for (const finding of response.result.findings) {
        if (/^PC(?:ONT|FG)\d{3}$/.test(finding.id) && Number.isSafeInteger(finding.line)) {
          emit(`[pre-push] finding rule=${finding.id} path_sha256=${createHash('sha256').update(String(finding.path)).digest('hex').slice(0, 16)} line=${finding.line}`)
        }
      }
      throw new Error(`${label} rejected candidate (source withheld)`)
    }
  } catch (error) {
    if (expired) throw new Error(`${label} timed out (source withheld)`)
    throw error
  } finally { clearTimeout(timeout); clearInterval(heartbeat) }
}

export function assertExportableCandidate(root, sha) {
  return readCommittedInventory(root, sha)
}

/** DATA-only AGENTS.md budget check on exact committed bytes (not the worktree). */
export async function assertCommittedAgentsInteractiveBudget(root, inventory, emit = console.error) {
  const agents = inventory.find(entry => entry.path === 'AGENTS.md')
  if (!agents) return null
  let bytes = null
  await readCommittedBlobs(root, [agents.oid], (_oid, blob) => { bytes = blob })
  if (!bytes) throw new Error('committed AGENTS.md unavailable')
  const length = assertInteractiveAgentsBudget(bytes)
  emit(`[pre-push] AGENTS.md committed length=${length} budget=ok`)
  return length
}

/** Verify every candidate's cheap invariants before any content scan or extraction. */
export async function preflightPushCandidates(commits, root, emit = console.error) {
  const plans = []
  for (const [index, sha] of commits.entries()) {
    const plan = await observeValidationWork(`preflight ${index + 1}/${commits.length} ${sha.slice(0, 12)}`, async () => {
      const inventory = assertExportableCandidate(root, sha)
      const byPath = new Map(inventory.map(entry => [entry.path, entry]))
      const required = ['POLICY_MANIFEST.json', ...coveredPaths]
      const blobs = new Map()
      await readCommittedBlobs(root, required.flatMap(path => byPath.has(path) ? [byPath.get(path).oid] : []), (oid, bytes) => blobs.set(oid, bytes))
      const verdict = verifyPolicyManifest(path => {
        const entry = byPath.get(path)
        if (!entry || !blobs.has(entry.oid)) throw new Error('manifest input unavailable')
        return blobs.get(entry.oid)
      })
      if (verdict.status !== 'VERIFIED') throw new Error(`policy integrity rejected candidate ${sha.slice(0, 12)} during preflight`)
      emit(`[pre-push] preflight ${index + 1}/${commits.length} ${sha} manifest=verified files=${inventory.length}`)
      await assertCommittedAgentsInteractiveBudget(root, inventory, emit)
      return { sha, inventory }
    }, emit)
    plans.push(plan)
  }
  return plans
}

/** Check exact staged policy bytes, including partial staging, before creating a commit. */
export async function verifyStagedManifest(root) {
  const required = ['POLICY_MANIFEST.json', ...coveredPaths]
  const rows = git(root, ['ls-files', '--stage', '-z', '--', ...required]).split('\0').filter(Boolean)
  const entries = new Map(rows.map(row => {
    const match = row.match(/^\d{6} ([a-f0-9]{40}) 0\t([\s\S]+)$/)
    if (!match) throw new Error('staged policy inventory unavailable or unmerged')
    return [match[2], match[1]]
  }))
  const blobs = new Map()
  await readCommittedBlobs(root, [...entries.values()], (oid, bytes) => blobs.set(oid, bytes))
  const result = verifyPolicyManifest(path => {
    if (!entries.has(path)) throw new Error('staged policy input missing')
    return blobs.get(entries.get(path))
  })
  if (result.status !== 'VERIFIED') throw new Error('staged policy integrity mismatch; regenerate and stage the matching manifest')
  if (entries.has('AGENTS.md')) {
    assertInteractiveAgentsBudget(blobs.get(entries.get('AGENTS.md')))
  }
  return result
}

/** Update the push-owned snapshot from preflighted inventories; never execute it. */
export async function materializePushSnapshot(root, snapshot, inventory, previous = []) {
  const target = resolve(snapshot), prefix = target + sep
  const destination = path => {
    const full = resolve(target, path)
    if (!full.startsWith(prefix)) throw new Error('snapshot path escaped owned directory')
    return full
  }
  // Validate every destination before performing any file removal.
  for (const entry of [...previous, ...inventory]) destination(entry.path)
  const before = new Map(previous.map(entry => [entry.path, entry]))
  const after = new Map(inventory.map(entry => [entry.path, entry]))
  const same = (a, b) => a && b && a.oid === b.oid && a.mode === b.mode
  if (!previous.length) mkdirSync(target)
  for (const entry of previous) {
    if (!same(entry, after.get(entry.path))) rmSync(destination(entry.path))
  }
  const directories = entries => new Set(entries.flatMap(entry => {
    const parts = entry.path.split('/')
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
  }))
  // Windows merges differently cased directory spellings into one identity.
  const directoryIdentity = path => process.platform === 'win32' ? path.toLowerCase() : path
  const nextDirectories = new Set([...directories(inventory)].map(directoryIdentity))
  const removedDirectories = new Map([...directories(previous)]
    .filter(path => !nextDirectories.has(directoryIdentity(path)))
    .map(path => [directoryIdentity(path), path]))
  for (const path of [...removedDirectories.values()].sort((a, b) => b.length - a.length)) {
    rmdirSync(destination(path))
  }
  const changed = inventory.filter(entry => !same(entry, before.get(entry.path)))
  const blobs = new Map()
  for (const entry of changed) {
    if (!blobs.has(entry.oid)) blobs.set(entry.oid, [])
    blobs.get(entry.oid).push(entry.path)
  }
  await readCommittedBlobs(root, [...blobs.keys()], (oid, bytes) => {
    for (const path of blobs.get(oid)) {
      const full = destination(path)
      mkdirSync(dirname(full), { recursive: true })
      // Symlink objects remain ordinary target text and are never followed.
      writeFileSync(full, bytes, { flag: 'wx' })
    }
  })
  return { changed: changed.length, reused: inventory.length - changed.length,
    removed: previous.filter(entry => !after.has(entry.path)).length }
}

/** Validate exported committed contents with host-side validators, without running candidate scripts. */
export async function validatePushCandidates(records, root, remote, { emit = console.error } = {}) {
  assertRemotePushFetchRepoAligned(root, remote, git)
  const commits = collectPushCandidates(records, root, remote, { publishedTips: readPublishedTips(root, remote) })
  if (!commits.length) return
  emit(`[pre-push] candidates=${commits.length}; checking cheap invariants before scanning`)
  const plans = await preflightPushCandidates(commits, root, emit)
  const scratch = mkdtempSync(join(tmpdir(), 'babel-push-check-'))
  const snapshot = join(scratch, 'snapshot')
  const worker = createPublicContentWorker(root)
  let previous = []
  try {
    const scanner = spawnSync('gitleaks', ['version'], { encoding: 'utf8', windowsHide: true })
    if (scanner.error || scanner.status !== 0) throw new Error('required gitleaks scanner unavailable')
    for (const [index, { sha, inventory }] of plans.entries()) {
      emit(`[pre-push] candidate ${index + 1}/${commits.length} ${sha} materializing committed blobs`)
      const changes = await observeValidationWork(`${sha.slice(0, 12)} materialize`, () => materializePushSnapshot(root, snapshot, inventory, previous), emit)
      emit(`[pre-push] snapshot changed=${changes.changed} reused=${changes.reused} removed=${changes.removed}`)
      await scanPublicContent(worker, snapshot, sha, emit)
      await runValidationStage('gitleaks', ['dir', '--redact', '--no-banner', snapshot], root, `${sha.slice(0, 12)} secrets`, emit)
      previous = inventory
      emit(`[pre-push] verified committed candidate ${sha}`)
    }
  } finally { worker.close(); rmSync(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])
    if (process.argv[2] === '--staged-manifest') {
      await verifyStagedManifest(root)
      console.error('[pre-commit] staged policy integrity verified')
    } else await validatePushCandidates(readFileSync(0, 'utf8'), root, process.argv[2] || 'origin')
  }
  catch (error) {
    // Native file errors may embed a rejected filename; never echo those paths.
    const message = error?.path || error?.dest ? 'committed file I/O failed (source withheld)' : error.message
    console.error(`[pre-push] ${message}`)
    process.exitCode = 1
  }
}
