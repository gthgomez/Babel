import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
        mode: 'babel-lite-plan',
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

test('model-suggested paths cannot expand the task contract or cause reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-model-scope-'));
  try {
    const planRunId = '20260610T180000Z-plan-abcdef01'; const runDir = join(root, 'runs', 'babel-lite', planRunId);
    mkdirSync(runDir, { recursive: true }); writeFileSync(join(root, 'allowed.txt'), 'SYNTHETIC_ALLOWED'); writeFileSync(join(root, 'outside-scope.txt'), 'SYNTHETIC_OUTSIDE_SCOPE');
    writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['allowed.txt'], required_reads: [] }));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ schema_version: 1, summary: 'Safe summary', likely_files: ['outside-scope.txt'] }));
    const handoff = loadPlanHandoff({ repoPath: root, task: 'Inspect allowed.txt', planRunId });
    assert.ok(handoff); assert.deepEqual(handoff.allowedPaths, ['allowed.txt']);
    assert.equal(handoff.contextText.includes('SYNTHETIC_ALLOWED'), true); assert.equal(handoff.contextText.includes('SYNTHETIC_OUTSIDE_SCOPE'), false);
    assert.deepEqual(assertPlannerPathsAllowed(['outside-scope.txt'], handoff.allowedPaths), ['outside-scope.txt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed task contracts cannot confer Plan handoff authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-contract-schema-'));
  try {
    const planRunId = '20260610T180000Z-plan-abcdef01'; const runDir = join(root, 'runs', 'babel-lite', planRunId); mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ schema_version: 1, summary: 'Safe' }));
    for (const invalid of [{}, { schema_version: 1, mode: 'wrong', likely_files: [], required_reads: [] }, { schema_version: 1, mode: 'babel-lite-plan', likely_files: [] }]) {
      writeFileSync(join(runDir, 'contract.json'), JSON.stringify(invalid));
      assert.equal(loadPlanHandoff({ repoPath: root, task: 'Inspect', planRunId }), null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty handoff scope rejects planner file targets', () => {
  assert.deepEqual(assertPlannerPathsAllowed(['src/unapproved.ts'], []), ['src/unapproved.ts']);
});

test('Plan handoff does not authorize opaque shell mutations outside its scope', () => {
  const violations = collectPlanHandoffViolations({
    plan_version: '1.0', plan_type: 'IMPLEMENTATION_PLAN', thinking: 'fixture', task_summary: 'fixture', known_facts: [], assumptions: [], risks: [], root_cause: 'fixture', out_of_scope: [],
    minimal_action_set: [{ step: 1, tool: 'shell_exec', target: 'node -e "write outside scope"', description: 'fixture', rationale: 'fixture', reversible: true, verification: 'fixture' }],
  }, ['allowed.ts']);
  assert.ok(violations.length > 0, 'opaque shell must not be treated as scoped file authority');
});

