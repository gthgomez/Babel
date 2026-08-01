/**
 * Unit tests for SWE-Bench Pro campaign early-stop + signatures (no network).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyCampaignFailureSignature,
  ensureShadowSummaryForCampaign,
  runSwebenchProCampaign,
  updateFailureStreak,
  type CampaignCellResult,
  type SwebenchProInstanceRow,
} from './swebenchProCampaign.js';
import { packageHintFromRepo } from './workspaceDepPreflight.js';

function cell(
  partial: Partial<CampaignCellResult> & Pick<CampaignCellResult, 'instance_id' | 'signature' | 'status' | 'phase'>,
): CampaignCellResult {
  return {
    notes: [],
    patch_bytes: 0,
    gold_diff_ok: null,
    policy_events: [],
    has_shadow_summary: false,
    duration_ms: 1,
    evidence_path: '/tmp/x.json',
    ...partial,
  };
}

describe('swebenchProCampaign early-stop', () => {
  test('ensureShadowSummaryForCampaign synthesizes boundary for mid-flush shadows', () => {
    const withSummary = ensureShadowSummaryForCampaign(
      [
        { kind: 'force_mutate_shadow', detail: 'would_kill' },
        { kind: 'zero_write_shadow', detail: 'would_kill' },
      ],
      { patchBytes: 120, goldDiffOk: false, terminalOutcome: 'BUDGET_EXHAUSTED' },
    );
    assert.equal(withSummary.some((e) => e.kind === 'policy_shadow_summary'), true);
    const detail = withSummary.find((e) => e.kind === 'policy_shadow_summary')?.detail ?? '';
    assert.match(detail, /later_progressed=1/);
    assert.match(detail, /later_succeeded=0/);
    assert.match(detail, /source=campaign_synthetic/);

    // No shadows → no synthetic summary
    const empty = ensureShadowSummaryForCampaign([], {
      patchBytes: 0,
      goldDiffOk: null,
      terminalOutcome: 'X',
    });
    assert.equal(empty.length, 0);

    // Existing summary preserved
    const already = ensureShadowSummaryForCampaign(
      [
        { kind: 'force_mutate_shadow' },
        { kind: 'policy_shadow_summary', detail: 'shadow_count=1 later_succeeded=0 later_progressed=0' },
      ],
      { patchBytes: 0, goldDiffOk: false, terminalOutcome: 'Y' },
    );
    assert.equal(already.filter((e) => e.kind === 'policy_shadow_summary').length, 1);
  });

  test('classifyCampaignFailureSignature covers infra and agent cases', () => {
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'infra',
        infraOk: false,
        infraError: 'git clone failed for x',
      }),
      'infra:checkout_failed',
    );
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        patchBytes: 0,
        goldDiffOk: false,
        cliExitCode: 1,
      }),
      'agent:cli_nonzero:1',
    );
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        patchBytes: 100,
        goldDiffOk: true,
      }),
      'agent:task_pass',
    );
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        missingApiKey: true,
      }),
      'infra:missing_api_key',
    );
  });

  test('Pri-3: structured env vs policy outranks blob ImportError noise', () => {
    // Policy hard-cap kill with ImportError text in stdout must stay policy
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        statusText: 'BLOCKED',
        terminalOutcome: 'BLOCKED_POLICY',
        envBlocked: false,
        patchBytes: 0,
        goldDiffOk: false,
        stdoutStderr: "ModuleNotFoundError: No module named 'qutebrowser'",
      }),
      'agent:blocked_policy',
    );
    // Explicit ENV_BLOCKED status
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        statusText: 'ENV_BLOCKED',
        terminalOutcome: 'BLOCKED_EXTERNAL',
        envBlocked: true,
        patchBytes: 0,
        goldDiffOk: false,
      }),
      'agent:env_blocked',
    );
    // env_blocked flag alone
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        statusText: 'BLOCKED',
        terminalOutcome: 'BLOCKED_EXTERNAL',
        envBlocked: true,
        patchBytes: 0,
      }),
      'agent:env_blocked',
    );
  });

  test('updateFailureStreak aborts after N identical fails', () => {
    let streak = { signature: null as string | null, count: 0, cell_ids: [] as string[] };
    for (let i = 0; i < 4; i += 1) {
      const r = updateFailureStreak(
        streak,
        cell({
          instance_id: `i${i}`,
          phase: 'live',
          status: 'fail',
          signature: 'agent:empty_patch',
        }),
        5,
        'live',
      );
      assert.equal(r.abort, null);
      streak = { signature: r.signature, count: r.count, cell_ids: r.cell_ids };
    }
    const fifth = updateFailureStreak(
      streak,
      cell({
        instance_id: 'i4',
        phase: 'live',
        status: 'fail',
        signature: 'agent:empty_patch',
      }),
      5,
      'live',
    );
    assert.ok(fifth.abort);
    assert.equal(fifth.abort!.streak, 5);
    assert.equal(fifth.abort!.signature, 'agent:empty_patch');
  });

  test('pass resets streak', () => {
    let streak = {
      signature: 'agent:empty_patch',
      count: 3,
      cell_ids: ['a', 'b', 'c'],
    };
    const r = updateFailureStreak(
      streak,
      cell({
        instance_id: 'ok',
        phase: 'live',
        status: 'pass',
        signature: 'agent:task_pass',
      }),
      5,
      'live',
    );
    assert.equal(r.count, 0);
    assert.equal(r.abort, null);
  });

  test('packageHintFromRepo aligns with Pro repo leaves', () => {
    assert.equal(packageHintFromRepo('internetarchive/openlibrary'), 'openlibrary');
    assert.equal(packageHintFromRepo('qutebrowser/qutebrowser'), 'qutebrowser');
  });

  test('campaign aborts live after 5 same signature (injected cells)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-'));
    const dataset = join(dir, 'pilot.jsonl');
    const rows: SwebenchProInstanceRow[] = Array.from({ length: 7 }, (_, i) => ({
      instance_id: `instance_${i}`,
      repo: 'example/repo',
      base_commit: 'deadbeef',
      problem_statement: 'fix me',
      patch: 'diff',
    }));
    writeFileSync(dataset, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    let liveCount = 0;
    const report = await runSwebenchProCampaign({
      datasetPath: dataset,
      evidenceDir: join(dir, 'evidence'),
      provider: 'mock',
      earlyStopN: 5,
      now: new Date('2026-07-30T12:00:00.000Z'),
      runCell: (instance, phase) => {
        if (phase === 'infra') {
          return cell({
            instance_id: instance.instance_id,
            phase: 'infra',
            status: 'pass',
            signature: 'infra:ok',
          });
        }
        liveCount += 1;
        return cell({
          instance_id: instance.instance_id,
          phase: 'live',
          status: 'fail',
          signature: 'agent:empty_patch',
          policy_events:
            liveCount === 1
              ? [
                  { at_turn: 5, kind: 'zero_write_shadow', detail: 'would_kill' },
                  {
                    at_turn: 10,
                    kind: 'policy_shadow_summary',
                    detail:
                      'shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=INCOMPLETE',
                  },
                ]
              : [],
          has_shadow_summary: liveCount === 1,
        });
      },
    });

    assert.ok(report.aborted);
    assert.equal(report.aborted!.streak, 5);
    assert.equal(liveCount, 5, 'should not run remaining instances after abort');
    assert.equal(report.shadow_sessions_with_summary, 1);
    assert.match(report.policy_events_jsonl, /policy-events\.jsonl$/);
  });
});
