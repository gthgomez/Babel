import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEvent } from '../../agent/sessionEvents.js'
import {
  buildShellInspectorView,
  renderTriState,
  ShellInspectorStore,
} from './shellInspector.js'

let seq = 0

function ev(
  kind: SessionEvent['kind'],
  turnId: string | null,
  extra: Record<string, unknown>,
  sessionId = 'session-1',
): SessionEvent {
  seq += 1
  return {
    schema_version: 1,
    event_id: `e${seq}`,
    session_id: sessionId,
    turn_id: turnId,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    kind,
    ...extra,
  } as unknown as SessionEvent
}

const context = { selectedModel: 'auto', sessionTokens: null }

test('inspector shows observed proposed tools and permitted capability tri-state', () => {
  const events: SessionEvent[] = [
    ev('model_input_receipt', 't1', {
      inference_id: 'i1',
      provider: 'deepseek',
      requested_model_id: 'req-model',
      normalized_model_id: 'norm-model',
      sent_model_id: 'sent-model',
      input_digest: 'd',
      input_ref: 'ref',
      context_limit_tokens: 128000,
      context_limit_source: 'provider',
    }),
    ev('tool_proposed', 't1', {
      tool_call_id: 'c1',
      idempotency_key: 'k1',
      tool_name: 'read_file',
    }),
    ev('tool_proposed', 't1', {
      tool_call_id: 'c2',
      idempotency_key: 'k2',
      tool_name: 'grep',
    }),
    ev('capability_binding_receipt', 't1', {
      inference_id: 'i1',
      provider: 'deepseek',
      capability: 'tools',
      advertised: true,
      authorized: null,
      effective: null,
    }),
  ]

  const view = buildShellInspectorView(events, context)
  assert.ok(view.tools.includes('Proposed (observed): read_file, grep'))
  assert.ok(
    view.tools.includes('Permitted tools: advertised=yes authorized=unknown effective=unknown'),
  )
  assert.ok(view.tools.includes('Offered (request capture): unavailable — request records tool_schema_hash only'))
  assert.ok(view.context.includes('Sent model: sent-model'))
  assert.ok(view.context.includes('Request limit: 128000 tokens (provider)'))
})

test('inspector labels absence explicitly instead of inventing values', () => {
  const view = buildShellInspectorView([], context)
  assert.deepEqual(view.tools, [
    'Proposed (observed): none this turn',
    'Permitted capability: unknown (no capability_binding_receipt)',
    'Offered (request capture): unavailable — request records tool_schema_hash only',
  ])
  assert.ok(view.context.includes('No provider request yet.'))
  assert.ok(view.context.includes('Session estimate: unknown'))
  assert.equal(
    view.tools.some((row) => /offered/i.test(row) && !/unavailable/i.test(row)),
    false,
  )
})

test('renderTriState never converts unknown into a boolean claim', () => {
  assert.equal(renderTriState(true), 'yes')
  assert.equal(renderTriState(false), 'no')
  assert.equal(renderTriState(null), 'unknown')
  assert.equal(renderTriState(undefined), 'unknown')
})

test('ShellInspectorStore bounds buffered events', () => {
  const store = new ShellInspectorStore(2)
  store.setActiveSession('session-1')
  store.observe(ev('tool_proposed', 't1', { tool_name: 'a', tool_call_id: '1', idempotency_key: '1' }))
  store.observe(ev('tool_proposed', 't1', { tool_name: 'b', tool_call_id: '2', idempotency_key: '2' }))
  store.observe(ev('tool_proposed', 't1', { tool_name: 'c', tool_call_id: '3', idempotency_key: '3' }))
  assert.equal(store.getEvents().length, 2)
  assert.deepEqual(store.build(context).tools[0], 'Proposed (observed): b, c')
})

test('inspector never shows a prior session request after a session transition', () => {
  const store = new ShellInspectorStore()
  store.setActiveSession('session-old')
  store.observe(
    ev('model_input_receipt', 't-old', {
      inference_id: 'i-old',
      provider: 'deepseek',
      requested_model_id: 'old-requested',
      normalized_model_id: 'old-normalized',
      sent_model_id: 'old-sent',
      input_digest: 'd',
      input_ref: 'ref',
      context_limit_tokens: 64000,
      context_limit_source: 'provider',
    }, 'session-old'),
  )

  // Transition to a genuinely new conversation: reset + no active session.
  store.setActiveSession(undefined)
  store.reset()
  const fresh = store.build(context)
  assert.ok(fresh.context.includes('No provider request yet.'))
  assert.equal(
    fresh.context.some((row) => row.includes('old-sent') || row.includes('64000')),
    false,
  )

  // Scoping also filters even without an explicit reset.
  store.setActiveSession('session-old')
  store.observe(
    ev(
      'model_input_receipt',
      't-other',
      {
        inference_id: 'i-other',
        provider: 'deepseek',
        requested_model_id: 'other-requested',
        normalized_model_id: 'other-normalized',
        sent_model_id: 'other-sent',
        input_digest: 'd',
        input_ref: 'ref',
      },
      'session-other',
    ),
  )
  store.setActiveSession('session-new')
  const scoped = store.build(context)
  assert.ok(scoped.context.includes('No provider request yet.'))
  assert.equal(
    scoped.context.some((row) => row.includes('other-sent') || row.includes('old-sent')),
    false,
  )
})
