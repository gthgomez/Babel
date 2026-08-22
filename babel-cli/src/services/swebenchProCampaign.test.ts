/**
 * Unit tests for SWE-Bench Pro campaign early-stop + signatures (no network).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyInstanceTestPatch,
  assertSelectableStage1Arms,
  cellPassesByMode,
  classifyCampaignFailureSignature,
  classifyFailToPassResult,
  defaultRunLiveCell,
  ensureShadowSummaryForCampaign,
  liveEvidenceStem,
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
  type CausalStage1Arm,
  type ExpectedAttempt,
} from './causalCampaignContract.js';
import { packageHintFromRepo } from './workspaceDepPreflight.js';
import { parseSweStringList } from './agentBenchmarkHarness.js';
import {
  createArmRegistry,
  createBabelCliChatHeadlessArmExecutor,
  type ArmExecutionRequest,
  type ArmExecutor,
} from './campaignExecutors.js';
import { createOpenCodeCliArmExecutor } from './campaignExecutors.opencode.js';

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

/**
 * Pre-seed a committed git workspace so defaultRunLiveCell's
 * `existsSync → checkoutProRepo` path never needs network.
 */
function seedGitWorkspace(ws: string): void {
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'tracked.txt'), 'base\n', 'utf8');
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: ws, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init']).status, 0);
  git(['config', 'user.email', 'babel-test@example.com']);
  git(['config', 'user.name', 'Babel Test']);
  git(['add', '.']);
  assert.equal(git(['commit', '-m', 'base']).status, 0);
}

