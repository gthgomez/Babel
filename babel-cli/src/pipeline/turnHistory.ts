/**
 * TurnHistory — structured executor turn accumulation.
 *
 * Phase 5: Replaces implicit state spread across flat variables with a
 * TurnRecord[]-based history that supports pruning and summarization.
 *
 * Currently runs alongside the legacy string-based executionHistory;
 * future phases will migrate prompt building and compaction to use
 * TurnHistory as the single source of truth.
 */

import type { ExecutorTurn } from '../schemas/agentContracts.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

// ── Types ──────────────────────────────────────────────────────────

export interface TurnRecord {
  /** 1-based turn number (matches the loop counter). */
  turn: number;
  /** ISO-8601 timestamp when the turn started. */
  startedAt: string;
  /** What the LLM returned for this turn. */
  response: ExecutorTurn;
  /** The tool call log entry produced by executing the response (null if completion/halt). */
  toolResult: ToolCallLog | null;
  /** Approximate prompt token count (input to the LLM call). */
  promptTokens?: number | undefined;
  /** Approximate completion token count (output from the LLM call). */
  completionTokens?: number | undefined;
  /** If this turn was compacted, what remains after pruning. */
  summary?: string | undefined;
}

export interface TurnHistorySnapshot {
  turns: TurnRecord[];
  totalTurns: number;
  totalToolCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  lastCompactedAt: string | null;
}

export interface CompactOptions {
  /** Turns older than this many turns from the latest are candidates for compaction. */
  keepRecent: number;
  /** Maximum number of turns to retain in full before summarizing. */
  maxFullTurns: number;
  /** Maximum bytes of stdout/stderr to keep per old turn. */
  outputByteLimit: number;
}

const DEFAULT_COMPACT_OPTIONS: CompactOptions = {
  keepRecent: 5,
  maxFullTurns: 20,
  outputByteLimit: 2048,
};

// ── TurnHistory ────────────────────────────────────────────────────

export class TurnHistory {
  private turns: TurnRecord[] = [];
  private lastCompactedAt: string | null = null;

  // ── mutation ──

  append(record: TurnRecord): void {
    this.turns.push(record);
  }

  /** Mark the most recent turn with a summary string (post-hoc pruning). */
  summarizeLast(summary: string): void {
    const last = this.turns[this.turns.length - 1];
    if (last) {
      last.summary = summary;
    }
  }

  // ── queries ──

  get latest(): TurnRecord | undefined {
    return this.turns[this.turns.length - 1];
  }

  get count(): number {
    return this.turns.length;
  }

  get fullTurns(): readonly TurnRecord[] {
    return this.turns.filter((t) => !t.summary);
  }

  get prunedTurns(): readonly TurnRecord[] {
    return this.turns.filter((t) => !!t.summary);
  }

  totalToolCalls(): number {
    return this.turns.reduce((n, t) => n + (t.toolResult ? 1 : 0), 0);
  }

  totalPromptTokens(): number {
    return this.turns.reduce((n, t) => n + (t.promptTokens ?? 0), 0);
  }

  totalCompletionTokens(): number {
    return this.turns.reduce((n, t) => n + (t.completionTokens ?? 0), 0);
  }

  // ── compaction ──

  /**
   * Summarize old turns by trimming stdout/stderr in their toolResult
   * entries and recording a summary string. Recent turns (within
   * `keepRecent` of the latest) are left intact.
   *
   * Returns the number of turns compacted.
   */
  compact(opts: Partial<CompactOptions> = {}): number {
    const { keepRecent, maxFullTurns, outputByteLimit } = { ...DEFAULT_COMPACT_OPTIONS, ...opts };
    if (this.turns.length <= keepRecent) return 0;

    const latestTurn = this.turns[this.turns.length - 1]!.turn;
    let compacted = 0;

    for (const record of this.turns) {
      // Skip turns that are already summarized or too recent
      if (record.summary) continue;
      if (record.turn > latestTurn - keepRecent) continue;

      // If we're within the maxFullTurns window, leave intact
      const fullCount = this.turns.filter((t) => !t.summary).length;
      if (fullCount <= maxFullTurns) break;

      if (record.toolResult) {
        record.summary = buildTurnSummary(record, outputByteLimit);
      } else {
        record.summary = `[Turn ${record.turn}: ${record.response.type === 'completion' ? 'completion' : 'tool_call (no result)'}]`;
      }
      compacted++;
    }

    if (compacted > 0) {
      this.lastCompactedAt = new Date().toISOString();
    }
    return compacted;
  }

  // ── snapshot ──

  snapshot(): TurnHistorySnapshot {
    return {
      turns: [...this.turns],
      totalTurns: this.turns.length,
      totalToolCalls: this.totalToolCalls(),
      totalPromptTokens: this.totalPromptTokens(),
      totalCompletionTokens: this.totalCompletionTokens(),
      lastCompactedAt: this.lastCompactedAt,
    };
  }

  /** Reset to empty (used for testing). */
  reset(): void {
    this.turns = [];
    this.lastCompactedAt = null;
  }
}

// ── helpers ──

function buildTurnSummary(record: TurnRecord, byteLimit: number): string {
  const r = record.toolResult;
  if (!r) return `[Turn ${record.turn}: no result]`;

  const trunc = (s: string | undefined, label: string): string => {
    if (!s) return '';
    if (s.length <= byteLimit) return s;
    return s.slice(0, byteLimit) + `\n[${label} truncated: ${s.length - byteLimit} bytes omitted]`;
  };

  return [
    `[Turn ${record.turn} summary]`,
    `tool: ${r.tool}`,
    `target: ${r.target}`,
    `exit_code: ${r.exit_code}`,
    trunc(r.stdout, 'stdout'),
    trunc(r.stderr, 'stderr'),
  ]
    .filter(Boolean)
    .join('\n');
}
