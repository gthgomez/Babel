// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRecordedBuildInputs, assertReleaseBuildInfo, captureRecordedBuildInputs } from './write_build_info.mjs'
import { npmNormalizedShebangDigest } from './consumer_archive.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(root, '..')
const output = resolve(process.argv[2] || join(root, '../artifacts/consumer-candidate'))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run with npm run package:release')
mkdirSync(output, {recursive: true})
function command(binary, args) {
  const r = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 300000, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  return r.stdout
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
assert.equal(command('git', ['status', '--porcelain']).trim(), '', 'Release packaging requires a clean candidate')
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim()
const sourceTreeSha = command('git', ['rev-parse', 'HEAD^{tree}']).trim()
assert.match(sourceSha, /^[a-f0-9]{40}$/)
assert.match(sourceTreeSha, /^[a-f0-9]{40}$/)
const recordedBuildInputs = captureRecordedBuildInputs(root)
assert.ok(recordedBuildInputs, 'Release packaging requires readable CLI build inputs')
command(process.execPath, [npmCli, 'run', 'check:source-provenance'])
// Advisory and dependency review run on the same lock the candidate will ship.
const dependencies = JSON.parse(command(process.execPath, ['scripts/check_installed_dependencies.mjs']))
assert.equal(dependencies.status, 'PASS', 'Installed dependencies drifted from the lock')
assert.equal(dependencies.lockSha256, recordedBuildInputs.packageLockSha256, 'Dependency check did not cover the recorded lockfile')
const advisories = JSON.parse(command(process.execPath, ['scripts/check_dependency_advisories.mjs', '--scope=npm']))
assert.equal(advisories.status, 'PASS', `Dependency advisories block npm qualification: ${advisories.problems.join('; ')}`)
command(process.execPath, [npmCli, 'run', 'build'])
command(process.execPath, ['scripts/stage_runtime_assets.mjs'])
const rows = JSON.parse(command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output]))
assert.equal(rows.length, 1, 'Exactly one release package must be produced')
const pack = rows[0]
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pack.name, packageJson.name, 'Packed name must match the candidate package')
assert.equal(pack.version, packageJson.version, 'Packed version must match the candidate package')
const bytes = readFileSync(join(output, pack.filename))
const sha = sha256(bytes)
const buildInfoBytes = readFileSync(join(root, 'dist', 'cli', 'build-info.json'))
const buildInfo = JSON.parse(buildInfoBytes)
assertReleaseBuildInfo(buildInfo, { packageVersion: packageJson.version, sourceCommit: sourceSha, sourceTree: sourceTreeSha, recordedBuildInputs })
assertRecordedBuildInputs(captureRecordedBuildInputs(root), recordedBuildInputs)
assert.equal(command('git', ['rev-parse', 'HEAD']).trim(), sourceSha, 'Candidate revision changed during release packaging')
assert.equal(command('git', ['status', '--porcelain']).trim(), '', 'Source changed during release packaging')
// Load payload qualification only after build and pack succeed: earlier gates
// (source provenance, dependency/advisory review) must stop the flow without
// depending on the inventory tooling.
const { loadPayloadInventory, payloadManifest } = await import('./release_artifact_inventory.mjs')
const inventory = loadPayloadInventory(repoRoot)
const payload = payloadManifest({ inventory, packageJson, files: pack.files })
// Compare the actual archive contents to staged distribution bytes, including ignored dist/.
const listing = command('tar', ['-tzf', join(output, pack.filename)]).trim().split(/\r?\n/)
const safeRelative = path => typeof path === 'string' && !/^[A-Za-z]:|^[\\/]|\\/.test(path) && !path.split('/').some(part => part === '..')
assert.ok(listing.every(path => path.startsWith('package/') && safeRelative(path)), 'Unsafe archive path')
const extracted = mkdtempSync(join(output, 'verify-'))
const archiveFiles = []
const binTargets = new Set(Object.values(packageJson.bin))
try {
  command('tar', ['-xzf', join(output, pack.filename), '-C', extracted])
  for (const file of pack.files) {
    assert.ok(safeRelative(file.path), 'Unsafe package file path')
    const archived = readFileSync(join(extracted, 'package', file.path))
    assert.deepEqual(archived, readFileSync(join(root, file.path)), 'Package content differs from validated build: ' + file.path)
    const npmShebangSha256 = binTargets.has(file.path) ? npmNormalizedShebangDigest(archived) : null
    archiveFiles.push({ ...file, sha256: sha256(archived), ...(npmShebangSha256 === null ? {} : { npmShebangSha256 }) })
  }
  // Re-run the advertised-payload proof against the extracted bytes, including bin shebangs.
  const extractedPackage = JSON.parse(readFileSync(join(extracted, 'package', 'package.json'), 'utf8'))
  const artifactPayload = payloadManifest({
    inventory,
    packageJson: extractedPackage,
    files: pack.files,
    readFile: path => readFileSync(join(extracted, 'package', path)),
  })
  assert.equal(artifactPayload.files, payload.files, 'Extracted payload inventory changed')
} finally { rmSync(extracted, { recursive: true, force: true }) }
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
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(output, 'SHA256SUMS'), `${sha}  ${pack.filename}\n`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha}\nsource_sha=${sourceSha}\narchive=${pack.filename}\nintegrity=${manifest.integrity}\n`)
console.log(JSON.stringify(manifest))
