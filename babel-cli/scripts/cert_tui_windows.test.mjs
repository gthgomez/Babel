import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Windows Terminal presence does not certify unperformed manual checks', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('./cert_tui_windows.ps1', import.meta.url)).replaceAll("'", "''")
  const command = `function npx { $global:LASTEXITCODE = 0 }; $env:WT_SESSION = 'synthetic-session'; & '${script}'; exit $LASTEXITCODE`
  const child = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  })
  assert.equal(child.status, 3, child.stderr)
  assert.match(child.stdout, /BLOCKED:.*manual/i)
})
