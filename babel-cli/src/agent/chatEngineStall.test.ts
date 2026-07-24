/**
 * Tests for stall detector and phase nudge utilities (P2).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createStallDetector, updateStallState, isStalled, escalateStallIntervention, getStallInterventionMessage } from './stallDetector.js';
import type { StallIntervention } from './stallDetector.js';
import { classifyPhase, buildPhaseNudge, shouldNudge } from './chatPhaseNudge.js';
import type { ChatPhase } from './chatPhaseNudge.js';

// ─── Stall Detector Tests ────────────────────────────────────────────────────

describe('createStallDetector', () => {
  test('returns zeroed initial state', () => {
    const s = createStallDetector();
    assert.equal(s.turnsSinceLastWrite, 0);
    assert.equal(s.turnsSinceNewFileRead, 0);
    assert.deepEqual(s.lastReadTargets, []);
    assert.equal(s.lastWriteTurn, -1);
    assert.equal(s.lastVerifierTurn, -1);
  });
});

describe('updateStallState', () => {
  test('resets turnsSinceLastWrite on write_file', () => {
    let s = createStallDetector();
    // Simulate 3 turns of reads
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(s, [{ tool: 'grep', target: 'pattern' }], 1);
    assert.equal(s.turnsSinceLastWrite, 2);
    // Now a write
    s = updateStallState(s, [{ tool: 'write_file', target: 'src/a.ts' }], 2);
    assert.equal(s.turnsSinceLastWrite, 0);
    assert.equal(s.lastWriteTurn, 2);
  });

  // Preferred edit tool must reset stall write progress
  test('resets turnsSinceLastWrite on str_replace', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/b.ts' }], 1);
    assert.equal(s.turnsSinceLastWrite, 2);
    s = updateStallState(s, [{ tool: 'str_replace', target: 'src/a.ts' }], 2);
    assert.equal(s.turnsSinceLastWrite, 0);
    assert.equal(s.lastWriteTurn, 2);
    assert.equal(s.totalWrites, 1);
  });

  // Bug A: blocked/failed mutations must NOT count as writes
  test('blocked str_replace does NOT reset turnsSinceLastWrite', () => {
    let s = createStallDetector();
    // Simulate 2 turns of reads
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/b.ts' }], 1);
    assert.equal(s.turnsSinceLastWrite, 2);
    // Blocked str_replace (phase-gate or plan-gate) — must NOT count
    s = updateStallState(
      s,
      [{ tool: 'str_replace', target: 'src/a.ts', error: 'blocked' }],
      2,
    );
    assert.equal(s.turnsSinceLastWrite, 3, 'blocked mutation should not reset write counter');
    assert.equal(s.totalWrites, 0, 'blocked mutation should not increment totalWrites');
    assert.equal(s.lastWriteTurn, -1);
  });

  test('failed str_replace does NOT count as write', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(
      s,
      [{ tool: 'str_replace', target: 'src/b.ts', error: 'str_replace: old_str not found' }],
      1,
    );
    assert.equal(s.turnsSinceLastWrite, 2, 'failed mutation should not reset write counter');
    assert.equal(s.totalWrites, 0);
  });

  test('phase can reach mutate without successful writes after 2 read-only turns', () => {
    let s = createStallDetector();
    // Turn 0: read
    s = updateStallState(s, [{ tool: 'grep', target: 'pattern' }], 0);
    // Turn 1: blocked str_replace
    s = updateStallState(
      s,
      [{ tool: 'str_replace', target: 'src/a.ts', error: 'blocked' }],
      1,
    );
    // Turn 2: read
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/b.ts' }], 2);
    // turnsSinceLastWrite should be 3 (not reset by blocked mutation)
    assert.equal(s.turnsSinceLastWrite, 3);
    // Phase should be mutate (≥2)
    assert.equal(classifyPhase(s, false, false), 'mutate');
  });

  test('resets turnsSinceNewFileRead on new file', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 1);
    assert.equal(s.turnsSinceNewFileRead, 1); // same file, no reset
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/b.ts' }], 2);
    assert.equal(s.turnsSinceNewFileRead, 0); // new file, reset
  });

  test('does not stamp lastVerifierTurn on shell before any write', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'test_run', target: 'npm test' }], 0);
    assert.equal(s.lastVerifierTurn, -1, 'test_run without writes is not a phase verifier');
    s = updateStallState(s, [{ tool: 'run_command', target: 'pytest' }], 1);
    assert.equal(s.lastVerifierTurn, -1, 'run_command without writes is not a phase verifier');
  });

  test('stamps lastVerifierTurn on shell only after a successful write', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'str_replace', target: 'src/a.ts' }], 0);
    assert.equal(s.totalWrites, 1);
    s = updateStallState(s, [{ tool: 'run_command', target: 'pytest' }], 1);
    assert.equal(s.lastVerifierTurn, 1);
    s = updateStallState(s, [{ tool: 'test_run', target: 'npm test' }], 2);
    assert.equal(s.lastVerifierTurn, 2);
  });

  test('stamps lastVerifierTurn when write and shell share the same turn', () => {
    let s = createStallDetector();
    s = updateStallState(
      s,
      [
        { tool: 'str_replace', target: 'src/a.ts' },
        { tool: 'run_command', target: 'pytest path' },
      ],
      0,
    );
    assert.equal(s.lastVerifierTurn, 0);
    assert.equal(s.totalWrites, 1);
  });

  test('maintains sliding window of read targets', () => {
    let s = createStallDetector();
    for (let i = 0; i < 15; i++) {
      s = updateStallState(s, [{ tool: 'read_file', target: `src/f${i}.ts` }], i);
    }
    // Should keep only last 12
    assert.ok(s.lastReadTargets.length <= 12);
    assert.ok(s.lastReadTargets.includes('src/f14.ts'));
    assert.ok(!s.lastReadTargets.includes('src/f0.ts'));
  });
});

describe('isStalled', () => {
  test('false when writes are happening', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'write_file', target: 'src/a.ts' }], 0);
    assert.equal(isStalled(s, 3), false);
  });

  test('false when new files are being read', () => {
    let s = createStallDetector();
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/a.ts' }], 0);
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/b.ts' }], 1);
    s = updateStallState(s, [{ tool: 'read_file', target: 'src/c.ts' }], 2);
    assert.equal(isStalled(s, 3), false); // turnsSinceNewFileRead is 0
  });

  test('true when stuck reading same file for N turns', () => {
    let s = createStallDetector();
    s.turnsSinceLastWrite = 5;
    s.turnsSinceNewFileRead = 5;
    s.totalToolCalls = 10; // past grace period (MIN_TURNS_BEFORE_STALL = 3)
    s.lastReadTargets = ['src/a.ts', 'src/a.ts', 'src/a.ts'];
    assert.equal(isStalled(s, 3), true);
  });

  test('false when lastReadTargets has fewer than 3 entries', () => {
    let s = createStallDetector();
    s.turnsSinceLastWrite = 5;
    s.turnsSinceNewFileRead = 5;
    s.lastReadTargets = ['src/a.ts', 'src/a.ts'];
    assert.equal(isStalled(s, 3), false);
  });

  test('false when turnsSinceLastWrite is under threshold', () => {
    let s = createStallDetector();
    s.turnsSinceLastWrite = 2; // under threshold of 3
    s.turnsSinceNewFileRead = 5;
    s.lastReadTargets = ['src/a.ts', 'src/a.ts', 'src/a.ts'];
    assert.equal(isStalled(s, 3), false);
  });
});

// ─── Phase Classification Tests ──────────────────────────────────────────────

describe('classifyPhase', () => {
  const baseState = createStallDetector();

  test('returns investigate for early turns with reads', () => {
    const s = { ...baseState, turnsSinceLastWrite: 0 };
    assert.equal(classifyPhase(s, false, false), 'investigate');
  });

  test('returns mutate after 2+ turns without write', () => {
    const s = { ...baseState, turnsSinceLastWrite: 2 };
    assert.equal(classifyPhase(s, false, false), 'mutate');
  });

  test('returns escalate after 4+ turns without write', () => {
    const s = { ...baseState, turnsSinceLastWrite: 4 };
    assert.equal(classifyPhase(s, false, false), 'escalate');
  });

  test('returns verify when writes exist but no verifier', () => {
    const s = { ...baseState, turnsSinceLastWrite: 0 };
    assert.equal(classifyPhase(s, true, false), 'verify');
  });

  test('returns verify when writes exist and verifier already run', () => {
    const s = { ...baseState, turnsSinceLastWrite: 0 };
    assert.equal(classifyPhase(s, true, true), 'verify');
  });

  test('shell-only hasVerifier does not force verify without writes', () => {
    const s = { ...baseState, turnsSinceLastWrite: 1 };
    assert.equal(classifyPhase(s, false, true), 'investigate');
  });
});

// ─── Phase Nudge Tests ───────────────────────────────────────────────────────

describe('buildPhaseNudge', () => {
  test('investigate nudge mentions files', () => {
    const nudge = buildPhaseNudge('investigate', ['src/a.ts', 'src/b.ts']);
    assert.ok(nudge.includes('Investigate'));
    assert.ok(nudge.includes('src/a.ts'));
    assert.ok(nudge.includes('src/b.ts'));
  });

  test('mutate nudge tells model to write', () => {
    const nudge = buildPhaseNudge('mutate', ['src/a.ts']);
    assert.ok(nudge.includes('write_file'));
    assert.ok(nudge.includes('Do not read more files'));
  });

  test('verify nudge tells model to run tests', () => {
    const nudge = buildPhaseNudge('verify', ['src/a.ts']);
    assert.ok(nudge.includes('verifier'));
    assert.ok(nudge.includes('test_run'));
  });

  test('escalate nudge is forceful', () => {
    const nudge = buildPhaseNudge('escalate', ['src/a.ts']);
    assert.ok(nudge.includes('NOW'));
    assert.ok(nudge.includes('write_file'));
  });

  test('handles empty file hints', () => {
    const nudge = buildPhaseNudge('mutate', []);
    assert.ok(nudge.includes('write_file'));
    // Should fall back to generic file reference
  });
});

describe('shouldNudge', () => {
  test('true for mutate, escalate, verify', () => {
    assert.equal(shouldNudge('mutate'), true);
    assert.equal(shouldNudge('escalate'), true);
    assert.equal(shouldNudge('verify'), true);
  });

  test('false for investigate', () => {
    assert.equal(shouldNudge('investigate'), false);
  });
});

// ─── R2: Escalating Stall Intervention Tests ──────────────────────────────────

describe('escalateStallIntervention', () => {
  test('first stall returns nudge', () => {
    const state = createStallDetector();
    const intervention = escalateStallIntervention(state, []);
    assert.equal(intervention.level, 'nudge');
    assert.ok(intervention.message.includes('writing files'));
    assert.ok(intervention.message.includes('BLOCKED'));
  });

  test('second stall returns restrict_tools', () => {
    const state = createStallDetector();
    const intervention = escalateStallIntervention(state, [
      { level: 'nudge', message: 'prior nudge' },
    ]);
    assert.equal(intervention.level, 'restrict_tools');
    assert.ok(intervention.message.includes('Stop reading'));
    assert.ok(intervention.message.includes('BLOCKED'));
  });

  test('third stall returns force_status', () => {
    const state = createStallDetector();
    const intervention = escalateStallIntervention(state, [
      { level: 'nudge', message: 'nudge 1' },
      { level: 'restrict_tools', message: 'restrict' },
    ]);
    assert.equal(intervention.level, 'force_status');
    assert.ok(intervention.message.includes('DONE') || intervention.message.includes('BLOCKED'));
    assert.ok(intervention.message.includes('NEED:'));
  });

  test('fourth stall returns kill', () => {
    const state = createStallDetector();
    const intervention = escalateStallIntervention(state, [
      { level: 'nudge', message: 'nudge 1' },
      { level: 'restrict_tools', message: 'restrict' },
      { level: 'force_status', message: 'force' },
    ]);
    assert.equal(intervention.level, 'kill');
    assert.ok(intervention.message.includes('terminated'));
  });
});

describe('getStallInterventionMessage', () => {
  test('returns null when not stalled', () => {
    const state = createStallDetector();
    state.totalToolCalls = 10;
    state.turnsSinceLastWrite = 1;
    state.turnsSinceNewFileRead = 1;
    const result = getStallInterventionMessage(state, 8);
    assert.equal(result, null);
  });

  test('returns intervention when stalled', () => {
    const state = createStallDetector();
    state.totalToolCalls = 10;
    state.turnsSinceLastWrite = 9;
    state.turnsSinceNewFileRead = 9;
    state.lastReadTargets = ['src/a.ts', 'src/a.ts', 'src/a.ts'];
    const result = getStallInterventionMessage(state, 3);
    assert.ok(result !== null);
    assert.equal(result!.level, 'nudge');
  });

  test('escalates from prior intervention level', () => {
    const state = createStallDetector();
    state.interventionLevel = 1;
    state.interventionHistory = ['Prior nudge message'];
    state.totalToolCalls = 10;
    state.turnsSinceLastWrite = 9;
    state.turnsSinceNewFileRead = 9;
    state.lastReadTargets = ['src/a.ts', 'src/a.ts', 'src/a.ts'];
    const result = getStallInterventionMessage(state, 3);
    assert.ok(result !== null);
    assert.equal(result!.level, 'restrict_tools');
  });

  test('creates detector with zero intervention level', () => {
    const state = createStallDetector();
    assert.equal(state.interventionLevel, 0);
    assert.deepEqual(state.interventionHistory, []);
  });
});

// ─── Restricted Tool Definitions ──────────────────────────────────────

import { buildChatToolDefinitions, buildRestrictedChatToolDefinitions } from './chatToolDefinitions.js';

describe('buildRestrictedChatToolDefinitions', () => {
  test('returns subset of full tool definitions', () => {
    const full = buildChatToolDefinitions();
    const restricted = buildRestrictedChatToolDefinitions();
    assert.ok(restricted.length < full.length, 'restricted set should be smaller than full set');
    assert.ok(restricted.length > 0, 'restricted set should not be empty');
  });

  test('includes mutation tools', () => {
    const restricted = buildRestrictedChatToolDefinitions();
    const names = restricted.map((d) => d.function.name);
    assert.ok(names.includes('write_file'), 'should include write_file');
    assert.ok(names.includes('str_replace'), 'should include str_replace');
    assert.ok(names.includes('apply_patch'), 'should include apply_patch');
  });

  test('mutate_only default excludes shell thrash tools', () => {
    const restricted = buildRestrictedChatToolDefinitions(); // default mutate_only
    const names = new Set(restricted.map((d) => d.function.name));
    assert.ok(!names.has('run_command'), 'mutate_only must NOT include run_command');
    assert.ok(!names.has('await_command'), 'mutate_only must NOT include await_command');
    assert.ok(!names.has('test_run'), 'mutate_only must NOT include test_run');
  });

  test('act_or_verify includes verifier/execution tools', () => {
    const restricted = buildRestrictedChatToolDefinitions('act_or_verify');
    const names = restricted.map((d) => d.function.name);
    assert.ok(names.includes('run_command'), 'should include run_command');
    assert.ok(names.includes('await_command'), 'should include await_command (T2.2)');
    assert.ok(names.includes('test_run'), 'should include test_run');
  });

  test('includes planning and completion tools', () => {
    const restricted = buildRestrictedChatToolDefinitions();
    const names = restricted.map((d) => d.function.name);
    assert.ok(names.includes('todo_write'), 'should include todo_write');
    assert.ok(names.includes('finish'), 'should include finish');
  });

  test('excludes exploration/read tools', () => {
    const restricted = buildRestrictedChatToolDefinitions();
    const names = new Set(restricted.map((d) => d.function.name));
    assert.ok(!names.has('read_file'), 'should NOT include read_file');
    assert.ok(!names.has('read_range'), 'should NOT include read_range');
    assert.ok(!names.has('list_dir'), 'should NOT include list_dir');
    assert.ok(!names.has('grep'), 'should NOT include grep');
    assert.ok(!names.has('glob'), 'should NOT include glob');
    assert.ok(!names.has('semantic_search'), 'should NOT include semantic_search');
    assert.ok(!names.has('git_context'), 'should NOT include git_context');
    assert.ok(!names.has('web_search'), 'should NOT include web_search');
    assert.ok(!names.has('web_fetch'), 'should NOT include web_fetch');
    assert.ok(!names.has('sub_agent'), 'should NOT include sub_agent');
    assert.ok(!names.has('mcp_tool_search'), 'should NOT include mcp_tool_search');
    assert.ok(!names.has('mcp_request'), 'should NOT include mcp_request');
  });

  test('mutate_only set contains exactly 5 tools', () => {
    // write_file, str_replace, apply_patch, todo_write, finish
    const restricted = buildRestrictedChatToolDefinitions('mutate_only');
    assert.equal(restricted.length, 5);
  });

  test('act_or_verify set contains exactly 8 tools', () => {
    // + run_command, await_command, test_run
    const restricted = buildRestrictedChatToolDefinitions('act_or_verify');
    assert.equal(restricted.length, 8);
  });
});
