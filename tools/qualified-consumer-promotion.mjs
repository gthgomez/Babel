// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPayloadInventory, verifyArchivePayload, verifyBuildInfoReceipt, verifyPackedPayload } from '../babel-cli/scripts/release_artifact_inventory.mjs'

const TRUSTED_WORKFLOW = 'typecheck.yml'
const ARTIFACT_NAME = 'consumer-candidate'

export function readCandidateManifest(candidateDir) {
  const manifestPath = join(candidateDir, 'manifest.json')
  assert.ok(existsSync(manifestPath), 'Qualified candidate manifest is missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.schemaVersion, 2, 'Unexpected candidate manifest schema; rebuild the qualified candidate')
  assert.match(manifest.sourceSha, /^[a-f0-9]{40}$/, 'Candidate sourceSha is invalid')
  assert.match(manifest.sourceTreeSha, /^[a-f0-9]{40}$/, 'Candidate sourceTreeSha is invalid')
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/, 'Candidate sha256 is invalid')
  assert.match(manifest.tarball ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/, 'Candidate tarball name is invalid')
  return manifest
}

/** Bind the immutable candidate metadata back to the checked-out frozen source. */
export function verifyManifestBinding({manifest, sourceRoot}) {
  const packageRoot = join(sourceRoot, 'babel-cli')
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const read = path => readFileSync(join(sourceRoot, path))
  const digest = path => createHash('sha256').update(read(path)).digest('hex')
  if (manifest.version !== pkg.version) throw new Error('Candidate version differs from the frozen source package')
  const bins = Object.entries(pkg.bin ?? {}).map(([alias, target]) => ({alias, target})).sort((a, b) => a.alias.localeCompare(b.alias))
  assert.deepEqual([...(manifest.inventory?.bin ?? [])].sort((a, b) => a.alias.localeCompare(b.alias)), bins, 'Candidate bin aliases differ from the frozen source package')
  if (manifest.inventory?.testOnlyShipped !== false) throw new Error('Candidate inventory does not exclude test-only payload')
  if (!Number.isInteger(manifest.inventory?.files) || manifest.inventory.files < 1) throw new Error('Candidate inventory file count is missing')
  const files = manifest.manifest ?? []
  if (files.length !== manifest.inventory.files) throw new Error('Candidate inventory count differs from the packed file list')
  // Re-derive the payload qualification from the frozen source inventory so a
  // stale or hand-edited manifest cannot self-certify its own file list.
  const payload = verifyPackedPayload({ inventory: loadPayloadInventory(sourceRoot), packageJson: pkg, files })
  if (payload.status !== 'PASS') throw new Error(`Candidate payload does not match the frozen source inventory: ${payload.problems.join('; ')}`)
  if (payload.testOnlyShipped) throw new Error(`Candidate ships classified test-only payload: ${payload.testOnlyFiles.join(', ')}`)
  if (manifest.inventory.files !== payload.files || manifest.inventory.unpackedBytes !== payload.bytes) {
    throw new Error('Candidate inventory summary differs from the packed file list')
  }
  for (const entry of manifest.inventory.bin) {
    if (!files.some(file => file.path === entry.target)) throw new Error(`Candidate bin target ${entry.target} is absent from the packed file list`)
  }
  for (const asset of manifest.inventory.requiredAssets ?? []) {
    if (!files.some(file => file.path === asset)) throw new Error(`Candidate required asset ${asset} is absent from the packed file list`)
  }
  if (manifest.advisories?.status !== 'PASS' || manifest.advisories?.scope !== 'npm') throw new Error('Candidate advisory review did not pass the npm artifact scope')
  if (manifest.advisories.lockSha256 !== digest('babel-cli/package-lock.json')) throw new Error('Candidate advisory review does not cover the frozen dependency lock')
  if (manifest.advisories.reviewSha256 !== digest('config/dependency-advisory-review.json')) throw new Error('Candidate advisory review record differs from the frozen source')
  if (manifest.provenance?.recordSha256 !== digest('babel-cli/source-provenance.json')) throw new Error('Candidate source provenance record differs from the frozen source')
  if (manifest.provenance?.dirty !== false) throw new Error('Candidate source provenance does not record a clean tree')
  const tree = spawnSync('git', ['--no-replace-objects', '-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' })
  if (tree.status !== 0) throw new Error(tree.stderr || 'Unable to read the frozen source tree')
  if (manifest.sourceTreeSha !== tree.stdout.trim()) throw new Error('Candidate sourceTreeSha does not match the checked-out frozen source tree')
  if (manifest.publisherAuthenticity?.signed !== false || manifest.publisherAuthenticity?.checksumsOnly !== true) throw new Error('Candidate publisher authenticity claims are not recorded accurately')
  return {packageVersion: pkg.version, binAliases: bins.map(entry => entry.alias), payloadFiles: payload.files}
}

