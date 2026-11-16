/** Bounded, pipe-only native keyring worker. Never logs inputs or native errors. */
import { createRequire } from 'node:module'
import { createKeyringBackend, isSharedCredentialReference } from './sharedCredentialStore.js'

const chunks: Buffer[] = []; let size = 0
process.stdin.on('data', (chunk: Buffer) => {
  size += chunk.length
  if (size > 32768) { process.exitCode = 1; process.stdin.destroy(); return }
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as { operation?: unknown; id?: unknown; value?: unknown }
    for (const chunk of chunks) chunk.fill(0)
    if (typeof input.id !== 'string' || !isSharedCredentialReference(`babel-os-v1:${input.id}`)) throw new Error()
    if (input.operation === 'selftest') { process.stdout.write('{"ok":true,"result":true}'); return }
    if (!['get', 'set', 'remove'].includes(String(input.operation))) throw new Error()
    const Entry = (createRequire(import.meta.url)('@napi-rs/keyring') as { Entry: Parameters<typeof createKeyringBackend>[0] }).Entry
    const backend = createKeyringBackend(Entry, process.platform)
    let result: string | boolean | null
    if (input.operation === 'get') result = backend.get(input.id)
    else if (input.operation === 'remove') result = backend.remove(input.id)
    else { if (typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 4096) throw new Error(); backend.set(input.id, input.value); result = true }
    process.stdout.write(JSON.stringify({ ok: true, result }))
  } catch {
    process.stdout.write('{"ok":false,"result":null}')
    process.exitCode = 1
  }
})
