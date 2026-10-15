import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { getSafeEnv } from '../utils/safeEnv.js'
import { evaluateOwnedFileAssertionV1, parseOwnedFileAssertionV1 } from './ownedFileAssertion.js'

function manifest(expected = 'required\n', candidate_path = 'output.txt') {
  return { schema_version: 1, kind: 'owned_file_assertion_v1', candidate_path,
    operation: 'utf8_equals', expected }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-owned-assertion-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

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

test('the owned data oracle observes red, an edit, green, then changed bytes', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'output.txt'), 'wrong\n')
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).status, 'failed')
  writeFileSync(join(root, 'output.txt'), 'required\n')
  const green = evaluateOwnedFileAssertionV1(root, manifest())
  assert.equal(green.status, 'passed')
  assert.equal(green.candidate_sha256, digest('required\n'))
  writeFileSync(join(root, 'output.txt'), 'external change\n')
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).status, 'failed')
  assert.equal(JSON.stringify(green).includes('required'), false)
})

test('literal comparison preserves BOM, line endings and Unicode bytes', t => {
  const root = fixture(t)
  for (const text of ['\ufeffvalue', 'value\r\n', 'e\u0301', '', '😀']) {
    writeFileSync(join(root, 'output.txt'), text)
    assert.equal(evaluateOwnedFileAssertionV1(root, manifest(text)).status, 'passed')
    assert.equal(evaluateOwnedFileAssertionV1(root, manifest(text + '\n')).status, 'failed')
  }
})

test('invalid UTF8 and oversized candidate files remain unsupported', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'output.txt'), Buffer.from([0xff]))
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).reason_code, 'candidate_not_utf8')
  writeFileSync(join(root, 'output.txt'), Buffer.alloc(1024 * 1024 + 1))
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).reason_code, 'candidate_unsupported')
})

test('hardlink aliases and directories cannot become assertion inputs', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'other.txt'), 'required\n')
  linkSync(join(root, 'other.txt'), join(root, 'output.txt'))
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).reason_code, 'candidate_unsupported')
  rmSync(join(root, 'output.txt'))
  mkdirSync(join(root, 'output.txt'))
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest()).reason_code, 'candidate_unsupported')
})

test('a directory link cannot redirect candidate reads outside the project', t => {
  const root = fixture(t), outside = fixture(t)
  writeFileSync(join(outside, 'output.txt'), 'required\n')
  symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(evaluateOwnedFileAssertionV1(root, manifest('required\n', 'redirect/output.txt')).status, 'unsupported')
})

test('invalid scope or manifest errors expose only bounded reason codes', t => {
  const root = fixture(t)
  for (const result of [evaluateOwnedFileAssertionV1('', manifest()),
    evaluateOwnedFileAssertionV1(root, manifest('private-fixture-literal', '../outside'))]) {
    assert.equal(result.status, 'unsupported')
    assert.equal(JSON.stringify(result).includes('private-fixture-literal'), false)
    assert.ok(JSON.stringify(result).length < 256)
  }
})

test('unsupported metadata and credential paths are refused before any content open', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'output.txt'), Buffer.alloc(1024 * 1024 + 1))
  let opens = 0
  const open = t.mock.method(fs, 'openSync', () => { opens++; throw new Error('fixture-open-denied') })
  const read = t.mock.method(fs, 'readFileSync', () => { opens++; throw new Error('fixture-read-denied') })
  syncBuiltinESMExports()
  const results = []
  try {
    results.push(evaluateOwnedFileAssertionV1(root, manifest()))
    results.push(evaluateOwnedFileAssertionV1(root, manifest('value', '.env')))
    results.push(evaluateOwnedFileAssertionV1(join(root, '.codex'), manifest()))
  } finally { open.mock.restore(); read.mock.restore(); syncBuiltinESMExports() }
  assert.equal(opens, 0)
  assert.ok(results.every(result => result.status === 'unsupported'))
})

