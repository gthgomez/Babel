/**
 * W0.5 — Offline implementor prove smokes (no live LLM).
 *
 * Three hard-cell capped trajectories that must:
 * - reach a successful mutation (write_count > 0)
 * - never false-fire zero-write hard stop on general_swe (threshold 0)
 * - expose tools_before_first_write for TTF-Write baseline
 */

import {
  evaluateZeroWriteHardStop,
  type ExploreFuseState,
  applyExploreFuses,
} from './chatZeroWritePolicy.js';
import { computeToolsBeforeFirstWrite } from './firstMoveCard.js';
import { isSuccessfulDirectMutation } from './mutationTools.js';
import type { ChatTaskClass } from '../config/chatTaskClass.js';
import { getChatTaskTune } from '../config/chatTaskClass.js';

export interface ProveSmokeToolCall {
  tool: string;
  target?: string;
  error?: string;
  detail?: string;
}

export interface ProveSmokeCell {
  id: string;
  description: string;
  taskClass: ChatTaskClass;
  executeIntent: boolean;
  /** Simulated completed tool turns (for hard-stop evaluator). */
  completedTurns: number;
  toolCalls: ProveSmokeToolCall[];
}

export interface ProveSmokeResult {
  id: string;
  description: string;
  write_count: number;
  tools_before_first_write: number;
  mutation_attempted: boolean;
  zero_write_hard_stop: boolean;
  zero_write_threshold: number;
  pass: boolean;
  fail_reasons: string[];
}

/** Three implementor hard cells used for Wave 0 exit gate #4. */
export function defaultImplementorProveCells(): ProveSmokeCell[] {
  return [
    {
      id: 'W0.5-H1-single-file-fix',
      description: 'Single-file fix: localize → str_replace → targeted test',
      taskClass: 'general_swe',
      executeIntent: true,
      completedTurns: 12,
      toolCalls: [
        { tool: 'read_file', target: 'src/parser.ts' },
        { tool: 'str_replace', target: 'src/parser.ts' },
        { tool: 'test_run', target: 'src/parser.test.ts', detail: 'exit 0' },
      ],
    },
    {
      id: 'W0.5-H2-multi-step-mutate',
      description: 'Grep + read + dual mutations without shell thrash kill',
      taskClass: 'general_swe',
      executeIntent: true,
      completedTurns: 15,
      toolCalls: [
        { tool: 'grep', target: 'FIXME' },
        { tool: 'read_file', target: 'src/a.ts' },
        { tool: 'read_file', target: 'src/b.ts' },
        { tool: 'str_replace', target: 'src/a.ts' },
        { tool: 'write_file', target: 'src/b.ts' },
      ],
    },
    {
      id: 'W0.5-H3-late-mutate',
      description: 'Several explores then first write (TTF-Write sample)',
      taskClass: 'general_swe',
      executeIntent: true,
      completedTurns: 20,
      toolCalls: [
        { tool: 'list_dir', target: 'src' },
        { tool: 'grep', target: 'bug' },
        { tool: 'read_file', target: 'src/foo.ts' },
        { tool: 'read_range', target: 'src/foo.ts' },
        { tool: 'glob', target: '**/*foo*' },
        { tool: 'str_replace', target: 'src/foo.ts' },
      ],
    },
  ];
}

export function evaluateProveSmokeCell(cell: ProveSmokeCell): ProveSmokeResult {
  const write_count = cell.toolCalls.filter((tc) =>
    isSuccessfulDirectMutation(tc.tool, tc.error),
  ).length;
  const tools_before_first_write = computeToolsBeforeFirstWrite(
    cell.toolCalls.map((tc) => ({
      tool: tc.tool,
      ...(tc.error !== undefined ? { error: tc.error } : {}),
    })),
  );
  const mutation_attempted = write_count > 0;
  const zero_write_threshold = getChatTaskTune(cell.taskClass).zeroWriteHardStopTurns;
  const hasAnyWrites = write_count > 0;
  const hardStop = evaluateZeroWriteHardStop({
    executeIntent: cell.executeIntent,
    completedTurns: cell.completedTurns,
    hasAnyWrites,
    taskClass: cell.taskClass,
  });
  const zero_write_hard_stop = hardStop != null;

  // Soft fuses must not convert into false hard stop when writes exist.
  const fuseState: ExploreFuseState = {
    turnsWithoutWrite: hasAnyWrites ? 0 : cell.completedTurns,
    consecutiveReadOnlyTools: 0,
    cumulativeExplorationTools: cell.toolCalls.filter(
      (t) => !isSuccessfulDirectMutation(t.tool, t.error),
    ).length,
    restrictToolsNextTurn: false,
    consecutiveNonMutatingShells: 0,
    toolsWithoutWrite: hasAnyWrites ? 0 : cell.toolCalls.length,
    phase: hasAnyWrites ? 'mutate' : 'investigate',
  };
  applyExploreFuses({
    executeIntent: cell.executeIntent,
    taskClass: cell.taskClass,
    hasAnyWrites,
    state: fuseState,
    pushUser: () => {},
    deferMessagesToArbiter: true,
  });

  const fail_reasons: string[] = [];
  if (!mutation_attempted) {
    fail_reasons.push('no successful mutation (write_count=0)');
  }
  if (zero_write_hard_stop) {
    fail_reasons.push('false zero-write hard stop fired');
  }
  if (cell.taskClass === 'general_swe' && zero_write_threshold !== 0) {
    fail_reasons.push(
      `general_swe zeroWriteHardStopTurns expected 0, got ${zero_write_threshold}`,
    );
  }

  return {
    id: cell.id,
    description: cell.description,
    write_count,
    tools_before_first_write,
    mutation_attempted,
    zero_write_hard_stop,
    zero_write_threshold,
    pass: fail_reasons.length === 0,
    fail_reasons,
  };
}

export interface ProveSmokeSuiteReport {
  pass: boolean;
  cells: ProveSmokeResult[];
  /** Median tools_before_first_write across passing mutation cells. */
  ttf_write_median: number | null;
  cells_passed: number;
  cells_total: number;
}

export function runImplementorProveSmokeSuite(
  cells: ProveSmokeCell[] = defaultImplementorProveCells(),
): ProveSmokeSuiteReport {
  const results = cells.map(evaluateProveSmokeCell);
  const ttfSamples = results
    .filter((r) => r.mutation_attempted)
    .map((r) => r.tools_before_first_write)
    .sort((a, b) => a - b);
  let ttf_write_median: number | null = null;
  if (ttfSamples.length > 0) {
    const mid = Math.floor(ttfSamples.length / 2);
    ttf_write_median =
      ttfSamples.length % 2 === 1
        ? ttfSamples[mid]!
        : (ttfSamples[mid - 1]! + ttfSamples[mid]!) / 2;
  }
  const cells_passed = results.filter((r) => r.pass).length;
  return {
    pass: cells_passed === results.length && results.length > 0,
    cells: results,
    ttf_write_median,
    cells_passed,
    cells_total: results.length,
  };
}