describe('swebenchProCampaign early-stop', () => {
  test('workspace directory names stay short and stable for Windows paths', () => {
    const instanceId = 'instance_internetarchive__openlibrary-' + 'a'.repeat(120);
    const first = workspaceDirectoryName(instanceId);
    assert.equal(first, workspaceDirectoryName(instanceId));
    assert.ok(first.length <= 40);
    assert.doesNotMatch(first, /[\\/]/);
  });

  test('B1: workspaceDirectoryName scopes attempts by arm+replicate, legacy name preserved', () => {
    const id = 'scope_check_instance';
    const bare = workspaceDirectoryName(id);
    // Legacy continuity: default single-attempt path keeps the historical name.
    assert.equal(workspaceDirectoryName(id), bare);
    assert.equal(workspaceDirectoryName(id, undefined, undefined), bare);
    assert.equal(
      workspaceDirectoryName(id, 'babel_enforce', 0),
      bare,
      'babel_enforce×r0 keeps the historical bare name (evidence-dir layout + disk reuse)',
    );
    // Every other attempt gets its own suffixed directory.
    assert.equal(workspaceDirectoryName(id, 'raw_opencode', 0), `${bare}.raw_opencode.r0`);
    assert.equal(workspaceDirectoryName(id, 'raw_opencode', 1), `${bare}.raw_opencode.r1`);
    assert.equal(workspaceDirectoryName(id, 'babel_enforce', 1), `${bare}.babel_enforce.r1`);
    assert.equal(
      workspaceDirectoryName(id, 'babel_prompt_control', 7),
      `${bare}.babel_prompt_control.r7`,
    );
    // Distinct (arm, replicate) ⇒ distinct directories — the contamination fix.
    const all = [
      bare,
      workspaceDirectoryName(id, 'raw_opencode', 0),
      workspaceDirectoryName(id, 'raw_opencode', 1),
      workspaceDirectoryName(id, 'babel_enforce', 1),
      workspaceDirectoryName(id, 'babel_shadow', 0),
    ];
    assert.equal(new Set(all).size, all.length);
    // Suffixed names remain short and Windows-path-safe.
    const suffixed = workspaceDirectoryName(id, 'babel_prompt_control', 12);
    assert.doesNotMatch(suffixed, /[\\/]/);
    assert.ok(suffixed.length <= 70);
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

  test('W2: two arms × two replicates attempt every manifest expected attempt (mock)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-w2-'));
    const dataset = join(dir, 'pilot.jsonl');
    const rows: SwebenchProInstanceRow[] = [1, 2].map((i) => ({
      instance_id: `instance_${i}`,
      repo: 'example/repo',
      base_commit: 'deadbeef',
      problem_statement: 'fix me',
      patch: 'diff',
    }));
    writeFileSync(dataset, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const evidenceDir = join(dir, 'evidence');

    const report = await runSwebenchProCampaign({
      datasetPath: dataset,
      evidenceDir,
      provider: 'mock',
      causalArms: ['babel_enforce', 'raw_opencode'],
      causalReplicates: 2,
      arms: ['babel_enforce', 'raw_opencode'],
      replicates: 2,
      now: new Date('2026-08-01T00:00:00.000Z'),
      runCell: (instance, phase) =>
        phase === 'infra'
          ? cell({
              instance_id: instance.instance_id,
              phase: 'infra',
              status: 'pass',
              signature: 'infra:ok',
            })
          : cell({
              instance_id: instance.instance_id,
              phase: 'live',
              status: 'fail',
              // Per-instance signatures keep the GLOBAL early-stop streak
              // (abort threshold 5) out of the way of full-matrix coverage.
              signature: `agent:fail_${instance.instance_id}`,
              evidence_path: join(dir, 'live', `${instance.instance_id}.injected.json`),
            }),
    });

    // Frozen denominator: 2 tasks × 2 arms × 2 replicates = 8 expected attempts…
    const manifest = loadCampaignManifest(evidenceDir);
    assert.equal(manifest.expected_attempts.length, 8);
    // …all of which were executed and terminalized (no orphans left behind).
    const states = listAttemptStates(evidenceDir);
    assert.equal(validateConservation(manifest, states).ok, true);
    assert.equal(states.filter((s) => s.lifecycle === 'terminal').length, 8);
    for (const exp of manifest.expected_attempts) {
      const st = states.find((s) => s.attempt_id === exp.attempt_id);
      assert.ok(st, `state missing for ${exp.attempt_id}`);
      assert.equal(st.lifecycle, 'terminal');
      assert.equal(
        st.terminal_signature,
        exp.arm === 'raw_opencode' ? 'live:skipped_mock_provider' : `agent:fail_${exp.task_id}`,
      );
    }

    // raw_opencode under mock: exact honest-skip shape, one per (task, replicate).
    const rawCells = report.cells.filter((c) => c.phase === 'live' && c.arm === 'raw_opencode');
    assert.equal(rawCells.length, 4);
    assert.ok(
      rawCells.every(
        (c) =>
          c.status === 'skipped' &&
          c.signature === 'live:skipped_mock_provider' &&
          c.duration_ms === 0,
      ),
    );

    // Every live cell carries structured experiment identity (additive keys).
    const babelCells = report.cells.filter((c) => c.phase === 'live' && c.arm === 'babel_enforce');
    assert.equal(babelCells.length, 4);
    for (const c of [...rawCells, ...babelCells]) {
      assert.equal(typeof c.replicate_id, 'number');
      assert.ok(c.arm_harness);
      assert.ok(c.execution_profile);
    }
    assert.deepEqual(babelCells[0]!.arm_harness, {
      name: 'babel',
      adapter_id: 'babel_cli_chat_headless',
      version: null,
    });
    assert.equal(babelCells[0]!.execution_profile?.policy_mode, 'full');
    assert.deepEqual(rawCells[0]!.arm_harness, {
      name: 'opencode',
      adapter_id: 'opencode_cli_raw',
      version: null,
    });
    assert.equal(rawCells[0]!.execution_profile?.policy_mode, 'external');

    // Harness-produced per-attempt evidence paths never collide across arms.
    const rawPaths = rawCells.map((c) => c.evidence_path);
    assert.equal(new Set(rawPaths).size, 4);
    // Stem scheme: legacy continuity for babel_enforce r0; suffixed otherwise
    // (default-path files; injected fixtures carry their own paths).
    assert.equal(liveEvidenceStem('i', 'babel_enforce', 0), 'i');
    assert.equal(liveEvidenceStem('i', 'babel_enforce', 1), 'i.babel_enforce.r1');
    assert.equal(liveEvidenceStem('i', 'raw_opencode', 0), 'i.raw_opencode.r0');
    assert.ok(
      rawCells.some((c) => /instance_1\.raw_opencode\.r1\.skipped\.json$/.test(c.evidence_path.replace(/\\/g, '/'))),
    );
  });

  test('W2: babel-arm invocation args preserved byte-for-byte through executor seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-argv-'));
    const instanceId = 'argv_check_instance';
    const evidenceDir = join(dir, 'evidence');
    const wsRoot = join(evidenceDir, 'workspaces', workspaceDirectoryName(instanceId));
    mkdirSync(wsRoot, { recursive: true });
    writeFileSync(join(wsRoot, 'README.md'), 'base\n', 'utf8');
    const git = (args: string[]) =>
      spawnSync('git', args, { cwd: wsRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(git(['init']).status, 0);
    git(['config', 'user.email', 'babel-test@example.com']);
    git(['config', 'user.name', 'Babel Test']);
    git(['add', '.']);
    assert.equal(git(['commit', '-m', 'base']).status, 0);

    // Recorder CLI entry: prints a valid chat-headless-style JSON payload that
    // embeds the exact argv/cwd it was spawned with. BABEL_CLI_ENTRY skips the
    // dist gate and routes the REAL dispatch path (armRegistry → ArmExecutor →
    // runBabelCli) at this script, letting us observe the wrapped args.
    // NOTE: there is no seam for injecting a spawn spy into runBabelCli itself,
    // so argv parity is observed through this real-entrypoint recorder instead.
    const recorder = join(dir, 'recorder.mjs');
    writeFileSync(
      recorder,
      [
        'const payload = {',
        '  status: "ANSWER_READY",',
        '  argv: process.argv.slice(2),',
        '  cwd: process.cwd(),',
        '};',
        'process.stdout.write(JSON.stringify(payload));',
        '',
      ].join('\n'),
      'utf8',
    );

    const row: SwebenchProInstanceRow = {
      instance_id: instanceId,
      repo: 'example/repo',
      base_commit: 'deadbeef',
      problem_statement: 'fix the flibber widget regression',
      patch: '',
      fail_to_pass: '',
      selected_test_files_to_run: '',
    };
    const manifestAttempt = {
      attempt_id: 'att_argv_test',
      pair_id: 'pair_argv_test',
      task_id: instanceId,
      arm: 'babel_enforce' as const,
      replicate_id: 0,
      arm_order: 0,
      arm_config_hash: 'h',
    };
    const registry = createArmRegistry();
    registry.register(createBabelCliChatHeadlessArmExecutor());
    registry.register(createOpenCodeCliArmExecutor());

    const prevEntry = process.env['BABEL_CLI_ENTRY'];
    process.env['BABEL_CLI_ENTRY'] = recorder;
    let cellResult;
    try {
      cellResult = await defaultRunLiveCell(
        row,
        evidenceDir,
        'mock',
        'deepseek-v4-flash',
        { depPreflight: false },
        {
          registry,
          exp: manifestAttempt,
        },
      );
    } finally {
      if (prevEntry === undefined) delete process.env['BABEL_CLI_ENTRY'];
      else process.env['BABEL_CLI_ENTRY'] = prevEntry;
    }

    assert.equal(cellResult.arm, 'babel_enforce');
    assert.equal(cellResult.replicate_id, 0);
    assert.equal(cellResult.cli_exit_code, 0);

    const evidence = JSON.parse(readFileSync(cellResult.evidence_path, 'utf8')) as {
      arm?: string;
      replicate_id?: number;
      arm_harness?: { name: string; adapter_id: string; version: null };
      execution_profile?: { policy_mode?: string; diagnostic?: boolean };
      cli_payload?: { status?: string; argv?: string[]; cwd?: string };
    };
    // Structured experiment identity stamped into the cell evidence JSON.
    assert.equal(evidence.arm, 'babel_enforce');
    assert.equal(evidence.replicate_id, 0);
    assert.deepEqual(evidence.arm_harness, {
      name: 'babel',
      adapter_id: 'babel_cli_chat_headless',
      version: null,
    });
    assert.equal(evidence.execution_profile?.policy_mode, 'full');
    // Compat layer recovered the payload from executor stdout (parse parity).
    assert.equal(evidence.cli_payload?.status, 'ANSWER_READY');
    // Pre-seam argv contract, byte-for-byte (mock provider → no --model flag):
    // ['run','--mode','chat-headless','--json','--yes','--project-root',ws,prompt]
    const argv = evidence.cli_payload?.argv ?? [];
    assert.deepEqual(argv.slice(0, 6), [
      'run',
      '--mode',
      'chat-headless',
      '--json',
      '--yes',
      '--project-root',
    ]);
    assert.equal(argv[6], wsRoot);
    assert.match(argv[7] ?? '', /flibber widget regression/);
    assert.equal(argv.length, 8);
    assert.ok(
      (evidence.cli_payload?.cwd ?? '').replace(/\\/g, '/').endsWith('/babel-cli'),
      `unexpected spawn cwd: ${evidence.cli_payload?.cwd}`,
    );
  });

  test('B1: each attempt gets its own fresh workspace — no cross-attempt contamination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-ws-scope-'));
    const instanceId = 'ws_scope_instance';
    const evidenceDir = join(dir, 'evidence');
    const row: SwebenchProInstanceRow = {
      instance_id: instanceId,
      repo: 'example/repo',
      base_commit: 'deadbeef',
      problem_statement: 'fix the flibber widget regression',
      patch: '',
      fail_to_pass: '',
      selected_test_files_to_run: '',
    };

    const wsFor = (arm: CausalStage1Arm, replicateId: number): string =>
      join(evidenceDir, 'workspaces', workspaceDirectoryName(instanceId, arm, replicateId));
    // Existence is exactly what keys the harness's fresh-checkout decision:
    // pre-seeding proves per-attempt dirs are distinct and never shared.
    seedGitWorkspace(wsFor('babel_enforce', 0));
    seedGitWorkspace(wsFor('raw_opencode', 0));

    // Recorder/mutator executor: appends an arm-specific mutation into
    // whatever workspaceRoot it was handed, records the root, and echoes a
    // chat-headless-style payload so the compat layer parses it.
    const seenRoots: string[] = [];
    const registry = createArmRegistry();
    const mutatingExecutor: ArmExecutor = {
      id: 'fake_mutating_executor',
      supports: (arm) => arm === 'babel_enforce' || arm === 'raw_opencode',
      execute: async (request: ArmExecutionRequest) => {
        seenRoots.push(request.workspaceRoot);
        appendFileSync(
          join(request.workspaceRoot, 'tracked.txt'),
          `mutation_${request.arm}\n`,
          'utf8',
        );
        return {
          executorId: 'fake_mutating_executor',
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({ status: 'ANSWER_READY' }),
          stderr: '',
          launchError: null,
        };
      },
    };
    registry.register(mutatingExecutor);

    const expFor = (arm: CausalStage1Arm): ExpectedAttempt => ({
      attempt_id: `att_ws_scope_${arm}`,
      pair_id: `pair_ws_scope_${arm}`,
      task_id: instanceId,
      arm,
      replicate_id: 0,
      arm_order: 0,
      arm_config_hash: 'h',
    });

    // Dist-gate skip: the fake executors never spawn a CLI.
    const prevEntry = process.env['BABEL_CLI_ENTRY'];
    process.env['BABEL_CLI_ENTRY'] = join(dir, 'unused-entry.mjs');
    let enforceCell: CampaignCellResult;
    let rawCell: CampaignCellResult;
    try {
      enforceCell = await defaultRunLiveCell(
        row,
        evidenceDir,
        'mock',
        'deepseek-v4-flash',
        { depPreflight: false },
        { registry, exp: expFor('babel_enforce') },
      );
      rawCell = await defaultRunLiveCell(
        row,
        evidenceDir,
        'mock',
        'deepseek-v4-flash',
        { depPreflight: false },
        { registry, exp: expFor('raw_opencode') },
      );
    } finally {
      if (prevEntry === undefined) delete process.env['BABEL_CLI_ENTRY'];
      else process.env['BABEL_CLI_ENTRY'] = prevEntry;
    }

    const norm = (p: string) => p.replace(/\\/g, '/');
    assert.equal(seenRoots.length, 2);
    // (a) Distinct workspaceRoots per attempt; legacy attempt keeps bare name.
    assert.equal(norm(seenRoots[0]!), norm(wsFor('babel_enforce', 0)));
    assert.equal(
      norm(seenRoots[0]!),
      norm(join(evidenceDir, 'workspaces', workspaceDirectoryName(instanceId))),
      'legacy babel_enforce×r0 must keep the historical bare workspace name',
    );
    assert.equal(norm(seenRoots[1]!), norm(wsFor('raw_opencode', 0)));
    assert.notEqual(norm(seenRoots[0]!), norm(seenRoots[1]!));

    // (b) Second attempt's captured patch does NOT contain first attempt's mutation.
    const patchFileOf = (c: CampaignCellResult): string => c.evidence_path.replace(/\.json$/, '.patch');
    const enforcePatch = readFileSync(patchFileOf(enforceCell), 'utf8');
    const rawPatch = readFileSync(patchFileOf(rawCell), 'utf8');
    assert.match(enforcePatch, /mutation_babel_enforce/);
    assert.doesNotMatch(rawPatch, /mutation_babel_enforce/, 'attempt N must not inherit attempt N−1 work');
    assert.match(rawPatch, /mutation_raw_opencode/);
  });

  test('B2: placebo arms are refused loudly before any artifact is written', async () => {
    // Guard-level behavior.
    assert.doesNotThrow(() => assertSelectableStage1Arms(['babel_enforce']));
    assert.doesNotThrow(() => assertSelectableStage1Arms(['babel_enforce', 'raw_opencode']));
    assert.throws(() => assertSelectableStage1Arms(['babel_shadow']), /babel_shadow/);
    assert.throws(() => assertSelectableStage1Arms(['raw_opencode', 'babel_prompt_control']), /babel_prompt_control/);

    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-placebo-'));
    const dataset = join(dir, 'pilot.jsonl');
    const rows: SwebenchProInstanceRow[] = [
      {
        instance_id: 'instance_1',
        repo: 'example/repo',
        base_commit: 'deadbeef',
        problem_statement: 'x',
        patch: 'diff',
      },
    ];
    writeFileSync(dataset, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Execution subset selects a placebo → refuse.
    await assert.rejects(
      runSwebenchProCampaign({
        datasetPath: dataset,
        evidenceDir: join(dir, 'ev-shadow'),
        provider: 'mock',
        arms: ['babel_enforce', 'babel_shadow'],
        now: new Date('2026-08-02T00:00:00.000Z'),
        runCell: () =>
          cell({ instance_id: 'instance_1', phase: 'infra', status: 'pass', signature: 'infra:ok' }),
      }),
      (err: Error) => {
        assert.match(err.message, /Refusing to select unimplemented stage-1 arm\(s\): 'babel_shadow'/);
        assert.match(err.message, /policy_mode\/prompt_delta reach neither argv nor env/);
        assert.match(err.message, /OX_ALPHA_EXPERIMENTAL_PROGRAM\.md/);
        return true;
      },
    );

    // Frozen denominator names a placebo → refuse too (attempts could only
    // ever run as byte-identical placebos or orphan forever).
    await assert.rejects(
      runSwebenchProCampaign({
        datasetPath: dataset,
        evidenceDir: join(dir, 'ev-prompt-control'),
        provider: 'mock',
        causalArms: ['babel_enforce', 'babel_prompt_control'],
        now: new Date('2026-08-02T00:00:00.000Z'),
        runCell: () =>
          cell({ instance_id: 'instance_1', phase: 'infra', status: 'pass', signature: 'infra:ok' }),
      }),
      /'babel_prompt_control'/,
    );

    // Loud failure means loud: zero partial evidence directories linger.
    assert.equal(existsSync(join(dir, 'ev-shadow')), false);
    assert.equal(existsSync(join(dir, 'ev-prompt-control')), false);
  });

  test('m1: failure capsules keep executor fidelity (timeout/launch fields; signal honestly null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-pro-capsule-'));
    const evidenceDir = join(dir, 'evidence');
    const rowFor = (instanceId: string, problem: string): SwebenchProInstanceRow => ({
      instance_id: instanceId,
      repo: 'example/repo',
      base_commit: 'deadbeef',
      problem_statement: problem,
      patch: '',
      fail_to_pass: '',
      selected_test_files_to_run: '',
    });
    const wsFor = (instanceId: string, arm: CausalStage1Arm, replicateId: number): string =>
      join(evidenceDir, 'workspaces', workspaceDirectoryName(instanceId, arm, replicateId));
    seedGitWorkspace(wsFor('capsule_a', 'babel_enforce', 0));
    seedGitWorkspace(wsFor('capsule_b', 'raw_opencode', 0));

    const registry = createArmRegistry();
    registry.register({
      id: 'fake_capsule_executor',
      supports: () => true,
      async execute(request: ArmExecutionRequest) {
        if (request.prompt.includes('LAUNCH_FAIL')) {
          return {
            executorId: 'fake_capsule_executor',
            exitCode: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            launchError: 'spawn fake ENOENT',
          };
        }
        return {
          executorId: 'fake_capsule_executor',
          exitCode: null,
          timedOut: true,
          stdout: '',
          stderr: '',
          launchError: null,
        };
      },
    });

    const expFor = (taskId: string, arm: CausalStage1Arm): ExpectedAttempt => ({
      attempt_id: `att_capsule_${arm}`,
      pair_id: `pair_capsule_${arm}`,
      task_id: taskId,
      arm,
      replicate_id: 0,
      arm_order: 0,
      arm_config_hash: 'h',
    });

    const prevEntry = process.env['BABEL_CLI_ENTRY'];
    process.env['BABEL_CLI_ENTRY'] = join(dir, 'unused-entry.mjs');
    let timeoutCell: CampaignCellResult;
    let launchCell: CampaignCellResult;
    try {
      timeoutCell = await defaultRunLiveCell(
        rowFor('capsule_a', 'please run normally'),
        evidenceDir,
        'mock',
        'm',
        { depPreflight: false },
        { registry, exp: expFor('capsule_a', 'babel_enforce') },
      );
      launchCell = await defaultRunLiveCell(
        rowFor('capsule_b', 'LAUNCH_FAIL please'),
        evidenceDir,
        'mock',
        'm',
        { depPreflight: false },
        { registry, exp: expFor('capsule_b', 'raw_opencode') },
      );
    } finally {
      if (prevEntry === undefined) delete process.env['BABEL_CLI_ENTRY'];
      else process.env['BABEL_CLI_ENTRY'] = prevEntry;
    }

    const timeoutCapsule = JSON.parse(
      readFileSync(timeoutCell.evidence_path.replace(/\.json$/, '.failure-capsule.json'), 'utf8'),
    ) as { timed_out?: boolean; error_name?: string | null; error_message?: string | null; signal?: string | null; failure_class_hint?: string };
    assert.equal(timeoutCapsule.timed_out, true);
    assert.equal(timeoutCapsule.error_name, 'timeout');
    assert.equal(timeoutCapsule.error_message, 'timeout');
    assert.equal(timeoutCapsule.signal, null);
    assert.equal(timeoutCapsule.failure_class_hint, 'harness_timeout');

    const launchCapsule = JSON.parse(
      readFileSync(launchCell.evidence_path.replace(/\.json$/, '.failure-capsule.json'), 'utf8'),
    ) as { timed_out?: boolean; error_name?: string | null; error_message?: string | null; signal?: string | null };
    assert.equal(launchCapsule.timed_out, false);
    assert.equal(launchCapsule.error_name, 'LaunchError');
    assert.equal(launchCapsule.error_message, 'spawn fake ENOENT');
    assert.equal(launchCapsule.signal, null);
  });
});
