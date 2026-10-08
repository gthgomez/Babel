import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hook = fileURLToPath(new URL('../../.githooks/pre-commit.ps1', import.meta.url))
test('rejected source and scanner output never appear in hook diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-hook-'))
  const canaries = ['gh' + 'p_' + 'A'.repeat(27), 'sk_' + 'live_' + 'B'.repeat(27),
    'sk-' + 'proj-' + 'C'.repeat(27), 'D'.repeat(27)]
  function git(...args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  try {
    git('init', '-q')
    writeFileSync(join(root, 'sample.txt'), canaries.slice(0, 3).join('\n') + '\napi_key="' + canaries[3] + '"\n')
    git('add', 'sample.txt')
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin/gitleaks.ps1'), `Write-Output '${canaries[0]}'; exit 1`)
    const r = spawnSync('pwsh', ['-NoProfile', '-File', hook], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: join(root, 'bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH } })
    assert.equal(r.status, 1)
    for (const canary of canaries) assert.ok(!(r.stdout + r.stderr).includes(canary), 'raw rejected content leaked')
    assert.match(r.stdout, /GitHub token.*sample\.txt:1/s)
    assert.match(r.stdout, /Generic key assignment.*sample\.txt:4/s)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
