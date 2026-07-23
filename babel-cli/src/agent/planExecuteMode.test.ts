import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatPlanExecuteHandoff,
  evaluateHardPlanModeGate,
  formatPlanHandoffUserMessage,
  normalizeChatOperatorMode,
  operatorModeAutoAcceptsEdits,
  operatorModeImpliesDryRun,
  resolveForceMutateTurnsForHandoff,
} from './planExecuteMode.js';

describe('planExecuteMode', () => {
  test('hard plan mode blocks str_replace and write_file', () => {
    assert.equal(
      evaluateHardPlanModeGate({ toolName: 'str_replace', hardPlanMode: true }).blocked,
      true,
    );
    assert.equal(
      evaluateHardPlanModeGate({ toolName: 'write_file', hardPlanMode: true }).blocked,
      true,
    );
    assert.equal(
      evaluateHardPlanModeGate({ toolName: 'read_file', hardPlanMode: true }).blocked,
      false,
    );
    assert.equal(
      evaluateHardPlanModeGate({ toolName: 'str_replace', hardPlanMode: false }).blocked,
      false,
    );
  });

  test('hard plan observation names hard-plan mode', () => {
    const r = evaluateHardPlanModeGate({ toolName: 'str_replace', hardPlanMode: true });
    assert.ok(r.observation?.includes('hard-plan mode'));
  });

  test('create handoff + format message includes plan body', () => {
    const h = createChatPlanExecuteHandoff({
      planBody: '1. Edit src/a.ts\n2. Run unit test',
      linkedEventId: 'evt_1',
      planId: 'plan_test',
      now: new Date('2026-07-15T12:00:00.000Z'),
    });
    assert.equal(h.planId, 'plan_test');
    assert.equal(h.elevatedMutate, true);
    const msg = formatPlanHandoffUserMessage(h);
    assert.ok(msg.includes('Plan → Execute'));
    assert.ok(msg.includes('src/a.ts'));
    assert.ok(msg.includes('evt_1'));
  });

  test('elevated mutate lowers force-mutate threshold to 1', () => {
    const h = createChatPlanExecuteHandoff({ planBody: 'x', elevatedMutate: true });
    assert.equal(resolveForceMutateTurnsForHandoff(5, h), 1);
    assert.equal(resolveForceMutateTurnsForHandoff(5, null), 5);
  });

  test('operator mode normalize + flags', () => {
    assert.equal(normalizeChatOperatorMode('hard-plan'), 'hard_plan');
    assert.equal(normalizeChatOperatorMode('accept_edits'), 'accept_edits');
    assert.equal(normalizeChatOperatorMode('yolo'), 'yolo');
    assert.equal(operatorModeImpliesDryRun('dry_run'), true);
    assert.equal(operatorModeAutoAcceptsEdits('yolo'), true);
    assert.equal(operatorModeAutoAcceptsEdits('default'), false);
  });
});
