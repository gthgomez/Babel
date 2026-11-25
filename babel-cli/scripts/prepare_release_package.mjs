// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRecordedBuildInputs, assertReleaseBuildInfo, captureRecordedBuildInputs, inspectBuildSource, readBuildGit } from './write_build_info.mjs'
import { verifyConsumerContents } from './consumer_archive.mjs'
import { loadPayloadInventory, npmNormalizedShebangDigest, payloadManifest, withExtractedArchive } from './release_artifact_inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = realpathSync(resolve(root, '..'))
const output = resolve(process.argv[2] || join(root, '../artifacts/consumer-candidate'))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run with npm run package:release')
function command(binary, args) {
  const r = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 300000, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  return r.stdout
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
const generatedPaths = [
  'babel-cli/node_modules', 'babel-cli/dist', 'babel-cli/resources', 'babel-cli/LICENSE', 'babel-cli/.tsbuildinfo',
  'artifacts/consumer-candidate', 'artifacts/consumer-package', 'WORKSPACE_CONTEXT.local.md',
]
function checkReleaseSource() {
  const state = inspectBuildSource(root)
  assert.equal(state.workingTreeClean, true, 'Release packaging requires a clean candidate')
  const entries = readBuildGit(repoRoot, ['ls-files', '-v', '-z'])
  assert.ok(entries && !entries.split('\0').some(entry => /^[a-zS] /.test(entry)), 'Release source has hidden Git index entries')
  const ignored = readBuildGit(repoRoot, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.',
    ...generatedPaths.map(path => ':(exclude,literal)' + path),
  ])
  assert.equal(ignored === '', true, 'Release source has ignored files outside generated paths')
  return state
}
const source = checkReleaseSource()
const { sourceCommit: sourceSha, sourceTree: sourceTreeSha } = source
assert.match(sourceSha, /^[a-f0-9]{40}$/)
assert.match(sourceTreeSha, /^[a-f0-9]{40}$/)
assert.equal(process.env.CANDIDATE_HEAD || sourceSha, sourceSha, 'Release checkout does not match the candidate head')
command(process.execPath, [npmCli, 'run', 'check:source-provenance'])
const recordedBuildInputs = captureRecordedBuildInputs(root)
assert.ok(recordedBuildInputs, 'Release packaging requires readable CLI build inputs')
// Advisory and dependency review run on the same lock the candidate will ship.
const dependencies = JSON.parse(command(process.execPath, ['scripts/check_installed_dependencies.mjs']))
assert.equal(dependencies.status, 'PASS', 'Installed dependencies drifted from the lock')
assert.equal(dependencies.lockSha256, recordedBuildInputs.packageLockSha256, 'Dependency check did not cover the recorded lockfile')
const advisories = JSON.parse(command(process.execPath, ['scripts/check_dependency_advisories.mjs', '--scope=npm']))
assert.equal(advisories.status, 'PASS', `Dependency advisories block npm qualification: ${advisories.problems.join('; ')}`)
command(process.execPath, [npmCli, 'run', 'build'])
command(process.execPath, ['scripts/stage_runtime_assets.mjs'])
const tempRoot = realpathSync(tmpdir())
function relativeToRepo(path) {
  const rel = relative(repoRoot, path)
  return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) ? null : rel
}
assert.equal(relativeToRepo(tempRoot), null, 'Release staging requires a temporary directory outside the source checkout')
const staging = mkdtempSync(join(tempRoot, 'babel-release-'))
try {
  const rows = JSON.parse(command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging]))
  assert.equal(rows.length, 1, 'Exactly one release package must be produced')
  const pack = rows[0]
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pack.name, packageJson.name, 'Packed name must match the candidate package')
  assert.equal(pack.version, packageJson.version, 'Packed version must match the candidate package')
  assert.match(pack.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/, 'Unsafe package archive name')
  const archive = join(staging, pack.filename)
  const bytes = readFileSync(archive)
  const sha = sha256(bytes)
  const buildInfoBytes = readFileSync(join(root, 'dist', 'cli', 'build-info.json'))
  const buildInfo = JSON.parse(buildInfoBytes)
  assertReleaseBuildInfo(buildInfo, { packageVersion: packageJson.version, sourceCommit: sourceSha, sourceTree: sourceTreeSha, recordedBuildInputs })
  assertRecordedBuildInputs(captureRecordedBuildInputs(root), recordedBuildInputs)
  // Read the frozen inventory only after build and pack succeed.
  const inventory = loadPayloadInventory(repoRoot)
  verifyConsumerContents(pack.files)
  const payload = payloadManifest({ inventory, packageJson, files: pack.files })
  const binTargets = new Set(Object.values(packageJson.bin))
  const archiveFiles = withExtractedArchive(archive, pack.files, read => {
    const receipts = pack.files.map(file => {
      const archived = read(file.path)
      assert.deepEqual(archived, readFileSync(join(root, file.path)), 'Package content differs from validated build: ' + file.path)
      assert.equal(archived.length, file.size, 'Pack file size differs from the archive: ' + file.path)
      const npmShebangSha256 = binTargets.has(file.path) ? npmNormalizedShebangDigest(archived) : null
      return { ...file, sha256: sha256(archived), ...(npmShebangSha256 === null ? {} : { npmShebangSha256 }) }
    })
    // Re-run the advertised-payload proof against the extracted bytes, including bin shebangs.
    const extractedPackage = JSON.parse(read('package.json'))
    const artifactPayload = payloadManifest({
      inventory,
      packageJson: extractedPackage,
      files: pack.files,
      readFile: read,
    })
    assert.equal(artifactPayload.files, payload.files, 'Extracted payload inventory changed')
    return receipts
  })
  const provenance = readFileSync(join(root, 'source-provenance.json'))
  const advisoryReview = readFileSync(resolve(repoRoot, 'config/dependency-advisory-review.json'))
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    sourceTreeSha,
    buildInfoSha256: sha256(buildInfoBytes),
    recordedBuildInputs,
    compilerVersion: buildInfo.typescriptVersion,
    candidateHead: process.env.CANDIDATE_HEAD || sourceSha,
    workflowSha: process.env.RELEASE_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    node: process.version,
    npm: process.env.npm_config_user_agent ?? null,
    platform: process.platform,
    arch: process.arch,
    name: pack.name,
    version: pack.version,
    tarball: pack.filename,
    sha256: sha,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    manifest: archiveFiles,
    inventory: payload,
    dependencies: {
      lockSha256: dependencies.lockSha256,
      checked: dependencies.checked,
      nodeVersion: dependencies.nodeVersion,
    },
    advisories: {
      review: 'config/dependency-advisory-review.json',
      reviewSha256: sha256(advisoryReview),
      reviewedAt: JSON.parse(advisoryReview).reviewedAt,
      scope: advisories.scope,
      status: advisories.status,
      lockSha256: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex'),
      decisions: advisories.advisories.map(entry => ({
        id: entry.id,
        package: entry.package,
        severity: entry.severity,
        decision: entry.decision,
        installed: entry.installed,
        affected: entry.affected,
      })),
    },
    provenance: {
      record: 'babel-cli/source-provenance.json',
      recordSha256: sha256(provenance),
      dirty: false,
    },
    publisherAuthenticity: {
      checksumsOnly: true,
      signed: false,
      reason: 'The npm tarball carries source provenance and checksums; npm provenance attestation is generated only by the authorized publish workflow. Windows Setup/ZIP Authenticode status is recorded by the Desktop build, which remains unsigned.',
    },
  }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(staging, 'SHA256SUMS'), `${sha}  ${pack.filename}\n`)
  assert.deepEqual(checkReleaseSource(), source, 'Source changed during release packaging')
  const outputNames = [pack.filename, 'SHA256SUMS', 'manifest.json']
  const configuredOutput = relativeToRepo(output)
  assert.ok(configuredOutput?.split(sep)[0].toLowerCase() !== '.git', 'Release output cannot be under Git metadata')
  mkdirSync(output, { recursive: true })
  const destination = realpathSync(output)
  const relativeOutput = relativeToRepo(destination)
  if (relativeOutput !== null) {
    assert.ok(relativeOutput.split(sep)[0].toLowerCase() !== '.git', 'Release output cannot be under Git metadata')
    const targets = outputNames.map(name => ':(top,literal)' + [relativeOutput, name].filter(Boolean).join('/').split(sep).join('/'))
    assert.equal(readBuildGit(repoRoot, ['ls-files', '--', ...targets]), '', 'Release output would replace a source file')
  }
  // Copy to the destination filesystem before replacing the final files. Readers
  // can qualify the archive only after the matching manifest is in place.
  const adjacent = mkdtempSync(join(destination, '.babel-release-'))
  try {
    for (const name of outputNames) copyFileSync(join(staging, name), join(adjacent, name))
    for (const name of outputNames) renameSync(join(adjacent, name), join(destination, name))
  } finally { rmSync(adjacent, { recursive: true, force: true }) }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha}\nsource_sha=${sourceSha}\narchive=${pack.filename}\nintegrity=${manifest.integrity}\n`)
  console.log(JSON.stringify(manifest))
} finally { rmSync(staging, { recursive: true, force: true }) }
