/**
 * Truthful mutation feedback and verifier evidence caveats
 * (chat-reliability-20261004, P4/P5).
 *
 * P4: the mutation detail used to display the tool runner's stdout.length as
 * "B written" and to label every exit-0 apply_patch "applied" — before any
 * effect evidence confirmed the requested mutation. The detail must project
 * the SETTLED effect: changed / no change / unknown / unverified.
 *
 * P5: a green exit with zero tests, or with every reported test skipped, is
 * not test evidence. Counts that are absent stay unknown — no output parsing.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  describeDirectMutationEffect,
  formatResultDetail,
} from './chatEngineSupport.js';
import { verifierEvidenceCaveats } from './chatEngineVerifierAdapter.js';

describe('effect-aware mutation feedback', () => {
  const writeAction = { type: 'write_file', path: 'src/a.ts', content: 'x' } as const;
  const patchAction = { type: 'apply_patch', patch: '--- a\n+++ b\n' } as const;

  test('no "B written" for write_file: stdout length is not bytes on disk', () => {
    const detail = formatResultDetail(
      writeAction,
      { stdout: 'x'.repeat(42), exit_code: 0 },
      { status: 'confirmed_change', reason: 'committed receipt proves change' },
    );
    assert.equal(detail, 'changed');
    assert.ok(!/\d+ B written/.test(detail));
  });

  test('confirmed_change projects "changed" for apply_patch', () => {
    assert.equal(
      formatResultDetail(
        patchAction,
        { exit_code: 0 },
        { status: 'confirmed_change', reason: '' },
      ),
      'changed',
    );
  });

  test('a byte-identical rewrite reports no change, not "applied"', () => {
    const detail = formatResultDetail(
      writeAction,
      { exit_code: 0 },
      { status: 'confirmed_no_change', reason: 'committed evidence proves identical post-state' },
    );
    assert.match(detail, /no change/);
    assert.ok(!/applied|written/.test(detail));
  });

  test('an indeterminate effect stays unknown, never claimed as success', () => {
    const detail = formatResultDetail(
      patchAction,
      { exit_code: 0 },
      { status: 'indeterminate', reason: 'mutation receipt is not committed (pending)' },
    );
    assert.match(detail, /unknown/);
  });

  test('a missing effect assessment is reported as unverified', () => {
    assert.equal(formatResultDetail(writeAction, { exit_code: 0 }), 'effect unverified');
    assert.equal(formatResultDetail(patchAction, { exit_code: 0 }, null), 'effect unverified');
  });

  test('describeDirectMutationEffect covers all statuses', () => {
    assert.equal(describeDirectMutationEffect({ status: 'confirmed_change', reason: '' }), 'changed');
    assert.equal(
      describeDirectMutationEffect({ status: 'not_applicable', reason: 'denied' }),
      'effect unverified',
    );
  });
});

describe('verifier evidence caveats', () => {
  test('zero tests with a green exit is flagged as non-evidence', () => {
    assert.deepEqual(
      verifierEvidenceCaveats({ exit_code: 0, tests_total: 0 }),
      ['verifier executed zero tests: a green exit with no tests is not test evidence'],
    );
  });

  test('all-skipped runs are flagged', () => {
    const caveats = verifierEvidenceCaveats({
      exit_code: 0,
      tests_total: 5,
      tests_skipped: 5,
    });
    assert.equal(caveats.length, 1);
    assert.match(caveats[0]!, /skipped/);
  });

  test('unknown counts stay unknown — no caveats, no speculation', () => {
    assert.deepEqual(verifierEvidenceCaveats({ exit_code: 0 }), []);
    assert.deepEqual(verifierEvidenceCaveats({ exit_code: 0, tests_total: 12, tests_skipped: 2 }), []);
    assert.deepEqual(verifierEvidenceCaveats({ exit_code: 1, tests_total: 0 }), []);
  });
});
