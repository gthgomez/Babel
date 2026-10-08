// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
assert.equal(command('git', ['status', '--porcelain']).trim(), '', 'Release packaging requires a clean candidate')
command(process.execPath, [npmCli, 'run', 'check:source-provenance'])
command(process.execPath, [npmCli, 'run', 'build'])
command(process.execPath, ['scripts/stage_runtime_assets.mjs'])
const rows = JSON.parse(command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output]))
assert.equal(rows.length, 1, 'Exactly one release package must be produced')
const pack = rows[0]
const bytes = readFileSync(join(output, pack.filename))
const sha256 = createHash('sha256').update(bytes).digest('hex')
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim()
assert.match(sourceSha, /^[a-f0-9]{40}$/)
const manifest = { schemaVersion: 1, sourceSha, candidateHead: process.env.CANDIDATE_HEAD || sourceSha,
  workflowSha: process.env.RELEASE_WORKFLOW_SHA, runId: process.env.GITHUB_RUN_ID,
  node: process.version, platform: process.platform, arch: process.arch,
  name: pack.name, version: pack.version, tarball: pack.filename, sha256,
  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), manifest: pack.files }
// Compare the actual archive contents to staged distribution bytes, including ignored dist/.
const listing = command('tar', ['-tzf', join(output, pack.filename)]).trim().split(/\r?\n/)
const safeRelative = path => typeof path === 'string' && !/^[A-Za-z]:|^[\\/]|\\/.test(path) && !path.split('/').some(part => part === '..')
assert.ok(listing.every(path => path.startsWith('package/') && safeRelative(path)), 'Unsafe archive path')
const extracted = mkdtempSync(join(output, 'verify-'))
try {
  command('tar', ['-xzf', join(output, pack.filename), '-C', extracted])
  for (const file of pack.files) {
    assert.ok(safeRelative(file.path), 'Unsafe package file path')
    assert.deepEqual(readFileSync(join(extracted, 'package', file.path)), readFileSync(join(root, file.path)), 'Package content differs from validated build: ' + file.path)
  }
} finally { rmSync(extracted, { recursive: true, force: true }) }
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${pack.filename}\n`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\nsource_sha=${sourceSha}\narchive=${pack.filename}\nintegrity=${manifest.integrity}\n`)
console.log(JSON.stringify(manifest))
