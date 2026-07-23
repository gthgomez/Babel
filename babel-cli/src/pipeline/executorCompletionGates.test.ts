import assert from 'node:assert/strict';
import test from 'node:test';

import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import {
  buildEvidenceRequestCompletionCondition,
  buildExternalPostconditionFeedback,
  buildMaxTurnsExceededCondition,
  buildMissingPlannedFileWritesCondition,
  getMissingSuccessfulPlannedFileWrites,
  shouldCompleteBoundedWriteTask,
} from './executorCompletionGates.js';

const fileWritePlan = {
  plan_version: '1.0',
  thinking: 'test',
  plan_type: 'IMPLEMENTATION_PLAN',
  task_summary: 'OBJECTIVE: write planned files',
  known_facts: ['Need planned writes.'],
  assumptions: [],
  risks: [],
  minimal_action_set: [
    {
      step: 1,
      description: 'Write output',
      tool: 'file_write',
      target: 'src\\Output.ts',
      rationale: 'Requested artifact.',
      reversible: true,
      verification: 'file exists',
    },
    {
      step: 2,
      description: 'Write report',
      tool: 'file_write',
      target: 'reports/summary.md',
      rationale: 'Requested report.',
      reversible: true,
      verification: 'file exists',
    },
  ],
  root_cause: 'N/A',
  out_of_scope: [],
} satisfies SwePlan;

test('planned file-write completion gate normalizes successful project-root writes', () => {
  const toolCallLog: ToolCallLog[] = [
    {
      step: 1,
      tool: 'file_write',
      target: '/tmp/repo/src/output.ts',
      exit_code: 0,
      stdout: 'ok',
      stderr: '',
      verified: true,
    },
  ];

  assert.deepEqual(
    getMissingSuccessfulPlannedFileWrites({
      approvedPlan: fileWritePlan,
      toolCallLog,
      projectRoot: '/tmp/repo',
    }),
    ['reports/summary.md'],
  );
});

test('completion gate condition strings stay stable for terminal reports', () => {
  assert.equal(
    buildMissingPlannedFileWritesCondition(['src/a.ts', 'src/b.ts']),
    'Executor reported EXECUTION_COMPLETE before successful file_write for planned target(s): src/a.ts, src/b.ts',
  );
  assert.equal(
    buildEvidenceRequestCompletionCondition(),
    'EVIDENCE_REQUEST minimal_action_set satisfied.',
  );
  assert.equal(
    buildMaxTurnsExceededCondition(3),
    'Executor exceeded the maximum of 3 turns without a terminal signal.',
  );
});

test('external postcondition feedback preserves executor history shape', () => {
  assert.equal(
    buildExternalPostconditionFeedback(2, 'missing output.txt'),
    [
      '[Postcondition 2] external_benchmark_verification -> requested output artifact',
      'Exit code: 1',
      'Stdout: (empty)',
      'Stderr: missing output.txt',
      'Verification: FAILED',
    ].join('\n'),
  );
});

test('shouldCompleteBoundedWriteTask returns false for shell_exec plans', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Run tests',
        tool: 'shell_exec' as const,
        target: 'npm test',
        rationale: 'Execute tests',
        reversible: true,
        verification: 'test pass',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  assert.equal(
    shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'Write src/output.ts',
      toolCallLog: [],
      projectRoot: null,
    }),
    false,
  );
});

test('shouldCompleteBoundedWriteTask returns false when file_write target is missing', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Write output',
        tool: 'file_write' as const,
        target: 'src/output.ts',
        rationale: 'Requested artifact.',
        reversible: true,
        verification: 'file exists',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  const toolCallLog: ToolCallLog[] = [
    {
      step: 1,
      tool: 'file_write',
      target: 'src/other.ts',
      exit_code: 0,
      stdout: 'ok',
      stderr: '',
      verified: true,
    },
  ];

  assert.equal(
    shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'Write the file src/output.ts',
      toolCallLog,
      projectRoot: null,
    }),
    false,
  );
});

test('shouldCompleteBoundedWriteTask handles empty tool call log', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Write output',
        tool: 'file_write' as const,
        target: 'src/output.ts',
        rationale: 'Requested artifact.',
        reversible: true,
        verification: 'file exists',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  assert.equal(
    shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'Write the file src/output.ts',
      toolCallLog: [],
      projectRoot: null,
    }),
    false,
  );
});
