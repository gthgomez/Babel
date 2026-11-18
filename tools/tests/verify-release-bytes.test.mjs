import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyReleaseDist } from '../verify-release-bytes.mjs'

const source = 'a'.repeat(40)
const version = '0.2.1'

function releaseFixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'babel-release-bytes-'))
  const write = (name, body) => writeFileSync(join(dir, name), body)
  const sha = body => createHash('sha256').update(body).digest('hex')
  const zip = `Babel-Desktop-${version}-win-x64.zip`, setup = `Babel-Desktop-Setup-${version}-win-x64.exe`
  const appImage = `Babel-Desktop-${version}-linux-x64.AppImage`, tgz = `babel-harness-${version}.tgz`
  write(zip, 'zip-bytes'); write(setup, 'setup-bytes'); write(tgz, 'cli-bytes'); write(appImage, 'appimage-bytes')
  write(`${setup}.sha256`, sha('setup-bytes') + '\n')
  write(`${setup}.build.json`, JSON.stringify({ installerSourceSha: source, payloadSourceSha: source, payloadVersion: version, payloadSha256: sha('zip-bytes'), signed: false }))
  write(`${appImage}.build.json`, JSON.stringify({ sourceSha: source, version, signed: false, updateChannel: null, cliArchiveSha256: sha('cli-bytes') }))
  write('manifest.json', JSON.stringify([{ path: 'Babel Desktop.exe', bytes: 1, sha256: '0'.repeat(64) }]))
  write('manifest-linux-x64.json', JSON.stringify([{ path: 'babel-desktop', bytes: 1, sha256: '0'.repeat(64) }]))
  write('SHA256SUMS', `${sha('zip-bytes')}  ${zip}\n${sha('cli-bytes')}  ${tgz}\n${sha('appimage-bytes')}  ${appImage}\n`)
  for (const [name, body] of Object.entries(overrides)) write(name, body)
  return dir
}

