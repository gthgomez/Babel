// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRUSTED_WORKFLOW = 'typecheck.yml'
const ARTIFACT_NAME = 'consumer-candidate'

export function readCandidateManifest(candidateDir) {
  const manifestPath = join(candidateDir, 'manifest.json')
  assert.ok(existsSync(manifestPath), 'Qualified candidate manifest is missing')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.schemaVersion, 1, 'Unexpected candidate manifest schema')
  assert.match(manifest.sourceSha, /^[a-f0-9]{40}$/, 'Candidate sourceSha is invalid')
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/, 'Candidate sha256 is invalid')
  assert.ok(typeof manifest.tarball === 'string' && manifest.tarball.length > 0, 'Candidate tarball name missing')
  return manifest
}

export function verifyQualifiedCandidate({candidateDir, expectedSourceSha, expectedVersion}) {
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
  return {manifest, archive, digest, integrity}
}

export function stagePromotionCandidate({candidateDir, outputDir, expectedSourceSha, expectedVersion, expectedRunId = null}) {
  const verified = verifyQualifiedCandidate({candidateDir, expectedSourceSha, expectedVersion})
  if (expectedRunId && String(verified.manifest.runId) !== String(expectedRunId)) {
    throw new Error('Qualified candidate producer run does not match downloaded artifact')
  }
  mkdirSync(outputDir, {recursive: true})
  for (const name of readdirSync(candidateDir)) {
    copyFileSync(join(candidateDir, name), join(outputDir, name))
  }
  return verified
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
  const unzip = spawnSync('unzip', ['-qo', zipPath, '-d', outputDir], {encoding: 'utf8'})
  rmSync(zipPath, {force: true})
  if (unzip.status !== 0) throw new Error(unzip.stderr || 'Unable to extract qualified consumer artifact')
  return meta
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
