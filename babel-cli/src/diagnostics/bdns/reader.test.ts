import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadBdnsDiagnosticBundle } from './reader.js'

test('reports an absent BDNS bundle as missing', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'bdns-reader-'))
  const bundle = await loadBdnsDiagnosticBundle(runDir)
  assert.equal(bundle.status, 'missing')
  assert.deepEqual(bundle.errors, [])
})

test('does not load an oversized BDNS JSONL artifact', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'bdns-reader-'))
  const root = join(runDir, 'diagnostics', 'bdns')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'bdns-observations.jsonl'), 'x'.repeat(10 * 1024 * 1024 + 1), 'utf8')
  const bundle = await loadBdnsDiagnosticBundle(runDir)
  assert.equal(bundle.status, 'corrupt')
  assert.match(bundle.errors.join('\n'), /exceeds read limit/u)
})
