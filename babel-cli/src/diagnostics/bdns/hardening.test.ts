import assert from 'node:assert/strict'
import test from 'node:test'
import { createBdnsObservationBus } from './observationBus.js'
import { stringifyBdns } from './serialization.js'

test('bounded soak preserves publication latency and exposes loss', async () => {
  const bus = createBdnsObservationBus<{ index: number }>({ maxQueue: 8 })
  const seen: number[] = []
  const unsubscribe = bus.subscribe({
    id: 'slow-soak-subscriber',
    maxQueue: 8,
    onObservation: async (observation) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      seen.push(observation.payload.index)
    },
  })

  const started = performance.now()
  for (let index = 0; index < 2_000; index += 1) {
    bus.publish({
      schemaVersion: 1,
      source: 'canonical',
      kind: 'canonical_event',
      correlation: {},
      evidenceState: 'complete',
      payload: { index },
    })
  }
  const publicationMs = performance.now() - started
  assert.ok(publicationMs < 500, `publication took ${publicationMs.toFixed(1)}ms`)
  assert.ok(bus.health().dropped + bus.health().coalesced > 0)
  await bus.flush()
  assert.ok(seen.length <= 8)
  unsubscribe()
  await bus.close()
})

test('hardening serializer never emits common secret-shaped values', () => {
  const line = stringifyBdns({ api_key: 'secret-value', authorization: 'Bearer secret-value' })
  assert.doesNotMatch(line, /secret-value/u)
  assert.match(line, /REDACTED/u)
})
