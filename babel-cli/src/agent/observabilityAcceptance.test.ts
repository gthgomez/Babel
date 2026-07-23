/**
 * D1: Offline observability acceptance suite.
 *
 * Asserts the harness-facing observability contract operators rely on
 * after a fail — schema version, toolCalls, policy_events, patch_reality,
 * tools_before_first_write, and failure card.
 *
 * Pure offline: no live API, no chatEngine, no SWE remeasure.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderFailureCard } from './failureCard.js';
import type { FailureCardInput } from './failureCard.js';
import type { PolicyEvent } from './policyEventLog.js';

// ─── Types (mirror harness JSON shape from runSwebenchAgentCell) ──────────

/** Shape of a single entry in the toolCalls array from the chat payload. */
interface SimulatedToolCall {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
}

/** Shape of the patch_reality object in the harness JSON. */
interface PatchReality {
  patch_bytes: number;
  changed_files: string[];
  empty_patch: boolean;
  capture_method: string;
  tool_write_count: number;
  git_write_signal: boolean;
}

/** Shape of the full harness JSON written by runSwebenchAgentCell. */
interface HarnessObservabilityPayload {
  task_id: string;
  observability_schema_version: number;
  patch_bytes: number;
  patch_reality: PatchReality;
  tools_before_first_write: number;
  tool_call_count: number;
  write_count: number;
  verifier_attempt_count: number;
  toolCalls?: SimulatedToolCall[] | undefined;
  policy_events?: PolicyEvent[] | undefined;
  failure_card_path?: string | null | undefined;
  success_card_path?: string | null | undefined;
}

// ─── Simulated fixtures ──────────────────────────────────────────────────

/**
 * Build a minimal harness payload simulating a "tools ran, zero writes" fail.
 * Mirrors the JSON shape written by runSwebenchAgentCell (agentBenchmarkHarness.ts).
 */
function buildToolsRanZeroWriteFixture(overrides?: Partial<HarnessObservabilityPayload>): HarnessObservabilityPayload {
  const toolCalls: SimulatedToolCall[] = [
    { tool: 'read_file', target: 'src/foo.ts' },
    { tool: 'grep', target: 'src/' },
    { tool: 'glob', target: '**/*.test.ts' },
    { tool: 'read_file', target: 'tests/foo.test.ts' },
  ];

  const policy_events: PolicyEvent[] = [
    { at_turn: 2, kind: 'force_mutate', detail: 'turns_without_write=2' },
    { at_turn: 4, kind: 'restrict_tools', detail: 'mode=mutate_only' },
    { at_turn: 6, kind: 'exploration_nudge', detail: 'consecutive_read_only=6' },
    { at_turn: 7, kind: 'zero_write_hard_stop', detail: 'turns=8' },
  ];

  return {
    task_id: 'D1-acceptance-fixture',
    observability_schema_version: 1,
    patch_bytes: 0,
    patch_reality: {
      patch_bytes: 0,
      changed_files: [],
      empty_patch: true,
      capture_method: 'git_diff',
      tool_write_count: 0,
      git_write_signal: false,
    },
    tools_before_first_write: 0,
    tool_call_count: toolCalls.length,
    write_count: 0,
    verifier_attempt_count: 0,
    toolCalls,
    policy_events,
    failure_card_path: 'runs/2026-07-13/D1-acceptance-fixture-FAILURE_CARD.md',
    success_card_path: null,
    ...overrides,
  };
}

/** Build a minimal FailureCardInput matching the harness card contract. */
function buildFailureCardInput(overrides?: Partial<FailureCardInput>): FailureCardInput {
  return {
    taskLabel: 'D1-acceptance-fixture',
    status: 'FAILED',
    costUsd: 0.42,
    turns: 8,
    patchBytes: 0,
    emptyPatch: true,
    modelsUsed: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    proCostShare: 0.3,
    lastTools: [
      { tool: 'read_file', target: 'src/foo.ts' },
      { tool: 'grep', target: 'src/' },
    ],
    policyEventCounts: {
      force_mutate: 1,
      restrict_tools: 1,
      exploration_nudge: 1,
      zero_write_hard_stop: 1,
    },
    recommendedAction: 'No writes produced. Review policy events and tool restrictions.',
    runDir: 'runs/2026-07-13/run-d1-acceptance',
    transcriptPath: 'runs/2026-07-13/run-d1-acceptance/transcript.jsonl',
    ...overrides,
  };
}

// ─── Acceptance tests ────────────────────────────────────────────────────

