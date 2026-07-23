import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runPhaseGateWriteBlockVisibilitySmoke,
  runPlanExecuteLinkedIdSmoke,
  runW1ResidualExitSmokes,
} from './implementorW1ExitSmoke.js';
import {
  comparePhaseGateWriteBlockBaseline,
  countPhaseGateWriteBlocks,
  formatWhyStopped,
  isPhaseGatePolicyEvent,
} from './implementorPolicy.js';

describe('implementorW1ExitSmoke (residual Wave 1 exit)', () => {
  test('plan→execute linked-id smoke passes', () => {
    const r = runPlanExecuteLinkedIdSmoke({ sessionId: 'sess_test_abc' });
    assert.equal(r.pass, true, r.fail_reasons.join('; '));
    assert.equal(r.details['linkedEventId'], 'sess_test_abc');
    assert.equal(r.details['forceMutateTurns'], 1);
  });

  test('phase-gate write-block visibility smoke passes', () => {
    const r = runPhaseGateWriteBlockVisibilitySmoke();
    assert.equal(r.pass, true, r.fail_reasons.join('; '));
    assert.equal(r.details['phase_gate_write_block_count'], 2);
    assert.ok(String(r.details['visibility_line']).includes('write blocked: phase-gate'));
  });

  test('combined residual exit smokes pass', () => {
    const all = runW1ResidualExitSmokes();
    assert.equal(all.pass, true, all.results.flatMap((r) => r.fail_reasons).join('; '));
    assert.equal(all.results.length, 2);
  });
});

describe('phase-gate write-block metrics (W1.2)', () => {
  test('isPhaseGatePolicyEvent recognizes phase_gate_block', () => {
    assert.equal(isPhaseGatePolicyEvent('phase_gate_block'), true);
    assert.equal(isPhaseGatePolicyEvent('phase_gate'), true);
    assert.equal(isPhaseGatePolicyEvent('force_mutate', 'phase-gate somehow'), true);
    assert.equal(isPhaseGatePolicyEvent('force_mutate', 'turns=3'), false);
  });

  test('countPhaseGateWriteBlocks separates write vs search blocks', () => {
    const m = countPhaseGateWriteBlocks({
      policyEvents: [
        { kind: 'phase_gate_block', tool: 'str_replace', detail: 'phase=investigate' },
        { kind: 'phase_gate_block', tool: 'grep', detail: 'phase=verify' },
      ],
    });
    assert.equal(m.phase_gate_write_block_count, 1);
    assert.equal(m.phase_gate_block_count, 2);
    assert.ok(m.visibility_line?.includes('write blocked: phase-gate ×1'));
  });

  test('formatWhyStopped surfaces write blocked: phase-gate from phase_gate_block', () => {
    const text = formatWhyStopped({
      status: 'BLOCKED',
      hasAnyWrites: false,
      lastPolicyEvents: [
        {
          kind: 'phase_gate_block',
          detail: 'phase=investigate',
          tool: 'str_replace',
          at_turn: 2,
        },
      ],
    });
    assert.ok(text.includes('write blocked: phase-gate'));
    assert.ok(text.includes('Phase-gate events: 1'));
  });

  test('baseline comparison starts then can improve', () => {
    const first = comparePhaseGateWriteBlockBaseline({ currentWriteBlocks: 4 });
    assert.equal(first.baseline_started, true);
    assert.equal(first.baseline, null);
    const second = comparePhaseGateWriteBlockBaseline({
      currentWriteBlocks: 2,
      baselineWriteBlocks: 4,
    });
    assert.equal(second.improved, true);
    assert.equal(second.delta, -2);
  });
});
