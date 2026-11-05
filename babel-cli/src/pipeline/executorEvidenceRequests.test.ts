import assert from 'node:assert/strict';
import test from 'node:test';

import { arePlannedActionsSatisfied, isEvidenceRequestPlanSatisfied } from './executorEvidenceRequests.js';
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
      target: 'Src/Input.ts',
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

test('evidence request satisfaction normalizes host paths while preserving opaque targets', () => {
  const toolCallLog: ToolCallLog[] = [
    {
      step: 1,
      tool: 'file_read',
      target: './Src/Input.ts',
      exit_code: 0,
      stdout: 'content',
      stderr: '',
      verified: true,
    },
    {
      step: 2,
      tool: 'shell_exec',
      target: 'npm   test',
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

test('recorded read-only actions can satisfy a legacy plan without relabeling its type', () => {
  const plan: SwePlan = {...baseEvidencePlan,plan_type:'IMPLEMENTATION_PLAN',minimal_action_set:baseEvidencePlan.minimal_action_set.slice(0,1)};
  const entry: ToolCallLog = {step:1,tool:'file_read',target:'Src/Input.ts',exit_code:0,stdout:'content',stderr:'',verified:true};
  assert.equal(arePlannedActionsSatisfied(plan,[entry]),true);
  assert.equal(isEvidenceRequestPlanSatisfied(plan,[entry]),false);
  assert.equal(arePlannedActionsSatisfied(plan,[]),false);
  assert.equal(arePlannedActionsSatisfied(plan,[{...entry,verified:false}]),false);
});

test('completion evidence cannot conflate path case, opaque target case, or quoted whitespace', () => {
  for (const [tool,target,other] of [
    ['file_read','src/Foo.ts','src/foo.ts'],
    ['mcp_resource_read','resource://server/Value','resource://server/value'],
    ['shell_exec','printf "Hello  World"','printf "Hello World"'],
  ] as const) {
    const plan: SwePlan = {...baseEvidencePlan,minimal_action_set:[{...baseEvidencePlan.minimal_action_set[0]!,tool,target}]};
    const entry: ToolCallLog = {step:1,tool,target:other,exit_code:0,stdout:'content',stderr:'',verified:true};
    assert.equal(arePlannedActionsSatisfied(plan,[entry]),false,`${tool}: distinct targets`);
    assert.equal(arePlannedActionsSatisfied(plan,[{...entry,target}]),true);
  }
});

test('backslash is only a path separator on a host where the executor treats it as one', () => {
  const plan: SwePlan = {...baseEvidencePlan,minimal_action_set:[{...baseEvidencePlan.minimal_action_set[0]!,target:'src\\input.ts'}]};
  const entry: ToolCallLog = {step:1,tool:'file_read',target:'src/input.ts',exit_code:0,stdout:'content',stderr:'',verified:true};
  assert.equal(arePlannedActionsSatisfied(plan,[entry]),process.platform === 'win32');
});
