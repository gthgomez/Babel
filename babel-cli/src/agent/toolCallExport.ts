/**
 * Enriched tool call export and aggregate computation for observability (Tier A1/A4).
 *
 * Provides ToolCallRecord enrichment (with turn numbers and duration), aggregate
 * computation, and re-exports the existing exportToolCallLog from
 * chatZeroWritePolicy.ts for unified access.
 */

import { exportToolCallLog } from './chatZeroWritePolicy.js';

export { exportToolCallLog };

// ─── Types ───────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  index: number;
  turn: number;
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
  duration_ms?: number;
}

export interface ToolCallAggregates {
  tool_call_count: number;
  write_count: number;
  verifier_attempt_count: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** All mutation tools that count as "writes". */
const MUTATION_TOOLS = new Set([
  'write_file',
  'str_replace',
  'apply_patch',
  'file_delete',
]);

/** All verifier-participation tools. */
const VERIFIER_TOOLS = new Set([
  'test_run',
  'run_command',
  'shell_exec',
]);

// ─── Enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich raw toolCallLog entries with turn numbers and duration.
 * `turnMap` maps each log entry's index to the turn number it occurred in.
 */
export function enrichToolCallLog(
  rawLog: Array<{
    tool: string; target: string; detail?: string; error?: string;
    index: number; exit_code?: number; stdout?: string; stderr?: string; verified?: boolean;
  }>,
  turnMap: Map<number, number>,  // logIndex → turn number
  durationMap?: Map<number, number>,  // logIndex → duration_ms
): ToolCallRecord[] {
  return rawLog.map((entry) => ({
    index: entry.index,
    turn: turnMap.get(entry.index) ?? 0,
    tool: entry.tool,
    target: entry.target,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.exit_code !== undefined ? { exit_code: entry.exit_code } : {}),
    ...(durationMap?.has(entry.index) ? { duration_ms: durationMap.get(entry.index)! } : {}),
  }));
}

// ─── Aggregates ──────────────────────────────────────────────────────────

/**
 * Compute aggregates from an array of tool call entries (shape matching
 * ChatResult.toolCalls or the internal toolCallLog).
 */
export function computeToolCallAggregates(
  rawLog: Array<{ tool: string; error?: string; verified?: boolean }>,
): ToolCallAggregates {
  const writeCount = rawLog.filter((e) => MUTATION_TOOLS.has(e.tool) && !e.error).length;
  const verifierCount = rawLog.filter((e) => VERIFIER_TOOLS.has(e.tool)).length;
  return {
    tool_call_count: rawLog.length,
    write_count: writeCount,
    verifier_attempt_count: verifierCount,
  };
}

// ─── Public convenience ──────────────────────────────────────────────────

/**
 * Export for payload — enriches raw internal tool call records with turn
 * and duration, returning ToolCallRecord[] suitable for serialization.
 */
export function exportEnrichedToolCallLog(
  rawLog: Array<{
    tool: string; target: string; detail?: string; error?: string;
    index: number; exit_code?: number; stdout?: string; stderr?: string; verified?: boolean;
  }>,
  turnMap: Map<number, number>,
  durationMap?: Map<number, number>,
): ToolCallRecord[] {
  return enrichToolCallLog(rawLog, turnMap, durationMap);
}