test('a leaf replaced between admission and open is rejected before content reads', t => {
  const root = fixture(t), outside = fixture(t)
  const target = join(root, 'output.txt')
  writeFileSync(target, 'required\n')
  const other = join(outside, 'outside.txt')
  writeFileSync(other, 'outside fixture data')
  const originalOpen = fs.openSync, originalRead = fs.readSync
  let reads = 0
  const open = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    rmSync(target)
    linkSync(other, target)
    return originalOpen(...args)
  })
  const read = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    reads++
    return originalRead(...args)
  })
  syncBuiltinESMExports()
  let result
  try { result = evaluateOwnedFileAssertionV1(root, manifest()) }
  finally { open.mock.restore(); read.mock.restore(); syncBuiltinESMExports() }
  assert.equal(result.status, 'unsupported')
  assert.equal(reads, 0)
})

for (const restoreParent of [false, true]) {
  test(`a parent swap${restoreParent ? ' with ABA restoration' : ''} cannot expose outside bytes`, t => {
    const root = fixture(t), outside = fixture(t)
    const sub = join(root, 'sub'), retained = join(root, 'retained')
    mkdirSync(sub)
    writeFileSync(join(sub, 'auth.json'), 'inside fixture data')
    writeFileSync(join(outside, 'auth.json'), 'outside synthetic fixture data')
    const originalStat = fs.lstatSync, originalOpen = fs.openSync, originalRead = fs.readSync
    let swapped = false, reads = 0
    const stat = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      const observed = originalStat(...args)
      if (!swapped && args[0] === sub) {
        swapped = true
        renameSync(sub, retained)
        symlinkSync(outside, sub, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return observed
    })
    const open = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const descriptor = originalOpen(...args)
      if (restoreParent && swapped) {
        rmSync(sub)
        renameSync(retained, sub)
      }
      return descriptor
    })
    const read = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      reads++
      return originalRead(...args)
    })
    syncBuiltinESMExports()
    let result
    try { result = evaluateOwnedFileAssertionV1(root, manifest('expected', 'sub/auth.json')) }
    finally { stat.mock.restore(); open.mock.restore(); read.mock.restore(); syncBuiltinESMExports() }
    assert.equal(swapped, true)
    assert.equal(result.status, 'unsupported')
    assert.equal(reads, 0, 'Outside fixture bytes must never be read, even when the result eventually rejects')
  })
}

test('the built owned runner executes data assertions in a real isolated child', t => {
  const root = fixture(t)
  const runner = fileURLToPath(new URL('../../dist/authority/ownedFileAssertion.js', import.meta.url))
  assert.ok(existsSync(runner), 'Build the owned runner before exercising its real child entry point')
  // This is oracle-backend execution only, not governed criterion authority.
  const text = JSON.stringify(manifest())
  const hash = digest(text)
  const oraclePath = join(root, `owned-file-assertion-${hash}.json`)
  writeFileSync(oraclePath, text)
  const run = (manifestHash = hash, source = oraclePath) => spawnSync(process.execPath,
    [runner, '--run', root, source, manifestHash], { cwd: root, env: getSafeEnv(process.env),
      encoding: 'utf8', timeout: 10000, maxBuffer: 4096, windowsHide: true })
  writeFileSync(join(root, 'output.txt'), 'wrong\n')
  const red = run()
  assert.equal(red.status, 1)
  assert.equal(JSON.parse(red.stdout).status, 'failed')
  writeFileSync(join(root, 'output.txt'), 'required\n')
  const green = run()
  assert.equal(green.status, 0)
  assert.equal(JSON.parse(green.stdout).status, 'passed')
  assert.equal(green.stderr, '')
  assert.ok(green.stdout.length < 1024)
  assert.equal(green.stdout.includes('required'), false)
  const codeAsData = 'import { writeFileSync } from "node:fs"; writeFileSync("unexpected-effect", "bad")'
  const dataManifest = JSON.stringify(manifest(codeAsData))
  const dataHash = digest(dataManifest)
  const dataOraclePath = join(root, `owned-file-assertion-${dataHash}.json`)
  writeFileSync(dataOraclePath, dataManifest)
  writeFileSync(join(root, 'output.txt'), codeAsData)
  writeFileSync(join(root, 'package.json'), '{invalid project loader fixture')
  assert.equal(run(dataHash, dataOraclePath).status, 0)
  assert.equal(existsSync(join(root, 'unexpected-effect')), false)
  assert.equal(run('0'.repeat(64)).status, 2)
  writeFileSync(oraclePath, JSON.stringify(manifest('changed definition')))
  assert.equal(run().status, 2)
  assert.equal(run(hash, join(root, '.env')).status, 2)
})
