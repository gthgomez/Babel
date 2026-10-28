import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-hook-discovery-'))
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  mkdirSync(join(root, '.githooks')); mkdirSync(join(root, 'tools')); mkdirSync(join(root, 'bin'))
  for (const name of ['pre-commit', 'pre-push']) {
    copyFileSync(join(repository, '.githooks', name), join(root, '.githooks', name))
    chmodSync(join(root, '.githooks', name), 0o755)
  }
  writeFileSync(join(root, 'tools/validate-push-candidates.mjs'), "require('node:fs').appendFileSync(process.env.HOOK_PROBE, 'node-check\\n')\n")
  return { root, git }
}

test('tracked shell hooks are executable and Git discovers a harmless local dispatcher', () => {
  const tracked = spawnSync('git', ['ls-files', '--stage', '.githooks/pre-commit', '.githooks/pre-push'], { cwd: repository, encoding: 'utf8' })
  assert.equal(tracked.status, 0)
  assert.equal(tracked.stdout.trim().split('\n').length, 2)
  assert.ok(tracked.stdout.trim().split('\n').every(line => line.startsWith('100755 ')), tracked.stdout)
  const { root, git } = fixture()
  try {
    const marker = join(root, 'hook-ran')
    writeFileSync(join(root, '.githooks/probe'), '#!/bin/sh\nprintf invoked > "$HOOK_PROBE"\n'); chmodSync(join(root, '.githooks/probe'), 0o755)
    copyFileSync(join(root, '.githooks/probe'), join(root, '.githooks/pre-commit')); chmodSync(join(root, '.githooks/pre-commit'), 0o755)
    assert.equal(git('config', 'core.hooksPath', '.githooks').status, 0)
    writeFileSync(join(root, 'fixture.txt'), 'public fixture\n'); assert.equal(git('add', 'fixture.txt').status, 0)
    const committed = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, HOOK_PROBE: 'hook-ran' } })
    assert.equal(committed.status, 0, committed.stderr)
    assert.equal(readFileSync(marker, 'utf8'), 'invoked')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real shell entrypoints fail closed when a required checker is absent', () => {
  const { root } = fixture()
  try {
    // Bash is explicitly located before PATH is restricted; the hook itself
    // must discover prerequisites and fail before either checker can execute.
    const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' })
    assert.equal(bash.status, 0, bash.stderr)
    for (const name of ['pre-commit', 'pre-push']) {
      const result = spawnSync(bash.stdout.trim(), [join(root, '.githooks', name)], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /required local tool unavailable: node/)
    }
    writeFileSync(join(root, 'bin/node'), '#!/bin/sh\nexit 0\n'); chmodSync(join(root, 'bin/node'), 0o755)
    for (const name of ['pre-commit', 'pre-push']) {
      const result = spawnSync(bash.stdout.trim(), [join(root, '.githooks', name)], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') } })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /required local tool unavailable: pwsh/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installer preserves an existing dispatcher and verifies entrypoint prerequisites in an owned fixture', () => {
  const {root,git}=fixture()
  const installer=join(repository,'tools/install-hooks.ps1')
  try {
    assert.equal(git('config','core.hooksPath','.host-owned').status,0)
    const denied=spawnSync('pwsh',['-NoProfile','-File',installer],{cwd:root,encoding:'utf8'})
    assert.equal(denied.status,1,denied.stderr)
    assert.match(denied.stdout+denied.stderr,/existing hooks dispatcher/)
    assert.equal(git('config','--get','core.hooksPath').stdout.trim(),'.host-owned')
    assert.equal(git('config','--unset','core.hooksPath').status,0)
    const installed=spawnSync('pwsh',['-NoProfile','-File',installer],{cwd:root,encoding:'utf8'})
    assert.equal(installed.status,0,installed.stderr)
    assert.equal(git('config','--get','core.hooksPath').stdout.trim(),'.githooks')
    assert.doesNotMatch(installed.stdout,/no-verify/)
    assert.match(installed.stdout,process.platform==='win32'?/execution is unverified/:/entrypoints are executable/)
  } finally {rmSync(root,{recursive:true,force:true})}
})
