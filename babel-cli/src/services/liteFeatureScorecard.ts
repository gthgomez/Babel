import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readParityCorpusTask,
  writeParityCorpusRepo,
} from './parityCorpus.js';
import { runLiteParallelReviewHarness } from './liteParallelReview.js';
import {
  resolveBabelCliEntry,
  runBabelCli,
} from './liteTrustDemo.js';

export type LiteFeatureDimension =
  | 'plan_mode'
  | 'parallel_review'
  | 'checkpoint_ux'
  | 'verifier_discipline';

export interface LiteFeatureScore {
  dimension: LiteFeatureDimension;
  status: 'pass' | 'fail';
  score: 0 | 1;
  detail: string;
}

export interface LiteFeatureScorecardReport {
  schema_version: 1;
  fixture_type: 'babel_lite_feature_scorecard';
  status: 'pass' | 'fail';
  dimensions: LiteFeatureScore[];
}

function scorePlanMode(projectRoot: string, cliEntry?: string): LiteFeatureScore {
  const cli = runBabelCli([
    'lite',
    'plan',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    projectRoot,
    'Plan how to fix the failing add test in src/math.js without editing tests.',
  ], {
    projectRoot,
    ...(cliEntry !== undefined ? { cliEntry } : {}),
  });
  const status = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
  const passed = cli.exitCode === 0 && status === 'PLAN_READY';
  return {
    dimension: 'plan_mode',
    status: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    detail: passed
      ? 'bl plan returned PLAN_READY on parity fixture repo.'
      : `Expected PLAN_READY; exit=${cli.exitCode}, status=${String(status)}.`,
  };
}

async function scoreParallelReview(): Promise<LiteFeatureScore> {
  const harness = await runLiteParallelReviewHarness();
  const passed = harness.status === 'pass';
  return {
    dimension: 'parallel_review',
    status: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    detail: passed
      ? 'Read-only Spark parallel review harness passed on fixture repos.'
      : `Parallel review harness failed: ${harness.scenarios.filter(s => s.status === 'fail').map(s => s.id).join(', ') || 'unknown'}.`,
  };
}

function scoreCheckpointUx(projectRoot: string, cliEntry?: string): LiteFeatureScore {
  const fixCli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    projectRoot,
    'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
  ], {
    projectRoot,
    ...(cliEntry !== undefined ? { cliEntry } : {}),
  });
  const fixStatus = typeof fixCli.payload?.['status'] === 'string' ? fixCli.payload['status'] : null;
  const checkpoint = fixCli.payload?.['checkpoint'];
  const checkpointRecord = checkpoint && typeof checkpoint === 'object'
    ? checkpoint as Record<string, unknown>
    : null;
  const restoreCommand = typeof checkpointRecord?.['restore_command'] === 'string'
    ? checkpointRecord['restore_command']
    : null;
  const inspectCommand = typeof checkpointRecord?.['inspect_command'] === 'string'
    ? checkpointRecord['inspect_command']
    : null;
  const hasCheckpointSurface = restoreCommand === 'bl undo' &&
    inspectCommand !== null &&
    inspectCommand.includes('checkpoint list');
  const passed = fixCli.exitCode === 0 && fixStatus === 'FIX_COMPLETE' && hasCheckpointSurface;
  return {
    dimension: 'checkpoint_ux',
    status: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    detail: passed
      ? 'Post-fix JSON exposes bl undo and checkpoint inspect commands.'
      : `Expected FIX_COMPLETE with checkpoint restore/inspect commands; fix status=${String(fixStatus)}, restore=${String(restoreCommand)}, inspect=${String(inspectCommand)}.`,
  };
}

function scoreVerifierDiscipline(projectRoot: string, cliEntry?: string): LiteFeatureScore {
  const task = readParityCorpusTask('small_bug_fix');
  const cli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    projectRoot,
    task.task,
  ], {
    projectRoot,
    ...(cliEntry !== undefined ? { cliEntry } : {}),
  });
  const status = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
  const checks = Array.isArray(cli.payload?.['checks'])
    ? cli.payload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  const verifierOk = checks.some(check => check === `${task.verifier_command}: passed`);
  const passed = cli.exitCode === 0 && status === 'FIX_COMPLETE' && verifierOk;
  const falseComplete = cli.exitCode === 0 && status === 'FIX_COMPLETE' && !verifierOk;
  return {
    dimension: 'verifier_discipline',
    status: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    detail: passed
      ? 'FIX_COMPLETE requires verifier pass on parity fixture.'
      : falseComplete
        ? 'False-complete risk: FIX_COMPLETE without verifier pass.'
        : `Expected FIX_COMPLETE with verifier pass; exit=${cli.exitCode}, status=${String(status)}.`,
  };
}

export async function runLiteFeatureScorecard(options: {
  dimensions?: LiteFeatureDimension[];
  cliEntry?: string;
} = {}): Promise<LiteFeatureScorecardReport> {
  const dimensions = options.dimensions ?? [
    'plan_mode',
    'parallel_review',
    'checkpoint_ux',
    'verifier_discipline',
  ];
  const cliEntry = options.cliEntry ?? resolveBabelCliEntry();
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-feature-scorecard-'));
  const scores: LiteFeatureScore[] = [];

  try {
    writeParityCorpusRepo(root, readParityCorpusTask('small_bug_fix'));

    for (const dimension of dimensions) {
      if (dimension === 'plan_mode') {
        scores.push(scorePlanMode(root, cliEntry));
        continue;
      }
      if (dimension === 'parallel_review') {
        scores.push(await scoreParallelReview());
        continue;
      }
      if (dimension === 'checkpoint_ux') {
        scores.push(scoreCheckpointUx(root, cliEntry));
        continue;
      }
      if (dimension === 'verifier_discipline') {
        scores.push(scoreVerifierDiscipline(root, cliEntry));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    schema_version: 1,
    fixture_type: 'babel_lite_feature_scorecard',
    status: scores.every(score => score.status === 'pass') ? 'pass' : 'fail',
    dimensions: scores,
  };
}

export async function runLiteFeatureDimension(
  dimension: LiteFeatureDimension,
  options: { cliEntry?: string } = {},
): Promise<LiteFeatureScore> {
  const report = await runLiteFeatureScorecard({
    dimensions: [dimension],
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  });
  const score = report.dimensions[0];
  if (!score) {
    throw new Error(`No score produced for dimension ${dimension}.`);
  }
  return score;
}
