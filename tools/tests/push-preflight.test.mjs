import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coveredPaths } from '../policy-integrity-manifest.mjs'
import { preflightPushCandidates, collectPushCandidates, runValidationStage, verifyStagedManifest, observeValidationWork, materializePushSnapshot } from '../validate-push-candidates.mjs'
import { readCommittedBlobs, readCommittedInventory } from '../committed-object-reader.mjs'

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
    const verified = events.filter(line => line.includes('manifest=verified'))
    assert.equal(verified.length, 1)
    assert.match(verified[0], /1\/2.*manifest=verified/)
    assert.ok(events.some(line => /preflight 2\/2.*status=failed/.test(line)))
    assert.deepEqual(collectPushCandidates(`refs/heads/feature ${two} refs/heads/feature ${'0'.repeat(40)}`, root, 'origin', { publishedTips: [one] }), [two])
    const oid = git('rev-parse', one + ':AGENTS.md')
    const objects = []
    await readCommittedBlobs(root, [oid, oid], (_oid, bytes) => objects.push(bytes))
    assert.equal(objects.length, 1)
    assert.deepEqual(objects[0], readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url))))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('object work reports live progress, preserves results and withholds failure details', async () => {
  const events = []
  let finished = false
  const result = await observeValidationWork('fixture', async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    finished = true
    return 42
  }, line => events.push({ line, finished }), 5)
  assert.equal(result, 42)
  assert.ok(events.some(event => event.line.includes('running') && !event.finished))
  assert.match(events.at(-1).line, /status=complete/)
  const failures = []
  await assert.rejects(observeValidationWork('failed fixture', async () => { throw new Error('synthetic withheld diagnostic') }, line => failures.push(line)), /withheld diagnostic/)
  assert.match(failures.at(-1), /status=failed/)
  assert.ok(failures.every(line => !line.includes('withheld diagnostic')))
})

test('snapshot transitions reuse unchanged blobs and preserve exact trees in either history order', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-snapshot-transition-'))
  const root = join(workspace, 'source'), snapshot = join(workspace, 'snapshot')
  mkdirSync(root)
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=' + join(workspace, 'no-hooks'), '-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const paths = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? paths(join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name]).sort()
  try {
    git('init', '-q')
    put('keep.txt', 'same'); put('edit.txt', 'first'); put('remove.txt', 'removed')
    put('directory-to-file/leaf.txt', 'old leaf'); put('file-to-directory', 'old file')
    git('add', '--all'); git('commit', '-qm', 'first tree')
    const first = readCommittedInventory(root, git('rev-parse', 'HEAD'))
    assert.deepEqual(await materializePushSnapshot(root, snapshot, first), { changed: 5, reused: 0, removed: 0 })
    const retainedDate = new Date('2001-01-01T00:00:00Z')
    utimesSync(join(snapshot, 'keep.txt'), retainedDate, retainedDate)
    put('edit.txt', 'second')
    rmSync(join(root, 'remove.txt')); rmSync(join(root, 'directory-to-file/leaf.txt'))
    rmdirSync(join(root, 'directory-to-file')); put('directory-to-file', 'new file')
    rmSync(join(root, 'file-to-directory')); put('file-to-directory/leaf.txt', 'new leaf')
    git('add', '--all'); git('commit', '-qm', 'second tree')
    const second = readCommittedInventory(root, git('rev-parse', 'HEAD'))
    assert.deepEqual(await materializePushSnapshot(root, snapshot, second, first), { changed: 3, reused: 1, removed: 3 })
    assert.deepEqual(paths(snapshot), second.map(entry => entry.path).sort())
    assert.equal(readFileSync(join(snapshot, 'edit.txt'), 'utf8'), 'second')
    assert.equal(readFileSync(join(snapshot, 'directory-to-file'), 'utf8'), 'new file')
    assert.equal(readFileSync(join(snapshot, 'file-to-directory/leaf.txt'), 'utf8'), 'new leaf')
    assert.equal(existsSync(join(snapshot, 'remove.txt')), false)
    // Push record order is not necessarily oldest-first. Reversing must work.
    await materializePushSnapshot(root, snapshot, first, second)
    assert.deepEqual(paths(snapshot), first.map(entry => entry.path).sort())
    assert.equal(readFileSync(join(snapshot, 'edit.txt'), 'utf8'), 'first')
    assert.equal(readFileSync(join(snapshot, 'remove.txt'), 'utf8'), 'removed')
    assert.equal(statSync(join(snapshot, 'keep.txt')).mtimeMs, retainedDate.getTime())
    const sentinel = join(workspace, 'sentinel')
    writeFileSync(sentinel, 'preserve')
    await assert.rejects(materializePushSnapshot(root, snapshot, second, [{ ...first[0], path: '../sentinel' }]), /escaped owned directory/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve')
    const aliasSnapshot = join(workspace, 'alias-snapshot')
    const aliases = [
      { ...first.find(entry => entry.path === 'keep.txt'), path: 'A/keep.txt' },
      { ...first.find(entry => entry.path === 'remove.txt'), path: 'a/gone.txt' },
    ]
    await materializePushSnapshot(root, aliasSnapshot, aliases)
    await materializePushSnapshot(root, aliasSnapshot, aliases.slice(0, 1), aliases)
    assert.equal(readFileSync(join(aliasSnapshot, 'A/keep.txt'), 'utf8'), 'same')
    assert.equal(existsSync(join(aliasSnapshot, 'a/gone.txt')), false)
    // Removing both aliases must remove the physical directory only once.
    const removedAliasSnapshot = join(workspace, 'removed-alias-snapshot')
    await materializePushSnapshot(root, removedAliasSnapshot, aliases)
    await materializePushSnapshot(root, removedAliasSnapshot, [], aliases)
    assert.deepEqual(paths(removedAliasSnapshot), [])
  } finally { rmSync(workspace, { recursive: true, force: true }) }
})

test('stage errors preserve exit status and never echo child source or diagnostics', async () => {
  const events = []
  await assert.rejects(runValidationStage(process.execPath, ['-e', 'console.error("synthetic-private-output");process.exitCode=7'], process.cwd(), 'fixture', line => events.push(line)), /rejected candidate/)
  assert.ok(events.some(line => line.includes('exit=7')))
  assert.ok(events.every(line => !line.includes('synthetic-private-output')))
  await assert.rejects(runValidationStage(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 'timeout-fixture', () => {}, 30), /timed out/)
})
