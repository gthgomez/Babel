/**
 * Bottleneck Ledger — lifecycle semantics, append-only fold, fail-closed
 * corruption handling, deterministic reload.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BOTTLENECK_ALLOWED_TRANSITIONS,
  BottleneckLedgerEntrySchema,
  LEDGER_FILE_NAME,
  PREREGISTRATION_FROZEN_SUBFIELDS,
  bottleneckLedgerPath,
  createBottleneckLedgerStore,
  foldLedgerRecords,
  loadBottleneckLedger,
  nextBottleneckId,
  replayDeltaMatchesDirection,
  validateBottleneckEntrySemantics,
  type BottleneckLedgerEntry,
  type EffectQuantification,
  type EntryAmendedRecord,
  type EntryOpenedRecord,
  type EntryTransitionedRecord,
  type NewBottleneckEntryInput,
} from './bottleneckLedger.js';

const T0 = '2026-08-21T10:00:00.000Z';
const T1 = '2026-08-21T11:00:00.000Z';
const T2 = '2026-08-21T12:00:00.000Z';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'bottleneck-ledger-'));
}

function baseEntryDraft(): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'babel_bottleneck_ledger_entry',
    id: 'BB-001',
    status: 'OPEN',
    claim: 'Tool mediation drops stderr context during long failing tool chains',
    suspected_subsystem: 'tool_mediation',
    observed_across: { attempt_count: 3, task_count: 2, model_count: 1 },
    harnesses: [{ name: 'babel', adapter_id: 'babel_cli_chat_headless', version: null }],
    stages: ['tool_use'],
    effect_quantification: {
      metric_name: 'blind_retry_rate',
      baseline_value: 0.5,
      intervention_value: 0.68,
      direction: 'improves',
    },
    evidence_strength: 'moderate',
    evidence_strength_justification:
      'Three independent trace audits corroborate the same dropped-context pattern.',
    evidence_refs: [{ source: 'transcript', id: 'tr-001' }],
    competing_hypotheses: [
      { label: 'HARNESS_TOOL', weight: 0.7, rationale: 'denial events surround every failure' },
      { label: 'MODEL', weight: 0.3, rationale: 'the model sometimes recovers anyway' },
    ],
    proposed_intervention: {
      description: 'Preserve stderr tail in the tool result envelope',
      expected_effect: 'Fewer blind retries after failing tools',
      preregistered_falsifier:
        'Paired replay showing no reduction in blind-retry rate falsifies this entry',
    },
    baseline_manifest_sha: null,
    rerun_manifest_sha: null,
    result: { verdict: null, replay_delta: null, notes: '' },
    created_at: T0,
    updated_at: T0,
  };
}

function makeEntry(overrides: Record<string, unknown> = {}): BottleneckLedgerEntry {
  return BottleneckLedgerEntrySchema.parse({ ...baseEntryDraft(), ...overrides });
}

function shippedEntry(overrides: Record<string, unknown> = {}): BottleneckLedgerEntry {
  return makeEntry({
    status: 'INTERVENTION_SHIPPED',
    baseline_manifest_sha: 'sha_baseline_001',
    ...overrides,
  });
}

function confirmedEntry(overrides: Record<string, unknown> = {}): BottleneckLedgerEntry {
  return makeEntry({
    status: 'CONFIRMED',
    baseline_manifest_sha: 'sha_baseline_001',
    rerun_manifest_sha: 'sha_rerun_001',
    result: { verdict: 'CONFIRMED', replay_delta: 0.18, notes: '' },
    ...overrides,
  });
}

function falsifiedEntry(overrides: Record<string, unknown> = {}): BottleneckLedgerEntry {
  return makeEntry({
    status: 'FALSIFIED',
    baseline_manifest_sha: 'sha_baseline_001',
    rerun_manifest_sha: 'sha_rerun_001',
    result: { verdict: 'FALSIFIED', replay_delta: -0.12, notes: '' },
    ...overrides,
  });
}

function openInput(overrides: Partial<NewBottleneckEntryInput> = {}): NewBottleneckEntryInput {
  return {
    claim: 'Tool mediation drops stderr context during long failing tool chains',
    suspected_subsystem: 'tool_mediation',
    observed_across: { attempt_count: 3, task_count: 2, model_count: 1 },
    harnesses: [{ name: 'babel', adapter_id: 'babel_cli_chat_headless', version: null }],
    stages: ['tool_use'],
    effect_quantification: {
      metric_name: 'blind_retry_rate',
      baseline_value: 0.5,
      intervention_value: 0.68,
      direction: 'improves',
    },
    evidence_strength: 'moderate',
    evidence_strength_justification:
      'Three independent trace audits corroborate the same dropped-context pattern.',
    evidence_refs: [{ source: 'transcript', id: 'tr-001' }],
    competing_hypotheses: [
      { label: 'HARNESS_TOOL', weight: 0.7, rationale: 'denial events surround every failure' },
      { label: 'MODEL', weight: 0.3, rationale: 'the model sometimes recovers anyway' },
    ],
    proposed_intervention: {
      description: 'Preserve stderr tail in the tool result envelope',
      expected_effect: 'Fewer blind retries after failing tools',
      preregistered_falsifier:
        'Paired replay showing no reduction in blind-retry rate falsifies this entry',
    },
    ...overrides,
  };
}

function openedRecord(entry: BottleneckLedgerEntry = makeEntry()): EntryOpenedRecord {
  return { kind: 'entry_opened', recorded_at: T0, entry };
}

describe('bottleneck ledger lifecycle', () => {
  test('happy path OPEN → INTERVENTION_SHIPPED → CONFIRMED', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);

    const opened = store.appendOpenEntry(openInput());
    assert.equal(opened.id, 'BB-001');
    assert.equal(opened.status, 'OPEN');
    assert.equal(opened.baseline_manifest_sha, null);
    assert.equal(opened.rerun_manifest_sha, null);
    assert.equal(opened.result.verdict, null);
    assert.equal(opened.created_at, opened.updated_at);

    const shipped = store.appendTransition(
      opened.id,
      'INTERVENTION_SHIPPED',
      'stderr-tail fix v1 shipped behind flag',
      { baseline_manifest_sha: 'sha_baseline_001' },
    );
    assert.equal(shipped.status, 'INTERVENTION_SHIPPED');
    assert.equal(shipped.baseline_manifest_sha, 'sha_baseline_001');
    assert.equal(shipped.result.verdict, null);
    assert.ok(shipped.updated_at >= shipped.created_at);

    const confirmed = store.appendTransition(opened.id, 'CONFIRMED', 'paired replay shows blind-retry rate drop', {
      rerun_manifest_sha: 'sha_rerun_001',
      replay_delta: 0.18,
      result_notes: 'n=4 pairs',
    });
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(confirmed.result.verdict, 'CONFIRMED');
    assert.equal(confirmed.result.replay_delta, 0.18);
    assert.equal(confirmed.result.notes, 'n=4 pairs');
    assert.equal(confirmed.rerun_manifest_sha, 'sha_rerun_001');

    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('falsified path records negative replay outcome without sign constraint', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput({ effect_quantification: null }));

    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship candidate', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    const falsified = store.appendTransition(
      opened.id,
      'FALSIFIED',
      'replay contradicts the preregistered prediction',
      {
        rerun_manifest_sha: 'sha_rerun_001',
        replay_delta: -0.2,
        result_notes: 'blind retries increased under the intervention',
      },
    );
    assert.equal(falsified.status, 'FALSIFIED');
    assert.equal(falsified.result.verdict, 'FALSIFIED');
    assert.equal(falsified.result.replay_delta, -0.2);
    assert.equal(falsified.effect_quantification, null);
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('amendments apply whitelist patches while OPEN and persist', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput({ evidence_strength: 'weak' }));

    const amended = store.appendAmendment(opened.id, {
      evidence_strength: 'strong',
      evidence_strength_justification: 'Fourth audit corroborates with cell-level receipts.',
      observed_across: { attempt_count: 5, task_count: 3, model_count: 2 },
    });
    assert.equal(amended.evidence_strength, 'strong');
    assert.equal(amended.observed_across.attempt_count, 5);
    assert.ok(amended.updated_at >= amended.created_at);
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('amendments are closed once an entry is terminal', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    store.appendTransition(opened.id, 'CONFIRMED', 'replay agrees', {
      rerun_manifest_sha: 'sha_rerun_001',
      replay_delta: 0.1,
    });
    assert.throws(() => store.appendAmendment(opened.id, { claim: makeEntry().claim }), /terminal/);
  });
});

describe('bottleneck ledger semantic validators', () => {
  test('OPEN requires a non-empty preregistered falsifier', () => {
    const entry = makeEntry({
      proposed_intervention: {
        description: 'desc',
        expected_effect: 'effect',
        preregistered_falsifier: '   ',
      },
    });
    const problems = validateBottleneckEntrySemantics(entry);
    assert.ok(problems.some((p) => /preregistered_falsifier/.test(p)), problems.join('; '));
  });

  test('INTERVENTION_SHIPPED requires description and baseline_manifest_sha', () => {
    const noBaseline = validateBottleneckEntrySemantics(
      shippedEntry({ baseline_manifest_sha: null }),
    );
    assert.ok(noBaseline.some((p) => /baseline_manifest_sha/.test(p)), noBaseline.join('; '));

    const noDescription = validateBottleneckEntrySemantics(
      shippedEntry({
        proposed_intervention: { description: '', expected_effect: 'e', preregistered_falsifier: 'f' },
      }),
    );
    assert.ok(
      noDescription.some((p) => /description/.test(p)),
      noDescription.join('; '),
    );
  });

  test('premature verdict/rerun/delta are rejected on OPEN and INTERVENTION_SHIPPED', () => {
    for (const status of ['OPEN', 'INTERVENTION_SHIPPED'] as const) {
      const base =
        status === 'OPEN'
          ? makeEntry({ status })
          : shippedEntry({ status });
      const withVerdict = validateBottleneckEntrySemantics({
        ...base,
        result: { ...base.result, verdict: 'CONFIRMED' },
      });
      assert.ok(withVerdict.some((p) => /premature verdict/.test(p)));
      const withRerun = validateBottleneckEntrySemantics({
        ...base,
        rerun_manifest_sha: 'sha_rerun_early',
      });
      assert.ok(withRerun.some((p) => /premature rerun_manifest_sha/.test(p)));
      const withDelta = validateBottleneckEntrySemantics({
        ...base,
        result: { ...base.result, replay_delta: 0.4 },
      });
      assert.ok(withDelta.some((p) => /premature result.replay_delta/.test(p)));
    }
  });

  test('terminal statuses require rerun sha, replay delta, and matching verdict', () => {
    assert.ok(
      validateBottleneckEntrySemantics(confirmedEntry({ rerun_manifest_sha: null })).some((p) =>
        /requires rerun_manifest_sha/.test(p),
      ),
    );
    assert.ok(
      validateBottleneckEntrySemantics(
        confirmedEntry({ result: { verdict: 'CONFIRMED', replay_delta: null, notes: '' } }),
      ).some((p) => /requires result.replay_delta/.test(p)),
    );
    assert.ok(
      validateBottleneckEntrySemantics(falsifiedEntry({ rerun_manifest_sha: null })).some((p) =>
        /requires rerun_manifest_sha/.test(p),
      ),
    );
    assert.ok(
      validateBottleneckEntrySemantics(
        confirmedEntry({ result: { verdict: 'FALSIFIED', replay_delta: 0.18, notes: '' } }),
      ).some((p) => /result.verdict must equal status CONFIRMED/.test(p)),
    );
  });

  test('CONFIRMED requires filled effect_quantification', () => {
    assert.ok(
      validateBottleneckEntrySemantics(confirmedEntry({ effect_quantification: null })).some((p) =>
        /CONFIRMED requires effect_quantification/.test(p),
      ),
    );
    assert.ok(
      validateBottleneckEntrySemantics(
        confirmedEntry({
          effect_quantification: {
            metric_name: 'blind_retry_rate',
            baseline_value: null,
            intervention_value: 0.68,
            direction: 'improves',
          },
        }),
      ).some((p) => /concrete baseline_value/.test(p)),
    );
  });

  test("direction 'unknown' cannot be CONFIRMED", () => {
    const problems = validateBottleneckEntrySemantics(
      confirmedEntry({
        effect_quantification: {
          metric_name: 'blind_retry_rate',
          baseline_value: 0.5,
          intervention_value: 0.55,
          direction: 'unknown',
        },
        result: { verdict: 'CONFIRMED', replay_delta: 0.05, notes: '' },
      }),
    );
    assert.ok(problems.some((p) => /known direction/.test(p)), problems.join('; '));
  });

  test('sign disagreement rejects CONFIRMED; agreement passes', () => {
    const disagree = validateBottleneckEntrySemantics(
      confirmedEntry({ result: { verdict: 'CONFIRMED', replay_delta: -0.05, notes: '' } }),
    );
    assert.ok(disagree.some((p) => /sign disagreement/.test(p)), disagree.join('; '));

    const worsensPositive = validateBottleneckEntrySemantics(
      confirmedEntry({
        effect_quantification: {
          metric_name: 'blind_retry_rate',
          baseline_value: 0.68,
          intervention_value: 0.5,
          direction: 'worsens',
        },
        result: { verdict: 'CONFIRMED', replay_delta: 0.1, notes: '' },
      }),
    );
    assert.ok(worsensPositive.some((p) => /sign disagreement/.test(p)));

    const neutralNonzero = validateBottleneckEntrySemantics(
      confirmedEntry({
        effect_quantification: {
          metric_name: 'blind_retry_rate',
          baseline_value: 0.5,
          intervention_value: 0.5,
          direction: 'neutral',
        },
        result: { verdict: 'CONFIRMED', replay_delta: 0.01, notes: '' },
      }),
    );
    assert.ok(neutralNonzero.some((p) => /sign disagreement/.test(p)));

    assert.deepEqual(
      validateBottleneckEntrySemantics(
        confirmedEntry({
          effect_quantification: {
            metric_name: 'blind_retry_rate',
            baseline_value: 0.5,
            intervention_value: 0.5,
            direction: 'neutral',
          },
          result: { verdict: 'CONFIRMED', replay_delta: 0, notes: '' },
        }),
      ),
      [],
    );
  });

  test('FALSIFIED carries no sign-agreement requirement', () => {
    const problems = validateBottleneckEntrySemantics(
      falsifiedEntry({
        effect_quantification: {
          metric_name: 'blind_retry_rate',
          baseline_value: 0.5,
          intervention_value: 0.68,
          direction: 'improves',
        },
        result: { verdict: 'FALSIFIED', replay_delta: -0.4, notes: '' },
      }),
    );
    assert.deepEqual(problems, []);
  });

  test('replayDeltaMatchesDirection encodes the documented sign rule', () => {
    assert.equal(replayDeltaMatchesDirection('improves', 0.01), true);
    assert.equal(replayDeltaMatchesDirection('improves', 0), false);
    assert.equal(replayDeltaMatchesDirection('improves', -1), false);
    assert.equal(replayDeltaMatchesDirection('worsens', -0.01), true);
    assert.equal(replayDeltaMatchesDirection('worsens', 0.01), false);
    assert.equal(replayDeltaMatchesDirection('neutral', 0), true);
    assert.equal(replayDeltaMatchesDirection('neutral', 0.001), false);
    assert.equal(replayDeltaMatchesDirection('unknown', 100), false);
    assert.equal(replayDeltaMatchesDirection('improves', null), false);
  });

  test('lifecycle map only allows OPEN → SHIPPED → terminal', () => {
    assert.deepEqual([...BOTTLENECK_ALLOWED_TRANSITIONS.OPEN], ['INTERVENTION_SHIPPED']);
    assert.deepEqual(
      [...BOTTLENECK_ALLOWED_TRANSITIONS.INTERVENTION_SHIPPED].sort(),
      ['CONFIRMED', 'FALSIFIED'],
    );
    assert.deepEqual(BOTTLENECK_ALLOWED_TRANSITIONS.CONFIRMED, []);
    assert.deepEqual(BOTTLENECK_ALLOWED_TRANSITIONS.FALSIFIED, []);
  });
});

describe('bottleneck ledger transition enforcement', () => {
  test('skipping INTERVENTION_SHIPPED is rejected', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    assert.throws(
      () => store.appendTransition(opened.id, 'CONFIRMED', 'skip ahead'),
      /illegal bottleneck ledger transition OPEN → CONFIRMED/,
    );
    assert.throws(
      () => store.appendTransition(opened.id, 'FALSIFIED', 'skip ahead'),
      /illegal bottleneck ledger transition OPEN → FALSIFIED/,
    );
  });

  test('backward and self transitions are rejected', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    assert.throws(
      () => store.appendTransition(opened.id, 'OPEN', 'rewind'),
      /illegal bottleneck ledger transition INTERVENTION_SHIPPED → OPEN/,
    );
    assert.throws(
      () => store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'self'),
      /illegal bottleneck ledger transition/,
    );
  });

  test('shipping without resolution.baseline_manifest_sha fails closed', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    assert.throws(
      () => store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship'),
      /requires resolution\.baseline_manifest_sha/,
    );
    assert.throws(
      () =>
        store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship', {
          baseline_manifest_sha: '',
        }),
      /requires resolution\.baseline_manifest_sha/,
    );
  });

  test('verdict transitions require resolution with numeric replay_delta', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    assert.throws(
      () => store.appendTransition(opened.id, 'CONFIRMED', 'no resolution at all'),
      /requires resolution\.rerun_manifest_sha/,
    );
    assert.throws(
      () =>
        store.appendTransition(opened.id, 'CONFIRMED', 'missing delta', {
          rerun_manifest_sha: 'sha_rerun_001',
        }),
      /numeric resolution\.replay_delta/,
    );
    // Nothing invalid was persisted — state is still shippable.
    const shipped = store.appendTransition(opened.id, 'CONFIRMED', 'valid now', {
      rerun_manifest_sha: 'sha_rerun_001',
      replay_delta: 0.2,
    });
    assert.equal(shipped.status, 'CONFIRMED');
  });

  test('transition reason is required', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    assert.throws(() => store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', '  '), /reason/);
  });

  test('sign disagreement is rejected at transition time before anything persists', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(
      openInput({
        effect_quantification: {
          metric_name: 'blind_retry_rate',
          baseline_value: 0.5,
          intervention_value: 0.68,
          direction: 'improves',
        },
      }),
    );
    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    assert.throws(
      () =>
        store.appendTransition(opened.id, 'CONFIRMED', 'delta went the wrong way', {
          rerun_manifest_sha: 'sha_rerun_001',
          replay_delta: -0.3,
        }),
      /sign disagreement/,
    );
    const stillShipped = store.getEntry(opened.id);
    assert.equal(stillShipped?.status, 'INTERVENTION_SHIPPED');
    assert.equal(stillShipped?.result.verdict, null);
  });
});

describe('fold determinism and corruption', () => {
  test('same record sequence folds to identical entries twice', () => {
    const shipped: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: T1,
      id: 'BB-001',
      from: 'OPEN',
      to: 'INTERVENTION_SHIPPED',
      at: T1,
      reason: 'ship',
      resolution: { baseline_manifest_sha: 'sha_baseline_001' },
    };
    const amended: EntryAmendedRecord = {
      kind: 'entry_amended',
      recorded_at: T2,
      id: 'BB-001',
      at: T2,
      patch: { evidence_strength: 'strong' },
    };
    const confirmed: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: T2,
      id: 'BB-001',
      from: 'INTERVENTION_SHIPPED',
      to: 'CONFIRMED',
      at: T2,
      reason: 'replay agrees',
      resolution: { rerun_manifest_sha: 'sha_rerun_001', replay_delta: 0.18 },
    };
    const records: (EntryOpenedRecord | EntryTransitionedRecord | EntryAmendedRecord)[] = [
      openedRecord(),
      shipped,
      amended,
      confirmed,
    ];
    const first = foldLedgerRecords(records);
    const second = foldLedgerRecords(
      JSON.parse(JSON.stringify(records)) as typeof records,
    );
    assert.notEqual(first, second);
    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.status, 'CONFIRMED');
    assert.equal(first[0]?.evidence_strength, 'strong');
  });

  test('corrupt JSON line fails closed with precise line number', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    store.appendOpenEntry(openInput());
    appendFileSync(bottleneckLedgerPath(dir), '{not valid json\n', 'utf-8');
    assert.throws(() => loadBottleneckLedger(dir), /corrupt bottleneck ledger record at line 2/);
  });

  test('unknown record kind fails closed', () => {
    const dir = tmpDir();
    createBottleneckLedgerStore(dir);
    appendFileSync(
      bottleneckLedgerPath(dir),
      `${JSON.stringify({ kind: 'entry_teleported', recorded_at: T0 })}\n`,
      'utf-8',
    );
    assert.throws(() => loadBottleneckLedger(dir), /unknown bottleneck ledger record kind/);
  });

  test('malformed non-object record fails closed', () => {
    const dir = tmpDir();
    createBottleneckLedgerStore(dir);
    appendFileSync(bottleneckLedgerPath(dir), '42\n', 'utf-8');
    assert.throws(() => loadBottleneckLedger(dir), /malformed bottleneck ledger record at line 1/);
  });

  test('broken transition (from mismatch) fails closed via foldLedgerRecords', () => {
    const bad: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: T1,
      id: 'BB-001',
      from: 'INTERVENTION_SHIPPED',
      to: 'CONFIRMED',
      at: T1,
      reason: 'lies about where it came from',
      resolution: { rerun_manifest_sha: 'r', replay_delta: 1 },
    };
    assert.throws(
      () => foldLedgerRecords([openedRecord(), bad]),
      /broken transition for BB-001 .* from=INTERVENTION_SHIPPED but folded status=OPEN/,
    );
  });

  test('duplicate open and unknown-id mutations fail closed', () => {
    const rec = openedRecord();
    assert.throws(() => foldLedgerRecords([rec, rec]), /duplicate entry_opened for BB-001/);
    const orphan: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: T1,
      id: 'BB-999',
      from: 'OPEN',
      to: 'INTERVENTION_SHIPPED',
      at: T1,
      reason: 'no such entry',
      resolution: { baseline_manifest_sha: 'x' },
    };
    assert.throws(() => foldLedgerRecords([rec, orphan]), /unknown ledger entry BB-999/);
  });

  test('entries must enter the ledger as OPEN', () => {
    const terminal = confirmedEntry();
    assert.throws(
      () => foldLedgerRecords([{ kind: 'entry_opened', recorded_at: T0, entry: terminal }]),
      /entries must open as OPEN/,
    );
  });

  test('amendment patch keys outside the whitelist fail closed', () => {
    const rec = openedRecord();
    for (const key of [
      'id',
      'status',
      'created_at',
      'updated_at',
      'baseline_manifest_sha',
      'rerun_manifest_sha',
      'result',
      'schema_version',
      'kind',
      'not_a_field',
    ]) {
      const amend: EntryAmendedRecord = {
        kind: 'entry_amended',
        recorded_at: T1,
        id: 'BB-001',
        at: T1,
        patch: { [key]: 'anything' },
      };
      assert.throws(
        () => foldLedgerRecords([rec, amend]),
        /not amendable/,
        `expected key '${key}' to be rejected`,
      );
    }
  });

  test('invalid amendment values fail closed', () => {
    const rec = openedRecord();
    const amend: EntryAmendedRecord = {
      kind: 'entry_amended',
      recorded_at: T1,
      id: 'BB-001',
      at: T1,
      patch: { competing_hypotheses: [{ label: 'MODEL', weight: 0.7, rationale: 'only one' }] },
    };
    assert.throws(() => foldLedgerRecords([rec, amend]), /invalid amendment value for 'competing_hypotheses'/);
  });

  test('ledger file name is stable jsonl', () => {
    assert.equal(LEDGER_FILE_NAME, 'bottleneck-ledger.jsonl');
    assert.equal(bottleneckLedgerPath('dir'), join('dir', 'bottleneck-ledger.jsonl'));
  });
});

describe('ids and store init', () => {
  test('nextBottleneckId allocates stable slugs deterministically', () => {
    assert.equal(nextBottleneckId([]), 'BB-001');
    assert.equal(nextBottleneckId(['BB-001']), 'BB-002');
    assert.equal(nextBottleneckId(['BB-002', 'BB-010']), 'BB-011');
    assert.equal(nextBottleneckId(['BB-002', 'BB-010', 'junk-id']), 'BB-011');
    assert.equal(nextBottleneckId(['BB-009']), 'BB-010');
  });

  test('store auto-allocates sequential ids when omitted', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const first = store.appendOpenEntry(openInput());
    const second = store.appendOpenEntry(openInput({ claim: 'Second distinct bottleneck claim exceeding min length' }));
    assert.equal(first.id, 'BB-001');
    assert.equal(second.id, 'BB-002');
    assert.deepEqual(store.entries.map((e) => e.id), ['BB-001', 'BB-002']);
  });

  test('store rejects duplicate and malformed ids', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    store.appendOpenEntry(openInput());
    assert.throws(() => store.appendOpenEntry(openInput({ id: 'BB-001' })), /duplicate ledger entry id/);
    assert.throws(
      () => store.appendOpenEntry(openInput({ id: 'bottleneck-one' })),
      /invalid ledger entry id/,
    );
  });

  test('create refuses overwrite; empty ledger loads as empty list', () => {
    const dir = tmpDir();
    createBottleneckLedgerStore(dir);
    assert.throws(() => createBottleneckLedgerStore(dir), /already exists/);
    assert.deepEqual(loadBottleneckLedger(dir), []);
  });

  test('schema rejects structurally invalid entries (min lengths, hypothesis count)', () => {
    assert.throws(
      () => makeEntry({ claim: 'too short' }),
      /claim/,
    );
    assert.throws(
      () =>
        makeEntry({
          competing_hypotheses: [
            { label: 'HARNESS_TOOL', weight: 1, rationale: 'single cause smuggled in' },
          ],
        }),
      /competing_hypotheses/,
    );
    assert.throws(() => makeEntry({ id: 'BB-1' }), /stable slug/);
    assert.throws(() => makeEntry({ stages: ['not_a_stage'] }), /stages/);
  });
});

describe('preregistration freeze after shipping (M2 hardening)', () => {
  const ORIGINAL_FALSIFIER =
    'Paired replay showing no reduction in blind-retry rate falsifies this entry';

  function flippedDirection(): EffectQuantification {
    return {
      metric_name: 'blind_retry_rate',
      baseline_value: 0.5,
      intervention_value: 0.68,
      direction: 'worsens',
    };
  }

  function shippedRecord(id = 'BB-001'): EntryTransitionedRecord {
    return {
      kind: 'entry_transitioned',
      recorded_at: T1,
      id,
      from: 'OPEN',
      to: 'INTERVENTION_SHIPPED',
      at: T1,
      reason: 'ship',
      resolution: { baseline_manifest_sha: 'sha_baseline_001' },
    };
  }

  function makeShippedStore(): {
    dir: string;
    store: ReturnType<typeof createBottleneckLedgerStore>;
    id: string;
  } {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    store.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'stderr-tail fix v1 shipped', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    return { dir, store, id: opened.id };
  }

  test('freeze table covers exactly the preregistration fields', () => {
    assert.deepEqual(PREREGISTRATION_FROZEN_SUBFIELDS.effect_quantification, [
      'direction',
      'metric_name',
    ]);
    assert.deepEqual(PREREGISTRATION_FROZEN_SUBFIELDS.proposed_intervention, [
      'preregistered_falsifier',
    ]);
  });

  test('(a) review attack — shipped entry rejects direction flip and persists nothing', () => {
    const { dir, store, id } = makeShippedStore();
    assert.throws(
      () => store.appendAmendment(id, { effect_quantification: flippedDirection() }),
      /frozen preregistration field 'effect_quantification\.direction' while entry BB-001 is INTERVENTION_SHIPPED/,
    );
    assert.equal(store.getEntry(id)?.effect_quantification?.direction, 'improves');
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('shipped entry rejects metric_name change on effect_quantification', () => {
    const { store, id } = makeShippedStore();
    assert.throws(
      () =>
        store.appendAmendment(id, {
          effect_quantification: { ...flippedDirection(), direction: 'improves', metric_name: 'tokens_per_task' },
        }),
      /frozen preregistration field 'effect_quantification\.metric_name' while entry BB-001 is INTERVENTION_SHIPPED/,
    );
  });

  test('(b) shipped entry rejects wholesale preregistered_falsifier replacement', () => {
    const { store, id } = makeShippedStore();
    assert.throws(
      () =>
        store.appendAmendment(id, {
          proposed_intervention: {
            description: 'Preserve stderr tail in the tool result envelope',
            expected_effect: 'Fewer blind retries after failing tools',
            preregistered_falsifier:
              'Rewritten after shipping: only a 10x regression counts as falsifying',
          },
        }),
      /frozen preregistration field 'proposed_intervention\.preregistered_falsifier' while entry BB-001 is INTERVENTION_SHIPPED/,
    );
    assert.equal(
      store.getEntry(id)?.proposed_intervention.preregistered_falsifier,
      ORIGINAL_FALSIFIER,
    );
  });

  test('(c) shipped entry still accepts result_notes amendments', () => {
    const { dir, store, id } = makeShippedStore();
    const amended = store.appendAmendment(id, {
      result_notes: 'shipped behind flag; awaiting controlled replay',
    });
    assert.equal(amended.result.notes, 'shipped behind flag; awaiting controlled replay');
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('(d) identical frozen-key amendments remain allowed while OPEN', () => {
    const dir = tmpDir();
    const store = createBottleneckLedgerStore(dir);
    const opened = store.appendOpenEntry(openInput());
    const amended = store.appendAmendment(opened.id, {
      effect_quantification: flippedDirection(),
      proposed_intervention: {
        description: 'Preserve stderr tail in the tool result envelope',
        expected_effect: 'Fewer blind retries after failing tools',
        preregistered_falsifier: 'Sharpened pre-ship: paired replay within 5% falsifies',
      },
      result_notes: 'still sharpening the preregistration',
    });
    assert.equal(amended.status, 'OPEN');
    assert.equal(amended.effect_quantification?.direction, 'worsens');
    assert.equal(
      amended.proposed_intervention.preregistered_falsifier,
      'Sharpened pre-ship: paired replay within 5% falsifies',
    );
    assert.equal(amended.result.notes, 'still sharpening the preregistration');
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('(e) crafted JSONL with frozen-key amendment line fails closed at fold', () => {
    const { dir, store, id } = makeShippedStore();
    const forged: EntryAmendedRecord = {
      kind: 'entry_amended',
      recorded_at: T2,
      id,
      at: T2,
      patch: { effect_quantification: flippedDirection() },
    };
    appendFileSync(bottleneckLedgerPath(dir), `${JSON.stringify(forged)}\n`, 'utf-8');
    assert.throws(
      () => loadBottleneckLedger(dir),
      /frozen preregistration field 'effect_quantification\.direction' while entry BB-001 is INTERVENTION_SHIPPED/,
    );
    assert.equal(store.getEntry(id)?.effect_quantification?.direction, 'improves');
  });

  test('freeze holds at CONFIRMED via fold ("INTERVENTION_SHIPPED or later")', () => {
    const confirmed: EntryTransitionedRecord = {
      kind: 'entry_transitioned',
      recorded_at: T2,
      id: 'BB-001',
      from: 'INTERVENTION_SHIPPED',
      to: 'CONFIRMED',
      at: T2,
      reason: 'replay agrees',
      resolution: { rerun_manifest_sha: 'sha_rerun_001', replay_delta: 0.18 },
    };
    const flipAfterVerdict: EntryAmendedRecord = {
      kind: 'entry_amended',
      recorded_at: T2,
      id: 'BB-001',
      at: T2,
      patch: { proposed_intervention: { ...makeEntry().proposed_intervention, preregistered_falsifier: 'post-verdict rewrite' } },
    };
    assert.throws(
      () => foldLedgerRecords([openedRecord(), shippedRecord(), confirmed, flipAfterVerdict]),
      /frozen preregistration field 'proposed_intervention\.preregistered_falsifier' while entry BB-001 is CONFIRMED/,
    );
  });

  test('non-frozen sub-fields stay amendable post-ship when frozen fields match exactly', () => {
    const { dir, store, id } = makeShippedStore();
    const amended = store.appendAmendment(id, {
      effect_quantification: {
        metric_name: 'blind_retry_rate',
        baseline_value: 0.52,
        intervention_value: 0.7,
        direction: 'improves',
      },
      proposed_intervention: {
        description: 'Preserve stderr tail in the tool result envelope (v2 wording)',
        expected_effect: 'Fewer blind retries after failing tools',
        preregistered_falsifier: ORIGINAL_FALSIFIER,
      },
    });
    assert.equal(amended.effect_quantification?.baseline_value, 0.52);
    assert.equal(amended.proposed_intervention.description.includes('v2'), true);
    assert.deepEqual(loadBottleneckLedger(dir), store.entries);
  });

  test('post-ship amendments cannot erase or introduce frozen fields (null handling)', () => {
    const { store, id } = makeShippedStore();
    assert.throws(
      () => store.appendAmendment(id, { effect_quantification: null }),
      /frozen preregistration field 'effect_quantification\.direction'/,
    );

    const dir = tmpDir();
    const lateStore = createBottleneckLedgerStore(dir);
    const opened = lateStore.appendOpenEntry(openInput({ effect_quantification: null }));
    lateStore.appendTransition(opened.id, 'INTERVENTION_SHIPPED', 'ship without quantification', {
      baseline_manifest_sha: 'sha_baseline_001',
    });
    assert.throws(
      () => lateStore.appendAmendment(opened.id, { effect_quantification: flippedDirection() }),
      /frozen preregistration field 'effect_quantification\.direction' while entry BB-001 is INTERVENTION_SHIPPED \(frozen null → attempted "worsens"\)/,
    );
  });
});
