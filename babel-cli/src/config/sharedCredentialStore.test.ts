import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createKeyringBackend, createPosixHelperRunner, createSharedCredentialStore, createWindowsCredentialBackend, createWindowsHelperRunner, type CredentialBackend } from './sharedCredentialStore.js'

const accountA = '11111111-1111-4111-8111-111111111111'
const accountB = '22222222-2222-4222-8222-222222222222'
const refA = `babel-os-v1:${accountA}`
const refB = `babel-os-v1:${accountB}`

function memoryBackend(): CredentialBackend {
  const values = new Map<string, string>()
  return {
    get: id => values.get(id) ?? null,
    set: (id, value) => { values.set(id, value) },
    remove: id => values.delete(id),
  }
}

test('separate accounts use immutable opaque references and verified writes', () => {
  const backend = memoryBackend()
  const a = createSharedCredentialStore(backend, () => accountA)
  const b = createSharedCredentialStore(backend, () => accountB)
  assert.equal(a.save('synthetic-key-a'), refA)
  assert.equal(b.save('synthetic-key-b'), refB)
  assert.equal(a.read(refA), 'synthetic-key-a')
  assert.equal(a.read(refB), 'synthetic-key-b')
  assert.throws(() => a.save('replacement'), /already exists/i)
  assert.equal(a.read(refA), 'synthetic-key-a')
  assert.equal(a.remove(refA), true)
  assert.throws(() => a.read(refA), /missing/i)
  assert.equal(a.read(refB), 'synthetic-key-b')
})

test('unavailable storage fails closed and errors never echo a key', () => {
  const key = 'synthetic-key-never-echo'
  const backend: CredentialBackend = {
    get: () => { throw new Error(`private detail ${key}`) },
    set: () => { throw new Error('not reached') },
    remove: () => { throw new Error('not reached') },
  }
  const store = createSharedCredentialStore(backend, () => accountA)
  assert.throws(() => store.read(refA), error => error instanceof Error && /unavailable/i.test(error.message) && !error.message.includes(key))
  assert.throws(() => store.save(key), error => error instanceof Error && /unavailable/i.test(error.message) && !error.message.includes(key))
  assert.throws(() => store.remove(refA), error => error instanceof Error && /unavailable/i.test(error.message) && !error.message.includes(key))
})

test('uncertain writes are not retried, deleted, or reported as saved', () => {
  let reads = 0, writes = 0, deletes = 0
  const backend: CredentialBackend = {
    get: () => { reads++; return reads === 1 ? null : 'different-key' },
    set: () => { writes++ },
    remove: () => { deletes++; return true },
  }
  const store = createSharedCredentialStore(backend, () => accountA)
  assert.throws(() => store.save('synthetic-key'), /could not be confirmed/i)
  assert.equal(writes, 1)
  assert.equal(deletes, 0)
})

test('invalid references cannot address arbitrary operating-system entries', () => {
  let calls = 0
  const backend: CredentialBackend = { get: () => { calls++; return null }, set: () => { calls++ }, remove: () => { calls++; return false } }
  const store = createSharedCredentialStore(backend)
  for (const ref of ['other:abc', '../another-app', 'babel-os-v1:invalid', 'babel-os-v1:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
    assert.throws(() => store.read(ref), /invalid/i)
    assert.throws(() => store.remove(ref), /invalid/i)
  }
  assert.equal(calls, 0)
})

test('Linux explicitly requires Secret Service; unsupported platforms do not fall back', () => {
  const calls: unknown[][] = []
  class Entry {
    constructor(...args: unknown[]) { calls.push(args) }
    getPassword() { return null }
    setPassword() {}
    deletePassword() { return false }
  }
  assert.equal(createKeyringBackend(Entry, 'linux').get(accountA), null)
  assert.deepEqual(calls, [['Babel', accountA, { linux: { store: 'secret-service' } }]])
  assert.throws(() => createKeyringBackend(Entry, 'win32'), /unavailable/i)
})

test('Windows backend uses private input and rejects malformed or unavailable helper output', () => {
  const inputs: string[] = []
  const backend = createWindowsCredentialBackend(input => { inputs.push(input); return { status: 0, stdout: '{"ok":true,"result":true}' } })
  backend.set(accountA, 'synthetic-key')
  assert.deepEqual(JSON.parse(inputs[0]!), { operation: 'set', id: accountA, value: 'synthetic-key' })
  assert.throws(() => createWindowsCredentialBackend(() => ({ status: 1, stdout: '' })).get(accountA))
  assert.throws(() => createWindowsCredentialBackend(() => ({ status: 0, stdout: '{"ok":true,"result":42}' })).get(accountA))
})

test('Windows helper uses fixed bounded arguments and never passes credentials in argv or environment', () => {
  const key = 'synthetic-key-private-pipe'; let captured: { executable: string; args: string[]; options: Record<string, unknown> } | undefined
  const run = createWindowsHelperRunner({ systemRoot: 'C:\\Windows', helper: 'C:\\trusted\\helper.ps1', temp: 'C:\\Temp',
    invoke: (executable, args, options) => { captured = { executable, args, options }; return { status: 0, stdout: '{}' } } })
  const input = JSON.stringify({ operation: 'set', id: accountA, value: key })
  run(input)
  assert.equal(captured?.options['input'], input)
  assert.equal(captured?.options['shell'], false)
  assert.equal(captured?.options['windowsHide'], true)
  const timeout = captured?.options['timeout']
  assert.ok(typeof timeout === 'number' && timeout >= 35000 && timeout <= 45000,
    'Windows helper must allow the observed slow compiler while remaining bounded')
  assert.doesNotMatch(JSON.stringify(captured?.args), /synthetic-key|ExecutionPolicy/i)
  assert.doesNotMatch(JSON.stringify(captured?.options['env']), /synthetic-key|OPENROUTER/i)
})

test('Linux and macOS keyring workers are bounded and receive no ambient provider secrets', () => {
  const key = 'synthetic-private-pipe'; let captured: { executable: string; args: string[]; options: Record<string, unknown> } | undefined
  const run = createPosixHelperRunner({ executable: '/trusted/node', worker: '/trusted/worker.js',
    env: { HOME: '/profile', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/session', OPENROUTER_API_KEY: 'never-pass' },
    invoke: (executable, args, options) => { captured = { executable, args, options }; return { status: 0, stdout: '{}' } } })
  const input = JSON.stringify({ operation: 'set', id: accountA, value: key })
  run(input)
  assert.equal(captured?.options['input'], input)
  assert.equal(captured?.options['shell'], false)
  assert.equal(captured?.options['timeout'], 15000)
  assert.equal(captured?.options['killSignal'], 'SIGKILL')
  assert.doesNotMatch(JSON.stringify(captured?.args), /synthetic-private-pipe/)
  assert.doesNotMatch(JSON.stringify(captured?.options['env']), /never-pass|OPENROUTER/)
})

test('Windows helper compiles under the restricted process environment without touching a credential store', { skip: process.platform !== 'win32' ? 'Windows credential helper requires Windows' : false }, () => {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR']
  assert.ok(systemRoot)
  assert.ok(process.env['LOCALAPPDATA'])
  const userTemp = join(process.env['LOCALAPPDATA'], 'Temp')
  const run = createWindowsHelperRunner({ systemRoot, helper: fileURLToPath(new URL('./sharedCredential.windows.ps1', import.meta.url)),
    temp: userTemp, tmp: userTemp })
  const result = run(JSON.stringify({ operation: 'selftest', id: accountA }))
  assert.equal(result.status, 0, `Windows helper could not initialize in its restricted environment: ${result.stderr ?? ''}`)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: true })
})
