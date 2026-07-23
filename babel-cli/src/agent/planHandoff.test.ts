import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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

test('loadPlanHandoff returns null when no plan run exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-handoff-missing-'));
  try {
    assert.equal(loadPlanHandoff({ repoPath: root, task: 'apply latest plan' }), null);
    assert.equal(existsSync(join(root, 'runs', 'babel-lite')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
