import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiteArtifactRun, writeLiteJsonArtifact } from '../lite/artifacts.js';
import { savePlan, withSavedPlanApplication } from '../services/savedPlan.js';

import {
  assertPlannerPathsAllowed,
  collectPlanHandoffViolations,
  extractPlanRunId,
  loadPlanHandoff,
} from './planHandoff.js';

test('extractPlanRunId reads explicit plan run ids from task text', () => {
  const planRunId = '20260610T180000Z-plan-abc123def456';
  assert.equal(
    extractPlanRunId(`Apply approved plan ${planRunId} for stale pointer repair.`),
    planRunId,
  );
});

test('loadPlanHandoff loads contract paths and context snippets', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-handoff-'));
  const planRunId = '20260610T180000Z-plan-abc123def456';
  const planRunDir = join(root, 'runs', 'babel-lite', planRunId);
  const sourceFile = 'babel-cli/src/pipeline/runPointers.ts';
  const testFile = 'babel-cli/src/evidence/runEvidence.test.ts';

  try {
    mkdirSync(planRunDir, { recursive: true });
    mkdirSync(join(root, 'babel-cli', 'src', 'pipeline'), { recursive: true });
    mkdirSync(join(root, 'babel-cli', 'src', 'evidence'), { recursive: true });
    writeFileSync(join(root, sourceFile), 'export const pointers = true;\n', 'utf-8');
    writeFileSync(join(root, testFile), "import test from 'node:test';\n", 'utf-8');
    writeFileSync(
      join(planRunDir, 'contract.json'),
      JSON.stringify({
        schema_version: 1,
        likely_files: [sourceFile, testFile],
        required_reads: [sourceFile],
      }),
      'utf-8',
    );
    writeFileSync(
      join(planRunDir, 'model_plan.json'),
      JSON.stringify({
        schema_version: 1,
        summary: 'Repair stale latest pointers',
        steps: ['Add repair helper', 'Add unit tests'],
      }),
      'utf-8',
    );

    const handoff = loadPlanHandoff({
      repoPath: root,
      task: `Implement approved plan ${planRunId}`,
      planRunId,
    });

    assert.ok(handoff);
    assert.equal(handoff?.planRunId, planRunId);
    assert.deepEqual(handoff?.allowedPaths.sort(), [sourceFile, testFile].sort());
    assert.match(handoff?.contextText ?? '', /runPointers\.ts/);
    assert.match(handoff?.contextText ?? '', /Repair stale latest pointers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanHandoffViolations rejects hallucinated planner paths', () => {
  const allowed = [
    'babel-cli/src/pipeline/runPointers.ts',
    'babel-cli/src/evidence/runEvidence.test.ts',
  ];
  assert.deepEqual(assertPlannerPathsAllowed(['babel-cli/src/run-latest.js'], allowed), [
    'babel-cli/src/run-latest.js',
  ]);

  const violations = collectPlanHandoffViolations(
    {
      plan_version: '1.0',
      plan_type: 'IMPLEMENTATION_PLAN',
      thinking: 'bad path',
      task_summary: 'OBJECTIVE: edit wrong file',
      known_facts: [],
      assumptions: [],
      risks: [],
      root_cause: 'N/A',
      out_of_scope: [],
      minimal_action_set: [
        {
          step: 1,
          tool: 'file_write',
          target: 'babel-cli/src/run-latest.js',
          description: 'Edit hallucinated file',
          rationale: 'Attempt to edit wrong file',
          reversible: true,
          verification: 'file_write succeeds',
        },
      ],
    },
    allowed,
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /run-latest\.js/);
});

test('private Plan handoffs preserve project scope and legacy lookup compatibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-handoff-storage-'));
  const previousRuns = process.env['BABEL_RUNS_DIR'];
  try {
    process.env['BABEL_RUNS_DIR'] = join(root, 'private-runs');
    const target = join(root, 'target');
    const other = join(root, 'other');
    mkdirSync(target);
    mkdirSync(other);
    writeFileSync(join(target, 'sample.ts'), 'export const target = true;');
    const plan = createLiteArtifactRun({ command: 'plan', repoPath: target, now: new Date('2026-06-10T18:00:00Z') });
    writeLiteJsonArtifact(plan, 'manifest.json', { command: 'plan', project_root: target });
    writeLiteJsonArtifact(plan, 'model_plan.json', { likely_files: ['sample.ts'], summary: 'Target plan' });
    const foreign = createLiteArtifactRun({ command: 'plan', repoPath: other, now: new Date('2026-06-10T19:00:00Z') });
    writeLiteJsonArtifact(foreign, 'manifest.json', { command: 'plan', project_root: other });
    writeLiteJsonArtifact(foreign, 'model_plan.json', { likely_files: ['foreign.ts'], summary: 'Other project plan' });
    const legacyId = '20260610T170000Z-plan-abc123';
    const legacyDir = join(target, 'runs', 'babel-lite', legacyId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'model_plan.json'), JSON.stringify({ likely_files: ['legacy.ts'] }));
    for (const task of [`Apply plan ${plan.runId}`, 'Apply latest plan']) {
      const handoff = loadPlanHandoff({ repoPath: target, task });
      assert.equal(handoff?.planRunDir, plan.runDir);
      assert.deepEqual(handoff?.allowedPaths, ['sample.ts']);
      assert.match(handoff?.contextText ?? '', /export const target = true/);
    }
    const alias = join(root, 'target-alias');
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(loadPlanHandoff({ repoPath: alias, task: `Apply plan ${plan.runId}` })?.planRunDir, plan.runDir);
    assert.equal(loadPlanHandoff({ repoPath: target, task: 'Apply plan', planRunId: foreign.runId }), null);
    assert.equal(loadPlanHandoff({ repoPath: target, task: 'Apply plan', planRunId: '../' + plan.runId }), null);
    assert.equal(loadPlanHandoff({ repoPath: target, task: `Apply plan ${legacyId}` })?.planRunDir, legacyDir);
  } finally {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previousRuns;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadPlanHandoff returns null when no plan run exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-handoff-missing-'));
  try {
    assert.equal(loadPlanHandoff({ repoPath: root, task: 'apply latest plan' }), null);
    assert.equal(existsSync(join(root, 'runs', 'babel-lite')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('model-generated handoff paths cannot read outside the project or credential-shaped fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-scope-'));
  const target = join(root, 'target');
  const outside = join(root, 'outside');
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(target, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'sample.txt'), 'UNAUTHORIZED_FIXTURE_BYTES');
    writeFileSync(join(target, '.env'), 'SYNTHETIC_DENIED_FIXTURE_BYTES');
    writeFileSync(join(target, 'safe.ts'), 'export const safe = true;');
    symlinkSync(outside, join(target, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ likely_files:
      ['safe.ts', '../outside/sample.txt', join(outside, 'sample.txt'), 'linked/sample.txt', '.env', '.env::$DATA'] }));
    const handoff = loadPlanHandoff({ repoPath: target, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.doesNotMatch(handoff.contextText, /UNAUTHORIZED_FIXTURE_BYTES|SYNTHETIC_DENIED_FIXTURE_BYTES/);
    assert.deepEqual(handoff.allowedPaths, ['safe.ts']);
    assert.match(handoff.contextText, /export const safe = true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applying the first of two saved plans retains its exact source handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-binding-'));
  const previousRuns = process.env['BABEL_RUNS_DIR'];
  const target = join(root, 'target');
  const env = { BABEL_STATE_DIR: join(root, 'state'), BABEL_CONFIG_DIR: join(root, 'config') };
  try {
    mkdirSync(target);
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const first = createLiteArtifactRun({ command: 'plan', repoPath: target, now: new Date('2026-06-10T18:00:00Z') });
    writeLiteJsonArtifact(first, 'manifest.json', { project_root: target });
    writeLiteJsonArtifact(first, 'model_plan.json', { likely_files: ['a.ts'] });
    const saved = savePlan({ projectRoot: target, task: 'Update a.ts', body: 'Update a.ts safely', sourceRunId: first.runId }, env);
    const second = createLiteArtifactRun({ command: 'plan', repoPath: target, now: new Date('2026-06-10T19:00:00Z') });
    writeLiteJsonArtifact(second, 'manifest.json', { project_root: target });
    writeLiteJsonArtifact(second, 'model_plan.json', { likely_files: ['b.ts'] });
    await withSavedPlanApplication(saved.id, { projectRoot: target, env, execute: async plan => {
      assert.equal(plan.sourceRunId, first.runId);
      const handoff = loadPlanHandoff({ repoPath: target, task: 'Implement this approved plan', planRunId: plan.sourceRunId });
      assert.deepEqual(handoff?.allowedPaths, ['a.ts']);
    } });
  } finally {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previousRuns;
    rmSync(root, { recursive: true, force: true });
  }
});
