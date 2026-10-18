import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getSafeEnv } from '../utils/safeEnv.js'
import { parseOwnedFileAssertionV1 } from './ownedFileAssertion.js'

const host = 'C:/Program Files/PowerShell/7/pwsh.exe'
const sourceScript = fileURLToPath(new URL('./ownedFileAssertion.windows.ps1', import.meta.url))
const oracleScript = fileURLToPath(new URL('../../dist/authority/ownedFileAssertion.windows.ps1', import.meta.url))
const nativeOnly = { skip: process.platform !== 'win32' ? 'Windows NTFS native boundary; other platforms remain unsupported' : false }

test('the CLI build carries the exact owned native script without a source fallback', () => {
  assert.equal(existsSync(oracleScript), true, 'dist/authority/ownedFileAssertion.windows.ps1 must be produced by npm run build (copy_playbooks)')
  assert.deepEqual(readFileSync(oracleScript), readFileSync(sourceScript))
})
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

test('native boundary preserves literal, encoding, size, alias and malformed manifest refusals', nativeOnly, t => {
  assert.equal(process.platform, 'win32', 'This test qualifies Windows NTFS only')
  const root = mkdtempSync(join(tmpdir(), 'babel-native-matrix-'))
  const outside = mkdtempSync(join(tmpdir(), 'babel-native-matrix-outside-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const cases: Array<{ root: string; manifest: string; hash: string; status: string; reason?: string }> = []
  const add = (path: string, expected: string, status: string, options: {
    root?: string; text?: string; hash?: string; reason?: string
  } = {}) => {
    const text = options.text ?? JSON.stringify({ schema_version: 1, kind: 'owned_file_assertion_v1',
      operation: 'utf8_equals', candidate_path: path, expected })
    const hash = options.hash ?? createHash('sha256').update(text).digest('hex')
    const manifest = join(root, `owned-file-assertion-${hash}.json`)
    writeFileSync(manifest, text)
    cases.push({ root: options.root ?? root, manifest, hash, status, ...(options.reason ? { reason: options.reason } : {}) })
  }
  for (const [index, text] of ['\ufeffvalue', 'value\r\n', 'e\u0301', '', '😀',
    'import { writeFileSync } from "node:fs"; writeFileSync("unexpected-effect", "bad")'].entries()) {
    const path = `literal-${index}.txt`
    writeFileSync(join(root, path), text)
    add(path, text, 'passed')
    add(path, text + '\n', 'failed')
  }
  writeFileSync(join(root, 'package.json'), '{invalid project-loader fixture')
  writeFileSync(join(root, 'invalid.txt'), Buffer.from([0xff]))
  add('invalid.txt', 'value', 'unsupported', { reason: 'candidate_not_utf8' })
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1))
  add('large.txt', 'value', 'unsupported', { reason: 'candidate_unsupported' })
  mkdirSync(join(root, 'directory'))
  add('directory', 'value', 'unsupported')
  writeFileSync(join(root, 'single.txt'), 'value')
  linkSync(join(root, 'single.txt'), join(root, 'alias.txt'))
  add('alias.txt', 'value', 'unsupported', { reason: 'candidate_unsupported' })
  writeFileSync(join(outside, 'output.txt'), 'outside fixture')
  symlinkSync(outside, join(root, 'redirect'), 'junction')
  add('redirect/output.txt', 'outside fixture', 'unsupported')
  for (const path of ['../output.txt', 'src/../output.txt', '/output.txt', 'C:/output.txt',
    'src\\output.txt', 'src//output.txt', 'src/output.txt/', '.env', '.codex/auth.json',
    'secrets/output.txt', 'src/key.pem', 'src/id_rsa', 'src/credentials.json',
    'CON.txt', 'aux', 'src/COM1.json', 'src/output.txt:stream', 'src/output.', 'src/output ']) {
    add(path, 'value', 'unsupported', { reason: 'manifest_invalid' })
  }
  const valid = JSON.stringify({ schema_version: 1, kind: 'owned_file_assertion_v1',
    operation: 'utf8_equals', candidate_path: 'invalid.txt', expected: 'value' })
  for (const text of ['null', '[]', '{}', '{', valid.replace('"schema_version":1', '"schema_version":2'),
    valid.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
    valid.replace('"expected":"value"', '"expected":42'),
    valid.replace('"expected":"value"', '"expected":null'),
    valid.replace('"expected":"value"', `"expected":"${'a'.repeat(32769)}"`),
    valid.replace('"expected":"value"', '"expected":"\\ud800"')]) {
    add('invalid.txt', 'value', 'unsupported', { text })
  }
  add('invalid.txt', 'value', 'unsupported', { hash: '0'.repeat(64), reason: 'manifest_hash_mismatch' })
  for (const project of ['', '.', '\\\\localhost\\share', root + '/..', root + '/missing']) {
    add('invalid.txt', 'value', 'unsupported', { root: project })
  }
  // Compile once in a bounded child. All arguments are synthetic test data;
  // the native reader still opens and authenticates every manifest itself.
  const matrix = join(root, 'matrix.json')
  writeFileSync(matrix, JSON.stringify(cases))
  const probe = join(root, 'matrix.ps1')
  writeFileSync(probe, `param([string]$OracleScript, [string]$Matrix)
$ErrorActionPreference = 'Stop'
. $OracleScript
$cases = [IO.File]::ReadAllText($Matrix) | ConvertFrom-Json
$failures = 0
foreach ($case in $cases) {
  $result = [BabelOwnedFileOracleV1]::Run($case.root, $case.manifest, $case.hash)
  $output = $result.Json | ConvertFrom-Json
  if ($output.status -ne $case.status -or
      ($case.PSObject.Properties['reason'] -and $output.reason_code -ne $case.reason)) { $failures++ }
  if ($result.ExitCode -ne $(if ($case.status -eq 'passed') { 0 } elseif ($case.status -eq 'failed') { 1 } else { 2 })) { $failures++ }
}
[Console]::Out.WriteLine('{"cases":' + $cases.Count + ',"failures":' + $failures + '}')
if ($failures) { exit 1 }
`)
  const child = nativeChild(root, probe, ['-OracleScript', oracleScript, '-Matrix', matrix])
  const output = JSON.parse(child.stdout) as { cases: number; failures: number }
  assert.equal(output.cases, cases.length)
  assert.equal(output.failures, 0)
  assert.equal(child.status, 0)
  assert.equal(existsSync(join(root, 'unexpected-effect')), false)
  t.diagnostic(`${cases.length} native data/path/manifest cases executed`)
})

