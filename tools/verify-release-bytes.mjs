// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { verifyAdvisoryReview } from '../babel-cli/scripts/check_dependency_advisories.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const digestOf = path => sha256(readFileSync(path))

/** Parse a SHA256SUMS file into name -> digest, rejecting duplicate or unsafe names. */
export function parseChecksums(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(/^([a-f0-9]{64}) [ *]([^/\\]+)$/)
    assert.ok(match, `Malformed checksum line: ${line.slice(0, 120)}`)
    const [, digest, name] = match
    assert.ok(!entries.has(name), `Duplicate checksum entry: ${name}`)
    entries.set(name, digest)
  }
  return entries
}

/**
 * Verify the exact staged release set: required OS artifacts are present and
 * checksum-bound, build metadata names the frozen source and version, publisher
 * authenticity is recorded truthfully, and the GitHub CLI tarball is bytewise
 * identical to the npm-qualified candidate when one is supplied.
 *
 * Checksum contract: ZIP, CLI tarball and AppImage are listed in SHA256SUMS.
 * Setup.exe is bound by its `.exe.sha256` sidecar (the NSIS builder owns it),
 * and the Windows file inventory is only required for Windows releases.
 * The desktop advisory review is always recorded; a deferred advisory is an
 * owner decision, not a hidden promotion failure.
 * @param {{distDir: string, version: string, sourceSha: string, platforms?: string[], npmCandidateDir?: string|null, appImageEvidence?: string|null, requireAppImageLaunch?: boolean, repoRoot?: string}} input
 */
