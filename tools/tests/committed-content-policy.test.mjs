// License: Apache-2.0 — see LICENSE
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertExportableCandidate } from '../validate-push-candidates.mjs'

test('exported content checks use exact committed inventory without reading dirty source files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-committed-policy-'))
  const source = join(root, 'source')
  const snapshot = join(root, 'snapshot')
  function git(...args) {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    mkdirSync(source); mkdirSync(snapshot)
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(source, 'public.txt'), 'safe committed content\n')
    git('add', 'public.txt'); git('commit', '-qm', 'fixture')
    const sha = git('rev-parse', 'HEAD')
    writeFileSync(join(source, 'public.txt'), 'dirty content must not be scanned\n')
    writeFileSync(join(snapshot, 'public.txt'), 'safe committed content\n')
    const args = ['-NoProfile', '-File', fileURLToPath(new URL('../check-public-content-policy.ps1', import.meta.url)),
      '-RepoRoot', snapshot, '-PolicyPath', fileURLToPath(new URL('../security/public-content-policy.json', import.meta.url)),
      '-SourceRepository', source, '-SourceCommit', sha, '-OutputFormat', 'json']
    const run = () => spawnSync('pwsh', args, { encoding: 'utf8' })
    const safe = run()
    assert.equal(safe.status, 0, safe.stderr)
    assert.equal(JSON.parse(safe.stdout).status, 'pass')
    writeFileSync(join(snapshot, 'public.txt'), 'C:' + '\\Users\\SyntheticFixture\\private\n')
    const rejected = run()
    assert.equal(rejected.status, 1)
    assert.ok(JSON.parse(rejected.stdout).findings.some(finding => finding.path === 'public.txt'))
    args[args.indexOf('-SourceCommit') + 1] = 'not-a-sha'
    assert.notEqual(run().status, 0)
    writeFileSync(join(source, '.env'), '')
    git('add', '.env'); git('commit', '-qm', 'prohibited path fixture')
    args[args.indexOf('-SourceCommit') + 1] = git('rev-parse', 'HEAD')
    assert.throws(() => assertExportableCandidate(source, args[args.indexOf('-SourceCommit') + 1]), /before export/)
    const credentialPath = run()
    assert.notEqual(credentialPath.status, 0)
    assert.match(credentialPath.stderr, /Credential-class tracked path rejected before content access/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
