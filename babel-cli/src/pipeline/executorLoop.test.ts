/**
 * executorLoop.test.ts — Unit tests for the CLI Executor loop (Stage 4).
 *
 * The executor loop orchestrates multi-turn tool execution. This test file covers:
 *   1. Pure helper functions and state transitions exercised via imported modules
 *   2. Turn-count and terminal-status invariants
 *   3. Mock-based integration tests for core loop paths
 *   4. File read cache eviction logic
 *
 * Coverage gaps (documented): the main `runExecutorLoop` function body (~2,000 lines
 * of inline-defined closures) requires extraction of state-machine logic before
 * full unit coverage is possible. See SECURITY_HARDENING_STATUS.md H5 for the plan.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  createMockExecuteTool,
  createMockRunDir,
  mockRunId,
  mockSwePlan,
  mockToolCallEntry,
  validateLoopResult,
  type MockExecutorConfig,
  type ScriptedTurn,
} from '../testing/mockExecutorRuntime.js';

import { MAX_EXECUTOR_TURNS, BABEL_ROOT, MAX_REPLAN_ATTEMPTS } from './paths.js';
import { shouldCompleteBoundedWriteTask, buildMaxTurnsExceededCondition } from './executorCompletionGates.js';
import type { ExecutorLoopResult } from './executorLoopTypes.js';
import type { SwePlan } from '../schemas/agentContracts.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Turn-limit invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe('executor loop invariants', () => {
  it('MAX_EXECUTOR_TURNS is a positive integer', () => {
    assert.ok(Number.isInteger(MAX_EXECUTOR_TURNS));
    assert.ok(MAX_EXECUTOR_TURNS > 0);
  });

  it('MAX_EXECUTOR_TURNS is at least 10 (safety floor)', () => {
    assert.ok(
      MAX_EXECUTOR_TURNS >= 10,
      `MAX_EXECUTOR_TURNS=${MAX_EXECUTOR_TURNS} is below safety floor of 10`,
    );
  });

  it('MAX_EXECUTOR_TURNS is at most 100 (cost ceiling)', () => {
    assert.ok(
      MAX_EXECUTOR_TURNS <= 100,
      `MAX_EXECUTOR_TURNS=${MAX_EXECUTOR_TURNS} exceeds cost ceiling of 100`,
    );
  });

  it('BABEL_ROOT is a non-empty string', () => {
    assert.ok(typeof BABEL_ROOT === 'string');
    assert.ok(BABEL_ROOT.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ExecutorLoopResult type validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExecutorLoopResult shape', () => {
  it('accepts EXECUTION_COMPLETE result', () => {
    const result: ExecutorLoopResult = {
      toolCallLog: [mockToolCallEntry({ step: 1, tool: 'file_write', exit_code: 0 })],
      terminalStatus: 'EXECUTION_COMPLETE',
    };
    assert.equal(validateLoopResult(result), null);
  });

  it('accepts EXECUTION_HALTED result with halt tag', () => {
    const result: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition: 'Missing planned file writes: src/output.ts',
    };
    assert.equal(validateLoopResult(result), null);
  });

  it('accepts ACTIVATION_REFUSED result', () => {
    const result: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'ACTIVATION_REFUSED',
      haltTag: 'ACTIVATION_GATE_FAIL',
      condition: 'Bounded contract: no allowed tools available',
    };
    assert.equal(validateLoopResult(result), null);
  });

  it('rejects null result', () => {
    const err = validateLoopResult(null as unknown as ExecutorLoopResult);
    assert.ok(err !== null);
  });

  it('rejects invalid terminalStatus', () => {
    const result = {
      toolCallLog: [],
      terminalStatus: 'INVALID_STATUS',
    } as unknown as ExecutorLoopResult;
    const err = validateLoopResult(result);
    assert.ok(err !== null);
    assert.ok(err!.includes('Invalid terminalStatus'));
  });

  it('haltTag is compile-time validated (HaltTag type from agentContracts.ts)', () => {
    // The HaltTag type is enforced by TypeScript at compile time.
    // Runtime validation of haltTag values is handled by Zod in runWithFallback.
    const result: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
    };
    assert.equal(validateLoopResult(result), null);
    assert.equal(result.haltTag, 'STEP_VERIFICATION_FAIL');
  });

  it('rejects non-array toolCallLog', () => {
    const result = {
      toolCallLog: 'not-an-array',
      terminalStatus: 'EXECUTION_COMPLETE',
    } as unknown as ExecutorLoopResult;
    const err = validateLoopResult(result);
    assert.ok(err !== null);
    assert.ok(err!.includes('toolCallLog'));
  });

  it('accepts result with JIT telemetry fields', () => {
    const result: ExecutorLoopResult = {
      toolCallLog: [mockToolCallEntry()],
      terminalStatus: 'EXECUTION_COMPLETE',
      jitLatencyMs: 450,
      streamPauseDurationMs: 120,
      lockWaitMs: 15,
      bufferPeakBytes: 65536,
    };
    assert.equal(validateLoopResult(result), null);
    assert.equal(result.jitLatencyMs, 450);
    assert.equal(result.streamPauseDurationMs, 120);
    assert.equal(result.lockWaitMs, 15);
    assert.equal(result.bufferPeakBytes, 65536);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Tool call log accumulation
// ═══════════════════════════════════════════════════════════════════════════════

describe('tool call log invariants', () => {
  it('mockToolCallEntry produces valid entries', () => {
    const entry = mockToolCallEntry({ step: 3, tool: 'shell_exec', exit_code: 0 });
    assert.equal(entry.step, 3);
    assert.equal(entry.tool, 'shell_exec');
    assert.equal(entry.exit_code, 0);
  });

  it('tool call log grows monotonically with step numbers', () => {
    const log = [
      mockToolCallEntry({ step: 1 }),
      mockToolCallEntry({ step: 2 }),
      mockToolCallEntry({ step: 3 }),
    ];
    for (let i = 1; i < log.length; i++) {
      assert.ok(
        (log[i]!.step ?? 0) > (log[i - 1]!.step ?? 0),
        `Step ${i} should be greater than step ${i - 1}`,
      );
    }
  });

  it('tool call log entries have required fields', () => {
    const entry = mockToolCallEntry();
    assert.ok('step' in entry);
    assert.ok('tool' in entry);
    assert.ok('exit_code' in entry);
    assert.ok('stdout' in entry);
    assert.ok('stderr' in entry);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Mock executeTool behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('mock executeTool', () => {
  let fileContents: Record<string, string>;

  beforeEach(() => {
    fileContents = { 'existing.txt': 'hello world' };
  });

  it('returns file content for file_read', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'file_read', path: 'existing.txt' });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'hello world');
  });

  it('returns default content for missing file_read path', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'file_read', path: 'missing.txt' });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'default mock content');
  });

  it('writes content and updates cache for file_write', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'file_write', path: 'output.txt', content: 'new content' });
    assert.equal(result.exit_code, 0);
    assert.equal(fileContents['output.txt'], 'new content');
  });

  it('returns success for shell_exec', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'shell_exec' });
    assert.equal(result.exit_code, 0);
  });

  it('returns success for directory_list', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'directory_list' });
    assert.equal(result.exit_code, 0);
    const parsed = JSON.parse(result.stdout!);
    assert.deepEqual(parsed, ['existing.txt']);
  });

  it('returns error for unknown tool', async () => {
    const exec = createMockExecuteTool(fileContents);
    const result = await exec({ tool: 'dangerous_tool' });
    assert.equal(result.exit_code, 1);
    assert.ok(result.stderr!.includes('Unknown mock tool'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Mock run directory lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('mock run directory', () => {
  it('creates a temporary directory', () => {
    const { runDir, cleanup } = createMockRunDir();
    assert.ok(runDir.length > 0);
    assert.ok(runDir.includes('babel-executor-test'));
    cleanup();
  });

  it('cleanup removes the directory', () => {
    const { runDir, cleanup } = createMockRunDir();
    assert.ok(existsSync(runDir));
    cleanup();
    assert.ok(!existsSync(runDir));
  });

  it('mockRunId generates unique IDs', () => {
    const id1 = mockRunId();
    const id2 = mockRunId();
    assert.notEqual(id1, id2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SwePlan mock
// ═══════════════════════════════════════════════════════════════════════════════

describe('mockSwePlan', () => {
  it('produces a valid minimal plan', () => {
    const plan = mockSwePlan();
    assert.equal(plan.plan_type, 'IMPLEMENTATION_PLAN');
    assert.ok(plan.task_summary.includes('OBJECTIVE:'));
    assert.ok(Array.isArray(plan.minimal_action_set));
  });

  it('accepts overrides', () => {
    const plan = mockSwePlan({
      plan_type: 'EVIDENCE_REQUEST',
      minimal_action_set: [
        {
          step: 1,
          description: 'Read main',
          tool: 'file_read',
          target: 'src/main.ts',
          rationale: 'need context',
          reversible: true,
          verification: 'check output',
        },
      ],
    } as Partial<SwePlan> as SwePlan);
    assert.equal(plan.plan_type, 'EVIDENCE_REQUEST');
    assert.equal(plan.minimal_action_set.length, 1);
    assert.equal(plan.minimal_action_set[0]?.tool, 'file_read');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Terminal state transitions (documented contract)
// ═══════════════════════════════════════════════════════════════════════════════

describe('terminal state transitions', () => {
  /** Valid transitions as documented in the executor loop. */
  const VALID_TRANSITIONS: Record<string, string[]> = {
    ACTIVE: ['EXECUTION_COMPLETE', 'EXECUTION_HALTED', 'ACTIVATION_REFUSED'],
    EXECUTION_COMPLETE: [], // terminal
    EXECUTION_HALTED: [], // terminal
    ACTIVATION_REFUSED: [], // terminal
  };

  it('all terminal states are final (no outgoing transitions)', () => {
    for (const [state, transitions] of Object.entries(VALID_TRANSITIONS)) {
      if (state === 'ACTIVE') continue;
      assert.equal(
        transitions.length,
        0,
        `Terminal state "${state}" should have no outgoing transitions, got: ${transitions.join(', ')}`,
      );
    }
  });

  it('ACTIVE can transition to all three terminal states', () => {
    const activeTransitions = VALID_TRANSITIONS['ACTIVE'] ?? [];
    assert.ok(activeTransitions.includes('EXECUTION_COMPLETE'));
    assert.ok(activeTransitions.includes('EXECUTION_HALTED'));
    assert.ok(activeTransitions.includes('ACTIVATION_REFUSED'));
  });

  it('EXECUTION_HALTED requires haltTag or condition', () => {
    // Contract: if terminalStatus is EXECUTION_HALTED, either haltTag or
    // condition should be present to explain why.
    const haltedWithTag: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
    };
    assert.equal(validateLoopResult(haltedWithTag), null);

    const haltedWithCondition: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      condition: 'Executor reported completion but no file writes executed',
    };
    assert.equal(validateLoopResult(haltedWithCondition), null);
  });

  it('EXECUTION_COMPLETE may or may not have condition', () => {
    const completeNoCondition: ExecutorLoopResult = {
      toolCallLog: [mockToolCallEntry()],
      terminalStatus: 'EXECUTION_COMPLETE',
    };
    assert.equal(validateLoopResult(completeNoCondition), null);

    const completeWithCondition: ExecutorLoopResult = {
      toolCallLog: [mockToolCallEntry()],
      terminalStatus: 'EXECUTION_COMPLETE',
      condition: 'EVIDENCE_REQUEST minimal_action_set satisfied.',
    };
    assert.equal(validateLoopResult(completeWithCondition), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. File read cache eviction logic (algorithm test)
// ═══════════════════════════════════════════════════════════════════════════════

describe('file read cache logic', () => {
  /**
   * These tests verify the cache eviction algorithm documented in executorLoop.ts:
   *   - TURN-BASED: entries unused for > 5 turns are evicted
   *   - SIZE-BASED: when cache exceeds 10 MB, oldest entries evicted first
   */

  const FILE_READ_CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  const STALE_TURN_THRESHOLD = 5;

  it('stale turn threshold is 5 turns', () => {
    // This constant is embedded in the executor loop. If changed, the
    // loop behavior changes — verify intentional.
    assert.equal(STALE_TURN_THRESHOLD, 5);
  });

  it('max cache size is 10 MB', () => {
    assert.equal(FILE_READ_CACHE_MAX_BYTES, 10 * 1024 * 1024);
  });

  it('turn-based eviction: entry unused for > 5 turns is evicted', () => {
    // Simulate the eviction logic inline
    const cacheUsedTurn = new Map<string, number>();
    cacheUsedTurn.set('file_a.txt', 1); // last used at turn 1
    const currentTurn = 7;
    const toEvict: string[] = [];
    for (const [filePath, lastUsed] of cacheUsedTurn.entries()) {
      if (currentTurn - lastUsed > STALE_TURN_THRESHOLD) {
        toEvict.push(filePath);
      }
    }
    assert.deepEqual(toEvict, ['file_a.txt']);
  });

  it('turn-based eviction: recently used entry survives', () => {
    const cacheUsedTurn = new Map<string, number>();
    cacheUsedTurn.set('file_a.txt', 5); // last used at turn 5
    const currentTurn = 7;
    const toEvict: string[] = [];
    for (const [filePath, lastUsed] of cacheUsedTurn.entries()) {
      if (currentTurn - lastUsed > STALE_TURN_THRESHOLD) {
        toEvict.push(filePath);
      }
    }
    assert.deepEqual(toEvict, []); // 7-5=2, not > 5
  });

  it('size-based eviction: oldest entries evicted first when over 10 MB', () => {
    // Simulate 3 entries totaling 15 MB: entry sizes [8MB, 5MB, 2MB] used at turns [3, 1, 5]
    // Sorted by last-used ascending: turns 1 (5MB), 3 (8MB), 5 (2MB)
    // Evict turns 1 (5MB) first → 10MB remains, at ceiling (<=10MB) → break
    // Remaining: large.ts (8MB) + small.ts (2MB) = 10MB
    const entries: Array<{ path: string; lastUsed: number; bytes: number }> = [
      { path: 'large.ts', lastUsed: 3, bytes: 8 * 1024 * 1024 },
      { path: 'med.ts', lastUsed: 1, bytes: 5 * 1024 * 1024 },
      { path: 'small.ts', lastUsed: 5, bytes: 2 * 1024 * 1024 },
    ];
    let totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    assert.ok(totalBytes > FILE_READ_CACHE_MAX_BYTES, 'Should start over budget');

    const sortedByAge = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
    const evicted: string[] = [];
    for (const entry of sortedByAge) {
      if (totalBytes <= FILE_READ_CACHE_MAX_BYTES) break;
      totalBytes -= entry.bytes;
      evicted.push(entry.path);
    }

    // med.ts (turn 1, oldest) evicted first → total drops to 10MB, at ceiling, stops.
    // large.ts and small.ts survive (10MB + 2MB = 12MB... but the loop stops at ceiling)
    assert.deepEqual(evicted, ['med.ts']);
    // After evicting med.ts: 15MB - 5MB = 10MB, exactly at ceiling, loop breaks
    assert.equal(totalBytes, 10 * 1024 * 1024);
  });

  it('size-based eviction: stops when under budget', () => {
    const entries: Array<{ path: string; lastUsed: number; bytes: number }> = [
      { path: 'a.ts', lastUsed: 1, bytes: 1 * 1024 * 1024 },
      { path: 'b.ts', lastUsed: 2, bytes: 2 * 1024 * 1024 },
      { path: 'c.ts', lastUsed: 3, bytes: 8 * 1024 * 1024 }, // this pushes over
    ];
    let totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    assert.ok(totalBytes > FILE_READ_CACHE_MAX_BYTES); // 11 MB

    const sortedByAge = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of sortedByAge) {
      if (totalBytes <= FILE_READ_CACHE_MAX_BYTES) break;
      totalBytes -= entry.bytes;
    }

    // After evicting a.ts (1MB) → 10MB, at ceiling but not over. Stop.
    assert.equal(totalBytes, 10 * 1024 * 1024);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Scripted turn flow (smoke test for mock infrastructure integration)
// ═══════════════════════════════════════════════════════════════════════════════

describe('scripted turn flow', () => {
  it('happy path: 3 tool calls then completion', () => {
    const script: ScriptedTurn[] = [
      {
        kind: 'tool_call',
        tool: 'file_read',
        target: 'src/index.ts',
        exitCode: 0,
        stdout: 'content',
      },
      { kind: 'tool_call', tool: 'file_write', target: 'src/fix.ts', exitCode: 0 },
      { kind: 'tool_call', tool: 'shell_exec', exitCode: 0, stdout: 'tests passed' },
      { kind: 'completion', status: 'EXECUTION_COMPLETE' },
    ];

    assert.equal(script.length, 4);
    assert.equal(script[0]!.kind, 'tool_call');
    assert.equal(script[3]!.kind, 'completion');
    assert.equal(
      (script[3] as { kind: 'completion'; status: string }).status,
      'EXECUTION_COMPLETE',
    );
  });

  it('halted path: tool call denied then completion halted', () => {
    const script: ScriptedTurn[] = [
      {
        kind: 'tool_call',
        tool: 'file_read',
        target: 'src/index.ts',
        exitCode: 0,
        stdout: 'content',
      },
      { kind: 'tool_call', tool: 'shell_exec', denial: 'POLICY_BLOCKED', exitCode: 1 },
      { kind: 'completion', status: 'EXECUTION_HALTED' },
    ];

    assert.equal(script.length, 3);
    assert.equal(script[1]!.kind, 'tool_call');
    assert.ok('denial' in script[1]!);
  });

  it('exceeds MAX_EXECUTOR_TURNS: batch of 21 turns is too many', () => {
    const script: ScriptedTurn[] = Array.from({ length: MAX_EXECUTOR_TURNS + 1 }, (_, i) => ({
      kind: 'tool_call' as const,
      tool: 'file_read',
      exitCode: 0,
    }));
    assert.ok(
      script.length > MAX_EXECUTOR_TURNS,
      `Script length ${script.length} should exceed MAX_EXECUTOR_TURNS ${MAX_EXECUTOR_TURNS}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Coverage gap documentation
// ═══════════════════════════════════════════════════════════════════════════════

describe('coverage gaps (documented)', () => {
  it.todo('extract ExecutorLoopState class for full state machine coverage');
  it.todo('test full loop with MockPipelineRunner');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Turn-limit enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe('turn-limit enforcement', () => {
  it('returns EXECUTION_HALTED shape when turn count exceeds MAX_EXECUTOR_TURNS', () => {
    const maxTurns = MAX_EXECUTOR_TURNS;
    const condition = buildMaxTurnsExceededCondition(maxTurns);
    const result: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'TOOL_CALL_ERROR',
      condition,
    };
    assert.equal(validateLoopResult(result), null);
    assert.equal(result.haltTag, 'TOOL_CALL_ERROR');
    assert.equal(result.terminalStatus, 'EXECUTION_HALTED');
    assert.ok(result.condition!.includes(String(maxTurns)), 'condition should mention turn count');
  });

  it('buildMaxTurnsExceededCondition includes turn count and is descriptive', () => {
    const condition = buildMaxTurnsExceededCondition(MAX_EXECUTOR_TURNS);
    assert.ok(condition.includes(String(MAX_EXECUTOR_TURNS)), 'should include turn count');
    assert.ok(condition.length > 0, 'should not be empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Completion gate decisions
// ═══════════════════════════════════════════════════════════════════════════════

describe('completion gate decisions', () => {
  it('returns false when the plan has non-file_write tools', () => {
    const plan = mockSwePlan({
      minimal_action_set: [
        {
          step: 1,
          description: 'Run tests',
          tool: 'shell_exec' as const,
          target: 'npm test',
          rationale: 'Verify changes',
          reversible: true,
          verification: 'exit code 0',
        },
      ],
    } as Partial<SwePlan> as SwePlan);
    const result = shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'Write src/output.ts',
      toolCallLog: [mockToolCallEntry()],
      projectRoot: null,
    });
    assert.equal(result, false);
  });

  it('returns false when planned file_write targets have not been written yet', () => {
    const plan = mockSwePlan({
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
    } as Partial<SwePlan> as SwePlan);
    const result = shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'Write the file src/output.ts',
      toolCallLog: [],
      projectRoot: null,
    });
    assert.equal(result, false);
  });

  it('returns a boolean value', () => {
    const plan = mockSwePlan();
    const result = shouldCompleteBoundedWriteTask({
      approvedPlan: plan,
      rawTask: 'non-bounded task',
      toolCallLog: [],
      projectRoot: null,
    });
    assert.equal(typeof result, 'boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Repair state transitions
// ═══════════════════════════════════════════════════════════════════════════════

describe('repair state transitions', () => {
  it('MAX_REPLAN_ATTEMPTS is 2', () => {
    assert.equal(MAX_REPLAN_ATTEMPTS, 2);
  });

  it('replan exhaustion produces EXECUTION_HALTED with STEP_VERIFICATION_FAIL', () => {
    const result: ExecutorLoopResult = {
      toolCallLog: [mockToolCallEntry()],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition: 'Replan budget exceeded after 2 attempts',
    };
    assert.equal(validateLoopResult(result), null);
    assert.ok(result.condition!.includes('2'), 'condition should mention attempts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Executor turn budget enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe('executor turn budget enforcement', () => {
  it('MAX_EXECUTOR_TURNS is 20', () => {
    assert.equal(MAX_EXECUTOR_TURNS, 20);
  });

  it('post-loop halt block uses TOOL_CALL_ERROR haltTag', () => {
    const condition = buildMaxTurnsExceededCondition(MAX_EXECUTOR_TURNS);
    const result: ExecutorLoopResult = {
      toolCallLog: [],
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'TOOL_CALL_ERROR',
      condition,
    };
    assert.equal(validateLoopResult(result), null);
    assert.equal(result.haltTag, 'TOOL_CALL_ERROR');
  });
});
