import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coveredPaths } from '../policy-integrity-manifest.mjs'
import { preflightPushCandidates, collectPushCandidates, runValidationStage, verifyStagedManifest } from '../validate-push-candidates.mjs'
import { readCommittedBlobs } from '../committed-object-reader.mjs'

test('all candidate manifests fail early, before scanning, using committed rather than dirty bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-push-preflight-'))
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=' + join(root, 'hooks'), '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0)
    return r.stdout.trim()
  }
  try {
    for (const path of coveredPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      copyFileSync(fileURLToPath(new URL('../../' + path, import.meta.url)), join(root, path))
    }
    const generated = spawnSync(process.execPath, [fileURLToPath(new URL('../policy-integrity-manifest.mjs', import.meta.url)), 'generate', '--repo-root', root], { windowsHide: true })
    assert.equal(generated.status, 0)
    git('init', '-q'); git('add', '--all')
    assert.equal((await verifyStagedManifest(root)).status, 'VERIFIED')
    git('commit', '-qm', 'consistent')
    const one = git('rev-parse', 'HEAD')
    writeFileSync(join(root, 'AGENTS.md'), 'changed fixture policy\n')
    git('add', 'AGENTS.md'); git('commit', '-qm', 'stale manifest')
    const two = git('rev-parse', 'HEAD')
    copyFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), join(root, 'AGENTS.md'))
    await assert.rejects(verifyStagedManifest(root), /staged policy integrity mismatch/)
    git('add', 'AGENTS.md')
    assert.equal((await verifyStagedManifest(root)).status, 'VERIFIED')
    const events = []
    await assert.rejects(preflightPushCandidates([one, two], root, line => events.push(line)), /policy integrity.*preflight/)
    assert.equal(events.length, 1)
    assert.match(events[0], /1\/2.*manifest=verified/)
    assert.deepEqual(collectPushCandidates(`refs/heads/feature ${two} refs/heads/feature ${'0'.repeat(40)}`, root, 'origin', { publishedTips: [one] }), [two])
    const oid = git('rev-parse', one + ':AGENTS.md')
    const objects = []
    await readCommittedBlobs(root, [oid, oid], (_oid, bytes) => objects.push(bytes))
    assert.equal(objects.length, 1)
    assert.deepEqual(objects[0], readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url))))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stage errors preserve exit status and never echo child source or diagnostics', async () => {
  const events = []
  await assert.rejects(runValidationStage(process.execPath, ['-e', 'console.error("synthetic-private-output");process.exitCode=7'], process.cwd(), 'fixture', line => events.push(line)), /rejected candidate/)
  assert.ok(events.some(line => line.includes('exit=7')))
  assert.ok(events.every(line => !line.includes('synthetic-private-output')))
  await assert.rejects(runValidationStage(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 'timeout-fixture', () => {}, 30), /timed out/)
})
