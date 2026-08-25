import assert from 'node:assert/strict'
import test from 'node:test'
import { createBdnsObservationBus } from './observationBus.js'

function observation(kind: 'canonical_event' | 'process_started' = 'canonical_event', value = 1) {
  return {
    schemaVersion: 1 as const,
    source: 'canonical' as const,
    kind,
    correlation: { sessionId: 'session-1' },
    evidenceState: 'complete' as const,
    payload: { value },
  }
}

test('does not run subscriber work synchronously during publication', async () => {
  const bus = createBdnsObservationBus({ maxQueue: 4 })
  let observed = 0
  bus.subscribe({ id: 'fast', onObservation: () => { observed += 1 } })

  bus.publish(observation())
  assert.equal(observed, 0)
  await bus.flush()
  assert.equal(observed, 1)
  await bus.close()
})

test('isolates a throwing subscriber from a healthy subscriber', async () => {
  const failures: string[] = []
  const bus = createBdnsObservationBus({
    onSubscriberFailure: (id) => failures.push(id),
  })
  let healthy = 0
  bus.subscribe({ id: 'bad', onObservation: () => { throw new Error('observer exploded') } })
  bus.subscribe({ id: 'healthy', onObservation: () => { healthy += 1 } })

  bus.publish(observation())
  await bus.flush()
  assert.equal(healthy, 1)
  assert.deepEqual(failures, ['bad'])
  assert.equal(bus.health().evidenceState, 'observer_failed')
  await bus.close()
})

test('surfaces bounded queue overflow and coalescing', async () => {
  const bus = createBdnsObservationBus({ maxQueue: 1 })
  let release: () => void = () => undefined
  const blocked = new Promise<void>((resolve) => { release = resolve })
  bus.subscribe({
    id: 'slow',
    maxQueue: 1,
    onObservation: async () => blocked,
  })

  bus.publish(observation('process_started'))
  bus.publish(observation('canonical_event', 2))
  bus.publish(observation('canonical_event', 3))
  const health = bus.health()
  assert.ok(health.dropped + health.coalesced > 0)
  release()
  await bus.flush()
  await bus.close()
})

test('does not block publication on a slow subscriber', async () => {
  const bus = createBdnsObservationBus({ maxQueue: 2 })
  bus.subscribe({
    id: 'slow',
    onObservation: async () => new Promise<void>(() => undefined),
  })
  const started = performance.now()
  const result = bus.publish(observation())
  const elapsed = performance.now() - started
  assert.equal(result.queued, 1)
  assert.ok(elapsed < 100)
  await bus.close(1)
})