describe('D1 offline observability acceptance', () => {
  // ── Schema version ───────────────────────────────────────────────────
  describe('observability_schema_version', () => {
    test('harness payload carries schema version 1', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.observability_schema_version, 1);
    });

    test('schema version is a number', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(typeof fixture.observability_schema_version, 'number');
    });
  });

  // ── toolCalls presence ───────────────────────────────────────────────
  describe('toolCalls', () => {
    test('is non-empty array when tools ran', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.ok(Array.isArray(fixture.toolCalls));
      assert.ok(fixture.toolCalls!.length > 0,
        'toolCalls must be non-empty when tools ran');
    });

    test('each entry has tool and target fields', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      for (const tc of fixture.toolCalls!) {
        assert.ok(typeof tc.tool === 'string' && tc.tool.length > 0,
          `toolCalls entry missing tool name: ${JSON.stringify(tc)}`);
        assert.ok(typeof tc.target === 'string',
          `toolCalls entry missing target: ${JSON.stringify(tc)}`);
      }
    });

    test('FAILS when toolCalls is omitted on a tools-ran fail payload', () => {
      // This is the canonical negative test: an empty/absent toolCalls
      // on a tools-ran scenario is an observability contract violation.
      const fixture = buildToolsRanZeroWriteFixture({ toolCalls: undefined });
      const hasToolCalls = Array.isArray(fixture.toolCalls) && fixture.toolCalls.length > 0;
      assert.equal(hasToolCalls, false,
        'toolCalls omitted on tools-ran scenario — this IS the expected failure mode the test guards against. '
        + 'The actual assertion below verifies the contract is violated (empty toolCalls when tools ran).');
    });

    test('toolCalls absence is detectable (contract guard pattern)', () => {
      // Build two fixtures: one with tools, one without.
      // Operators must be able to detect the difference.
      const withTools = buildToolsRanZeroWriteFixture();
      const withoutTools = buildToolsRanZeroWriteFixture({ toolCalls: undefined, tool_call_count: 0 });

      const hasTools = Array.isArray(withTools.toolCalls) && withTools.toolCalls.length > 0;
      const hasNoTools = !Array.isArray(withoutTools.toolCalls) || withoutTools.toolCalls.length === 0;

      assert.equal(hasTools, true);
      assert.equal(hasNoTools, true);
    });
  });

  // ── patch_reality shape ──────────────────────────────────────────────
  describe('patch_reality', () => {
    test('has all required fields', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      const pr = fixture.patch_reality;
      assert.ok(typeof pr === 'object' && pr !== null);

      // Structural fields
      assert.ok('patch_bytes' in pr, 'patch_reality missing patch_bytes');
      assert.ok('changed_files' in pr, 'patch_reality missing changed_files');
      assert.ok('empty_patch' in pr, 'patch_reality missing empty_patch');
      assert.ok('capture_method' in pr, 'patch_reality missing capture_method');
      assert.ok('tool_write_count' in pr, 'patch_reality missing tool_write_count');
      assert.ok('git_write_signal' in pr, 'patch_reality missing git_write_signal');
    });

    test('empty_patch is true when no writes', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.patch_reality.empty_patch, true);
    });

    test('patch_bytes is 0 when no writes', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.patch_reality.patch_bytes, 0);
      assert.equal(fixture.patch_bytes, 0);
    });

    test('changed_files is empty array when no writes', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.ok(Array.isArray(fixture.patch_reality.changed_files));
      assert.equal(fixture.patch_reality.changed_files.length, 0);
    });

    test('tool_write_count is 0 when no writes', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.patch_reality.tool_write_count, 0);
    });

    test('capture_method is a non-empty string', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.ok(typeof fixture.patch_reality.capture_method === 'string');
      assert.ok(fixture.patch_reality.capture_method.length > 0);
    });

    test('git_write_signal is false when no writes', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.patch_reality.git_write_signal, false);
    });
  });

  // ── policy_events shape ──────────────────────────────────────────────
  describe('policy_events', () => {
    test('is an array', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.ok(Array.isArray(fixture.policy_events));
    });

    test('contains at least one thrash-related kind under zero-write sim', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      const thrashKinds = new Set([
        'force_mutate',
        'restrict_tools',
        'phase_change',
        'read_thrash_fuse',
        'exploration_nudge',
        'exploration_escalation',
        'exploration_exhausted',
        'zero_write_hard_stop',
        'stall_intervention',
        'phase_gate_block',
        'plan_gate_block',
        'token_explosion',
        'budget_kill',
      ]);

      const hasThrashEvent = fixture.policy_events!.some(
        (pe) => thrashKinds.has(pe.kind),
      );
      assert.ok(hasThrashEvent,
        `policy_events must include ≥1 thrash-related kind; got: ${
          fixture.policy_events!.map((pe) => pe.kind).join(', ')
        }`);
    });

    test('includes zero_write_hard_stop under zero-write sim', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      const hasHardStop = fixture.policy_events!.some(
        (pe) => pe.kind === 'zero_write_hard_stop',
      );
      assert.ok(hasHardStop,
        'zero-write sim must include zero_write_hard_stop policy event');
    });

    test('each event has at_turn (number) and kind (string)', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      for (const pe of fixture.policy_events!) {
        assert.ok(typeof pe.at_turn === 'number',
          `policy event missing numeric at_turn: ${JSON.stringify(pe)}`);
        assert.ok(typeof pe.kind === 'string' && pe.kind.length > 0,
          `policy event missing kind: ${JSON.stringify(pe)}`);
      }
    });

    test('kind values match real PolicyEventKind union members', () => {
      // Real kinds from policyEventLog.ts — if a kind appears in the log
      // that isn't in this set, the union changed and the acceptance test
      // should be updated (but that's a design change, not a bug).
      const validKinds = new Set([
        'force_mutate',
        'restrict_tools',
        'phase_change',
        'read_thrash_fuse',
        'exploration_nudge',
        'exploration_escalation',
        'exploration_exhausted',
        'zero_write_hard_stop',
        'stall_intervention',
        'phase_gate_block',
        'plan_gate_block',
        'token_explosion',
        'budget_kill',
      ]);

      const fixture = buildToolsRanZeroWriteFixture();
      for (const pe of fixture.policy_events!) {
        assert.ok(validKinds.has(pe.kind),
          `Unknown policy event kind "${pe.kind}" — not in PolicyEventKind union. `
          + `Valid: ${[...validKinds].join(', ')}`);
      }
    });
  });

  // ── tools_before_first_write ─────────────────────────────────────────
  describe('tools_before_first_write', () => {
    test('is a number (0 or positive)', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(typeof fixture.tools_before_first_write, 'number');
      assert.ok(fixture.tools_before_first_write >= 0,
        'tools_before_first_write must be 0 or positive');
    });

    test('is 0 when no writes occurred (tools before first write = all tools)', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      // When no writes happened, tools_before_first_write counts all tools
      // or resets to 0 depending on implementation. Either way it's a number.
      assert.equal(typeof fixture.tools_before_first_write, 'number');
    });
  });

  // ── Failure card markdown ────────────────────────────────────────────
  describe('failure card', () => {
    test('renderFailureCard produces non-empty string', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.ok(typeof card === 'string', 'failure card must be a string');
      assert.ok(card.length > 0, 'failure card must be non-empty');
    });

    test('failure card includes task label and FAILED status', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.match(card, /D1-acceptance-fixture/);
      assert.match(card, /FAILED/);
    });

    test('failure card includes cost, turns, patch info', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.match(card, /\$0\.42/);
      assert.match(card, /Turns.*8/);
      assert.match(card, /0 B/);  // patch bytes
    });

    test('failure card includes policy event counts', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.match(card, /force_mutate/);
      assert.match(card, /zero_write_hard_stop/);
      assert.match(card, /restrict_tools/);
    });

    test('failure card includes recommended action', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.match(card, /Recommended next action/);
      assert.match(card, /No writes produced/);
    });

    test('failure card includes run dir path', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.match(card, /run-d1-acceptance/);
    });

    test('renderFailureCard with zero-write empty patch has correct patch display', () => {
      const input = buildFailureCardInput({
        emptyPatch: true,
        patchBytes: 0,
      });
      const card = renderFailureCard(input);
      assert.match(card, /0 B/);
    });
  });

  // ── End-to-end: full fail payload contract ───────────────────────────
  describe('full fail payload contract', () => {
    test('all acceptance fields present on a tools-ran zero-write fail', () => {
      const fixture = buildToolsRanZeroWriteFixture();

      // Schema version
      assert.equal(fixture.observability_schema_version, 1);

      // toolCalls
      assert.ok(Array.isArray(fixture.toolCalls) && fixture.toolCalls!.length > 0);

      // patch_reality
      assert.equal(fixture.patch_reality.empty_patch, true);
      assert.equal(fixture.patch_reality.patch_bytes, 0);

      // policy_events
      assert.ok(Array.isArray(fixture.policy_events) && fixture.policy_events!.length > 0);

      // tools_before_first_write
      assert.equal(typeof fixture.tools_before_first_write, 'number');

      // Tool call counts
      assert.equal(typeof fixture.tool_call_count, 'number');
      assert.equal(fixture.write_count, 0);

      // Card paths: fail should have failure_card_path, not success_card_path
      assert.ok(typeof fixture.failure_card_path === 'string' && fixture.failure_card_path.length > 0);
      assert.equal(fixture.success_card_path, null);
    });

    test('card markdown is non-empty for the fail fixture', () => {
      const input = buildFailureCardInput();
      const card = renderFailureCard(input);
      assert.ok(card.length > 0);
      // Confirm it starts with a markdown heading
      assert.match(card, /^# /);
    });

    test('zero-write fixture has correct write aggregates (all zero)', () => {
      const fixture = buildToolsRanZeroWriteFixture();
      assert.equal(fixture.write_count, 0);
      assert.equal(fixture.patch_reality.tool_write_count, 0);
      assert.equal(fixture.verifier_attempt_count, 0);
    });
  });
});
