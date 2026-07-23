import assert from 'node:assert/strict';
import test from 'node:test';

import { isEvidenceRequestPlanSatisfied } from './executorEvidenceRequests.js';
import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';

const baseEvidencePlan = {
  plan_version: '1.0',
  thinking: 'test',
  plan_type: 'EVIDENCE_REQUEST',
  task_summary: 'OBJECTIVE: inspect files before planning',
  known_facts: ['Need evidence before implementation.'],
  assumptions: [],
  risks: [],
  minimal_action_set: [
    {
      step: 1,
      description: 'Read input',
      tool: 'file_read',
      target: 'Src\\Input.ts',
      rationale: 'Need input file.',
      reversible: true,
      verification: 'file_read succeeds',
    },
    {
      step: 2,
      description: 'Run verifier',
      tool: 'shell_exec',
      target: 'npm   test',
      rationale: 'Need verifier output.',
      reversible: true,
      verification: 'shell_exec succeeds',
    },
  ],
  root_cause: 'N/A',
  out_of_scope: [],
} satisfies SwePlan;

test('evidence request satisfaction normalizes file paths and shell whitespace', () => {
  const toolCallLog: ToolCallLog[] = [
    {
      step: 1,
      tool: 'file_read',
      target: 'src/input.ts',
      exit_code: 0,
      stdout: 'content',
      stderr: '',
      verified: true,
    },
    {
      step: 2,
      tool: 'shell_exec',
      target: 'npm test',
      exit_code: 0,
      stdout: 'pass',
      stderr: '',
      verified: true,
    },
  ];

  assert.equal(isEvidenceRequestPlanSatisfied(baseEvidencePlan, toolCallLog), true);
});

test('evidence request satisfaction requires every planned verified step', () => {
  assert.equal(
    isEvidenceRequestPlanSatisfied(baseEvidencePlan, [
      {
        step: 1,
        tool: 'file_read',
        target: 'src/input.ts',
        exit_code: 0,
        stdout: 'content',
        stderr: '',
        verified: true,
      },
    ]),
    false,
  );
});

test('non-evidence plans are not treated as evidence-satisfied', () => {
  assert.equal(
    isEvidenceRequestPlanSatisfied(
      {
        ...baseEvidencePlan,
        plan_type: 'IMPLEMENTATION_PLAN',
      },
      [],
    ),
    false,
  );
});
