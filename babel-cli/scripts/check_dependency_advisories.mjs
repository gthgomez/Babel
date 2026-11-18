// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ARTIFACT_SCOPES = new Set(['npm', 'desktop'])
const DECISIONS = new Set(['not_affected', 'remediated', 'mitigated', 'accepted_risk', 'deferred'])
const BLOCKING_DECISIONS = new Set(['accepted_risk', 'deferred'])

function requireText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.trim().length > 0, `${label} must not be empty`)
  return value
}

function lockedVersion(lock, name) {
  const entry = lock.packages?.[`node_modules/${name}`]
  return typeof entry?.version === 'string' ? entry.version : null
}

/** Advisory ranges are published with ", " as AND; semver expects whitespace. */
function satisfiesRange(version, range) {
  return semver.satisfies(version, String(range).replace(/\s*,\s*/g, ' '), { includePrerelease: true })
}

/**
 * Verify a committed advisory review against the exact dependency locks it
 * claims to cover. A changed lock, a missing package, an unrecorded range
 * match or an inconsistent decision fails closed. Offline by design: the
 * record is the reviewed snapshot, not a live advisory feed.
 * @param {{repoRoot: string, scope?: 'npm'|'desktop'|'all', reviewPath?: string}} input
 * @returns {{status: 'PASS'|'FAIL', scope: string, reviewSha256: string, checked: number, advisories: Array<object>, problems: string[]}}
 */
export function verifyAdvisoryReview({ repoRoot, scope = 'npm', reviewPath = 'config/dependency-advisory-review.json' }) {
  assert.ok(scope === 'npm' || scope === 'desktop' || scope === 'all', 'scope must be npm, desktop or all')
  const reviewFile = resolve(repoRoot, reviewPath)
  const bytes = readFileSync(reviewFile)
  const review = JSON.parse(bytes)
  const problems = []
  assert.equal(review.schemaVersion, 1, 'unsupported advisory review schema')
  requireText(review.reviewedAt, 'reviewedAt')
  assert.ok(Array.isArray(review.locks) && review.locks.length > 0, 'advisory review must name its dependency locks')
  assert.ok(Array.isArray(review.advisories) && review.advisories.length > 0, 'advisory review must record at least one advisory')

  const locks = new Map()
  for (const declared of review.locks) {
    const path = requireText(declared.path, 'lock path')
    const absolute = resolve(repoRoot, path)
    const lockBytes = readFileSync(absolute)
    const digest = createHash('sha256').update(lockBytes).digest('hex')
    if (digest !== declared.sha256) problems.push(`stale advisory review: ${path} digest ${digest} does not match reviewed ${declared.sha256}`)
    locks.set(path, JSON.parse(lockBytes))
  }

  const advisories = []
  for (const advisory of review.advisories) {
    const id = requireText(advisory.id, 'advisory id')
    const name = requireText(advisory.package, 'advisory package')
    assert.ok(DECISIONS.has(advisory.decision), `${id}: unsupported decision ${advisory.decision}`)
    assert.ok(Array.isArray(advisory.artifactScopes) && advisory.artifactScopes.length > 0, `${id}: artifactScopes required`)
    for (const entry of advisory.artifactScopes) assert.ok(ARTIFACT_SCOPES.has(entry), `${id}: unknown artifact scope ${entry}`)
    assert.ok(Array.isArray(advisory.ranges) && advisory.ranges.length > 0, `${id}: affected ranges required`)
    requireText(advisory.rationale, `${id}: rationale`)
    requireText(advisory.exposure, `${id}: exposure`)
    assert.ok(Array.isArray(advisory.references) && advisory.references.some(ref => /^https:\/\/github\.com\/advisories\//.test(ref)), `${id}: advisory reference required`)

    const installed = new Map()
    for (const [path, lock] of locks) {
      const version = lockedVersion(lock, name)
      if (version) installed.set(path, version)
    }
    if (installed.size === 0) {
      problems.push(`${id}: ${name} is not present in any reviewed lock (stale review)`)
      continue
    }

    const inScope = scope === 'all' || advisory.artifactScopes.includes(scope)
    const rows = [...installed].map(([path, version]) => {
      const affected = advisory.ranges.some(range => satisfiesRange(version, range))
      return { lock: path, version, affected }
    })
    const affected = rows.some(row => row.affected)
    const scopeRows = inScope ? rows : []
    const scopeAffected = scopeRows.some(row => row.affected)

    if (advisory.decision === 'not_affected' && affected) problems.push(`${id}: recorded not_affected but ${name} ${rows.map(row => row.version).join(', ')} matches ${advisory.ranges.join(' || ')}`)
    if (advisory.decision === 'remediated') {
      if (affected) problems.push(`${id}: recorded remediated but an installed ${name} still matches ${advisory.ranges.join(' || ')}`)
      const fixed = (advisory.fixedVersions ?? []).map(version => semver.parse(version)).filter(Boolean)
      if (fixed.length === 0) problems.push(`${id}: remediated decision requires a fixedVersions entry`)
    }
    if (advisory.decision === 'mitigated') requireText(advisory.mitigation, `${id}: mitigation`)
    if (BLOCKING_DECISIONS.has(advisory.decision) && affected) {
      requireText(advisory.releaseImpact, `${id}: releaseImpact`)
      if (scopeAffected) problems.push(`${id}: ${advisory.decision} blocks ${scope} qualification for ${name} ${scopeRows.filter(row => row.affected).map(row => row.version).join(', ')}`)
    }

    advisories.push({ id, package: name, severity: advisory.severity, decision: advisory.decision, artifactScopes: advisory.artifactScopes, installed: rows, affected, scopeAffected })
  }

  return {
    status: problems.length ? 'FAIL' : 'PASS',
    scope,
    review: reviewPath,
    reviewSha256: createHash('sha256').update(bytes).digest('hex'),
    checked: advisories.length,
    advisories,
    problems,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const scopeArg = process.argv.find(arg => arg.startsWith('--scope='))?.split('=')[1]
    const result = verifyAdvisoryReview({ repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), scope: scopeArg ?? 'npm' })
    console.log(JSON.stringify(result))
    if (result.status !== 'PASS') process.exitCode = 1
  } catch (error) {
    console.error(`Advisory review unavailable: ${error.message}`)
    process.exitCode = 1
  }
}
