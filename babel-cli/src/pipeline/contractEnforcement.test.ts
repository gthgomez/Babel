/**
 * contractEnforcement.test.ts — Bounded contract enforcement, lock checks, and scope validation
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectBoundedContractViolations,
  mergeLockedFiles,
  parseLockedFilesEnv,
} from './contractEnforcement.js';
import type { SwePlan, QaVerdictReject } from '../schemas/agentContracts.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<SwePlan> = {}): SwePlan {
  return {
    plan_version: '1.0',
    thinking: '',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'test task',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [],
    root_cause: 'N/A' as const,
    out_of_scope: [],
    ...overrides,
  };
}

function fileWriteStep(step: number, target: string) {
  return {
    step,
    description: `Write ${target}`,
    tool: 'file_write' as const,
    target,
    rationale: 'Write target file',
    reversible: true,
    verification: 'Verify file exists',
  };
}

function shellStep(step: number, target: string) {
  return {
    step,
    description: `Run ${target}`,
    tool: 'shell_exec' as const,
    target,
    rationale: 'Execute command',
    reversible: true,
    verification: 'Exit code 0',
  };
}

// ─── collectBoundedContractViolations ────────────────────────────────────────

test('collectBoundedContractViolations: bounded contract with matching targets returns null', () => {
  const plan = makePlan({
    minimal_action_set: [fileWriteStep(1, 'src/output.txt')],
  });
  const task = 'Create src/output.txt with Hello World and run a test.';

  const result = collectBoundedContractViolations(plan, task);
  assert.equal(result, null);
});

test('collectBoundedContractViolations: bounded contract with missing target returns REJECT (INCOMPLETE_SUBMISSION)', () => {
  const plan = makePlan({
    minimal_action_set: [fileWriteStep(1, 'src/other.txt')],
  });
  const task = 'Create src/output.txt with Hello World.';

  const result = collectBoundedContractViolations(plan, task);
  assert.notEqual(result, null);
  assert.equal(result!.verdict, 'REJECT');

  const incompleteTags = result!.failures.filter((f) => f.tag === 'INCOMPLETE_SUBMISSION');
  assert.equal(incompleteTags.length, 1);
  assert.match(incompleteTags[0]!.condition, /src\/output\.txt/);
});

test('collectBoundedContractViolations: bounded contract with extra unrequested write returns SFDIPOT-P', () => {
  const plan = makePlan({
    minimal_action_set: [
      fileWriteStep(1, 'src/output.txt'),
      fileWriteStep(2, 'src/unrequested.txt'),
    ],
  });
  const task = 'Create src/output.txt with Hello World.';

  const result = collectBoundedContractViolations(plan, task);
  assert.notEqual(result, null);
  assert.equal(result!.verdict, 'REJECT');

  const creepTags = result!.failures.filter((f) => f.tag === 'SFDIPOT-P');
  assert.equal(creepTags.length, 1);
  assert.match(creepTags[0]!.condition, /src\/unrequested\.txt/);
  // Bounded contracts get confidence 5 on scope-creep
  assert.equal(creepTags[0]!.confidence, 5);
});

test('collectBoundedContractViolations: non-bounded contract still detects scope creep', () => {
  // A task with 5+ file references triggers bounded=false (only <=4 is bounded),
  // but scope creep on unrequested writes is still detected.
  const plan = makePlan({
    minimal_action_set: [fileWriteStep(1, 'src/sneaky.txt')],
  });
  const task = 'Read file1.txt, file2.txt, file3.txt, file4.txt, file5.txt and provide a summary.';

  const result = collectBoundedContractViolations(plan, task);
  assert.notEqual(result, null);
  assert.equal(result!.verdict, 'REJECT');

  const creepTags = result!.failures.filter((f) => f.tag === 'SFDIPOT-P');
  assert.equal(creepTags.length, 1);
  // Non-bounded gets confidence 3
  assert.equal(creepTags[0]!.confidence, 3);
});

test('collectBoundedContractViolations: empty minimal_action_set returns null when task has no targets', () => {
  const plan = makePlan({
    minimal_action_set: [],
  });
  // Task with no file paths → contract.requestedTargets is empty → function returns null
  const task = 'Just say hello world.';

  const result = collectBoundedContractViolations(plan, task);
  assert.equal(result, null);
});

test('collectBoundedContractViolations: benchmark task returns null early', () => {
  const plan = makePlan({
    minimal_action_set: [],
  });
  const task = 'This is a Terminal-Bench 2 task with no output.';

  const result = collectBoundedContractViolations(plan, task);
  assert.equal(result, null);
});

test('collectBoundedContractViolations: handles mixed tools without file writes', () => {
  const plan = makePlan({
    minimal_action_set: [
      shellStep(1, 'npm test'),
      { ...shellStep(2, 'ls -la'), tool: 'directory_list' as const, target: '.' },
    ],
  });
  const task = 'Analyze the codebase structure and report findings.';

  const result = collectBoundedContractViolations(plan, task);
  assert.equal(result, null);
});

// ─── mergeLockedFiles ────────────────────────────────────────────────────────

test('mergeLockedFiles: deduplicates across groups', () => {
  const result = mergeLockedFiles(['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/c.ts']);
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
});

test('mergeLockedFiles: normalizes paths', () => {
  const result = mergeLockedFiles(['src\\a.ts', './src/b.ts']);
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('mergeLockedFiles: handles empty inputs', () => {
  const result1 = mergeLockedFiles([], []);
  assert.deepEqual(result1, []);

  const result2 = mergeLockedFiles(['src/a.ts'], []);
  assert.deepEqual(result2, ['src/a.ts']);

  const result3 = mergeLockedFiles();
  assert.deepEqual(result3, []);
});

test('mergeLockedFiles: case insensitive dedup', () => {
  const result = mergeLockedFiles(['SRC/A.TS'], ['src/a.ts']);
  assert.equal(result.length, 1);
});

// ─── parseLockedFilesEnv ─────────────────────────────────────────────────────

test('parseLockedFilesEnv: parses JSON array', () => {
  const result = parseLockedFilesEnv('["src/a.ts","src/b.ts"]');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: parses comma-delimited string', () => {
  const result = parseLockedFilesEnv('src/a.ts, src/b.ts');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: returns empty array for undefined', () => {
  const result = parseLockedFilesEnv(undefined);
  assert.deepEqual(result, []);
});

test('parseLockedFilesEnv: returns empty array for empty string', () => {
  const result = parseLockedFilesEnv('');
  assert.deepEqual(result, []);
});

test('parseLockedFilesEnv: returns empty array for whitespace-only', () => {
  const result = parseLockedFilesEnv('   ');
  assert.deepEqual(result, []);
});

test('parseLockedFilesEnv: handles leading/trailing whitespace in array items', () => {
  const result = parseLockedFilesEnv('["  src/a.ts  ", "src/b.ts"]');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: handles leading/trailing whitespace in comma-delimited', () => {
  const result = parseLockedFilesEnv('  src/a.ts  ,  src/b.ts  ');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: filters empty array entries from JSON', () => {
  const result = parseLockedFilesEnv('["src/a.ts", "", "src/b.ts"]');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: falls back to comma parse for invalid JSON', () => {
  const result = parseLockedFilesEnv('src/a.ts, src/b.ts');
  assert.deepEqual(result, ['src/a.ts', 'src/b.ts']);
});

test('parseLockedFilesEnv: single item without comma', () => {
  const result = parseLockedFilesEnv('src/a.ts');
  assert.deepEqual(result, ['src/a.ts']);
});
