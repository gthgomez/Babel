/**
 * grounding.test.ts — Plan target extraction, artifact building, and grounding helpers
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  uniqueList,
  planStepString,
  plannedFileWriteTargets,
  buildCounterAgentCritiqueArtifact,
} from './grounding.js';
import type { SwePlan } from '../schemas/agentContracts.js';
import type { BabelIntentContract } from '../services/liteFullRouter.js';

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

function makeStep(
  overrides: Partial<SwePlan['minimal_action_set'][number]> = {},
): SwePlan['minimal_action_set'][number] {
  return {
    step: 1,
    description: 'Step description',
    tool: 'file_read',
    target: 'src/a.ts',
    rationale: 'Read a file',
    reversible: true,
    verification: 'Contents available',
    ...overrides,
  };
}

function makeIntent(overrides: Partial<BabelIntentContract> = {}): BabelIntentContract {
  return {
    task_kind: 'implementation',
    write_intent: true,
    write_confidence: 'high',
    mutation_allowed: true,
    no_write_requested: false,
    action_capable: true,
    ...overrides,
  };
}

// ─── uniqueList ──────────────────────────────────────────────────────────────

test('uniqueList: filters null values', () => {
  assert.deepEqual(uniqueList(['a', null, 'b', undefined]), ['a', 'b']);
});

test('uniqueList: filters empty strings', () => {
  assert.deepEqual(uniqueList(['a', '', 'b', '  ']), ['a', 'b']);
});

test('uniqueList: deduplicates', () => {
  assert.deepEqual(uniqueList(['a', 'b', 'a', 'b']), ['a', 'b']);
});

test('uniqueList: preserves order of first occurrence', () => {
  assert.deepEqual(uniqueList(['b', 'a', 'b']), ['b', 'a']);
});

test('uniqueList: handles empty array', () => {
  assert.deepEqual(uniqueList([]), []);
});

test('uniqueList: handles all null/undefined', () => {
  assert.deepEqual(uniqueList([null, undefined, null]), []);
});

test('uniqueList: trims whitespace values', () => {
  assert.deepEqual(uniqueList(['  a  ', 'b']), ['a', 'b']);
});

test('uniqueList: treats whitespace-only as empty', () => {
  assert.deepEqual(uniqueList(['  ', '\t']), []);
});

// ─── planStepString ──────────────────────────────────────────────────────────

test('planStepString: with target', () => {
  const step = makeStep({ tool: 'file_read', target: 'src/a.ts' });
  assert.equal(planStepString(step), 'file_read: src/a.ts');
});

test('planStepString: without target', () => {
  const step = makeStep({ tool: 'shell_exec', target: 'npm test' });
  assert.equal(planStepString(step), 'shell_exec: npm test');
});

test('planStepString: fallback for missing tool', () => {
  // @ts-expect-error testing missing tool
  const step = makeStep({ tool: undefined, target: 'foo' });
  const result = planStepString(step);
  assert.equal(result, 'tool: foo');
});

test('planStepString: empty target shows bare tool', () => {
  const step = makeStep({ tool: 'file_read', target: '' });
  assert.equal(planStepString(step), 'file_read');
});

test('planStepString: whitespace-only target shows bare tool', () => {
  const step = makeStep({ tool: 'file_read', target: '   ' });
  assert.equal(planStepString(step), 'file_read');
});

// ─── plannedFileWriteTargets ─────────────────────────────────────────────────

test('plannedFileWriteTargets: extracts file_write targets from plan', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_read', target: 'README.md' }),
      makeStep({ step: 2, tool: 'file_write', target: 'src/output.txt' }),
      makeStep({ step: 3, tool: 'file_write', target: 'src/other.txt' }),
      makeStep({ step: 4, tool: 'shell_exec', target: 'npm test' }),
    ],
  });
  assert.deepEqual(plannedFileWriteTargets(plan), ['src/output.txt', 'src/other.txt']);
});

test('plannedFileWriteTargets: returns empty array for plan with no file_write steps', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_read', target: 'README.md' }),
      makeStep({ step: 2, tool: 'shell_exec', target: 'npm test' }),
    ],
  });
  assert.deepEqual(plannedFileWriteTargets(plan), []);
});

test('plannedFileWriteTargets: returns empty array for null plan', () => {
  assert.deepEqual(plannedFileWriteTargets(null), []);
});

test('plannedFileWriteTargets: returns empty array for undefined plan', () => {
  assert.deepEqual(plannedFileWriteTargets(undefined), []);
});

test('plannedFileWriteTargets: deduplicates targets', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' }),
      makeStep({ step: 2, tool: 'file_write', target: 'src/output.txt' }),
    ],
  });
  assert.deepEqual(plannedFileWriteTargets(plan), ['src/output.txt']);
});

test('plannedFileWriteTargets: filters empty targets', () => {
  const plan = makePlan({
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: '' }),
      makeStep({ step: 2, tool: 'file_write', target: 'src/output.txt' }),
    ],
  });
  assert.deepEqual(plannedFileWriteTargets(plan), ['src/output.txt']);
});

// ─── buildCounterAgentCritiqueArtifact ───────────────────────────────────────

test('buildCounterAgentCritiqueArtifact: IMPLEMENTATION_PLAN with mutation_allowed=false returns critical', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' })],
  });
  const intent = makeIntent({ mutation_allowed: false });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent });

  assert.equal(result.schema_version, 1);
  assert.equal(result.artifact_type, 'babel_counter_agent_critique');
  assert.equal(result.critic_verdict, 'block');
  assert.equal(result.severity, 'critical');
  assert.ok(result.required_changes.length > 0);
  assert.match(result.required_changes[0]!, /read-only|no-write|implementation plan/i);
});

test('buildCounterAgentCritiqueArtifact: includes targetScopeViolations as critical', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' })],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({
    plan,
    intent,
    targetScopeViolations: ['Write to protected path src/secret.txt is not allowed.'],
  });

  assert.equal(result.critic_verdict, 'block');
  assert.equal(result.severity, 'critical');
  assert.ok(result.required_changes.some((c) => c.includes('src/secret.txt')));
});

test('buildCounterAgentCritiqueArtifact: IMPLEMENTATION_PLAN with verification strategy passes', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' }),
      {
        step: 2,
        description: 'Verify output',
        tool: 'shell_exec',
        target: 'npm test',
        rationale: 'Verify the change',
        reversible: true,
        verification: 'Exit code 0',
      },
    ],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent });

  // Has file_write targets + verification command → all good
  assert.equal(result.critic_verdict, 'pass');
  assert.equal(result.severity, 'minor');
  assert.equal(result.required_changes.length, 0);
  assert.ok(result.optional_suggestions.length > 0);
});

test('buildCounterAgentCritiqueArtifact: IMPLEMENTATION_PLAN without file writes passes (no verification needed)', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [makeStep({ step: 1, tool: 'shell_exec', target: 'npm test' })],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent });

  // No file_write targets → hasVerificationStrategy is true (via plannedFileWriteTargets.length === 0)
  assert.equal(result.critic_verdict, 'pass');
  assert.equal(result.severity, 'minor');
});

test('buildCounterAgentCritiqueArtifact: IMPLEMENTATION_PLAN with mutation_allowed but no verification returns major', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' })],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent });

  assert.equal(result.critic_verdict, 'block');
  assert.equal(result.severity, 'major');
  assert.ok(result.required_changes.some((c) => /verification/i.test(c)));
});

test('buildCounterAgentCritiqueArtifact: EVIDENCE_REQUEST always passes regardless of verification', () => {
  const plan = makePlan({
    plan_type: 'EVIDENCE_REQUEST',
    minimal_action_set: [
      makeStep({ step: 1, tool: 'file_read', target: 'README.md' }),
      {
        step: 2,
        description: 'Analyze file',
        tool: 'semantic_search',
        target: 'test description',
        rationale: 'Search for patterns',
        reversible: true,
        verification: 'Results available',
      },
    ],
  });
  const intent = makeIntent({ mutation_allowed: false });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent });

  // EVIDENCE_REQUEST does NOT trigger the IMPLEMENTATION_PLAN checks,
  // even though mutation_allowed is false.
  assert.equal(result.critic_verdict, 'pass');
  assert.equal(result.severity, 'minor');
});

test('buildCounterAgentCritiqueArtifact: targetScopeViolations empty does not add extra changes', () => {
  const plan = makePlan({
    plan_type: 'EVIDENCE_REQUEST',
    minimal_action_set: [makeStep({ step: 1, tool: 'file_read', target: 'README.md' })],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({ plan, intent, targetScopeViolations: [] });

  assert.equal(result.critic_verdict, 'pass');
  assert.equal(result.severity, 'minor');
  assert.equal(result.required_changes.length, 0);
});

test('buildCounterAgentCritiqueArtifact: multiple target scope violations all appear in required_changes', () => {
  const plan = makePlan({
    plan_type: 'IMPLEMENTATION_PLAN',
    minimal_action_set: [makeStep({ step: 1, tool: 'file_write', target: 'src/output.txt' })],
  });
  const intent = makeIntent({ mutation_allowed: true });

  const result = buildCounterAgentCritiqueArtifact({
    plan,
    intent,
    targetScopeViolations: ['Violation one.', 'Violation two.'],
  });

  assert.equal(result.severity, 'critical');
  assert.ok(result.required_changes.some((c) => c === 'Violation one.'));
  assert.ok(result.required_changes.some((c) => c === 'Violation two.'));
  assert.equal(result.optional_suggestions.length, 0);
});
