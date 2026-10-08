import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('push records select initial, non-HEAD, tag and multiple refs without mutating dirty files', async () => {
  const { collectPushCandidates } = await import('../validate-push-candidates.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-push-'))
  const zero = '0'.repeat(40)
  function git(...args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(root, 'file.txt'), 'one'); git('add', 'file.txt'); git('commit', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    writeFileSync(join(root, 'file.txt'), 'two'); git('add', 'file.txt'); git('commit', '-qm', 'two')
    const two = git('rev-parse', 'HEAD')
    git('tag', '-a', 'v1.0.0', '-m', 'fixture', one)
    const tag = git('rev-parse', 'v1.0.0')
    writeFileSync(join(root, 'file.txt'), 'dirty staged'); git('add', 'file.txt')
    writeFileSync(join(root, 'file.txt'), 'dirty unstaged')
    const before = git('diff', '--binary', 'HEAD')
    const records = `HEAD~1 ${one} refs/heads/old ${zero}\nrefs/heads/main ${two} refs/heads/main ${one}\nrefs/tags/v1.0.0 ${tag} refs/tags/v1.0.0 ${zero}\n(delete) ${zero} refs/heads/deleted ${two}\n`
    assert.deepEqual(new Set(collectPushCandidates(records, root, 'origin')), new Set([one, two]))
    assert.deepEqual(collectPushCandidates(`refs/heads/new ${two} refs/heads/new ${zero}`, root, 'origin'), [two, one])
    assert.throws(() => collectPushCandidates(`refs/heads/main ${two} refs/heads/main ${'f'.repeat(40)}`, root, 'origin'), /object unavailable/)
    assert.throws(() => collectPushCandidates('malformed', root, 'origin'), /record/)
    assert.equal(git('diff', '--binary', 'HEAD'), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('candidate credential path guard rejects case variants before archive export', async () => {
  const { assertExportableCandidate } = await import('../validate-push-candidates.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-push-paths-'))
  let candidateIndex = 0
  function candidate(path) {
    const candidateRoot = join(root, String(candidateIndex++))
    mkdirSync(candidateRoot)
    function git(...args) {
      const r = spawnSync('git', args, { cwd: candidateRoot, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.trim()
    }
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    const fullPath = join(candidateRoot, ...path.split('/'))
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, 'fixture path only')
    git('add', '-f', '--', path); git('commit', '-qm', `fixture ${path}`)
    return { root: candidateRoot, sha: git('rev-parse', 'HEAD') }
  }
  try {
    for (const path of ['.ENV', '.env.LOCAL', '.CODEX/AUTH.JSON']) {
      const { root: candidateRoot, sha } = candidate(path)
      assert.throws(() => assertExportableCandidate(candidateRoot, sha), /credential-class.*before export/, path)
    }
    const { root: candidateRoot, sha } = candidate('.ENV.EXAMPLE')
    assert.doesNotThrow(() => assertExportableCandidate(candidateRoot, sha))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
