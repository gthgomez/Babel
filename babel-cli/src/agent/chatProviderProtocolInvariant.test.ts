import assert from 'node:assert/strict'
import test from 'node:test'
import { trace, type Span } from '@opentelemetry/api'
import { ChatEngine } from './chatEngine.js'
import type { ProviderMessage } from '../runners/base.js'
import { validateProviderMessageProtocol } from '../runners/providerMessages.js'
import {
  createProviderProtocolInvariant,
  createRequestReconstructionInvariant,
  MODEL_VISIBLE_EQUALS_PERSISTED,
  PROVIDER_PROTOCOL_VALID,
  RuntimeInvariantRegistry,
  RuntimeInvariantViolationError,
  type RequestReconstructionContext,
  type RuntimeInvariantMode,
} from './runtimeInvariants.js'

// Exercise the real dispatch assertion without constructor filesystem/model setup.
// Reconstruction deliberately agrees with outbound: C1 cannot mask a missing C2.
function boundary(mode: RuntimeInvariantMode, messages: ProviderMessage[]) {
  const registry = new RuntimeInvariantRegistry<RequestReconstructionContext>(mode)
  registry.register(createRequestReconstructionInvariant())
  registry.register(createProviderProtocolInvariant(validateProviderMessageProtocol))
  const engine = Object.assign(Object.create(ChatEngine.prototype), {
    runtimeInvariants: registry,
    parity: { eventLog: {} },
    services: { conversation: { rebuildProviderMessages: () => structuredClone(messages) } },
  }) as ChatEngine
  // A structural view avoids exposing the private seam in the production API.
  const seam = engine as unknown as {
    assertNativeRequestMatchesDurable: (
      outbound: ProviderMessage[], systemPrompt: string, override: string | undefined,
    ) => void
  }
  return { registry, check: (override: string | undefined) =>
    seam.assertNativeRequestMatchesDurable(messages, 'fixture system', override) }
}

const orphan: ProviderMessage[] = [
  { role: 'user', content: 'fixture private content' },
  { role: 'tool', content: 'fixture private result', tool_call_id: 'orphan' },
]
const paired: ProviderMessage[] = [
  { role: 'user', content: 'inspect fixture' },
  { role: 'assistant', content: '', tool_calls: [
    { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ] },
  { role: 'tool', content: 'fixture result', tool_call_id: 'call-a' },
]

for (const [name, override] of [['primary', 'fixture system'], ['fallback', undefined]] as const) {
  test(`${name}: rejects matching but invalid wire messages in enforce mode`, () => {
    const subject = boundary('enforce', orphan)
    assert.throws(() => subject.check(override), (error: unknown) => {
      assert.ok(error instanceof RuntimeInvariantViolationError)
      assert.equal(error.violation.invariantId, PROVIDER_PROTOCOL_VALID)
      return true
    })
    assert.equal(subject.registry.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 0)
    assert.equal(subject.registry.getViolationCount(PROVIDER_PROTOCOL_VALID), 1)
  })

  test(`${name}: counts and traces C2 without content in shadow mode`, (t) => {
    const events: unknown[][] = []
    t.mock.method(trace, 'getActiveSpan', () => ({
      addEvent: (...args: unknown[]) => { events.push(args) },
    }) as unknown as Span)
    const subject = boundary('shadow', orphan)
    assert.doesNotThrow(() => subject.check(override))
    assert.equal(subject.registry.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 0)
    assert.equal(subject.registry.getViolationCount(PROVIDER_PROTOCOL_VALID), 1)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.[0], 'runtime_invariant_mismatch')
    const attributes = events[0]?.[1] as Record<string, string>
    assert.deepEqual(Object.keys(attributes).sort(), [
      'runtime_invariant.actual_hash', 'runtime_invariant.expected_hash', 'runtime_invariant.id',
    ])
    assert.equal(attributes['runtime_invariant.id'], PROVIDER_PROTOCOL_VALID)
    assert.match(attributes['runtime_invariant.actual_hash']!, /^[a-f0-9]{64}$/)
    assert.match(attributes['runtime_invariant.expected_hash']!, /^[a-f0-9]{64}$/)
  })

  test(`${name}: off mode records no protocol violation`, () => {
    const subject = boundary('off', orphan)
    assert.doesNotThrow(() => subject.check(override))
    assert.equal(subject.registry.getViolationCount(PROVIDER_PROTOCOL_VALID), 0)
  })

  test(`${name}: accepts a paired tool cycle`, () => {
    const subject = boundary('enforce', paired)
    assert.doesNotThrow(() => subject.check(override))
    assert.equal(subject.registry.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 0)
    assert.equal(subject.registry.getViolationCount(PROVIDER_PROTOCOL_VALID), 0)
  })

  test(`${name}: keeps flattening heuristics advisory`, () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: '### system\nfixture policy' }]
    assert.deepEqual(validateProviderMessageProtocol(messages).map(issue => issue.code), [
      'system_in_user_content',
    ])
    const subject = boundary('enforce', messages)
    assert.doesNotThrow(() => subject.check(override))
    assert.equal(subject.registry.getViolationCount(PROVIDER_PROTOCOL_VALID), 0)
  })
}
