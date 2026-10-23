import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicContentWorker } from '../public-content-worker.mjs'

test('worker reuses only local decisions and rechecks changed bytes, links, and duplicate titles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-content-worker-'))
  const source = join(root, 'source'), snapshot = join(root, 'snapshot')
  mkdirSync(source); mkdirSync(snapshot)
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=' + join(root, 'hooks'), '-C', source, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0)
    return r.stdout.trim()
  }
  const put = (path, text) => { writeFileSync(join(source, path), text); writeFileSync(join(snapshot, path), text) }
  const commit = () => { git('add', '--all'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  const worker = createPublicContentWorker(source)
  try {
    git('init', '-q')
    put('public.txt', 'synthetic public text\n')
    put('guide.md', '# Synthetic Guide\n[Target](public.txt)\n')
    let sha = commit()
    assert.equal((await worker.check(snapshot, sha)).exitCode, 0)
    assert.equal((await worker.check(snapshot, sha)).exitCode, 0)
    writeFileSync(join(snapshot, 'public.txt'), 'C:' + '\\Users\\SyntheticFixture\\private\n')
    assert.equal((await worker.check(snapshot, sha)).exitCode, 1)
    put('public.txt', 'synthetic public text\n')
    rmSync(join(source, 'public.txt')); rmSync(join(snapshot, 'public.txt'))
    sha = commit()
    const broken = await worker.check(snapshot, sha)
    assert.equal(broken.exitCode, 1)
    assert.ok(broken.result.findings.some(f => f.path === 'guide.md'))
    put('public.txt', 'synthetic public text\n')
    put('second.md', '# Synthetic Guide\n')
    sha = commit()
    const duplicate = await worker.check(snapshot, sha)
    assert.equal(duplicate.exitCode, 1)
    assert.ok(duplicate.result.findings.some(f => f.path === 'second.md'))
  } finally { worker.close(); rmSync(root, { recursive: true, force: true }) }
})
