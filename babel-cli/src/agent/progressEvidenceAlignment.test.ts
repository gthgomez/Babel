/**
 * D02 — progress evidence alignment.
 *
 * The W3 ProgressController must score the same evidence set as the durable
 * progress receipt (read novelty: new path / changed content hash / new
 * context epoch) instead of an empty mutation-only signal list. Genuine
 * no-progress loops must remain bounded; unchanged re-reads are never
 * rewarded. Acceptance: D-T05, D-T06.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ProgressController } from './progressController.js';
import {
  createProgressLedger,
  progressSignalsFromReceipt,
  recordProgressCycle,
  scoreProgressIntervention,
} from './progressReceipt.js';
import { createParityRuntime, parityArbitrateCycle } from './chatEngineParityBridge.js';

const RESTRICTING_LABELS = new Set(['restricted_tools', 'last_chance_repair', 'terminal_blocked']);

describe('D02 progress evidence alignment', () => {
  test('D-T05 twelve distinct hashed reads never emit enforced restriction/terminal labels', () => {
    // Control: the legacy empty-mutation-signal list does escalate (the defect).
    const control = new ProgressController();
    for (let cycle = 0; cycle < 12; cycle += 1) {
      control.scoreTurn([], true, 0);
    }
    assert.equal(control.InterventionLevel, 'terminal_blocked');

    const ledger = createProgressLedger();
    const controller = new ProgressController();
    const rt = createParityRuntime('d-t05');
    rt.progress = ledger;

    for (let cycle = 1; cycle <= 12; cycle += 1) {
      const receipt = recordProgressCycle(ledger, {
        at_turn: cycle,
        reads: [{ path: `src/file-${cycle}.ts`, contentHash: `hash-${cycle}` }],
      });
      assert.equal(receipt.hasDelta, true, `cycle ${cycle} is novel`);
      const signals = progressSignalsFromReceipt(receipt);
      assert.deepEqual(signals, ['new_localization']);
      assert.ok(!signals.includes('production_mutation'), 'no mutation claim from reads');

      const scored = controller.scoreTurn(signals, false, 0);
      assert.ok(
        !RESTRICTING_LABELS.has(scored.intervention),
        `cycle ${cycle} intervention=${scored.intervention}`,
      );

      const arb = parityArbitrateCycle({
        rt,
        fuseLabels: [],
        isReadOnlyInspection: true,
      });
      assert.equal(arb.terminalAnswer, null, `cycle ${cycle} has no terminal`);
      assert.notEqual(arb.policySource, 'progress_terminal');
    }

    assert.equal(controller.InterventionLevel, 'none');
    assert.equal(ledger.consecutiveNoProgress, 0);
  });

  test('D-T06 unchanged re-reads stay bounded while novel/changed/post-epoch reads progress', () => {
    const ledger = createProgressLedger();
    const rt = createParityRuntime('d-t06');
    rt.progress = ledger;

    // First read localizes; the next eight unchanged re-reads are no-progress.
    recordProgressCycle(ledger, {
      at_turn: 1,
      contextEpoch: 0,
      reads: [{ path: 'src/a.ts', contentHash: 'h1' }],
    });
    for (let cycle = 2; cycle <= 9; cycle += 1) {
      const receipt = recordProgressCycle(ledger, {
        at_turn: cycle,
        contextEpoch: 0,
        reads: [{ path: 'src/a.ts', contentHash: 'h1' }],
      });
      assert.equal(receipt.hasDelta, false, `cycle ${cycle} unchanged re-read`);
      assert.ok(receipt.deltas.includes('no_progress'));
      assert.deepEqual(progressSignalsFromReceipt(receipt), []);
    }
    assert.equal(ledger.consecutiveNoProgress, 8);

    // Receipt-level bound still fires.
    const terminal = scoreProgressIntervention(ledger, { recoveryAlreadyTried: true });
    assert.equal(terminal.action, 'terminal');
    assert.match(
      terminal.action === 'terminal' ? terminal.reason : '',
      /no-progress after recovery/i,
    );

    // Production arbiter: genuine read-only no-progress is still bounded (the
    // read-only gate suppresses only false mutation-derived labels).
    rt.recoveryTried = true;
    const arb = parityArbitrateCycle({
      rt,
      fuseLabels: [],
      isReadOnlyInspection: true,
    });
    assert.ok(arb.terminalAnswer, 'read-only genuine no-progress still terminals');
    assert.equal(arb.policySource, 'progress_terminal');

    // A changed content hash counts as progress and resets the streak.
    const changed = recordProgressCycle(ledger, {
      at_turn: 10,
      contextEpoch: 0,
      reads: [{ path: 'src/a.ts', contentHash: 'h2' }],
    });
    assert.equal(changed.hasDelta, true);
    assert.ok(changed.deltas.includes('target_change'));
    assert.equal(ledger.consecutiveNoProgress, 0);
    assert.equal(scoreProgressIntervention(ledger, { recoveryAlreadyTried: true }).action, 'continue');

    // A post-epoch (post-compaction) re-read is necessary again, not no-progress.
    const epochLedger = createProgressLedger();
    recordProgressCycle(epochLedger, {
      at_turn: 1,
      contextEpoch: 0,
      reads: [{ path: 'src/b.ts', contentHash: 'hb' }],
    });
    const sameEpoch = recordProgressCycle(epochLedger, {
      at_turn: 2,
      contextEpoch: 0,
      reads: [{ path: 'src/b.ts', contentHash: 'hb' }],
    });
    assert.equal(sameEpoch.hasDelta, false);
    const newEpoch = recordProgressCycle(epochLedger, {
      at_turn: 3,
      contextEpoch: 1,
      reads: [{ path: 'src/b.ts', contentHash: 'hb' }],
    });
    assert.equal(newEpoch.hasDelta, true);
    assert.ok(newEpoch.deltas.includes('localization'));
  });
});