test('planner scope rejects a different path that only ends in an allowed path', () => {
  assert.deepEqual(assertPlannerPathsAllowed(['other/src/allowed.ts'], ['src/allowed.ts']), ['other/src/allowed.ts']);
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
    writeLiteJsonArtifact(plan, 'contract.json', { schema_version: 1, mode: 'babel-lite-plan', likely_files: ['sample.ts'], required_reads: [] });
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
    assert.deepEqual(loadPlanHandoff({ repoPath: target, task: `Apply plan ${legacyId}` })?.allowedPaths, []);
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

test('legacy plan directory linked outside the project cannot supply handoff content', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-linked-artifact-'));
  const target = join(root, 'target');
  const outside = join(root, 'outside');
  const runId = '20260610T180000Z-plan-abc123';
  try {
    mkdirSync(join(target, 'runs', 'babel-lite'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'model_plan.json'), JSON.stringify({ summary: 'SYNTHETIC_OUTSIDE_PLAN' }));
    symlinkSync(outside, join(target, 'runs', 'babel-lite', runId), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(loadPlanHandoff({ repoPath: target, task: `Apply ${runId}` }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('linked plan JSON cannot supply outside content', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-linked-json-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'target', 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ summary: 'SYNTHETIC_OUTSIDE_JSON' }));
    try { symlinkSync(outside, join(runDir, 'model_plan.json'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlinks unavailable'); return; }
      throw error;
    }
    const handoff = loadPlanHandoff({ repoPath: join(root, 'target'), task: `Apply ${runId}` });
    assert.equal(handoff?.contextText.includes('SYNTHETIC_OUTSIDE_JSON') ?? false, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hard-linked plan JSON cannot supply outside content', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-hardlink-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'target', 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ summary: 'SYNTHETIC_HARDLINK_CONTENT' }));
    linkSync(outside, join(runDir, 'model_plan.json'));
    const handoff = loadPlanHandoff({ repoPath: join(root, 'target'), task: `Apply ${runId}` });
    assert.equal(handoff?.contextText.includes('SYNTHETIC_HARDLINK_CONTENT') ?? false, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oversized plan JSON is not admitted to the handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-size-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'x'.repeat(2 * 1024 * 1024) }));
    const handoff = loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` });
    assert.equal(handoff?.modelPlan != null, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('large valid plan text has a bounded handoff with an explicit truncation marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-text-bound-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ answer: 'a'.repeat(100_000) }));
    const handoff = loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.ok(handoff.contextText.length < 40_000);
    assert.match(handoff.contextText, /\[truncated\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed project metadata cannot be treated as a metadata-free legacy plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-metadata-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'manifest.json'), '{ invalid');
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Plan' }));
    assert.equal(loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conflicting or malformed owner metadata cannot inherit legacy project trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-owner-')); const other = mkdtempSync(join(tmpdir(), 'babel-handoff-other-'))
  const runId = '20260610T180000Z-plan-abc123'; const runDir = join(root, 'runs', 'babel-lite', runId)
  try {
    mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Plan' }))
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ project_root: 42 }))
    assert.equal(loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` }), null)
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ project_root: root }))
    writeFileSync(join(runDir, 'request.json'), JSON.stringify({ project_root: other }))
    assert.equal(loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` }), null)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
});

test('malformed plan path lists are rejected without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-schema-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ likely_files: 12 }));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Plan' }));
    assert.equal(loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed plan content fields are rejected without coercion', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-content-schema-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'Plan', steps: [{ command: 'unexpected' }] }));
    assert.equal(loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files:
      ['safe.ts', '../outside/sample.txt', join(outside, 'sample.txt'), 'linked/sample.txt', '.env', '.env::$DATA'], required_reads: [] }));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ likely_files:
      ['safe.ts', '../outside/sample.txt', join(outside, 'sample.txt'), 'linked/sample.txt', '.env', '.env::$DATA'] }));
    const handoff = loadPlanHandoff({ repoPath: target, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.doesNotMatch(handoff.contextText, /UNAUTHORIZED_FIXTURE_BYTES|SYNTHETIC_DENIED_FIXTURE_BYTES/);
    assert.deepEqual(handoff.allowedPaths, ['safe.ts']);
    assert.match(handoff.contextText, /export const safe = true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dotenv variants cannot enter handoff context', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-dotenv-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(root, '.env.production.local'), 'SYNTHETIC_DOTENV_VARIANT');
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ likely_files: ['.env.production.local'] }));
    const handoff = loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.equal(handoff.contextText.includes('SYNTHETIC_DOTENV_VARIANT'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hard-linked project snippets cannot expose outside content', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-hardlink-snippet-'));
  const target = join(root, 'target');
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(target, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'SYNTHETIC_OUTSIDE_SNIPPET');
    linkSync(outside, join(target, 'snippet.txt'));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ likely_files: ['snippet.txt'] }));
    const handoff = loadPlanHandoff({ repoPath: target, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.equal(handoff.contextText.includes('SYNTHETIC_OUTSIDE_SNIPPET'), false);
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
    writeLiteJsonArtifact(first, 'contract.json', { schema_version: 1, mode: 'babel-lite-plan', likely_files: ['a.ts'], required_reads: [] });
    writeLiteJsonArtifact(first, 'model_plan.json', { likely_files: ['a.ts'] });
    writeFileSync(join(first.runDir, 'plan.md'), 'Update a.ts safely');
    const saved = savePlan({ projectRoot: target, task: 'Update a.ts', body: 'Update a.ts safely', sourceRunId: first.runId }, env);
    const second = createLiteArtifactRun({ command: 'plan', repoPath: target, now: new Date('2026-06-10T19:00:00Z') });
    writeLiteJsonArtifact(second, 'manifest.json', { project_root: target });
    writeLiteJsonArtifact(second, 'model_plan.json', { likely_files: ['b.ts'] });
    await withSavedPlanApplication(saved.id, { projectRoot: target, env, execute: async plan => {
      assert.equal(plan.sourceRunId, first.runId);
      const handoff = loadPlanHandoff({ repoPath: target, task: 'Implement this approved plan', planRunId: plan.sourceRunId });
      assert.deepEqual(handoff?.allowedPaths, ['a.ts']);
      return { status: 'COMPLETE', runDir: target };
    } });
  } finally {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previousRuns;
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic fallback plan artifacts cannot be selected as an executable handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-diagnostic-'));
  try {
    const id = '20260610T180000Z-plan-abcdef01';
    const dir = join(root, 'runs', 'babel-lite', id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ project_root: root, status: 'UNVERIFIED_LOCAL_DRAFT' }));
    writeFileSync(join(dir, 'model_plan.json'), JSON.stringify({ status: 'PLAN_READY', summary: 'Draft' }));
    assert.equal(loadPlanHandoff({ repoPath: root, task: 'Apply', planRunId: id }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a junction swap after the snippet stat cannot expose outside bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-swap-'));
  const target = join(root, 'target');
  const outside = join(root, 'outside');
  const sourceDir = join(target, 'src');
  const sourceFile = join(sourceDir, 'source.txt');
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(target, 'runs', 'babel-lite', runId);
  try {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(sourceDir);
    mkdirSync(outside);
    writeFileSync(sourceFile, 'authorized synthetic content');
    writeFileSync(join(outside, 'source.txt'), 'SYNTHETIC_JUNCTION_SWAP_CANARY');
    writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['src/source.txt'], required_reads: [] }));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ likely_files: ['src/source.txt'] }));
    const original = fs.lstatSync;
    let swapped = false;
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, ...args: unknown[]) => {
      const stat = original(path, ...(args as []));
      if (!swapped && String(path).toLowerCase() === sourceFile.toLowerCase()) {
        swapped = true;
        fs.renameSync(sourceDir, join(target, 'src-before-swap'));
        symlinkSync(outside, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return stat;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    const handoff = loadPlanHandoff({ repoPath: target, task: `Apply ${runId}` });
    assert.equal(swapped, true, 'fixture must swap at the real snippet check');
    assert.ok(handoff);
    assert.doesNotMatch(handoff.contextText, /SYNTHETIC_JUNCTION_SWAP_CANARY/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a Plan metadata replacement after stat is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-metadata-swap-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  const planPath = join(runDir, 'model_plan.json');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(planPath, JSON.stringify({ summary: 'safe' }));
    const replacement = join(root, 'replacement.json');
    writeFileSync(replacement, JSON.stringify({ summary: 'SYNTHETIC_METADATA_SWAP_CANARY' }));
    const original = fs.lstatSync;
    let swapped = false;
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, ...args: unknown[]) => {
      const stat = original(path, ...(args as []));
      if (!swapped && String(path).toLowerCase() === planPath.toLowerCase()) {
        swapped = true;
        fs.renameSync(planPath, join(runDir, 'model_plan-before.json'));
        fs.renameSync(replacement, planPath);
      }
      return stat;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    const handoff = loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` });
    assert.equal(swapped, true);
    assert.equal(handoff, null);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a snippet growing after identity validation is read only up to the original bound', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-handoff-growing-'));
  const runId = '20260610T180000Z-plan-abc123';
  const runDir = join(root, 'runs', 'babel-lite', runId);
  const sourceFile = join(root, 'source.txt');
  const initial = 'safe';
  let targetFd: number | undefined;
  let targetStats = 0;
  let readBytes = 0;
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(sourceFile, initial);
    writeFileSync(join(runDir, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['source.txt'], required_reads: [] }));
    writeFileSync(join(runDir, 'model_plan.json'), JSON.stringify({ summary: 'safe' }));
    const originalOpen = fs.openSync;
    const originalStat = fs.lstatSync;
    const originalReadFile = fs.readFileSync;
    const originalRead = fs.readSync;
    t.mock.method(fs, 'openSync', ((...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, args) as number;
      if (String(args[0]).toLowerCase() === sourceFile.toLowerCase() && args[1] === (fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))) targetFd = fd;
      return fd;
    }) as typeof fs.openSync);
    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, ...args: unknown[]) => {
      const stat = originalStat(path, ...(args as []));
      if (String(path).toLowerCase() === sourceFile.toLowerCase() && ++targetStats === 2) {
        fs.appendFileSync(sourceFile, Buffer.alloc(2 * 1024 * 1024, 65));
      }
      return stat;
    }) as typeof fs.lstatSync);
    t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => {
      const value = Reflect.apply(originalReadFile, fs, args) as string | Buffer;
      if (args[0] === targetFd) readBytes += Buffer.byteLength(value);
      return value;
    }) as typeof fs.readFileSync);
    t.mock.method(fs, 'readSync', ((...args: unknown[]) => {
      const count = Reflect.apply(originalRead, fs, args) as number;
      if (args[0] === targetFd) readBytes += count;
      return count;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    const handoff = loadPlanHandoff({ repoPath: root, task: `Apply ${runId}` });
    assert.ok(handoff);
    assert.equal(targetStats >= 2, true, 'fixture must grow the file at the checked-read boundary');
    assert.notEqual(targetFd, undefined, 'fixture must observe the source descriptor');
    assert.ok(readBytes <= Buffer.byteLength(initial) + 1, `read ${readBytes} bytes after the file grew`);
    assert.doesNotMatch(handoff.contextText, /AAAAAA/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Plan source parent stays held while an approved snippet is opened', t => {
  if (process.platform !== 'win32') { t.skip('Windows directory sharing semantics'); return; }
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-preview-anchor-'));
  const planRunId = '20260610T180000Z-plan-abc123def456';
  try {
    const run = join(root, 'runs', 'babel-lite', planRunId); const parent = join(root, 'src'); const source = join(parent, 'safe.txt');
    mkdirSync(run, { recursive: true }); mkdirSync(parent); writeFileSync(source, 'safe snippet');
    writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['src/safe.txt'], required_reads: [] }));
    writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: 'safe plan' }));
    const original = fs.openSync; let attempted = false; let renamed = false;
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
      if (!attempted && String(path).toLowerCase() === source.toLowerCase()) {
        attempted = true;
        try { fs.renameSync(parent, join(root, 'moved')); renamed = true; fs.renameSync(join(root, 'moved'), parent); }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      return original(path, ...(args as [fs.OpenMode]));
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    const handoff = loadPlanHandoff({ repoPath: root, task: 'Use the selected Plan', planRunId });
    assert.equal(attempted, true);
    assert.equal(renamed, false, 'Plan source parent must remain pinned during the file open');
    assert.match(handoff?.contextText ?? '', /safe snippet/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
