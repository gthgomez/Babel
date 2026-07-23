import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SwePlan } from '../schemas/agentContracts.js';
import {
  extractRequiredVerifierCommandsFromTask,
  hasImplementationVerificationStrategy,
  injectVerificationStepsIntoPlan,
  plannedVerificationCommandsFromPlan,
} from './planVerifierInjection.js';

function basePlan(): SwePlan {
  return {
    plan_version: '1.0',
    thinking: '',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'Fix math',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Write fix',
        tool: 'file_write',
        target: 'src/math.js',
        rationale: 'Apply the fix',
        reversible: true,
        verification: 'File updated',
      },
    ],
    root_cause: 'Wrong operator',
    out_of_scope: [],
  };
}

test('extractRequiredVerifierCommandsFromTask parses run-before-completing wording', () => {
  const commands = extractRequiredVerifierCommandsFromTask(
    'Fix src/math.js. Run npm test before completing.',
  );
  assert.deepEqual(commands, ['npm test']);
});

test('injectVerificationStepsIntoPlan inserts verifier steps before file writes', () => {
  const result = injectVerificationStepsIntoPlan(
    basePlan(),
    'Fix src/math.js. Run npm test before completing.',
    null,
  );
  assert.equal(result.injected, true);
  assert.deepEqual(result.commands, ['npm test']);
  assert.equal(result.plan.minimal_action_set[0]?.tool, 'test_run');
  assert.equal(result.plan.minimal_action_set[0]?.target, 'npm test');
  assert.equal(result.plan.minimal_action_set[1]?.tool, 'file_write');
  assert.ok(plannedVerificationCommandsFromPlan(result.plan).includes('npm test'));
});

test('injectVerificationStepsIntoPlan discovers npm test from package.json when task is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-inject-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        {
          scripts: { test: 'node --test' },
        },
        null,
        2,
      ),
      'utf8',
    );
    const result = injectVerificationStepsIntoPlan(basePlan(), 'Fix src/math.js only.', root);
    assert.equal(result.injected, true);
    assert.deepEqual(result.commands, ['npm test']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hasImplementationVerificationStrategy accepts verification text on implementation steps', () => {
  const plan = basePlan();
  plan.minimal_action_set[0] = {
    ...plan.minimal_action_set[0]!,
    description: 'Update math implementation',
    verification: 'npm test passes after the write',
  };
  assert.equal(hasImplementationVerificationStrategy(plan), true);
  assert.equal(plannedVerificationCommandsFromPlan(plan).length, 0);
});

test('hasImplementationVerificationStrategy rejects bare file-write plans without verify cues', () => {
  assert.equal(hasImplementationVerificationStrategy(basePlan()), false);
});

test('injectVerificationStepsIntoPlan is a no-op for read-only plans', () => {
  const reportPlan = {
    ...basePlan(),
    plan_type: 'EVIDENCE_REQUEST' as const,
  };
  const result = injectVerificationStepsIntoPlan(
    reportPlan,
    'Run npm test before completing.',
    null,
  );
  assert.equal(result.injected, false);
  assert.equal(result.plan.minimal_action_set.length, 1);
});

test('injectVerificationStepsIntoPlan synthesizes content-verification from file_write targets when task and project are silent', () => {
  const plan: SwePlan = {
    ...basePlan(),
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [
      {
        step: 1,
        description: 'Create status file',
        tool: 'file_write',
        target: 'exact-status.txt',
        rationale: 'Write the status file',
        reversible: true,
        verification: 'File created',
      },
    ],
  };
  const result = injectVerificationStepsIntoPlan(
    plan,
    'Create exact-status.txt containing the exact string "autonomous exact ok".',
    null,
  );
  assert.equal(result.injected, true);
  assert.ok(result.commands.length === 1, `expected 1 command, got ${result.commands.length}`);
  // Synthesized verification steps run AFTER file_write (file doesn't exist yet before write)
  assert.equal(result.plan.minimal_action_set[0]?.tool, 'file_write');
  assert.equal(result.plan.minimal_action_set[1]?.tool, 'shell_exec');
  // The synthesized command should read the target file
  assert.ok(
    result.commands[0]?.includes('exact-status.txt'),
    `expected command to reference exact-status.txt, got "${result.commands[0]}"`,
  );
  // hasImplementationVerificationStrategy must see the injected verification (field contains "Verify")
  assert.equal(hasImplementationVerificationStrategy(result.plan), true);
});

test('injectVerificationStepsIntoPlan synthesizes verification for multiple file_writes', () => {
  const plan: SwePlan = {
    ...basePlan(),
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [
      {
        step: 1,
        description: 'Create a.txt',
        tool: 'file_write',
        target: 'a.txt',
        rationale: 'Write alpha file',
        reversible: true,
        verification: 'Created',
      },
      {
        step: 2,
        description: 'Create b.txt',
        tool: 'file_write',
        target: 'b.txt',
        rationale: 'Write beta file',
        reversible: true,
        verification: 'Created',
      },
    ],
  };
  const result = injectVerificationStepsIntoPlan(
    plan,
    'Create a.txt and b.txt containing the exact strings alpha and beta.',
    null,
  );
  assert.equal(result.injected, true);
  assert.ok(result.commands.length >= 2, `expected >=2 commands, got ${result.commands.length}`);
  // Synthesized verification steps appear AFTER file_writes (files don't exist yet before writes)
  assert.equal(result.plan.minimal_action_set[0]?.tool, 'file_write');
  assert.equal(result.plan.minimal_action_set[1]?.tool, 'file_write');
  assert.equal(result.plan.minimal_action_set[2]?.tool, 'shell_exec');
  assert.equal(result.plan.minimal_action_set[3]?.tool, 'shell_exec');
  assert.equal(hasImplementationVerificationStrategy(result.plan), true);
});

test('injectVerificationStepsIntoPlan does not synthesize for binary/non-text targets', () => {
  const plan: SwePlan = {
    ...basePlan(),
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [
      {
        step: 1,
        description: 'Create binary artifact',
        tool: 'file_write',
        target: 'output.bin',
        rationale: 'Write binary data',
        reversible: true,
        verification: 'Created',
      },
    ],
  };
  const result = injectVerificationStepsIntoPlan(plan, 'Create output.bin with binary data.', null);
  // .bin is not a recognized text extension, so no synthesis should happen
  assert.equal(result.injected, false);
});

test('injectVerificationStepsIntoPlan prefers task-text verifier over synthesis', () => {
  const plan: SwePlan = {
    ...basePlan(),
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [
      {
        step: 1,
        description: 'Create status file',
        tool: 'file_write',
        target: 'exact-status.txt',
        rationale: 'Write the status file',
        reversible: true,
        verification: 'File created',
      },
    ],
  };
  const result = injectVerificationStepsIntoPlan(
    plan,
    'Create exact-status.txt. Run npm test before completing.',
    null,
  );
  assert.equal(result.injected, true);
  // Must use `npm test` from task text, not the synthesized cat/type command
  assert.ok(
    result.commands.some((c) => c === 'npm test'),
    `expected npm test in commands, got ${JSON.stringify(result.commands)}`,
  );
});
