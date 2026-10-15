import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getSafeEnv } from '../utils/safeEnv.js'
import { parseOwnedFileAssertionV1 } from './ownedFileAssertion.js'

const host = 'C:/Program Files/PowerShell/7/pwsh.exe'
const oracleScript = fileURLToPath(new URL('./ownedFileAssertion.windows.ps1', import.meta.url))
function nativeChild(root: string, script: string, args: string[]) {
  const env = { ...getSafeEnv(process.env), PSModulePath: join(dirname(host), 'Modules'),
    POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_HOME: root,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' }
  const child = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4096, windowsHide: true })
  assert.equal(Boolean(child.error), false)
  assert.equal(Boolean(child.stderr), false)
  assert.ok(child.stdout.length < 1024)
  return child
}

test('local Windows native oracle performs an actual red edit green data check', t => {
  assert.equal(process.platform, 'win32', 'This test qualifies Windows NTFS only')
  const root = mkdtempSync(join(tmpdir(), 'babel-native-oracle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = parseOwnedFileAssertionV1({ schema_version: 1, kind: 'owned_file_assertion_v1',
    operation: 'utf8_equals', candidate_path: 'output.txt', expected: 'required\n' })
  const text = JSON.stringify(manifest)
  const hash = createHash('sha256').update(text).digest('hex')
  const manifestPath = join(root, `owned-file-assertion-${hash}.json`)
  writeFileSync(manifestPath, text)
  const run = () => {
    // Explicit system host is local qualification, never production fallback.
    const child = nativeChild(root, oracleScript,
      ['-ProjectRoot', root, '-ManifestPath', manifestPath, '-ManifestHash', hash])
    const output = JSON.parse(child.stdout) as { status: string; reason_code: string; candidate_sha256?: string }
    assert.match(output.reason_code, /^[a-z0-9_]+$/)
    return { exit: child.status, output }
  }
  writeFileSync(join(root, 'output.txt'), 'wrong\n')
  const red = run()
  assert.equal(red.output.status, 'failed', red.output.reason_code)
  assert.equal(red.exit, 1)
  writeFileSync(join(root, 'output.txt'), 'required\n')
  const green = run()
  assert.equal(green.output.status, 'passed', green.output.reason_code)
  assert.equal(green.exit, 0)
  assert.equal(green.output.candidate_sha256, createHash('sha256').update('required\n').digest('hex'))
})

for (const mode of ['watch_control', 'rename', 'attributes']) {
  test(`actual Windows ${mode} reparse races cannot make outside bytes satisfy the oracle`, t => {
    assert.equal(process.platform, 'win32', 'This test qualifies Windows NTFS only')
    const root = mkdtempSync(join(tmpdir(), 'babel-native-race-'))
    const outside = mkdtempSync(join(tmpdir(), 'babel-native-outside-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(outside, 'auth.json'), 'outside synthetic fixture data')
    if (mode === 'rename') {
      writeFileSync(join(root, 'sub/auth.json'), 'inside fixture data')
      symlinkSync(outside, join(root, 'junction'), 'junction')
    }
    const text = JSON.stringify(parseOwnedFileAssertionV1({ schema_version: 1, kind: 'owned_file_assertion_v1',
      operation: 'utf8_equals', candidate_path: 'sub/auth.json', expected: 'outside synthetic fixture data' }))
    const hash = createHash('sha256').update(text).digest('hex')
    const manifestPath = join(root, `owned-file-assertion-${hash}.json`)
    writeFileSync(manifestPath, text)
    const probe = fileURLToPath(new URL('../testinfra/owned-oracle-race.windows.ps1', import.meta.url))
    const child = nativeChild(root, probe, ['-OracleScript', oracleScript, '-ProjectRoot', root,
      '-OutsideRoot', outside, '-ManifestPath', manifestPath, '-ManifestHash', hash, '-Mode', mode])
    const output = JSON.parse(child.stdout) as Record<string, number | string | boolean>
    const code = String(output['compiler_codes'] ?? output['reason_code'] ?? 'probe_result')
    assert.match(code, /^[a-z0-9_]*$/)
    assert.equal(child.status, 0, code)
    if (mode === 'watch_control') {
      assert.ok(Number(output['outside_read_opens']) > 0, 'Calibrate the watcher with an actual synthetic outside-file read')
      return
    }
    assert.ok(Number(output['attempts']) > 4, 'The attack must actually attempt filesystem changes')
    assert.ok(Number(output['transitions']) > 4, 'The attack must successfully alter the fixture namespace or attributes')
    assert.ok(Number(output['oracle_calls']) > 0, 'The real native oracle must run during the attack')
    assert.equal(output['outside_passes'], 0)
    assert.equal(output['outside_read_opens'], 0, 'No outside read-open may be hidden by a later rejection')
  })
}
