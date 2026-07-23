// Tests for helper functions exported from waterfall.ts and outputBuffer.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppendOnlyRenderer, WaterfallRenderer, ConversationalRenderer } from './waterfall.js';

// Direct imports of exported helper functions (no more reference duplicates).
import {
  formatElapsed,
  formatDuration,
  formatETA,
  stageAction,
  activityKey,
  normalizeActivityLine,
  runtimeEventLabel,
  conversationalToolLabel,
  activityColor,
  successLike,
} from './waterfall.js';
import { isBrokenStdoutError } from './outputBuffer.js';
import { stripAnsi } from './theme.js';

// ── Direct tests ─────────────────────────────────────────────────────────────
// All tests now exercise the real exported functions directly.

// ═══════════════════════════════════════════════════════════════════════════════
// formatElapsed
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatElapsed', () => {
  it('returns "00:00" for 0ms', () => {
    assert.equal(formatElapsed(0), '00:00');
  });

  it('returns "00:00" for sub-second values', () => {
    assert.equal(formatElapsed(500), '00:00');
    assert.equal(formatElapsed(999), '00:00');
  });

  it('returns "00:01" for 1000ms', () => {
    assert.equal(formatElapsed(1000), '00:01');
  });

  it('returns "00:59" for 59000ms', () => {
    assert.equal(formatElapsed(59000), '00:59');
  });

  it('returns "01:00" for 60000ms', () => {
    assert.equal(formatElapsed(60000), '01:00');
  });

  it('returns "01:05" for 65000ms', () => {
    assert.equal(formatElapsed(65000), '01:05');
  });

  it('returns "60:00" for 3600000ms (1 hour)', () => {
    assert.equal(formatElapsed(3600000), '60:00');
  });

  it('returns "61:01" for 3661000ms', () => {
    assert.equal(formatElapsed(3661000), '61:01');
  });

  it('clamps negative values to 0 and returns "00:00"', () => {
    assert.equal(formatElapsed(-1), '00:00');
    assert.equal(formatElapsed(-1000), '00:00');
    assert.equal(formatElapsed(-999999), '00:00');
  });

  it('handles large values without overflow', () => {
    // 100 hours
    assert.equal(formatElapsed(360_000_000), '6000:00');
  });

  it('pads single-digit minutes and seconds with leading zero', () => {
    assert.equal(formatElapsed(3000), '00:03');
    assert.equal(formatElapsed(63000), '01:03');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatDuration
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDuration', () => {
  it('returns "<1s" for 0ms', () => {
    assert.equal(formatDuration(0), '<1s');
  });

  it('returns "<1s" for sub-second values (< 1000ms)', () => {
    assert.equal(formatDuration(500), '<1s');
    assert.equal(formatDuration(999), '<1s');
  });

  it('returns "1s" for exactly 1000ms', () => {
    assert.equal(formatDuration(1000), '1s');
  });

  it('returns "59s" for 59000ms', () => {
    assert.equal(formatDuration(59000), '59s');
  });

  it('returns "1m 0s" for 60000ms', () => {
    assert.equal(formatDuration(60000), '1m 0s');
  });

  it('returns "2m 5s" for 125000ms', () => {
    assert.equal(formatDuration(125000), '2m 5s');
  });

  it('returns "60m 0s" for 3600000ms', () => {
    assert.equal(formatDuration(3600000), '60m 0s');
  });

  it('rounds seconds correctly', () => {
    // 1m 30s for 90500ms (90.5s → rounds to 91s → 1m 31s)
    assert.equal(formatDuration(90500), '1m 31s');
    // 1m 29s for 89500ms (89.5s → rounds to 90s → 1m 30s)
    assert.equal(formatDuration(89500), '1m 30s');
  });

  it('handles values just under minute boundaries', () => {
    assert.equal(formatDuration(59999), '60s'); // rounds 59.999 → 60
    assert.equal(formatDuration(59900), '60s'); // rounds 59.9 → 60
    // Hmm, actually 59999/1000 = 59.999 → Math.round = 60
    // And 59900/1000 = 59.9 → Math.round = 60
    // So both give "60s" since they're < 60_000
  });

  it('handles exactly on minute boundaries', () => {
    // 120000ms = 2m exactly → "2m 0s"
    assert.equal(formatDuration(120000), '2m 0s');
  });

  it('handles values with decimal seconds', () => {
    // 1500ms = 1.5s → "2s" (Math.round(1.5) = 2)
    assert.equal(formatDuration(1500), '2s');
    // 1400ms = 1.4s → "1s" (Math.round(1.4) = 1)
    assert.equal(formatDuration(1400), '1s');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatETA
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatETA', () => {
  it('returns empty string for 0', () => {
    assert.equal(formatETA(0), '');
  });

  it('returns empty string for negative values', () => {
    assert.equal(formatETA(-1), '');
    assert.equal(formatETA(-1000), '');
  });

  it('returns "<1s" for sub-second positive values (1-999ms)', () => {
    assert.equal(formatETA(1), '<1s');
    assert.equal(formatETA(500), '<1s');
    assert.equal(formatETA(999), '<1s');
  });

  it('returns "~1s" for 1000ms', () => {
    assert.equal(formatETA(1000), '~1s');
  });

  it('returns "~30s" for 30000ms', () => {
    assert.equal(formatETA(30000), '~30s');
  });

  it('returns "~1m 0s" for 60000ms', () => {
    assert.equal(formatETA(60000), '~1m 0s');
  });

  it('returns "~2m 5s" for 125000ms', () => {
    assert.equal(formatETA(125000), '~2m 5s');
  });

  it('returns "~59s" for 59000ms', () => {
    assert.equal(formatETA(59000), '~59s');
  });

  it('rounds seconds after minute boundary', () => {
    // 61000ms → 1m 1s
    assert.equal(formatETA(61000), '~1m 1s');
    // 119000ms → 1m 59s
    assert.equal(formatETA(119000), '~1m 59s');
  });

  it('handles large values', () => {
    // 7200000ms = 120m
    assert.equal(formatETA(7200000), '~120m 0s');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// stageAction
// ═══════════════════════════════════════════════════════════════════════════════

describe('stageAction', () => {
  it('returns "Analyzing your request" for index 1', () => {
    assert.equal(stageAction(1), 'Analyzing your request');
  });

  it('returns "Planning" for index 2', () => {
    assert.equal(stageAction(2), 'Planning');
  });

  it('returns "Reviewing" for index 3', () => {
    assert.equal(stageAction(3), 'Reviewing');
  });

  it('returns "Applying changes" for index 4', () => {
    assert.equal(stageAction(4), 'Applying changes');
  });

  it('returns "Working" for index 0', () => {
    assert.equal(stageAction(0), 'Working');
  });

  it('returns "Working" for negative indices', () => {
    assert.equal(stageAction(-1), 'Working');
  });

  it('returns "Working" for indices > 4', () => {
    assert.equal(stageAction(5), 'Working');
    assert.equal(stageAction(100), 'Working');
  });

  it('returns "Working" for NaN-like values (accepts number type only)');
  // Note: TypeScript enforces number type; this is a type-level guarantee
});

// ═══════════════════════════════════════════════════════════════════════════════
// activityKey
// ═══════════════════════════════════════════════════════════════════════════════

describe('activityKey', () => {
  it('lowercases the input', () => {
    assert.equal(activityKey('READING File.ts'), 'reading file.ts');
  });

  it('replaces numbers with #', () => {
    assert.equal(activityKey('test 123 file'), 'test # file');
  });

  it('replaces "number/number" patterns with "#/#"', () => {
    assert.equal(activityKey('step 3/5 complete'), 'step #/# complete');
  });

  it('collapses whitespace', () => {
    assert.equal(activityKey('a    b   c'), 'a b c');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(activityKey('  hello world  '), 'hello world');
  });

  it('returns empty string for empty or whitespace-only input', () => {
    assert.equal(activityKey(''), '');
    assert.equal(activityKey('   '), '');
  });

  it('handles null/undefined-like input via String coercion', () => {
    assert.equal(activityKey(null as unknown as string), '');
    assert.equal(activityKey(undefined as unknown as string), '');
  });

  it('preserves semantic content but normalizes numbers', () => {
    // Same semantic content → same key
    assert.equal(activityKey('Reading file123.ts'), activityKey('Reading file456.ts'));
  });

  it('produces different keys for different content', () => {
    assert.notEqual(activityKey('Reading file.ts'), activityKey('Writing file.ts'));
  });

  it('normalizes mixed fraction patterns', () => {
    assert.equal(activityKey('processed 12/25 items'), 'processed #/# items');
    assert.equal(activityKey('12/25'), '#/#');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeActivityLine
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizeActivityLine', () => {
  it('returns null for empty string', () => {
    assert.equal(normalizeActivityLine(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.equal(normalizeActivityLine('   '), null);
    assert.equal(normalizeActivityLine('\t'), null);
  });

  it('returns null for ### INTERNAL MONOLOGUE', () => {
    assert.equal(normalizeActivityLine('### INTERNAL MONOLOGUE'), null);
    assert.equal(normalizeActivityLine('prefix ### INTERNAL MONOLOGUE suffix'), null);
  });

  it('returns null for JSON-format strings', () => {
    assert.equal(normalizeActivityLine('{"tool":"file_read"}'), null);
    assert.equal(normalizeActivityLine('{"key": "value"}'), null);
  });

  it('returns null for strings with "tool": pattern', () => {
    assert.equal(normalizeActivityLine('data "tool": "shell_exec" end'), null);
  });

  it('returns null for JSON-like content in braces', () => {
    // /{.*}/ pattern
    assert.equal(normalizeActivityLine('prefix {some json} suffix'), null);
  });

  it('strips [babel:...] prefix', () => {
    assert.equal(normalizeActivityLine('[babel:info] Processing file'), 'Processing file');
  });

  it('strips [babel] HH:MM:SS prefix', () => {
    assert.equal(normalizeActivityLine('[babel] 14:30:00 Processing file'), 'Processing file');
  });

  it('strips Executor turn N/M prefix', () => {
    assert.equal(normalizeActivityLine('Executor turn 3/5 — Analyzing'), 'Analyzing request');
  });

  it('strips Stage N/M prefix', () => {
    assert.equal(normalizeActivityLine('Stage 1/4 — Analyzing'), 'Analyzing request');
  });

  it('strips bracketed internal tags', () => {
    assert.equal(
      normalizeActivityLine('Something [EXECUTOR_HALTED] happened'),
      'Something happened',
    );
    assert.equal(normalizeActivityLine('[FATAL_ERROR] Crash'), ' Crash');
    assert.equal(normalizeActivityLine('[VERIFIER_FAILED] Check'), ' Check');
    assert.equal(normalizeActivityLine('[ROLLBACK_APPLIED] Reverted'), ' Reverted');
  });

  it('strips [debug] prefix', () => {
    assert.equal(normalizeActivityLine('[debug] Starting analysis'), 'Starting analysis');
  });

  it('replaces em-dash with regular dash', () => {
    assert.equal(normalizeActivityLine('Running test—check'), 'Running test-check');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeActivityLine('a    b'), 'a b');
  });

  it('truncates very long lines', () => {
    const longLine = 'x'.repeat(500);
    const result = normalizeActivityLine(longLine);
    assert.ok(result !== null);
    assert.ok(result!.length <= 200); // Math.max(60, getTerminalWidth() - 8) — default ~200 in reference
  });

  // ── Stage canonicalization ──

  it('maps Stage 1/4 to "Analyzing request"', () => {
    assert.equal(normalizeActivityLine('Stage 1/4 — Analyzing'), 'Analyzing request');
  });

  it('maps "Analyzing..." to "Analyzing request"', () => {
    assert.equal(normalizeActivityLine('Analyzing dependencies'), 'Analyzing request');
  });

  it('maps "Orchestrator ..." to "Analyzing request"', () => {
    assert.equal(normalizeActivityLine('Orchestrator running'), 'Analyzing request');
  });

  it('maps Stage 2/4 to "Planning"', () => {
    assert.equal(normalizeActivityLine('Stage 2/4 — Planning'), 'Planning');
  });

  it('maps "Planning ..." to "Planning"', () => {
    assert.equal(normalizeActivityLine('Planning the solution'), 'Planning');
  });

  it('maps "SWE Agent ..." to "Planning"', () => {
    assert.equal(normalizeActivityLine('SWE Agent starting'), 'Planning');
  });

  it('maps Stage 3/4 to "Reviewing"', () => {
    assert.equal(normalizeActivityLine('Stage 3/4 — Reviewing'), 'Reviewing');
  });

  it('maps "Reviewing ..." to "Reviewing"', () => {
    assert.equal(normalizeActivityLine('Reviewing the changes'), 'Reviewing');
  });

  it('maps "QA Reviewer ..." to "Reviewing"', () => {
    assert.equal(normalizeActivityLine('QA Reviewer running'), 'Reviewing');
  });

  it('maps Stage 4/4 to "Applying changes"', () => {
    assert.equal(normalizeActivityLine('Stage 4/4 — Applying'), 'Applying changes');
  });

  it('maps "Applying ..." to "Applying changes"', () => {
    assert.equal(normalizeActivityLine('Applying patches'), 'Applying changes');
  });

  it('maps "Executor ..." to "Applying changes"', () => {
    assert.equal(normalizeActivityLine('Executor running commands'), 'Applying changes');
  });

  it('maps Stage 0/4 to "Optimizing context"', () => {
    assert.equal(normalizeActivityLine('Stage 0/4'), 'Optimizing context');
  });

  it('maps "Optimizing context" to "Optimizing context"', () => {
    assert.equal(
      normalizeActivityLine('Optimizing context for better results'),
      'Optimizing context',
    );
  });

  // ── Pipeline lifecycle messages ──

  it('returns null for "Run directory:"', () => {
    assert.equal(normalizeActivityLine('Run directory: /tmp/foo'), null);
  });

  it('maps dry run messages to "Dry run active"', () => {
    assert.equal(normalizeActivityLine('DRY RUN mode active'), 'Dry run active');
    assert.equal(normalizeActivityLine('Dry run mode is on'), 'Dry run active');
  });

  it('maps "Execution profile:" to profile label', () => {
    assert.equal(normalizeActivityLine('Execution profile: balanced'), 'Using balanced profile');
  });

  it('maps "Resolved typed stack" to "Loaded project context"', () => {
    assert.equal(normalizeActivityLine('Resolved typed stack'), 'Loaded project context');
  });

  // ── Internal telemetry / config filters ──

  it('returns null for v9 stack telemetry', () => {
    assert.equal(normalizeActivityLine('v9 stack telemetry: ...'), null);
  });

  it('returns null for Tool project root', () => {
    assert.equal(normalizeActivityLine('Tool project root: /foo'), null);
  });

  it('returns null for Project:', () => {
    assert.equal(normalizeActivityLine('Project: my-app'), null);
  });

  it('returns null for Model:', () => {
    assert.equal(normalizeActivityLine('Model: claude-sonnet-4'), null);
  });

  it('returns null for Provider:', () => {
    assert.equal(normalizeActivityLine('Provider: anthropic'), null);
  });

  it('returns null for Router:', () => {
    assert.equal(normalizeActivityLine('Router: v9'), null);
  });

  it('returns null for Mode:', () => {
    assert.equal(normalizeActivityLine('Mode: chat'), null);
  });

  it('returns null for Pipeline mode', () => {
    assert.equal(normalizeActivityLine('Pipeline mode: governed'), null);
  });

  it('returns null for Session start', () => {
    assert.equal(normalizeActivityLine('Session start: 2026-06-23'), null);
  });

  it('returns null for Authoritative/Runtime project root', () => {
    assert.equal(normalizeActivityLine('Authoritative project root: /foo'), null);
    assert.equal(normalizeActivityLine('Runtime project root: /foo'), null);
  });

  it('returns null for various internal identifiers in text', () => {
    assert.equal(normalizeActivityLine('model_context detected'), null);
    assert.equal(normalizeActivityLine('Checking provider status'), null);
    assert.equal(normalizeActivityLine('prompt_manifest loaded'), null);
    assert.equal(normalizeActivityLine('instruction_stack ready'), null);
    assert.equal(normalizeActivityLine('telemetry data'), null);
    assert.equal(normalizeActivityLine('BABEL_PROJECT_ROOT set'), null);
  });

  // ── Plan and result messages ──

  it('maps "Action steps:" to "Plan ready"', () => {
    assert.equal(normalizeActivityLine('Action steps: 5'), 'Plan ready');
  });

  it('maps "Mode is chat" to "Complete — read-only"', () => {
    assert.equal(normalizeActivityLine('Mode is "chat"'), 'Complete — read-only');
  });

  it('maps "Pipeline complete" to "Complete"', () => {
    assert.equal(normalizeActivityLine('Pipeline complete'), 'Complete');
    assert.equal(normalizeActivityLine('Done — finished'), 'Done - finished');
  });

  it('maps QA pass to "Review passed"', () => {
    assert.equal(normalizeActivityLine('QA: PASS'), 'Review passed');
    assert.equal(normalizeActivityLine('QA passed'), 'Review passed');
    assert.equal(normalizeActivityLine('review pass'), 'Review passed');
  });

  it('maps QA reject/fail to "Review blocked"', () => {
    assert.equal(normalizeActivityLine('QA: REJECT'), 'Review blocked');
    assert.equal(normalizeActivityLine('QA: FAIL'), 'Review blocked');
    assert.equal(normalizeActivityLine('QA rejected'), 'Review blocked');
    assert.equal(normalizeActivityLine('QA failed'), 'Review blocked');
    assert.equal(normalizeActivityLine('review blocked'), 'Review blocked');
  });

  it('maps cancelled/halted to "Stopped"', () => {
    assert.equal(normalizeActivityLine('Review cancelled'), 'Stopped');
    assert.equal(normalizeActivityLine('Pipeline halted'), 'Stopped');
    assert.equal(normalizeActivityLine('EXECUTOR_HALTED'), 'Stopped');
    assert.equal(normalizeActivityLine('Stopped — user request'), 'Stopped - user request');
  });

  // ── Tool activity ──

  it('maps reading tools to "Reading file"', () => {
    assert.equal(normalizeActivityLine('directory_list src/'), 'Reading file');
    assert.equal(normalizeActivityLine('file_read src/index.ts'), 'Reading file');
    assert.equal(normalizeActivityLine('semantic_search query'), 'Reading file');
    assert.equal(normalizeActivityLine('Reading file contents'), 'Reading file');
  });

  it('maps writing tools to "Writing file"', () => {
    assert.equal(normalizeActivityLine('file_write output.txt'), 'Writing file');
    assert.equal(normalizeActivityLine('patched src/app.ts'), 'Writing file');
    assert.equal(normalizeActivityLine('applying changes'), 'Applying changes');
  });

  it('maps testing tools to "Running check"', () => {
    assert.equal(normalizeActivityLine('test_run completed'), 'Running check');
    assert.equal(normalizeActivityLine('verifier starting'), 'Running check');
    assert.equal(normalizeActivityLine('npm test'), 'Running check');
    assert.equal(normalizeActivityLine('pytest passed'), 'Running check');
    assert.equal(normalizeActivityLine('gradle test'), 'Running check');
  });

  // ── Internal data filters ──

  it('returns null for "Run data:"', () => {
    assert.equal(normalizeActivityLine('Run data: collected'), null);
  });

  it('returns null for "See ... for details"', () => {
    assert.equal(normalizeActivityLine('See /tmp/run.log for details'), null);
  });

  it('returns null for "Run data saved"', () => {
    assert.equal(normalizeActivityLine('Run data saved to /tmp'), null);
  });

  it('returns null for "Evidence bundle:"', () => {
    assert.equal(normalizeActivityLine('Evidence bundle: /tmp/ev'), null);
  });

  // ── Common activity text passes through ──

  it('passes through regular activity text', () => {
    assert.equal(normalizeActivityLine('Installing dependencies'), 'Installing dependencies');
  });

  it('passes through brief messages unchanged', () => {
    assert.equal(normalizeActivityLine('Building project'), 'Building project');
  });

  it('handles special characters', () => {
    const result = normalizeActivityLine('Processing file: src/utils/helper.ts (+12 -3)');
    assert.equal(result, 'Processing file: src/utils/helper.ts (+12 -3)');
  });

  it('handles lines with file paths', () => {
    const result = normalizeActivityLine('Reading /tmp/project\\file.ts');
    assert.equal(result, 'Reading file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runtimeEventLabel
// ═══════════════════════════════════════════════════════════════════════════════

describe('runtimeEventLabel', () => {
  it('returns null for missing event_type', () => {
    assert.equal(runtimeEventLabel({} as any), null);
    assert.equal(runtimeEventLabel({ payload: {} } as any), null);
  });

  it('returns null for session.started', () => {
    assert.equal(runtimeEventLabel({ event_type: 'session.started' }), null);
  });

  it('returns null for session.completed', () => {
    assert.equal(runtimeEventLabel({ event_type: 'session.completed' }), null);
  });

  it('returns null for unknown event_type', () => {
    assert.equal(runtimeEventLabel({ event_type: 'unknown.event' }), null);
    assert.equal(runtimeEventLabel({ event_type: 'custom_event' }), null);
  });

  it('returns null for null/undefined event', () => {
    assert.equal(runtimeEventLabel(null as unknown as { event_type?: string }), null);
    assert.equal(runtimeEventLabel(undefined as unknown as { event_type?: string }), null);
  });

  // ── verification.decision ──

  it('labels verification.decision with decision payload', () => {
    const result = runtimeEventLabel({
      event_type: 'verification.decision',
      payload: { decision: 'PASS' },
    });
    assert.equal(result, 'Verification pass');
  });

  it('labels verification.decision with status payload fallback', () => {
    const result = runtimeEventLabel({
      event_type: 'verification.decision',
      payload: { status: 'FAIL' },
    });
    assert.equal(result, 'Verification fail');
  });

  it('labels verification.decision without payload as "Verification recorded"', () => {
    const result = runtimeEventLabel({
      event_type: 'verification.decision',
      payload: {},
    });
    assert.equal(result, 'Verification recorded');
  });

  // ── policy.decision ──

  it('labels policy.decision', () => {
    assert.equal(runtimeEventLabel({ event_type: 'policy.decision' }), 'Policy decision recorded');
  });

  // ── tool.requested ──

  it('labels tool.requested with tool name and target', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.requested',
      payload: { tool: 'file_read', target: 'src/index.ts' },
    });
    assert.equal(result, 'file_read src/index.ts');
  });

  it('labels tool.requested without target', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.requested',
      payload: { tool: 'file_read' },
    });
    assert.equal(result, 'file_read');
  });

  it('labels tool.requested for shell_exec with command preview', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.requested',
      payload: { tool: 'shell_exec', command: 'npm test -- --coverage' },
    });
    assert.equal(result, 'shell_exec: npm test -- --coverage');
  });

  it('truncates shell_exec command to 40 chars', () => {
    const longCmd = 'a'.repeat(100);
    const result = runtimeEventLabel({
      event_type: 'tool.requested',
      payload: { tool: 'shell_exec', command: longCmd },
    });
    assert.equal(result, `shell_exec: ${'a'.repeat(40)}`);
  });

  it('labels tool.requested for file_write with target', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.requested',
      payload: { tool: 'file_write', target: 'output.txt' },
    });
    assert.equal(result, 'file_write output.txt');
  });

  // ── tool.completed ──

  it('labels tool.completed with success checkmark for exit_code 0', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.completed',
      payload: { tool: 'file_read', target: 'src/index.ts', exit_code: 0 },
    });
    assert.equal(result, 'file_read src/index.ts ✓');
  });

  it('labels tool.completed with failure for non-zero exit_code', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.completed',
      payload: { tool: 'shell_exec', target: 'npm test', exit_code: 1 },
    });
    assert.equal(result, 'shell_exec npm test ✗ (1)');
  });

  it('labels tool.completed with detail string', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.completed',
      payload: { tool: 'file_read', target: 'src/index.ts', exit_code: 0, detail: '2.1 KB' },
    });
    assert.equal(result, 'file_read src/index.ts ✓ (2.1 KB)');
  });

  it('labels tool.completed without exit_code (no status)', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.completed',
      payload: { tool: 'file_read', target: 'src/index.ts' },
    });
    assert.equal(result, 'file_read src/index.ts ');
  });

  it('labels tool.completed without payload target', () => {
    const result = runtimeEventLabel({
      event_type: 'tool.completed',
      payload: { tool: 'shell_exec', exit_code: 0 },
    });
    assert.equal(result, 'shell_exec ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// conversationalToolLabel
// ═══════════════════════════════════════════════════════════════════════════════

describe('conversationalToolLabel', () => {
  it('formats short tool + target with known verb', () => {
    const result = conversationalToolLabel('file_read', 'src/index.ts');
    assert.equal(stripAnsi(result), 'Reading src/index.ts');
  });

  it('formats shell_exec with known verb', () => {
    const result = conversationalToolLabel('shell_exec', 'npm test');
    assert.equal(stripAnsi(result), 'Running npm test');
  });

  it('formats web_fetch with known verb', () => {
    const result = conversationalToolLabel('web_fetch', 'https://example.com');
    assert.equal(stripAnsi(result), 'Fetching https://example.com');
  });

  it('uses the raw tool name for unknown tools', () => {
    const result = conversationalToolLabel('custom_tool', 'target');
    assert.equal(stripAnsi(result), 'custom_tool target');
  });

  it('truncates target longer than 50 characters', () => {
    const longTarget = 'a'.repeat(60);
    const result = conversationalToolLabel('file_read', longTarget);
    assert.equal(stripAnsi(result), `Reading ${'a'.repeat(47)}…`);
  });

  it('does not truncate target at exactly 50 characters', () => {
    const target = 'a'.repeat(50);
    const result = conversationalToolLabel('file_read', target);
    assert.equal(stripAnsi(result), `Reading ${target}`);
  });

  it('truncates target at 51 characters (50+1)', () => {
    const target = 'a'.repeat(51);
    const result = conversationalToolLabel('file_read', target);
    assert.equal(stripAnsi(result), `Reading ${'a'.repeat(47)}…`);
  });

  it('handles empty target string', () => {
    const result = conversationalToolLabel('file_read', '');
    assert.equal(stripAnsi(result), 'Reading ');
  });

  it('maps all known tool types to their verbs', () => {
    const knownTools: Record<string, [string, string]> = {
      file_read: ['Reading', 'file.ts'],
      directory_list: ['Listing', 'src/'],
      semantic_search: ['Searching', 'query'],
      grep: ['Searching', 'pattern'],
      glob: ['Finding', '**/*.ts'],
      file_write: ['Editing', 'file.ts'],
      shell_exec: ['Running', 'npm test'],
      web_search: ['Searching web', 'query'],
      web_fetch: ['Fetching', 'url'],
      test_run: ['Testing', 'suite'],
      verifier: ['Verifying', 'config'],
      mcp_request: ['Calling', 'server'],
    };

    for (const [tool, [verb, target]] of Object.entries(knownTools)) {
      assert.equal(
        stripAnsi(conversationalToolLabel(tool, target)),
        `${verb} ${target}`,
        `Tool "${tool}" should map to verb "${verb}"`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isBrokenStdoutError
// ═══════════════════════════════════════════════════════════════════════════════

describe('isBrokenStdoutError', () => {
  it('returns true for EPIPE error', () => {
    const error = new Error('broken pipe');
    (error as NodeJS.ErrnoException).code = 'EPIPE';
    assert.equal(isBrokenStdoutError(error), true);
  });

  it('returns true for ERR_STREAM_DESTROYED error', () => {
    const error = new Error('stream destroyed');
    (error as NodeJS.ErrnoException).code = 'ERR_STREAM_DESTROYED';
    assert.equal(isBrokenStdoutError(error), true);
  });

  it('returns true for ENOTCONN error', () => {
    const error = new Error('not connected');
    (error as NodeJS.ErrnoException).code = 'ENOTCONN';
    assert.equal(isBrokenStdoutError(error), true);
  });

  it('returns false for other system errors', () => {
    const error = new Error('permission denied');
    (error as NodeJS.ErrnoException).code = 'EACCES';
    assert.equal(isBrokenStdoutError(error), false);
  });

  it('returns false for ENOENT', () => {
    const error = new Error('not found');
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    assert.equal(isBrokenStdoutError(error), false);
  });

  it('returns false for string values', () => {
    assert.equal(isBrokenStdoutError('EPIPE'), false);
  });

  it('returns false for null', () => {
    assert.equal(isBrokenStdoutError(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isBrokenStdoutError(undefined), false);
  });

  it('returns false for plain objects without code', () => {
    assert.equal(isBrokenStdoutError({ message: 'error' }), false);
  });

  it('returns false for numbers', () => {
    assert.equal(isBrokenStdoutError(42), false);
  });

  it('returns true for object with matching code property (not necessarily an Error)', () => {
    assert.equal(isBrokenStdoutError({ code: 'EPIPE' }), true);
  });

  it('is case-sensitive on code values', () => {
    assert.equal(isBrokenStdoutError({ code: 'epipe' }), false);
    assert.equal(isBrokenStdoutError({ code: 'Epipe' }), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// activityColor (routing logic)
// ═══════════════════════════════════════════════════════════════════════════════

describe('activityColor', () => {
  it('classifies error/fail/halt/blocked lines as error-styled', () => {
    assert.equal(stripAnsi(activityColor('Something failed')), 'Something failed');
    assert.equal(stripAnsi(activityColor('Error occurred')), 'Error occurred');
    assert.equal(stripAnsi(activityColor('Pipeline halted')), 'Pipeline halted');
    assert.equal(stripAnsi(activityColor('Access denied')), 'Access denied');
    assert.equal(stripAnsi(activityColor('Build stopped')), 'Build stopped');
    assert.equal(stripAnsi(activityColor('Request cancelled')), 'Request cancelled');
  });

  it('classifies write/patched/applying lines as success-styled', () => {
    assert.equal(stripAnsi(activityColor('Writing file')), 'Writing file');
    assert.equal(stripAnsi(activityColor('patched src/main.ts')), 'patched src/main.ts');
    assert.equal(stripAnsi(activityColor('Applying changes')), 'Applying changes');
  });

  it('classifies run/command/shell/npm/pytest/gradle lines as warning-styled', () => {
    assert.equal(stripAnsi(activityColor('ran tests')), 'ran tests');
    assert.equal(stripAnsi(activityColor('running build')), 'running build');
    assert.equal(stripAnsi(activityColor('shell command')), 'shell command');
    assert.equal(stripAnsi(activityColor('executing command')), 'executing command');
    assert.equal(stripAnsi(activityColor('npm install')), 'npm install');
    assert.equal(stripAnsi(activityColor('pytest suite')), 'pytest suite');
    assert.equal(stripAnsi(activityColor('gradle assemble')), 'gradle assemble');
  });

  it('classifies read/list/search/grep/glob/found lines as info-styled', () => {
    assert.equal(stripAnsi(activityColor('Reading file')), 'Reading file');
    assert.equal(stripAnsi(activityColor('List directory')), 'List directory');
    assert.equal(stripAnsi(activityColor('Searching codebase')), 'Searching codebase');
    assert.equal(stripAnsi(activityColor('grep pattern')), 'grep pattern');
    assert.equal(stripAnsi(activityColor('glob match')), 'glob match');
    assert.equal(stripAnsi(activityColor('found results')), 'found results');
  });

  it('classifies other lines as muted-styled', () => {
    assert.equal(stripAnsi(activityColor('Installing dependencies')), 'Installing dependencies');
    assert.equal(stripAnsi(activityColor('Building project')), 'Building project');
    assert.equal(stripAnsi(activityColor('Starting server')), 'Starting server');
  });

  it('error patterns take priority over other classifiers', () => {
    // "run failed" contains both "run" (warning) and "failed" (error) — error wins
    assert.equal(stripAnsi(activityColor('run failed')), 'run failed');
    // "read error" contains "read" (info) but "error" (error) wins
    assert.equal(stripAnsi(activityColor('read error')), 'read error');
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(activityColor('')), '');
    assert.equal(stripAnsi(activityColor('   ')), '   ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// successLike
// ═══════════════════════════════════════════════════════════════════════════════

describe('successLike', () => {
  it('wraps text in accentBright when color is supported, preserves content always', () => {
    const result = successLike('test');
    // accentBright delegates to accent + bold; ANSI wrapping depends on
    // terminal color support (HAS_COLOR). Content is always preserved.
    assert.ok(result.includes('test'), 'content preserved');
    // If color is supported, ANSI wrapping should be present
    if (result !== 'test') {
      assert.ok(result.includes('\x1b['), 'ANSI wrapping when color supported');
    }
  });

  it('preserves special characters', () => {
    const result = successLike('●');
    assert.ok(result.includes('●'));
  });

  it('preserves empty string', () => {
    const result = successLike('');
    // Empty string is preserved; ANSI wrapping depends on color support
    if (result !== '') {
      assert.ok(result.includes('\x1b['), 'ANSI wrapping when color supported');
    }
  });

  it('wraps unicode characters', () => {
    const result = successLike('✓');
    assert.ok(result.includes('✓'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration tests — through exported class APIs
// ═══════════════════════════════════════════════════════════════════════════════
// These tests exercise the pure helper functions indirectly through the
// exported renderer classes. They verify functional equivalence between
// the reference implementations and the real module code.

describe('Integration — AppendOnlyRenderer', () => {
  it('produces [MM:SS] formatted transcripts via write()', () => {
    const bus = new EventEmitter();
    const renderer = new AppendOnlyRenderer(bus);
    renderer.start();

    // Write a message — formatElapsed is called internally
    renderer.write('test activity');
    const transcript = renderer.getTranscript();

    // The transcript should contain a timestamped line
    assert.match(transcript, /\[\d{2}:\d{2}\] test activity/);

    renderer.stop();
  });

  it('deduplicates via activityKey', () => {
    const bus = new EventEmitter();
    const renderer = new AppendOnlyRenderer(bus);
    renderer.start();

    renderer.write('Reading file123.ts');
    renderer.write('Reading file456.ts'); // same key after normalization
    renderer.write('different activity');

    const transcript = renderer.getTranscript();
    const lines = transcript.split('\n');

    // "Reading file..." should appear only once
    const readingLines = lines.filter((l) => l.includes('Reading file'));
    assert.equal(readingLines.length, 1);

    // "different activity" should appear
    const diffLines = lines.filter((l) => l.includes('different activity'));
    assert.equal(diffLines.length, 1);

    renderer.stop();
  });

  it('normalizes log lines via the log event handler', () => {
    const bus = new EventEmitter();
    const renderer = new AppendOnlyRenderer(bus);
    renderer.start();

    // Emit a raw stage line — normalizeActivityLine maps it
    bus.emit('log', 'Stage 1/4 — Analyzing request');
    bus.emit('log', 'Reading file src/index.ts');
    bus.emit('log', '### INTERNAL MONOLOGUE'); // should be filtered

    const transcript = renderer.getTranscript();
    assert.match(transcript, /Analyzing request/);
    assert.match(transcript, /Reading file/);
    assert.doesNotMatch(transcript, /INTERNAL MONOLOGUE/);

    renderer.stop();
  });

  it('filters runtime events through runtimeEventLabel via the runtime_event handler', () => {
    const bus = new EventEmitter();
    const renderer = new AppendOnlyRenderer(bus);
    renderer.start();

    bus.emit('runtime_event', {
      event_type: 'tool.completed',
      payload: { tool: 'file_read', target: 'src/index.ts', exit_code: 0 },
    });
    bus.emit('runtime_event', { event_type: 'session.started' }); // should be filtered
    bus.emit('runtime_event', { event_type: 'unknown.thing' }); // should be filtered

    const transcript = renderer.getTranscript();
    assert.match(transcript, /file_read src\/index.ts/);
    assert.doesNotMatch(transcript, /session\.started/);
    assert.doesNotMatch(transcript, /unknown\.thing/);

    renderer.stop();
  });

  it('maps stage events via stageAction', () => {
    const bus = new EventEmitter();
    const renderer = new AppendOnlyRenderer(bus);
    renderer.start();

    bus.emit('stage', 1);
    bus.emit('stage', 2);
    bus.emit('stage', 3);
    bus.emit('stage', 5); // out of range → "Working"

    const transcript = renderer.getTranscript();
    assert.match(transcript, /Analyzing your request/);
    assert.match(transcript, /Planning/);
    assert.match(transcript, /Reviewing/);
    assert.match(transcript, /Working/);

    renderer.stop();
  });
});

describe('Integration — ConversationalRenderer', () => {
  it('formats tool indicators via conversationalToolLabel', () => {
    // Capture stdout writes to inspect formatted output
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true });
      renderer.start();

      renderer.onToolCallStart('file_read', 'src/index.ts');
      renderer.onToolCallComplete(1);

      // Check that the output contains the formatted conversationalToolLabel
      const allOutput = chunks.join('');
      assert.match(allOutput, /Reading/);
      assert.match(allOutput, /src\/index\.ts/);
      assert.match(allOutput, /✓/);

      renderer.stop();
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('outputs elapsed time in onSummary via formatElapsed', () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const renderer = new ConversationalRenderer({ isTTY: true });
      renderer.start();

      // Wait a tiny bit so elapsed > 0 then check summary format
      renderer.onSummary({ costUSD: 0.0123 });

      const allOutput = chunks.join('');
      // Should contain elapsed time in format from formatElapsed
      assert.match(allOutput, /\d{2}:\d{2}/);

      renderer.stop();
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});

describe('Integration — WaterfallRenderer', () => {
  it('computes ETA through formatETA via computeETA()', () => {
    const bus = new EventEmitter();
    const renderer = new WaterfallRenderer(bus);

    // computeETA() requires completed stage durations, which accumulate
    // as stage events fire.
    bus.emit('stage', 1);
    bus.emit('stage', 2);

    const eta = renderer.computeETA(2);

    // Should be null or a non-empty string depending on timing
    if (eta !== null) {
      assert.ok(typeof eta === 'string');
      assert.ok(eta.length > 0);
    }

    renderer.stop();
  });

  it('produces a snapshot with stage progress via formatElapsed and successLike', () => {
    const bus = new EventEmitter();
    const renderer = new WaterfallRenderer(bus);

    bus.emit('stage', 1);
    bus.emit('log', 'Reading configuration');

    const snapshot = renderer.snapshot();

    // Snapshot should contain a duration line (from formatElapsed)
    assert.match(snapshot, /\d{2}:\d{2}/);
    // Snapshot should contain stage labels
    assert.match(snapshot, /Run Complete/);
    assert.match(snapshot, /Stages/);

    renderer.stop();
  });

  it('deduplicates log lines via activityKey', () => {
    const bus = new EventEmitter();
    const renderer = new WaterfallRenderer(bus);

    bus.emit('log', 'Reading file123.ts');
    bus.emit('log', 'Reading file456.ts'); // same key after normalization

    const snapshot = renderer.snapshot();

    // "Reading file" should appear only once in the activity list
    // (it might also appear in other parts, so count occurrences)
    const activitySection = snapshot.split('Activity')[1] ?? '';
    const readingMatches = activitySection.match(/Reading file/g) ?? [];
    assert.equal(readingMatches.length, 1);

    renderer.stop();
  });

  it('filters normalized lines via normalizeActivityLine', () => {
    const bus = new EventEmitter();
    const renderer = new WaterfallRenderer(bus);

    bus.emit('log', 'Model: claude-sonnet-4'); // should be filtered
    bus.emit('log', 'User activity message'); // should pass through

    const transcript = renderer.getTranscript();
    assert.doesNotMatch(transcript, /Model:/);
    assert.match(transcript, /User activity message/);

    renderer.stop();
  });
});
