/**
 * mockExecutorRuntime.ts — Deterministic test doubles for executor loop dependencies.
 *
 * Provides mock implementations of `runWithFallback`, `executeTool`,
 * `IncrementalToolDetector`, and other dependencies needed to test the
 * executor loop without real LLM calls or filesystem access.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type { ToolCallLog, SwePlan } from '../schemas/agentContracts.js';
import type { ExecutorLoopResult } from '../pipeline/executorLoopTypes.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** A pre-scripted turn: either a tool call or a completion signal. */
export type ScriptedTurn =
  | {
      kind: 'tool_call';
      tool: string;
      target?: string;
      content?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      denial?: string;
    }
  | { kind: 'completion'; status?: 'EXECUTION_COMPLETE' | 'EXECUTION_HALTED' };

/** Configuration for a scripted executor loop run. */
export interface MockExecutorConfig {
  /** Pre-scripted LLM responses, one per turn. */
  turns: ScriptedTurn[];
  /** Approved plan to feed the executor. */
  approvedPlan?: SwePlan;
  /** Whether the IncrementalToolDetector should veto. */
  vetoOnTurns?: Set<number>;
  /** Whether Docker is available (for benchmark profiles). */
  dockerAvailable?: boolean;
  /** Mock file content for file_read responses. */
  fileContents?: Record<string, string>;
}

/** A minimal approved plan for testing. */
export function mockSwePlan(overrides: Partial<SwePlan> = {}): SwePlan {
  return {
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: Test task',
    minimal_action_set: [],
    requested_outputs: [],
    grounding_commitment: 'This is a test plan.',
    ...overrides,
  } as SwePlan;
}

/** A minimal tool call log entry for testing. */
export function mockToolCallEntry(overrides: Partial<ToolCallLog> = {}): ToolCallLog {
  return {
    step: 1,
    tool: 'file_read',
    target: 'test.txt',
    exit_code: 0,
    stdout: 'mock file content',
    stderr: '',
    ...overrides,
  } as ToolCallLog;
}

// ── Mock Tool Execution ──────────────────────────────────────────────────────

/**
 * Creates a mock `executeTool` function that returns pre-configured responses
 * based on the tool name.
 */
export function createMockExecuteTool(fileContents: Record<string, string> = {}) {
  return async (request: { tool: string; path?: string; content?: string }, _opts?: unknown) => {
    switch (request.tool) {
      case 'file_read': {
        const content = fileContents[request.path ?? ''] ?? 'default mock content';
        return {
          exit_code: 0,
          stdout: content,
          stderr: '',
        };
      }
      case 'file_write': {
        const path = request.path ?? 'output.txt';
        fileContents[path] = request.content ?? '';
        return {
          exit_code: 0,
          stdout: `Wrote ${(request.content ?? '').length} bytes to ${path}`,
          stderr: '',
        };
      }
      case 'shell_exec': {
        return {
          exit_code: 0,
          stdout: 'mock command output',
          stderr: '',
        };
      }
      case 'directory_list': {
        return {
          exit_code: 0,
          stdout: JSON.stringify(Object.keys(fileContents)),
          stderr: '',
        };
      }
      default: {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `Unknown mock tool: ${request.tool}`,
        };
      }
    }
  };
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

/** Creates a temporary run directory with basic structure. */
export function createMockRunDir(): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-executor-test-'));
  mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    cleanup: () => {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Generates a unique run ID. */
export function mockRunId(): string {
  return `test-run-${randomUUID().slice(0, 8)}`;
}

// ── Turn Outcome Assertions ──────────────────────────────────────────────────

/** Expected terminal states for the executor loop. */
export const VALID_TERMINAL_STATUSES = [
  'EXECUTION_COMPLETE',
  'EXECUTION_HALTED',
  'ACTIVATION_REFUSED',
] as const;

/**
 * Asserts that an ExecutorLoopResult has the expected shape.
 * haltTag is validated at compile-time by TypeScript (HaltTag type from agentContracts.ts).
 * Does NOT use node:assert — returns a string error or null.
 */
export function validateLoopResult(result: ExecutorLoopResult): string | null {
  if (!result) {
    return 'Result is null/undefined';
  }
  if (
    !VALID_TERMINAL_STATUSES.includes(
      result.terminalStatus as (typeof VALID_TERMINAL_STATUSES)[number],
    )
  ) {
    return `Invalid terminalStatus: ${result.terminalStatus}`;
  }
  if (!Array.isArray(result.toolCallLog)) {
    return 'toolCallLog is not an array';
  }
  return null;
}
