import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderFailureCard, renderSuccessCard, formatSessionToolTimeline, buildInteractiveCard } from './failureCard.js';
import type { FailureCardInput, ToolCallEntry, InteractiveCardInput } from './failureCard.js';

const MINIMAL_INPUT: FailureCardInput = {
  taskLabel: 'SWE-A08 test fix',
  status: 'FAILED',
  costUsd: 1.23,
  turns: 8,
  patchBytes: 0,
  emptyPatch: true,
  modelsUsed: ['deepseek-pro-v2', 'deepseek-flash-v2'],
  proCostShare: 0.4,
  lastTools: [
    { tool: 'read_file', target: 'src/foo.ts' },
    { tool: 'grep', target: 'src/' },
    { tool: 'str_replace', target: 'src/foo.ts' },
    { tool: 'run_command', target: 'npm test' },
    { tool: 'read_file', target: 'src/bar.ts' },
  ],
  policyEventCounts: {
    force_mutate: 2,
    phase_change: 1,
    read_thrash_fuse: 1,
  },
  topBlockedReasons: [
    { reason: 'phase_gate:verify_only', count: 3 },
    { reason: 'tool_restriction:mutate_only', count: 1 },
  ],
  observationTails: [
    { tool: 'run_command', target: 'npm test', exit_code: 1, tail: 'FAIL tests/foo.test.ts' },
  ],
  recommendedAction: 'Fix the test assertion in foo.test.ts before retrying.',
  runDir: 'runs/2026-07-12/run-001',
  transcriptPath: 'runs/2026-07-12/run-001/transcript.jsonl',
};

describe('renderFailureCard', () => {
  test('produces non-empty markdown with expected sections', () => {
    const result = renderFailureCard(MINIMAL_INPUT);
    assert.ok(result.length > 0);

    // Header with task label and status
    assert.match(result, /SWE-A08 test fix/);
    assert.match(result, /FAILED/);

    // Cost and turns
    assert.match(result, /\$1\.23/);
    assert.match(result, /Turns.*8/);

    // Models (shown as flash/pro percentage split)
    assert.match(result, /flash.*60%/);
    assert.match(result, /pro.*40%/);

    // Last tools summary
    assert.match(result, /Last tools/);

    // Policy events
    assert.match(result, /force_mutate/);
    assert.match(result, /phase_change/);

    // Blocked attempts
    assert.match(result, /phase_gate:verify_only/);

    // Observation tails
    assert.match(result, /run_command/);

    // Recommended action
    assert.match(result, /Fix the test assertion/);

    // Paths
    assert.match(result, /run-001/);
    assert.match(result, /transcript\.jsonl/);
  });

  test('handles empty optional fields gracefully', () => {
    const minimal: FailureCardInput = {
      taskLabel: 'test',
      status: 'FAILED',
      costUsd: 0,
      turns: 0,
      patchBytes: 0,
      emptyPatch: true,
      modelsUsed: [],
      proCostShare: 0,
      lastTools: [],
      policyEventCounts: {},
    };
    const result = renderFailureCard(minimal);
    assert.ok(result.length > 0);
    assert.match(result, /test/);
    assert.match(result, /FAILED/);
  });
});

describe('renderSuccessCard', () => {
  test('produces non-empty markdown', () => {
    const result = renderSuccessCard(MINIMAL_INPUT);
    assert.ok(result.length > 0);

    assert.match(result, /SWE-A08 test fix/);
    assert.match(result, /PASSED/);
    assert.match(result, /\$1\.23/);
    assert.match(result, /deepseek-pro-v2/);
  });
});

// ─── U1.1: Tool timeline + interactive card tests ────────────────────────────

const TOOL_FIXTURES: ToolCallEntry[] = [
  { tool: 'read_file', target: 'src/foo.ts' },
  { tool: 'grep', target: 'src/' },
  { tool: 'str_replace', target: 'src/foo.ts' },
  { tool: 'run_command', target: 'npm test -- --grep "auth"' },
  { tool: 'read_file', target: 'src/bar.ts' },
  { tool: 'write_file', target: 'src/baz.ts' },
];

describe('formatSessionToolTimeline', () => {
  test('returns empty string for undefined toolCalls', () => {
    assert.equal(formatSessionToolTimeline(undefined), '');
  });

  test('returns empty string for empty toolCalls', () => {
    assert.equal(formatSessionToolTimeline([]), '');
  });

  test('formats last N=5 tools with check marks', () => {
    const result = formatSessionToolTimeline(TOOL_FIXTURES, 5);
    assert.match(result, /Last 5 of 6 tools/);
    assert.match(result, /✓ str_replace src\/foo\.ts/);
    assert.match(result, /✓ grep src\//);
    assert.match(result, /✓ write_file src\/baz\.ts/);
    // Should NOT include the first tool (index 0)
    assert.ok(!result.includes('✓ read_file src/foo.ts'), 'should exclude the first tool (only last 5 of 6)');
  });

  test('formats all tools when fewer than N', () => {
    const shortList: ToolCallEntry[] = [
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'write_file', target: 'b.ts' },
    ];
    const result = formatSessionToolTimeline(shortList, 5);
    assert.match(result, /Last 2 tools/);
    assert.match(result, /✓ read_file a\.ts/);
    assert.match(result, /✓ write_file b\.ts/);
  });

  test('shows error marker for tools with error', () => {
    const withError: ToolCallEntry[] = [
      { tool: 'read_file', target: 'a.ts' },
      { tool: 'run_command', target: 'npm test', error: 'exit 1' },
    ];
    const result = formatSessionToolTimeline(withError, 5);
    assert.match(result, /✓ read_file a\.ts/);
    assert.match(result, /✗ run_command npm test/);
  });

  test('truncates long targets', () => {
    const longTarget = 'a'.repeat(80);
    const list: ToolCallEntry[] = [{ tool: 'read_file', target: longTarget }];
    const result = formatSessionToolTimeline(list, 5);
    assert.ok(result.length < longTarget.length + 30, 'target should be truncated');
    assert.match(result, /\.\.\./);
  });

  test('pluralizes correctly for single tool', () => {
    const single: ToolCallEntry[] = [{ tool: 'read_file', target: 'a.ts' }];
    const result = formatSessionToolTimeline(single, 5);
    assert.match(result, /Last 1 tool:/);
    assert.ok(!result.includes('tools'));
  });
});