export function verifyQualifiedCandidate({candidateDir, expectedSourceSha, expectedVersion, sourceRoot}) {
  const manifest = readCandidateManifest(candidateDir)
  if (expectedSourceSha && manifest.sourceSha !== expectedSourceSha) {
    throw new Error('Qualified candidate sourceSha does not match frozen release source')
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error('Qualified candidate version does not match release tag')
  }
  const archive = join(candidateDir, manifest.tarball)
  assert.ok(existsSync(archive), 'Qualified candidate archive is missing')
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (digest !== manifest.sha256) {
    throw new Error('Qualified candidate archive digest does not match manifest')
  }
  const sums = readFileSync(join(candidateDir, 'SHA256SUMS'), 'utf8')
  const bound = sums.split('\n').map(line => line.trim()).filter(Boolean).some(line => {
    const [hash, name] = line.split(/\s+/, 2)
    return hash === manifest.sha256 && name === manifest.tarball
  })
  if (!bound) throw new Error('Qualified candidate SHA256SUMS does not bind the archive')
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')
  if (manifest.integrity && manifest.integrity !== integrity) {
    throw new Error('Qualified candidate integrity does not match archive bytes')
  }
  if (sourceRoot) verifyManifestBinding({manifest, sourceRoot})
  assert.equal(manifest.dependencies?.lockSha256, manifest.advisories?.lockSha256, 'Candidate build lock differs from the advisory lock')
  const binTargets = Object.fromEntries(manifest.inventory.bin.map(({ alias, target }) => [alias, target]))
  const { packageJson, buildInfoBytes } = verifyArchivePayload({ archive, files: manifest.manifest, binTargets })
  assert.equal(packageJson.name, manifest.name, 'Archived package name differs from the receipt')
  assert.equal(packageJson.version, manifest.version, 'Archived package version differs from the receipt')
  verifyBuildInfoReceipt(buildInfoBytes, manifest)
  return {manifest, archive, digest, integrity}
}

export function stagePromotionCandidate({candidateDir, outputDir, expectedSourceSha, expectedVersion, expectedRunId = null, sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')}) {
  assert.match(expectedSourceSha ?? '', /^[a-f0-9]{40}$/, 'Promotion requires the frozen source SHA')
  assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0, 'Promotion requires the frozen release version')
  const verified = verifyQualifiedCandidate({candidateDir, expectedSourceSha, expectedVersion, sourceRoot})
  if (expectedRunId && String(verified.manifest.runId) !== String(expectedRunId)) {
    throw new Error('Qualified candidate producer run does not match downloaded artifact')
  }
  mkdirSync(outputDir, {recursive: true})
  for (const name of readdirSync(candidateDir)) {
    copyFileSync(join(candidateDir, name), join(outputDir, name))
  }
  return verified
}

/** Windows ships bsdtar; POSIX keeps unzip. No new Windows package dependency. */
export function extractCommand({ archive, outputDir, platform = process.platform }) {
  return platform === 'win32'
    ? { binary: 'tar.exe', args: ['-xf', archive, '-C', outputDir] }
    : { binary: 'unzip', args: ['-qo', archive, '-d', outputDir] }
}