test('local Windows native oracle performs an actual red edit green data check', nativeOnly, t => {
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
  writeFileSync(join(root, 'output.txt'), 'external edit\n')
  assert.equal(run().output.status, 'failed')
})

for (const mode of ['watch_control', 'watch_native_control', 'hardlink', 'rename', 'attributes']) {
  const scenarios: Record<string, string> = {
    watch_control: 'outside watcher detects a real ordinary reader',
    watch_native_control: 'outside watcher detects the actual native oracle reader',
    hardlink: 'native hardlink refusal does not request outside data access',
    rename: 'native parent rename and ABA races cannot read outside bytes',
    attributes: 'native attribute-only reparse races cannot read outside bytes',
  }
  test(scenarios[mode]!, nativeOnly, t => {
    assert.equal(process.platform, 'win32', 'This test qualifies Windows NTFS only')
    const root = mkdtempSync(join(tmpdir(), 'babel-native-race-'))
    const outside = mkdtempSync(join(tmpdir(), 'babel-native-outside-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(outside, 'auth.json'), 'outside synthetic fixture data')
    if (mode === 'hardlink') linkSync(join(outside, 'auth.json'), join(root, 'sub/auth.json'))
    if (mode === 'rename') {
      writeFileSync(join(root, 'sub/auth.json'), 'inside fixture data')
      symlinkSync(outside, join(root, 'junction'), 'junction')
    }
    const text = JSON.stringify(parseOwnedFileAssertionV1({ schema_version: 1, kind: 'owned_file_assertion_v1',
      operation: 'utf8_equals', candidate_path: mode === 'watch_native_control' ? 'auth.json' : 'sub/auth.json', expected: 'outside synthetic fixture data' }))
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
    if (mode === 'watch_control' || mode === 'watch_native_control') {
      if (mode === 'watch_native_control') assert.equal(output['oracle_passed'], true, String(output['oracle_reason']))
      assert.ok(Number(output['outside_read_opens']) > 0, 'Calibrate the watcher with an actual synthetic outside-file read')
      return
    }
    if (mode === 'hardlink') {
      assert.equal(output['oracle_refused'], true)
      assert.equal(output['outside_read_opens'], 0, 'A pre-existing hardlink must not cause an outside read')
      return
    }
    assert.ok(Number(output['attempts']) > 4, 'The attack must actually attempt filesystem changes')
    assert.ok(Number(output['transitions']) > 4, 'The attack must successfully alter the fixture namespace or attributes')
    assert.ok(Number(output['oracle_calls']) > 0, 'The real native oracle must run during the attack')
    assert.equal(output['outside_passes'], 0)
    assert.equal(output['outside_read_opens'], 0, 'No outside read-open may be hidden by a later rejection')
  })
}
