/**
 * Unit tests for SWE-Bench Pro campaign early-stop + signatures (no network).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyInstanceTestPatch,
  cellPassesByMode,
  classifyCampaignFailureSignature,
  classifyFailToPassResult,
  ensureShadowSummaryForCampaign,
  resolveProTestPathHint,
  resolveSweProPassMode,
  runSwebenchProCampaign,
  updateFailureStreak,
  workspaceDirectoryName,
  type CampaignCellResult,
  type SwebenchProInstanceRow,
} from './swebenchProCampaign.js';
import {
  listAttemptStates,
  loadCampaignManifest,
  reconcileCampaignEvidence,
  validateConservation,
} from './causalCampaignContract.js';
import { packageHintFromRepo } from './workspaceDepPreflight.js';
import { parseSweStringList } from './agentBenchmarkHarness.js';

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
  test('workspace directory names stay short and stable for Windows paths', () => {
    const instanceId = 'instance_internetarchive__openlibrary-' + 'a'.repeat(120);
    const first = workspaceDirectoryName(instanceId);
    assert.equal(first, workspaceDirectoryName(instanceId));
    assert.ok(first.length <= 40);
    assert.doesNotMatch(first, /[\\/]/);
  });

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
    // Mock openlibrary: env_blocked=false but policy log mentions env_blocked
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        statusText: 'NEEDS_MORE_CONTEXT',
        terminalOutcome: 'AGENT_FAILURE',
        envBlocked: false,
        patchBytes: 0,
        goldDiffOk: false,
        stdoutStderr:
          'progress_policy env_blocked: ENV_BLOCKED: verification cannot run in this environment',
      }),
      'agent:empty_patch',
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

    // Frozen denominator: manifest exists before/through abort; open attempts remain non-terminal
    const evidenceDir = join(dir, 'evidence');
    assert.equal(existsSync(join(evidenceDir, 'campaign-manifest.json')), true);
    const manifest = loadCampaignManifest(evidenceDir);
    assert.equal(manifest.expected_attempts.length, 7);
    assert.equal(manifest.causal_stage1_complete_design, false);
    assert.equal(manifest.identity.mode, 'chat-headless');
    const states = listAttemptStates(evidenceDir);
    assert.equal(states.length, 7);
    assert.equal(validateConservation(manifest, states).ok, true);
    // 5 live terminals + remaining queued/running after early-stop
    const terminal = states.filter((s) => s.lifecycle === 'terminal').length;
    assert.equal(terminal, 5);
    const open = states.filter((s) => s.lifecycle === 'queued' || s.lifecycle === 'running');
    assert.ok(open.length >= 2, 'early-stop must leave expected attempts open for reconcile');

    const recon = reconcileCampaignEvidence({
      evidenceDir,
      graceMs: 0,
      nowMs: Date.now() + 60_000,
      processTreeAlive: false,
      processRecord: {
        pid: 1,
        started_at: '2026-07-30T12:00:00.000Z',
        launch_method: 'test',
      },
    });
    assert.equal(recon.conservation_ok, true);
    assert.equal(recon.campaign_complete, true);
    assert.ok(recon.orphaned_attempt_ids.length >= 2);
  });

  test('W1 D: classifyFailToPassResult separates collect_error from assert_fail', () => {
    assert.equal(classifyFailToPassResult({ exitCode: 0, output: '1 passed' }), 'pass');
    assert.equal(
      classifyFailToPassResult({
        exitCode: 4,
        output:
          "ImportError while loading conftest\nModuleNotFoundError: No module named 'web'",
      }),
      'collect_error',
    );
    assert.equal(
      classifyFailToPassResult({
        exitCode: 1,
        output: 'FAILED test_x.py::test_y - AssertionError',
      }),
      'assert_fail',
    );
    assert.equal(
      classifyFailToPassResult({ exitCode: null, skippedReason: 'disabled' }),
      'skipped',
    );
  });

  test('W1 C: production patch + collect_error → verifier_collect_error signature', () => {
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        patchBytes: 1040,
        goldDiffOk: false,
        terminalOutcome: 'BLOCKED_EXTERNAL',
        envBlocked: false,
        failToPassClass: 'collect_error',
      }),
      'agent:verifier_collect_error',
    );
    // Without patch, collect stays env/external path
    assert.equal(
      classifyCampaignFailureSignature({
        phase: 'live',
        patchBytes: 0,
        goldDiffOk: false,
        terminalOutcome: 'BLOCKED_EXTERNAL',
        envBlocked: false,
        failToPassClass: 'collect_error',
      }),
      'agent:blocked_external',
    );
  });

  test('W1.3: resolveSweProPassMode + cellPassesByMode dual scoreboard', () => {
    assert.equal(resolveSweProPassMode({}), 'gold');
    assert.equal(resolveSweProPassMode({ BABEL_SWE_PRO_PASS_MODE: 'gold' }), 'gold');
    assert.equal(resolveSweProPassMode({ BABEL_SWE_PRO_PASS_MODE: 'ftp' }), 'ftp');
    assert.equal(resolveSweProPassMode({ BABEL_SWE_PRO_PASS_MODE: 'both' }), 'both');
    assert.equal(resolveSweProPassMode({ BABEL_SWE_PRO_PASS_MODE: 'fail_to_pass' }), 'ftp');

    // gold mode: historical — gold only
    assert.equal(cellPassesByMode(true, false, 'gold'), true);
    assert.equal(cellPassesByMode(false, true, 'gold'), false);
    assert.equal(cellPassesByMode(null, true, 'gold'), false);

    // ftp mode
    assert.equal(cellPassesByMode(false, true, 'ftp'), true);
    assert.equal(cellPassesByMode(true, false, 'ftp'), false);
    assert.equal(cellPassesByMode(true, null, 'ftp'), false);

    // both requires gold AND ftp
    assert.equal(cellPassesByMode(true, true, 'both'), true);
    assert.equal(cellPassesByMode(true, false, 'both'), false);
    assert.equal(cellPassesByMode(false, true, 'both'), false);
  });

  test('W1.2 H4: resolveProTestPathHint strips Python-list / JSON brackets', () => {
    assert.equal(
      resolveProTestPathHint({
        instance_id: '4a5d',
        repo: 'internetarchive/openlibrary',
        base_commit: 'abc',
        problem_statement: 'x',
        selected_test_files_to_run: '["openlibrary/tests/core/test_wikidata.py"]',
        fail_to_pass:
          "['openlibrary/tests/core/test_wikidata.py::test_get_statement_values']",
      }),
      'openlibrary/tests/core/test_wikidata.py',
    );
    // fall back to fail_to_pass file path when selected absent
    assert.equal(
      resolveProTestPathHint({
        instance_id: 'x',
        repo: 'a/b',
        base_commit: 'c',
        problem_statement: 'y',
        fail_to_pass:
          "['openlibrary/tests/core/test_wikidata.py::test_get_statement_values']",
      }),
      'openlibrary/tests/core/test_wikidata.py',
    );
    assert.deepEqual(
      parseSweStringList(
        "['openlibrary/tests/core/test_wikidata.py::test_get_statement_values']",
      ),
      ['openlibrary/tests/core/test_wikidata.py::test_get_statement_values'],
    );
  });

  test('W1.2 H3: applyInstanceTestPatch applies unified diff into a git workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-test-patch-'));
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
      });
    assert.equal(git(['init']).status, 0);
    // Identity for commit on clean CI agents
    git(['config', 'user.email', 'babel-test@example.com']);
    git(['config', 'user.name', 'Babel Test']);
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'test_example.py'), 'def existing():\n    return 1\n', 'utf8');
    assert.equal(git(['add', '.']).status, 0);
    assert.equal(git(['commit', '-m', 'base']).status, 0);

    const empty = applyInstanceTestPatch(dir, '');
    assert.equal(empty.attempted, false);
    assert.equal(empty.applied, false);

    const patch = [
      'diff --git a/tests/test_example.py b/tests/test_example.py',
      'index 1111111..2222222 100644',
      '--- a/tests/test_example.py',
      '+++ b/tests/test_example.py',
      '@@ -1,2 +1,5 @@',
      ' def existing():',
      '     return 1',
      '+',
      '+def test_get_statement_values():',
      '+    assert True',
      '',
    ].join('\n');

    const first = applyInstanceTestPatch(dir, patch);
    assert.equal(first.attempted, true, first.error ?? 'apply should attempt');
    assert.equal(first.applied, true, first.error ?? 'apply should succeed');
    const body = readFileSync(join(dir, 'tests', 'test_example.py'), 'utf8');
    assert.match(body, /test_get_statement_values/);
    assert.equal(existsSync(join(dir, '.babel-swe-pro-test-patch.ok')), true);

    // test_patch committed → working tree clean (agent-only diffs later)
    const dirty = spawnSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal((dirty.stdout ?? '').trim(), '', 'test_patch must be committed baseline');

    // Idempotent on reused workspace
    const second = applyInstanceTestPatch(dir, patch);
    assert.equal(second.applied, true);
  });
});