function evidence(dir, digest) {
  const path = join(dir, '..', `evidence-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(path, JSON.stringify({ status: 'pass', window_visible: true, appimage_sha256: digest }))
  return path
}

test('exact staged release set passes with checksum and provenance binding', () => {
  const dir = releaseFixture()
  try {
    const digest = createHash('sha256').update('appimage-bytes').digest('hex')
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, appImageEvidence: evidence(dir, digest), requireAppImageLaunch: true })
    assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
    assert.equal(result.artifacts.cli.sha256, createHash('sha256').update('cli-bytes').digest('hex'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('checksum drift, missing AppImage evidence and wrong source fail closed', () => {
  const dir = releaseFixture({ SHA256SUMS: `${'0'.repeat(64)}  Babel-Desktop-${version}-win-x64.zip\n${'0'.repeat(64)}  babel-harness-${version}.tgz\n${'0'.repeat(64)}  Babel-Desktop-${version}-linux-x64.AppImage\n` })
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, requireAppImageLaunch: true })
    const problems = result.problems.join('\n')
    assert.equal(result.status, 'FAIL')
    assert.match(problems, /SHA256SUMS digest mismatch/)
    assert.match(problems, /AppImage launch evidence is required/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('AppImage launch evidence must belong to the distributed bytes', () => {
  const dir = releaseFixture()
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, appImageEvidence: evidence(dir, '1'.repeat(64)), requireAppImageLaunch: true })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems.join('\n'), /recorded for different bytes/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Build metadata must name the frozen source, version and unsigned status', () => {
  const dir = releaseFixture({
    [`Babel-Desktop-Setup-${version}-win-x64.exe.build.json`]: JSON.stringify({ installerSourceSha: 'b'.repeat(40), payloadSourceSha: 'b'.repeat(40), payloadVersion: '0.0.0', payloadSha256: '0'.repeat(64), signed: true }),
  })
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, platforms: ['win32-x64'] })
    const problems = result.problems.join('\n')
    assert.match(problems, /installerSourceSha does not match/)
    assert.match(problems, /payloadVersion does not match/)
    assert.match(problems, /unsigned publisher status/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('npm candidate bytes must equal the GitHub CLI tarball', () => {
  const dir = releaseFixture()
  const candidate = mkdtempSync(join(tmpdir(), 'babel-npm-candidate-'))
  try {
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ sourceSha: source, version, sha256: '2'.repeat(64) }))
    const mismatch = verifyReleaseDist({ distDir: dir, version, sourceSha: source, npmCandidateDir: candidate })
    assert.equal(mismatch.status, 'FAIL')
    assert.match(mismatch.problems.join('\n'), /not bytewise identical to the npm-qualified candidate/)
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ sourceSha: source, version, sha256: createHash('sha256').update('cli-bytes').digest('hex') }))
    const match = verifyReleaseDist({ distDir: dir, version, sourceSha: source, npmCandidateDir: candidate })
    assert.equal(match.status, 'PASS', JSON.stringify(match.problems))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(candidate, { recursive: true, force: true })
  }
})

test('unexpected staged files and unbound checksums fail closed', () => {
  const dir = releaseFixture({ 'notes.txt': 'scratch' })
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source })
    assert.match(result.problems.join('\n'), /unexpected staged release files: .*notes.txt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function linuxOnlyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'babel-release-linux-'))
  const sha = body => createHash('sha256').update(body).digest('hex')
  const appImage = `Babel-Desktop-${version}-linux-x64.AppImage`, tgz = `babel-harness-${version}.tgz`
  writeFileSync(join(dir, appImage), 'appimage-bytes')
  writeFileSync(join(dir, tgz), 'cli-bytes')
  writeFileSync(join(dir, `${appImage}.build.json`), JSON.stringify({ sourceSha: source, version, signed: false, updateChannel: null, cliArchiveSha256: sha('cli-bytes') }))
  writeFileSync(join(dir, 'manifest-linux-x64.json'), JSON.stringify([{ path: 'babel-desktop', bytes: 1, sha256: '0'.repeat(64) }]))
  writeFileSync(join(dir, 'SHA256SUMS'), `${sha('cli-bytes')}  ${tgz}\n${sha('appimage-bytes')}  ${appImage}\n`)
  return { dir, appImage, sha: sha('appimage-bytes') }
}

test('a Linux-only release does not require the Windows inventory', () => {
  const { dir, sha } = linuxOnlyFixture()
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, platforms: ['linux-x64'], appImageEvidence: evidence(dir, sha), requireAppImageLaunch: true })
    assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
    assert.equal(result.artifacts.zip, undefined)
    assert.equal(result.artifacts.setup, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a Windows-only release binds Setup through its sidecar and records the desktop advisory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-release-windows-'))
  const sha = body => createHash('sha256').update(body).digest('hex')
  const zip = `Babel-Desktop-${version}-win-x64.zip`, setup = `Babel-Desktop-Setup-${version}-win-x64.exe`, tgz = `babel-harness-${version}.tgz`
  try {
    writeFileSync(join(dir, zip), 'zip-bytes'); writeFileSync(join(dir, setup), 'setup-bytes'); writeFileSync(join(dir, tgz), 'cli-bytes')
    writeFileSync(join(dir, `${setup}.sha256`), sha('setup-bytes') + '\n')
    writeFileSync(join(dir, `${setup}.build.json`), JSON.stringify({ installerSourceSha: source, payloadSourceSha: source, payloadVersion: version, payloadSha256: sha('zip-bytes'), signed: false }))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([{ path: 'Babel Desktop.exe', bytes: 1, sha256: '0'.repeat(64) }]))
    writeFileSync(join(dir, 'SHA256SUMS'), `${sha('zip-bytes')}  ${zip}\n${sha('cli-bytes')}  ${tgz}\n`)
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, platforms: ['win32-x64'] })
    assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
    assert.equal(result.artifacts.setup.checksumBinding, 'sidecar')
    assert.equal(result.artifacts.zip.checksumBinding, 'sha256sums')
    assert.equal(result.artifacts.appImage, undefined)
    assert.equal(result.advisoryReview.scope, 'desktop')
    assert.match(result.advisoryReview.reviewedCheckoutSha, /^[a-f0-9]{40}$/)
    assert.equal(result.advisoryReview.status, 'FAIL')
    assert.equal(result.advisoryReview.ownerDecisionRequired, true)
    assert.equal(result.advisoryReview.deferred[0].id, 'GHSA-jr5w-w6x2-84p9')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unavailable desktop advisory review blocks promotion', () => {
  const { dir, sha } = linuxOnlyFixture()
  const emptyRoot = mkdtempSync(join(tmpdir(), 'babel-release-noreview-'))
  try {
    const result = verifyReleaseDist({ distDir: dir, version, sourceSha: source, platforms: ['linux-x64'], appImageEvidence: evidence(dir, sha), requireAppImageLaunch: true, repoRoot: emptyRoot })
    assert.equal(result.status, 'FAIL')
    assert.match(result.problems.join('\n'), /desktop advisory review outcome unavailable/)
    assert.equal(result.advisoryReview, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(emptyRoot, { recursive: true, force: true })
  }
})
