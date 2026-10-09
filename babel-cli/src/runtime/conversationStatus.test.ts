/**
 * Packet A1 — ConversationStatus enum and terminal classification.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canTransition,
  conversationStatusFromLegacyStatus,
  conversationStatusFromTerminalOutcome,
  ConversationStatus,
  isTerminal,
} from './conversationStatus.js';
import { recordTurnEnded } from '../agent/sessionEvents.js';

test('A1: isTerminal classifies FINISHED/ERROR/STUCK as terminal, others not', () => {
  assert.equal(isTerminal(ConversationStatus.FINISHED), true);
  assert.equal(isTerminal(ConversationStatus.ERROR), true);
  assert.equal(isTerminal(ConversationStatus.STUCK), true);
  assert.equal(isTerminal(ConversationStatus.IDLE), false);
  assert.equal(isTerminal(ConversationStatus.RUNNING), false);
  assert.equal(isTerminal(ConversationStatus.PAUSED), false);
  assert.equal(isTerminal(ConversationStatus.AWAITING_PERMISSION), false);
});

test('A1: transition legality — no transition may leave a terminal status', () => {
  for (const terminal of [ConversationStatus.FINISHED, ConversationStatus.ERROR, ConversationStatus.STUCK]) {
    for (const to of Object.values(ConversationStatus)) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to} must be illegal`);
    }
  }
  for (const from of [
    ConversationStatus.IDLE,
    ConversationStatus.RUNNING,
    ConversationStatus.PAUSED,
    ConversationStatus.AWAITING_PERMISSION,
  ]) {
    for (const to of Object.values(ConversationStatus)) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} must be legal`);
    }
  }
});

test('A1: every TerminalOutcome maps (shadow, total over the vocabulary)', () => {
  const outcomes: Array<[string, ConversationStatus]> = [
    ['VERIFIED_COMPLETE', ConversationStatus.FINISHED],
    ['UNVERIFIED_PATCH', ConversationStatus.FINISHED],
    ['NO_CHANGE_REQUIRED', ConversationStatus.FINISHED],
    ['PLAN_COMPLETE', ConversationStatus.FINISHED],
    ['BUDGET_EXHAUSTED', ConversationStatus.ERROR],
    ['INFRA_FAILURE', ConversationStatus.ERROR],
    ['AGENT_FAILURE', ConversationStatus.ERROR],
    ['BLOCKED_EXTERNAL', ConversationStatus.AWAITING_PERMISSION],
    ['BLOCKED_POLICY', ConversationStatus.AWAITING_PERMISSION],
    ['NEEDS_HUMAN_DECISION', ConversationStatus.AWAITING_PERMISSION],
    ['INVALID_TASK', ConversationStatus.AWAITING_PERMISSION],
    ['CANCELLED', ConversationStatus.PAUSED],
  ];
  for (const [outcome, expected] of outcomes) {
    assert.equal(conversationStatusFromTerminalOutcome(outcome), expected, outcome);
  }
  // Unknown / absent never fabricates a failure.
  assert.equal(conversationStatusFromTerminalOutcome('MYSTERY'), ConversationStatus.IDLE);
  assert.equal(conversationStatusFromTerminalOutcome(undefined), ConversationStatus.IDLE);
  assert.equal(conversationStatusFromTerminalOutcome(''), ConversationStatus.IDLE);
});

test('A1: legacy ChatStatus strings map without breaking legacy values', () => {
  assert.equal(conversationStatusFromLegacyStatus('completed'), ConversationStatus.FINISHED);
  assert.equal(conversationStatusFromLegacyStatus('failed'), ConversationStatus.ERROR);
  assert.equal(conversationStatusFromLegacyStatus('budget_exhausted'), ConversationStatus.ERROR);
  assert.equal(conversationStatusFromLegacyStatus('blocked'), ConversationStatus.AWAITING_PERMISSION);
  assert.equal(conversationStatusFromLegacyStatus('cancelled'), ConversationStatus.PAUSED);
  assert.equal(conversationStatusFromLegacyStatus('something_new'), ConversationStatus.IDLE);
});

test('A1: legacy adapter shadows run.settled with run.status_changed (v1 compat)', async () => {
  const { sessionEventPayloads, sessionEventToFacts } = await import('./legacyEventAdapters.js');
  const { classifyFactType, RUNTIME_FACT_SCHEMA_VERSION, validateRuntimeFact } = await import('./events.js');

  // Build the event through the real durable-log constructor so the fixture
  // matches the actual SessionEvent shape (base fields included).
  const { createSessionEventLog } = await import('../agent/sessionEvents.js');
  const log = createSessionEventLog('sess-1');
  const event = recordTurnEnded(log, {
    turn_id: 'turn-1',
    outcome: 'VERIFIED_COMPLETE',
    status: 'completed',
  });
  const payloads = sessionEventPayloads(event, {});
  // Shadow pattern: legacy fact preserved verbatim, status fact rides along.
  assert.deepEqual(payloads, [
    { type: 'run.settled', status: 'VERIFIED_COMPLETE' },
    { type: 'run.status_changed', status: 'FINISHED', reason: 'turn_ended' },
  ]);

  const facts = sessionEventToFacts(event, {});
  assert.equal(facts.length, 2);
  const statusFact = facts[1]!;
  assert.equal(statusFact.payload.type, 'run.status_changed');
  assert.equal(statusFact.schemaVersion, RUNTIME_FACT_SCHEMA_VERSION);
  assert.equal(classifyFactType('run.status_changed'), 'observation');
  assert.equal(validateRuntimeFact(statusFact).ok, true);
});
