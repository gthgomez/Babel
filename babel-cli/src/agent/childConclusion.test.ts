/**
 * S02/#212 (T02) — bounded read-only child conclusion handoff.
 *
 * Reproduces the original defect (finish summary absent from observations),
 * then asserts the bounded child result reaches the actual parent formatter and
 * the text-tools renderer exactly once, with distinct states and visible
 * bounds, and no promotion to completion/verifier authority.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  READONLY_CHILD_CONCLUSION_MAX_CHARS,
  READONLY_CHILD_EVIDENCE_MAX_REFS,
  buildReadOnlyChildResult,
  renderReadOnlyChildResultSection,
  type ReadOnlyChildResultInput,
} from './childConclusion.js';
import { formatSubAgentFindings } from './chatToolDefinitions.js';
import { formatTextToolResults } from './chatEngine.js';
import { formatReadOnlyObservations } from './lanes/readOnlyAgentLoop.js';

const SENTINEL = 'SENTINEL_S02_2f9c_UNIQUE_CHILD_CONCLUSION';
const SOURCE = 'export const SOURCE_EVIDENCE_S02 = 42;';

const STEPS = [
  {
    phase: 'observe',
    action: { type: 'read_file', path: 'src/example.ts' },
    policyBlocked: false,
    toolResults: [{ exit_code: 0, stdout: SOURCE, stderr: '' }],
  },
  {
    phase: 'finish',
    action: { type: 'finish', summary: SENTINEL },
    policyBlocked: false,
    toolResults: [],
  },
] as const;

const TOOL_CALL_LOG = [
  { tool: 'read_file', target: 'src/example.ts', exit_code: 0, verified: true },
];

function makeInput(overrides: Partial<ReadOnlyChildResultInput> = {}): ReadOnlyChildResultInput {
  return {
    steps: STEPS as unknown as ReadOnlyChildResultInput['steps'],
    toolCallLog: TOOL_CALL_LOG,
    observations: SOURCE,
    stepsExecuted: 1,
    degraded: false,
    completed: true,
    roundExhausted: false,
    policyBlocked: false,
    roundsExecuted: 1,
    lane: 'ask',
    childId: 'chat-sub-1',
    maxRounds: 4,
    cancelled: false,
    ...overrides,
  };
}

describe('S02/#212 child conclusion handoff', () => {
  test('control: the finish sentinel is absent from raw observations', () => {
    const observations = formatReadOnlyObservations(
      STEPS as unknown as Parameters<typeof formatReadOnlyObservations>[0],
    );
    assert.ok(observations.includes('SOURCE_EVIDENCE_S02'), 'source evidence survives');
    assert.ok(!observations.includes(SENTINEL), 'finish summary is dropped (original defect)');
  });

  test('bounded child result carries the finish summary + evidence + provenance', () => {
    const result = buildReadOnlyChildResult(makeInput());
    assert.equal(result.schema, 'babel.readonly_child_result.v1');
    assert.equal(result.conclusion, SENTINEL);
    assert.equal(result.completion, 'completed');
    assert.equal(result.provenance.authority, 'child_assertion_not_verified');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]!.tool, 'read_file');
    assert.equal(result.limits.roundsExecuted, 1);
    assert.equal(result.limits.maxRounds, 4);
  });

  test('parent formatter surfaces the conclusion exactly once with no verification promotion', () => {
    const result = buildReadOnlyChildResult(makeInput());
    const findings = formatSubAgentFindings('chat-sub-1', 'probe task', {
      observations: SOURCE,
      stepsExecuted: 1,
      degraded: false,
      childResult: result,
    });
    assert.equal(findings.split(SENTINEL).length - 1, 1, 'sentinel appears exactly once');
    assert.match(findings, /Child conclusion \(child-reported; NOT verified\)/);
    assert.match(findings, /completion: completed/);
    assert.match(findings, /authority: child_assertion_not_verified/);
    assert.match(findings, /file_read|read_file/);
    assert.doesNotMatch(findings, /verified: true/);
    assert.doesNotMatch(findings, /confirmed_change/);
    // raw observations still present (evidence preserved by reference)
    assert.match(findings, /SOURCE_EVIDENCE_S02/);
  });

  test('text-tools path surfaces the same bounded child section exactly once', () => {
    const result = buildReadOnlyChildResult(makeInput());
    const childSection = renderReadOnlyChildResultSection(result);
    const text = formatTextToolResults([
      ...TOOL_CALL_LOG.map((entry) => ({ ...entry, detail: 'ok', stdout: SOURCE })),
      {
        tool: 'sub_agent',
        target: 'probe task',
        detail: '1 steps, 0 changed, attribution=child_noop',
        exit_code: 0,
        stdout: childSection,
      },
    ]);
    assert.equal(text.split(SENTINEL).length - 1, 1, 'sentinel appears exactly once on the text path');
    assert.match(text, /\[RESULT\] sub_agent:probe task/);
    assert.match(text, /authority: child_assertion_not_verified/);
    assert.match(text, /SOURCE_EVIDENCE_S02/);
  });

  test('a failed child still surfaces its bounded result on the text path', () => {
    const result = buildReadOnlyChildResult(
      makeInput({
        completed: false,
        roundExhausted: true,
        degraded: true,
        steps: [STEPS[0]] as unknown as ReadOnlyChildResultInput['steps'],
      }),
    );
    assert.equal(result.completion, 'partial');
    const text = formatTextToolResults([
      {
        tool: 'sub_agent',
        target: 'probe task',
        detail: '1 steps, 0 changed, attribution=child_round_exhaustion',
        exit_code: 1,
        stdout: renderReadOnlyChildResultSection(result),
      },
    ]);
    assert.match(text, /\[RESULT\] sub_agent:probe task/);
    assert.match(text, /completion: partial/);
    assert.match(text, /round_exhausted=true/);
  });

  test('completion states stay distinct (empty/partial/policy/cancel/provider/budget)', () => {
    const cases: Array<[Partial<ReadOnlyChildResultInput>, string]> = [
      [{ completed: true, steps: [STEPS[0]] as unknown as ReadOnlyChildResultInput['steps'] }, 'empty_conclusion'],
      [{ completed: false, roundExhausted: true }, 'partial'],
      [{ completed: false, policyBlocked: true }, 'policy_denied'],
      [{ completed: false, needsApproval: true }, 'policy_denied'],
      [{ completed: false, cancelled: true, roundExhausted: true }, 'cancelled'],
      [{ completed: false, providerError: 'transport reset' }, 'provider_error'],
      [{ completed: false, inheritedBudgetExceeded: true }, 'budget_exhausted'],
    ];
    for (const [override, expected] of cases) {
      const result = buildReadOnlyChildResult(makeInput(override));
      assert.equal(result.completion, expected, JSON.stringify(override));
    }
    // Co-occurring signals are retained, not collapsed.
    const cancelledPartial = buildReadOnlyChildResult(
      makeInput({ completed: false, cancelled: true, roundExhausted: true }),
    );
    assert.equal(cancelledPartial.completion, 'cancelled');
    assert.equal(cancelledPartial.flags.roundExhausted, true);
    assert.equal(cancelledPartial.flags.cancelled, true);
  });

  test('bounds are explicit and truncation is visible', () => {
    const longSummary = 'x'.repeat(READONLY_CHILD_CONCLUSION_MAX_CHARS + 250);
    const longResult = buildReadOnlyChildResult(
      makeInput({
        steps: [
          STEPS[0],
          { phase: 'finish', action: { type: 'finish', summary: longSummary }, policyBlocked: false, toolResults: [] },
        ] as unknown as ReadOnlyChildResultInput['steps'],
      }),
    );
    assert.equal(longResult.conclusionTruncated, true);
    assert.match(longResult.conclusion, /\[child conclusion truncated: 250 chars omitted\]/);

    const manyRefs = Array.from({ length: READONLY_CHILD_EVIDENCE_MAX_REFS + 3 }, (_, i) => ({
      tool: 'read_file',
      target: `src/f${i}.ts`,
      exit_code: 0,
      verified: true,
    }));
    const manyResult = buildReadOnlyChildResult(
      makeInput({ toolCallLog: manyRefs, stepsExecuted: manyRefs.length }),
    );
    assert.equal(manyResult.evidence.length, READONLY_CHILD_EVIDENCE_MAX_REFS);
    assert.equal(manyResult.evidenceTruncated, true);
    assert.match(renderReadOnlyChildResultSection(manyResult), /\[evidence list truncated/);
  });
});