/** Extract a GitHub artifact ZIP without adding an unqualified Windows dependency. */
export function extractArtifact({ archive, outputDir, platform = process.platform }) {
  const { binary, args } = extractCommand({ archive, outputDir, platform })
  return spawnSync(binary, args, {encoding: 'utf8'})
}

export async function downloadTrustedCandidate({repository, sourceSha, token, fetchImpl = globalThis.fetch}) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`}
  const runsUrl = `https://api.github.com/repos/${repository}/actions/workflows/${TRUSTED_WORKFLOW}/runs?head_sha=${sourceSha}&status=success&per_page=20`
  const runsResponse = await fetchImpl(runsUrl, {headers})
  if (!runsResponse.ok) throw new Error(`Unable to list trusted workflow runs (${runsResponse.status})`)
  const runsPayload = await runsResponse.json()
  const runs = (runsPayload.workflow_runs ?? []).filter(run =>
    run.head_sha === sourceSha &&
    run.conclusion === 'success' &&
    run.event === 'push',
  )
  for (const trustedRun of runs) {
    const artifactsUrl = `https://api.github.com/repos/${repository}/actions/runs/${trustedRun.id}/artifacts?per_page=100`
    const artifactsResponse = await fetchImpl(artifactsUrl, {headers})
    if (!artifactsResponse.ok) throw new Error(`Unable to list workflow artifacts (${artifactsResponse.status})`)
    const artifactsPayload = await artifactsResponse.json()
    const artifact = (artifactsPayload.artifacts ?? []).find(entry => entry.name === ARTIFACT_NAME && !entry.expired)
    if (artifact) {
      return {runId: trustedRun.id, artifactId: artifact.id, archiveDownloadUrl: artifact.archive_download_url}
    }
  }
  throw new Error('No successful trusted consumer producer run found for frozen source')
}

export async function downloadAndExtractTrustedCandidate({repository, sourceSha, token, outputDir, fetchImpl = globalThis.fetch}) {
  const meta = await downloadTrustedCandidate({repository, sourceSha, token, fetchImpl})
  const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`}
  const zipResponse = await fetchImpl(meta.archiveDownloadUrl, {headers, redirect: 'follow'})
  if (!zipResponse.ok) throw new Error(`Unable to download qualified artifact (${zipResponse.status})`)
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer())
  const zipPath = join(tmpdir(), `consumer-candidate-${meta.artifactId}.zip`)
  writeFileSync(zipPath, zipBytes)
  mkdirSync(outputDir, {recursive: true})
  const extraction = extractArtifact({archive: zipPath, outputDir})
  rmSync(zipPath, {force: true})
  if (extraction.status !== 0) throw new Error(extraction.stderr || 'Unable to extract qualified consumer artifact')
  // The downloaded artifact must still bind its own archive bytes and source.
  const verified = verifyQualifiedCandidate({candidateDir: outputDir, expectedSourceSha: sourceSha})
  return {...meta, archive: verified.archive, sha256: verified.digest}
}

function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) flags.set(key, 'true')
    else { flags.set(key, next); i += 1 }
  }
  return flags
}

function writePackOutputs(verified) {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${verified.digest}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${verified.manifest.sourceSha}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `archive=${verified.manifest.tarball}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `integrity=${verified.integrity}\n`)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.get('download') === 'true') {
    await downloadAndExtractTrustedCandidate({
      repository: flags.get('repository'),
      sourceSha: flags.get('source-sha'),
      token: process.env.GH_TOKEN,
      outputDir: resolve(flags.get('output')),
    })
    return
  }
  if (flags.get('stage') === 'true') {
    const verified = stagePromotionCandidate({
      candidateDir: resolve(flags.get('candidate-dir')),
      outputDir: resolve(flags.get('output')),
      expectedSourceSha: flags.get('expected-source'),
      expectedVersion: flags.get('expected-version'),
      expectedRunId: flags.get('expected-run-id'),
    })
    writePackOutputs(verified)
    return
  }
  throw new Error('Specify --download or --stage')
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