export function verifyReleaseDist({ distDir, version, sourceSha, platforms = ['win32-x64', 'linux-x64'], npmCandidateDir = null, appImageEvidence = null, requireAppImageLaunch = false, repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..') }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-preview\.\d{8})?$/, 'Release version is invalid')
  assert.match(sourceSha, /^[a-f0-9]{40}$/, 'Release source SHA is invalid')
  assert.ok(existsSync(distDir), 'Release directory is missing')
  const names = readdirSync(distDir).filter(name => statSync(join(distDir, name)).isFile()).sort()
  const problems = []
  const present = name => names.includes(name)
  const artifacts = {}
  const expected = new Set(['SHA256SUMS'])

  const requireFile = name => {
    expected.add(name)
    if (!present(name)) { problems.push(`missing release file: ${name}`); return false }
    return true
  }

  if (platforms.includes('win32-x64')) {
    const zip = `Babel-Desktop-${version}-win-x64.zip`
    const setup = `Babel-Desktop-Setup-${version}-win-x64.exe`
    const setupBuild = `${setup}.build.json`
    if (requireFile(zip)) artifacts.zip = { name: zip, sha256: digestOf(join(distDir, zip)), checksumBinding: 'sha256sums' }
    if (requireFile(setup)) artifacts.setup = { name: setup, sha256: digestOf(join(distDir, setup)), checksumBinding: 'sidecar' }
    if (requireFile(`${setup}.sha256`)) {
      const sidecar = readFileSync(join(distDir, `${setup}.sha256`), 'utf8').trim()
      if (artifacts.setup && sidecar !== artifacts.setup.sha256) problems.push('Setup.exe checksum sidecar does not match the Setup bytes')
    }
    if (requireFile(setupBuild)) {
      const build = JSON.parse(readFileSync(join(distDir, setupBuild), 'utf8'))
      if (build.installerSourceSha !== sourceSha) problems.push('Setup build installerSourceSha does not match the frozen source')
      if (build.payloadSourceSha !== sourceSha) problems.push('Setup build payloadSourceSha does not match the frozen source')
      if (build.payloadVersion !== version) problems.push('Setup build payloadVersion does not match the release version')
      if (build.signed !== false) problems.push('Setup build does not record its unsigned publisher status')
      if (artifacts.zip && build.payloadSha256 !== artifacts.zip.sha256) problems.push('Setup payload digest does not match the distributed ZIP')
    }
  }

  const tgz = `babel-harness-${version}.tgz`
  if (requireFile(tgz)) artifacts.cli = { name: tgz, sha256: digestOf(join(distDir, tgz)), checksumBinding: 'sha256sums' }

  if (platforms.includes('linux-x64')) {
    const appImage = `Babel-Desktop-${version}-linux-x64.AppImage`
    const appBuild = `${appImage}.build.json`
    if (requireFile(appImage)) artifacts.appImage = { name: appImage, sha256: digestOf(join(distDir, appImage)), checksumBinding: 'sha256sums' }
    if (requireFile(appBuild)) {
      const build = JSON.parse(readFileSync(join(distDir, appBuild), 'utf8'))
      if (build.sourceSha !== sourceSha) problems.push('AppImage build sourceSha does not match the frozen source')
      if (build.version !== version) problems.push('AppImage build version does not match the release version')
      if (build.signed !== false) problems.push('AppImage build does not record its unsigned publisher status')
      if (build.updateChannel !== null) problems.push('AppImage build advertises an update channel')
      if (artifacts.cli && build.cliArchiveSha256 !== artifacts.cli.sha256) problems.push('AppImage embedded CLI digest does not match the distributed CLI tarball')
    }
  }

  if (platforms.includes('win32-x64') && requireFile('manifest.json')) {
    const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'))
    assert.ok(Array.isArray(manifest), 'Windows manifest must be a file inventory')
  }
  if (platforms.includes('linux-x64') && requireFile('manifest-linux-x64.json')) {
    const manifest = JSON.parse(readFileSync(join(distDir, 'manifest-linux-x64.json'), 'utf8'))
    assert.ok(Array.isArray(manifest), 'Linux manifest must be a file inventory')
  }

  if (requireFile('SHA256SUMS')) {
    const sums = parseChecksums(readFileSync(join(distDir, 'SHA256SUMS'), 'utf8'))
    for (const [name, digest] of sums) {
      if (!present(name)) problems.push(`SHA256SUMS names a missing file: ${name}`)
      else if (digestOf(join(distDir, name)) !== digest) problems.push(`SHA256SUMS digest mismatch: ${name}`)
    }
    for (const artifact of Object.values(artifacts)) {
      if (artifact.checksumBinding === 'sidecar') continue
      if (!sums.has(artifact.name)) problems.push(`SHA256SUMS does not bind ${artifact.name}`)
    }
    const unexpected = [...sums.keys()].filter(name => !Object.values(artifacts).some(artifact => artifact.name === name))
    if (unexpected.length) problems.push(`SHA256SUMS binds unexpected files: ${unexpected.join(', ')}`)
  }

  if (npmCandidateDir) {
    const candidate = JSON.parse(readFileSync(join(npmCandidateDir, 'manifest.json'), 'utf8'))
    if (candidate.sourceSha !== sourceSha) problems.push('npm candidate source does not match the release source')
    if (candidate.version !== version) problems.push('npm candidate version does not match the release version')
    if (artifacts.cli && candidate.sha256 !== artifacts.cli.sha256) problems.push('GitHub CLI tarball is not bytewise identical to the npm-qualified candidate')
  }

  if (requireAppImageLaunch && !appImageEvidence) problems.push('AppImage launch evidence is required before promotion')
  if (appImageEvidence) {
    assert.ok(existsSync(appImageEvidence), `AppImage launch evidence is missing: ${appImageEvidence}`)
    const evidence = JSON.parse(readFileSync(appImageEvidence, 'utf8'))
    if (evidence.status !== 'pass' || evidence.window_visible !== true) problems.push('AppImage launch evidence does not record a visible window')
    if (typeof evidence.appimage_sha256 !== 'string') problems.push('AppImage launch evidence does not record the launched artifact digest')
    else if (artifacts.appImage && evidence.appimage_sha256 !== artifacts.appImage.sha256) problems.push('AppImage launch evidence was recorded for different bytes')
  }

  // Record the Desktop advisory outcome. A deferred advisory keeps Desktop
  // artifacts unqualified, but it is an explicit owner decision rather than a
  // missing record; an unavailable review fails the promotion gate.
  let advisoryReview = null
  try {
    const review = verifyAdvisoryReview({ repoRoot, scope: 'desktop' })
    advisoryReview = {
      scope: 'desktop',
      status: review.status,
      review: review.review,
      reviewSha256: review.reviewSha256,
      ownerDecisionRequired: review.status !== 'PASS',
      deferred: review.advisories
        .filter(entry => entry.scopeAffected && (entry.decision === 'deferred' || entry.decision === 'accepted_risk'))
        .map(entry => ({ id: entry.id, package: entry.package, decision: entry.decision, installed: entry.installed })),
      blockers: review.problems,
    }
  } catch (error) {
    problems.push(`desktop advisory review outcome unavailable: ${error.message}`)
  }

  const unexpected = names.filter(name => !expected.has(name))
  if (unexpected.length) problems.push(`unexpected staged release files: ${unexpected.join(', ')}`)

  return { status: problems.length ? 'FAIL' : 'PASS', version, sourceSha, artifacts, advisoryReview, problems }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries([
      'dist', 'version', 'source', 'platforms', 'npm-candidate', 'appimage-evidence', 'result',
    ].map(key => [key, { type: 'string' }])) })
    const result = verifyReleaseDist({
      distDir: resolve(values.dist),
      version: values.version,
      sourceSha: values.source,
      platforms: values.platforms ? values.platforms.split(',') : undefined,
      npmCandidateDir: values['npm-candidate'] ? resolve(values['npm-candidate']) : null,
      appImageEvidence: values['appimage-evidence'] ? resolve(values['appimage-evidence']) : null,
      requireAppImageLaunch: values.platforms ? values.platforms.includes('linux-x64') : true,
    })
    const rendered = JSON.stringify(result, null, 2) + '\n'
    if (values.result) writeFileSync(resolve(values.result), rendered)
    if (process.env.GITHUB_STEP_SUMMARY) {
      const advisory = result.advisoryReview
      const line = advisory
        ? `Desktop advisory review: **${advisory.status}**${advisory.ownerDecisionRequired ? ' (owner decision required)' : ''}` +
          (advisory.deferred.length ? ` — ${advisory.deferred.map(entry => `${entry.id} (${entry.package} ${entry.installed.map(item => item.version).join('/')}) ${entry.decision}`).join('; ')}` : '') + '\n'
        : 'Desktop advisory review: **unavailable**\n'
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, line)
    }
    console.log(rendered)
    if (result.status !== 'PASS') process.exitCode = 1
  } catch (error) {
    console.error(`Release artifact verification unavailable: ${error.message}`)
    process.exitCode = 1
  }
}
