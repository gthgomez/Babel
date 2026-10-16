import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getSafeEnv } from '../utils/safeEnv.js'
import { parseOwnedFileAssertionV1 } from './ownedFileAssertion.js'

function manifest(expected = 'required\n', candidate_path = 'output.txt') {
  return { schema_version: 1, kind: 'owned_file_assertion_v1', candidate_path,
    operation: 'utf8_equals', expected }
}

test('owned assertion parsing admits only the bounded literal manifest', () => {
  const parsed = parseOwnedFileAssertionV1(manifest())
  assert.deepEqual(parsed, manifest())
  assert.ok(Object.isFrozen(parsed))
  assert.equal(parseOwnedFileAssertionV1(manifest('')).expected, '')
  assert.equal(parseOwnedFileAssertionV1(manifest('a'.repeat(32768))).expected.length, 32768)
  for (const input of [null, [], {}, { ...manifest(), pass: true },
    { ...manifest(), schema_version: 2 }, { ...manifest(), kind: 'node_test' },
    { ...manifest(), operation: 'eval' }, manifest('a'.repeat(32769)),
    manifest('😀'.repeat(8193)), manifest('\ud800'), { ...manifest(), expected: 42 }]) {
    assert.throws(() => parseOwnedFileAssertionV1(input), /OWNED_ASSERTION_MANIFEST_INVALID/)
  }
})

test('owned assertions reject ambiguous, credential and platform device paths', () => {
  for (const path of ['', '../output.txt', 'src/../output.txt', '/output.txt',
    'C:/output.txt', 'src\\output.txt', 'src//output.txt', 'src/output.txt/',
    '.env', '.codex/auth.json', 'secrets/output.txt', 'src/key.pem', 'src/id_rsa',
    'src/credentials.json', 'CON.txt', 'aux', 'src/COM1.json', 'src/output.txt:stream',
    'src/output.', 'src/output ', 'src/\noutput.txt']) {
    assert.throws(() => parseOwnedFileAssertionV1(manifest('value', path)),
      /OWNED_ASSERTION_MANIFEST_INVALID/)
  }
})

test('manifest getters cannot run during parsing', () => {
  let calls = 0
  const input = { ...manifest(), get expected() { calls++; return 'value' } }
  assert.throws(() => parseOwnedFileAssertionV1(input), /OWNED_ASSERTION_MANIFEST_INVALID/)
  assert.equal(calls, 0)
})

test('retired Node oracle exports only the pure manifest parser', async () => {
  const module = await import('./ownedFileAssertion.js')
  assert.deepEqual(Object.keys(module), ['parseOwnedFileAssertionV1'])
})

test('legacy direct invocation fails closed without opening argument-selected data', () => {
  const runner = fileURLToPath(new URL('../../dist/authority/ownedFileAssertion.js', import.meta.url))
  const child = spawnSync(process.execPath, [runner, '--run', 'unavailable-root', 'unavailable-manifest', '0'.repeat(64)],
    { env: getSafeEnv(process.env), encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true })
  assert.equal(child.status, 2)
  assert.deepEqual(JSON.parse(child.stdout), {
    schema_version: 1, status: 'unsupported', reason_code: 'node_oracle_retired',
  })
  assert.equal(child.stderr, '')
})
