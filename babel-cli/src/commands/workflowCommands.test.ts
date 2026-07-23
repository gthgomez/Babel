import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSmallFixLitePayload,
  normalizeSmallFixProvider,
  resolveSmallFixProviderForCommand,
  shouldRecoverLitePlanSchemaFailure,
} from './workflowCommands.js';
import { formatLiteResultHuman } from '../cli/structuredOutput.js';
import { stripAnsi } from '../ui/theme.js';
import type { SmallFixCompleted } from '../services/smallFix.js';

function makeResult(result: Partial<SmallFixCompleted>): SmallFixCompleted {
  return {
    status: 'SMALL_FIX_COMPLETE',
    task: 'Fix the failing test',
    project: 'example_saas_backend',
    projectRoot: 'C:/tmp/fix-root',
    targetFile: 'src/math.js',
    verifierCommand: 'npm test',
    runDir: '/tmp/run',
    scopePath: '/tmp/run',
    changedFiles: [],
    checks: [],
    summary: 'Updated file',
    usageSummary: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      modelBreakdown: {},
    },
    ...result,
  };
}

function writeFixture(
  runDir: string,
  options: {
    withCheckpoint?: boolean;
    smallFixCheckpointId?: string;
  } = {},
): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'terminal_status_summary.json'),
    JSON.stringify({
      artifact_type: 'babel_terminal_status_summary',
      schema_version: 1,
      status: 'COMPLETE',
    }),
    'utf-8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({ status: 'SMALL_FIX_COMPLETE' }),
    'utf-8',
  );
  writeFileSync(join(runDir, 'small_fix_answer.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
  writeFileSync(join(runDir, 'small_fix_verifier_stdout.log'), 'ok', 'utf-8');
  writeFileSync(join(runDir, 'small_fix_verifier_stderr.log'), '', 'utf-8');
  writeFileSync(
    join(runDir, 'cost_ledger.json'),
    JSON.stringify({
      artifact_type: 'babel_cost_ledger',
    }),
    'utf-8',
  );
  if (options.withCheckpoint === true) {
    mkdirSync(join(runDir, 'checkpoints'), { recursive: true });
    writeFileSync(
      join(runDir, 'checkpoints', 'checkpoints.json'),
      JSON.stringify({
        checkpoints: [{ id: 'cp-quick-fix' }],
      }),
      'utf-8',
    );
  }
  if (options.smallFixCheckpointId !== undefined) {
    writeFileSync(
      join(runDir, 'small_fix_checkpoint.json'),
      JSON.stringify({
        schema_version: 1,
        checkpoint_id: options.smallFixCheckpointId,
        scope_artifact_type: 'small_fix_checkpoint',
        target_file: 'src/math.js',
        tool: 'file_write',
        target_path: '/tmp/run/src/math.js',
        changed_files: ['src/math.js'],
        changed: true,
        pre_mutation: {
          checksum_sha256: 'abc',
          bytes_before: 10,
        },
        post_mutation: {
          checksum_sha256: 'def',
          bytes_after: 12,
        },
      }),
      'utf-8',
    );
  }
}

describe('buildSmallFixLitePayload', () => {
  it('renders complete fix output with verification, checkpoints, evidence, and usage ledger path', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-small-fix-complete-'));
    try {
      writeFixture(runDir, {
        withCheckpoint: true,
        smallFixCheckpointId: 'cp-small-fix',
      });
      const payload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_COMPLETE',
          changedFiles: ['src/math.js'],
          checks: ['npm test: passed'],
          usageSummary: {
            totalCostUSD: 0.012,
            totalInputTokens: 20,
            totalOutputTokens: 8,
            totalTokens: 28,
            modelBreakdown: {},
          },
          runDir,
          project: 'example_saas_backend',
          projectRoot: 'C:/project/root',
        }),
        {
          verb: 'fix',
          task: 'repair the failing math test',
          project: 'example_saas_backend',
          projectRoot: 'C:/project/root',
        },
      );

      assert.equal(payload.status, 'FIX_COMPLETE');
      assert.equal(payload.user_status, 'success');
      assert.equal(payload.execution_path, 'small_fix');

      const loopPayload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_COMPLETE',
          changedFiles: ['src/math.js'],
          checks: ['npm test: passed'],
          usageSummary: {
            totalCostUSD: 0.012,
            totalInputTokens: 20,
            totalOutputTokens: 8,
            totalTokens: 28,
            modelBreakdown: {},
          },
          runDir,
          project: 'example_saas_backend',
          projectRoot: 'C:/project/root',
          sessionLoopSteps: [
            { phase: 'observe', status: 'pass', policy_decision: 'allow' },
            { phase: 'act', status: 'pass', policy_decision: 'allow' },
            { phase: 'verify', status: 'pass', policy_decision: 'allow' },
            { phase: 'finish', status: 'pass', policy_decision: 'allow' },
          ],
        }),
        {
          verb: 'fix',
          task: 'repair the failing math test',
          project: 'example_saas_backend',
          projectRoot: 'C:/project/root',
        },
      );
      assert.equal(loopPayload.execution_path, 'session_loop');
      assert.equal(loopPayload.session_loop_steps?.length, 4);
      assert.deepEqual(payload.changed_files, ['src/math.js']);
      assert.equal(payload.verification.status, 'passed');
      assert.equal(payload.verification.skipped_reason, null);
      assert.equal(payload.checkpoint.required, true);
      assert.equal(payload.checkpoint.available, true);
      assert.equal(payload.checkpoint.restore_command, 'babel undo');
      assert.equal(payload.checkpoint.inspect_command, `babel checkpoint list --run "${runDir}"`);
      assert.equal(payload.usage.cost_ledger_path, join(runDir, 'cost_ledger.json'));
      assert.equal(payload.failure_capsule_path, undefined);
      assert.match(
        String(
          payload.evidence.artifacts.find((artifact) => artifact.endsWith('cost_ledger.json')),
        ),
        /cost_ledger\.json$/,
      );
      assert.ok(payload.evidence.artifacts.includes(join(runDir, 'small_fix_scope_before.json')));
      assert.ok(payload.evidence.artifacts.includes(join(runDir, 'small_fix_checkpoint.json')));
      assert.match(payload.next.join('\n'), /Review the changed file\./);
      assert.equal(payload.answer?.summary, 'Updated file');

      const human = stripAnsi(formatLiteResultHuman(payload));
      assert.match(human, /^Babel Small Fix Complete/);
      assert.match(human, /\nMode:\nSmall Fix/);
      assert.match(human, /Changed:\n- src\/math\.js/);
      assert.match(human, /Verified:\n- npm test: passed/);
      assert.match(human, /Recovery:\n- Undo: babel undo/);
      assert.match(human, new RegExp(`Run: ${runDir.replace(/\\/g, '\\\\')}`));
      assert.match(human, /28 tokens/);
      assert.doesNotMatch(human, /Cost ledger:/);
      assert.match(
        human,
        /Answer:\n(?:Updated file|Completed the small fix run and changed src\/math\.js\.)/,
      );

      const doPayload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_COMPLETE',
          changedFiles: ['src/math.js'],
          checks: ['npm test: passed'],
          usageSummary: {
            totalCostUSD: 0.012,
            totalInputTokens: 20,
            totalOutputTokens: 8,
            totalTokens: 28,
            modelBreakdown: {},
          },
          runDir,
        }),
        {
          verb: 'do',
          task: 'repair the failing math test',
          projectRoot: 'C:/project/root',
        },
      );

      assert.equal(doPayload.status, 'DO_COMPLETE');

      const notRequiredPayload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_COMPLETE',
          changedFiles: [],
          checks: [],
          usageSummary: {
            totalCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            modelBreakdown: {},
          },
          runDir,
        }),
        {
          verb: 'fix',
          task: 'nothing to change',
          projectRoot: 'C:/project/root',
        },
      );
      assert.equal(notRequiredPayload.verification.status, 'not_required');
      assert.equal(notRequiredPayload.user_status, 'success');
      assert.equal(notRequiredPayload.verification.skipped_reason, null);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('renders progress steps and model summary in human fix output', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-small-fix-progress-'));
    try {
      writeFixture(runDir);
      const payload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_COMPLETE',
          changedFiles: ['src/math.js'],
          checks: ['npm test: passed'],
          summary: 'Fixed add() to return the sum of two numbers.',
          runDir,
        }),
        {
          verb: 'fix',
          task: 'fix the failing test',
          projectRoot: 'C:/project/root',
          progressSteps: ['Scoped src/math.js (npm test)', 'Model patch ready', 'npm test: passed'],
        },
      );

      const human = stripAnsi(formatLiteResultHuman(payload));
      assert.match(
        human,
        /Answer:\n(?:Fixed add\(\) to return the sum of two numbers\.|Completed the small fix run and changed src\/math\.js\.)/,
      );
      assert.match(human, /Progress:\n- Scoped src\/math\.js \(npm test\)/);
      assert.match(human, /- npm test: passed/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('renders failed small-fix output with restore unavailable, verification failed, and recovery fields', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-small-fix-failed-'));
    try {
      writeFixture(runDir);
      writeFileSync(
        join(runDir, 'small_fix_failure_capsule.json'),
        JSON.stringify({
          artifact_type: 'small_fix_failure',
        }),
        'utf-8',
      );
      const payload = buildSmallFixLitePayload(
        makeResult({
          status: 'SMALL_FIX_FAILED',
          changedFiles: [],
          checks: ['npm test: failed'],
          usageSummary: {
            totalCostUSD: 0.007,
            totalInputTokens: 10,
            totalOutputTokens: 2,
            totalTokens: 12,
            modelBreakdown: {},
          },
          runDir,
        }),
        {
          verb: 'fix',
          task: 'repair the failing math test',
          project: 'example_saas_backend',
        },
      );

      assert.equal(payload.status, 'SMALL_FIX_FAILED');
      assert.equal(payload.user_status, 'failed');
      assert.deepEqual(payload.changed_files, []);
      assert.equal(payload.verification.status, 'failed');
      assert.equal(payload.verification.skipped_reason, 'small-fix verification did not pass');
      assert.equal(payload.checkpoint.required, false);
      assert.equal(payload.checkpoint.available, false);
      assert.equal(payload.checkpoint.restore_command, null);
      assert.equal(payload.checkpoint.inspect_command, `babel checkpoint list --run "${runDir}"`);
      assert.equal(payload.failure_capsule_path, join(runDir, 'small_fix_failure_capsule.json'));
      assert.equal(payload.execution_report_path, join(runDir, '04_execution_report.json'));
      assert.equal(payload.retryable, true);
      assert.match(payload.next.join('\n'), /Inspect the verifier output\./);
      assert.equal(payload.usage.cost_ledger_path, join(runDir, 'cost_ledger.json'));

      const human = stripAnsi(formatLiteResultHuman(payload));
      assert.match(human, /^Babel Small Fix Failed/);
      assert.match(human, /\nMode:\nSmall Fix/);
      assert.doesNotMatch(human, /Changed:/);
      assert.match(human, /Verified:\n- npm test: failed/);
      assert.doesNotMatch(human, /Recovery:/);
      assert.doesNotMatch(human, /Complete/);
      assert.match(human, /12 tokens, \$0\.007000/);
      assert.doesNotMatch(human, /Cost ledger:/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('includes execution_mode when offline demo fix completes', () => {
    const payload = buildSmallFixLitePayload(
      makeResult({
        executionMode: 'offline_demo',
        changedFiles: ['src/math.js'],
        checks: ['npm test: passed'],
      }),
      {
        verb: 'fix',
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
      },
    );
    assert.equal(payload.execution_mode, 'offline_demo');
  });
});

describe('small-fix provider command resolution', () => {
  it('normalizes provider flags and env offline mode', () => {
    assert.equal(normalizeSmallFixProvider('mock'), 'mock');
    assert.equal(normalizeSmallFixProvider('live'), 'live');
    assert.throws(() => normalizeSmallFixProvider('offline'), /Invalid provider/);
    assert.equal(resolveSmallFixProviderForCommand({ provider: 'mock' }), 'mock');
    assert.equal(resolveSmallFixProviderForCommand({}, { BABEL_LITE_OFFLINE: '1' }), 'mock');
    assert.equal(resolveSmallFixProviderForCommand({}), 'live');
  });
});

describe('Lite plan schema recovery routing', () => {
  it('recovers direct plan and do-routed plan schema failures only on read-only plan lanes', () => {
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'plan',
        selectedLane: 'lite_plan',
      }),
      true,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'report',
        selectedLane: 'lite_report',
      }),
      true,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'do',
        selectedLane: 'lite_plan',
      }),
      true,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'do',
        selectedLane: 'lite_report',
      }),
      true,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'do',
        selectedLane: 'lite_plan',
        workerChain: true,
      }),
      false,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'do',
        selectedLane: 'lite_fix',
      }),
      false,
    );
    assert.equal(
      shouldRecoverLitePlanSchemaFailure({
        verb: 'fix',
        selectedLane: 'lite_fix',
      }),
      false,
    );
  });
});