describe('buildInteractiveCard', () => {
  test('renders status label', () => {
    const result = buildInteractiveCard({
      status: 'BLOCKED',
    });
    assert.match(result, /── BLOCKED ──/);
  });

  test('renders cost when provided', () => {
    const result = buildInteractiveCard({
      status: 'FAILED',
      costUsd: 0.042,
    });
    assert.match(result, /\$0\.0420/);
  });

  test('renders tool timeline when tools provided', () => {
    const result = buildInteractiveCard({
      status: 'FAILED',
      lastTools: [
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'str_replace', target: 'b.ts' },
      ],
    });
    assert.match(result, /Last 2 tools/);
    assert.match(result, /read_file a\.ts/);
  });

  test('renders recommended action when provided', () => {
    const result = buildInteractiveCard({
      status: 'BLOCKED',
      recommendedAction: 'Review blocked report.',
    });
    assert.match(result, /Next: Review blocked report/);
  });

  test('handles empty optional fields gracefully', () => {
    const result = buildInteractiveCard({
      status: 'CANCELLED',
    });
    const lines = result.split('\n');
    // Should only have header line
    assert.equal(lines[0], '── CANCELLED ──');
    // No cost, no tools, no next action
    assert.ok(!result.includes('Cost'));
    assert.ok(!result.includes('Next'));
  });

  test('golden output for full card', () => {
    const result = buildInteractiveCard({
      status: 'FAILED',
      costUsd: 0.0125,
      lastTools: [
        { tool: 'read_file', target: 'src/foo.ts' },
        { tool: 'str_replace', target: 'src/foo.ts' },
        { tool: 'run_command', target: 'npm test', error: 'exit 1' },
      ],
      recommendedAction: 'Check test failure before retrying.',
    });
    const expected = [
      '── FAILED ──',
      '  Cost: $0.0125',
      'Last 3 tools:',
      '  ✓ read_file src/foo.ts',
      '  ✓ str_replace src/foo.ts',
      '  ✗ run_command npm test',
      '  Next: Check test failure before retrying.',
    ].join('\n');
    assert.equal(result, expected);
  });
});

// ─── C3: Golden tests for stable markdown output ──────────────────────────────

const GOLDEN_FAILURE_OUTPUT = [
  '# SWE-A08 test fix — FAILED',
  '',
  '- **Cost**: $1.23 | **Turns**: 8 | **Patch**: 0 B',
  '- **Models**: flash 60% / pro 40%',
  '- **Last tools**: read_file → grep → str_replace → run_command → read_file',
  '- **Policy**: force_mutate×2, phase_change×1, read_thrash_fuse×1',
  '- **Top blocked attempts**: phase_gate:verify_only×3, tool_restriction:mutate_only×1',
  '',
  '## Last observation tails',
  '',
  '### run_command: `npm test` (exit 1)',
  '',
  '```',
  'FAIL tests/foo.test.ts',
  '```',
  '',
  '- **Recommended next action**: Fix the test assertion in foo.test.ts before retrying.',
  '- **Run dir**: `runs/2026-07-12/run-001`',
  '- **Transcript**: `runs/2026-07-12/run-001/transcript.jsonl`',
  '',
].join('\n');

describe('golden markdown stability (C3)', () => {
  test('renderFailureCard produces stable output for known fixture', () => {
    const result = renderFailureCard(MINIMAL_INPUT);
    assert.equal(result, GOLDEN_FAILURE_OUTPUT);
  });

  test('renderFailureCard with turn summaries includes decision section', () => {
    const withSummaries: FailureCardInput = {
      ...MINIMAL_INPUT,
      turnSummaries: [
        {
          turn: 4,
          hypothesis: 'The clear() call uses reset() instead',
          files_of_interest: ['src/logging.py'],
          next_tool: 'str_replace',
          blockers: [],
          ts: '2026-07-12T10:30:00Z',
        },
        {
          turn: 7,
          hypothesis: 'Fix applied; running tests to verify',
          files_of_interest: ['src/logging.py', 'tests/test_logging.py'],
          next_tool: 'run_command',
          blockers: ['test env missing pytest'],
          ts: '2026-07-12T10:31:00Z',
        },
      ],
    };
    const result = renderFailureCard(withSummaries);
    assert.match(result, /## Turn decision summaries/);
    assert.match(result, /clear\(\) call uses reset/);
    assert.match(result, /src\/logging\.py/);
    assert.match(result, /test env missing pytest/);
  });

  test('renderSuccessCard golden output for known fixture', () => {
    const result = renderSuccessCard(MINIMAL_INPUT);
    const expected = [
      '# SWE-A08 test fix — PASSED ✓',
      '',
      '- **Cost**: $1.23 | **Turns**: 8 | **Patch**: 0 B',
      '- **Models**: deepseek-pro-v2, deepseek-flash-v2',
      '- **Run dir**: `runs/2026-07-12/run-001`',
      '- **Transcript**: `runs/2026-07-12/run-001/transcript.jsonl`',
      '',
    ].join('\n');
    assert.equal(result, expected);
  });
});
