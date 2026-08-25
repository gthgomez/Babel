import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BdnsDiagnosticStore } from './diagnosticStore.js'

test('persists bounded redacted observations and an atomic summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bdns-store-'))
  try {
    const store = new BdnsDiagnosticStore({ root, maxBytes: 4096 })
    store.appendObservation({
      schemaVersion: 1,
      observerSequence: 1,
      source: 'process',
      kind: 'process_exited',
      correlation: {},
      wallTime: new Date().toISOString(),
      monotonicTimeMs: 1,
      evidenceState: 'complete',
      payload: { api_key: 'secret-value' },
    })
    store.writeSummary({ status: 'partial', count: 1 })
    await store.flush()
    assert.match(await readFile(store.observationsPath, 'utf8'), /\[REDACTED\]/)
    assert.match(await readFile(store.summaryPath, 'utf8'), /partial/)
    assert.equal(store.health().failures, 0)
    await store.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writer failure degrades diagnostics without throwing to the caller', async () => {
  const store = new BdnsDiagnosticStore({
    root: join(tmpdir(), 'bdns-store-failure'),
    appendLine: async () => { throw new Error('disk unavailable') },
  })
  store.appendIncident({
    schemaVersion: 1,
    incidentId: 'inc-1',
    category: 'PERSISTENCE_DEGRADED',
    correlation: {},
    facts: [],
    inferences: [],
    hypotheses: [],
    confidence: 'unknown',
    evidenceState: 'partial',
    createdAt: new Date().toISOString(),
  })
  await store.flush()
  assert.equal(store.health().evidenceState, 'persistence_degraded')
  await store.close()
})
