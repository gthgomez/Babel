/**
 * HistoryTranscript — active → committed flush lifecycle for chat turns.
 *
 * Mirrors Codex ChatWidget transcript semantics:
 * - One active cell at a time (thinking or streaming assistant message)
 * - Tool calls commit immediately as running cells; complete updates in place
 * - flushActive() moves active → committed before tool boundaries
 */

import type { BaseHistoryCell } from './historyCell.js';
import {
  createAssistantMessageCell,
  createThinkingCell,
  createToolCallCell,
  historyCellFromRecord,
} from './cells.js';
import type {
  AssistantMessagePayload,
  HistoryCellRecord,
  ThinkingPayload,
  ToolCallPayload,
} from './types.js';

export interface HistoryTranscriptTurnOptions {
  turn_id?: number;
  thread_id?: string;
}

export class HistoryTranscript {
  private committed: BaseHistoryCell[] = [];
  private active: BaseHistoryCell | null = null;
  private activeRevision = 0;
  private readonly toolIdToCellId = new Map<number, string>();
  private turnId = 0;
  private threadId: string | undefined;

  beginTurn(options: HistoryTranscriptTurnOptions = {}): void {
    // Flush any in-progress turn before starting a new one, so callers
    // can safely call beginTurn() without worrying about mid-turn state.
    this.finishTurn();

    // Reset turn-local state for the new turn.
    this.committed = [];
    this.active = null;
    this.activeRevision = 0;
    this.toolIdToCellId.clear();

    if (options.turn_id !== undefined) this.turnId = options.turn_id;
    if (options.thread_id !== undefined) this.threadId = options.thread_id;

    this.active = createThinkingCell(undefined, this.activeRecordOptions('active'));
    this.bumpActiveRevision();
  }

  private activeRecordOptions(lifecycle: 'active' | 'committed') {
    const opts: {
      lifecycle: 'active' | 'committed';
      revision: number;
      turn_id?: number;
      thread_id?: string;
    } = { lifecycle, revision: this.activeRevision };
    if (this.turnId > 0) opts.turn_id = this.turnId;
    if (this.threadId !== undefined) opts.thread_id = this.threadId;
    return opts;
  }

  private committedRecordOptions() {
    const opts: {
      lifecycle: 'committed';
      revision: number;
      turn_id?: number;
      thread_id?: string;
    } = { lifecycle: 'committed', revision: 0 };
    if (this.turnId > 0) opts.turn_id = this.turnId;
    if (this.threadId !== undefined) opts.thread_id = this.threadId;
    return opts;
  }

  private bumpActiveRevision(): void {
    this.activeRevision += 1;
    if (this.active) {
      this.active.record.revision = this.activeRevision;
    }
  }

  /** Commit the active cell into history (if it has displayable content). */
  flushActive(): void {
    if (!this.active) return;

    const record = this.active.toRecord();
    if (record.kind === 'thinking') {
      const text = (record.payload as ThinkingPayload).text?.trim();
      if (!text) {
        this.active = null;
        return;
      }
    }

    const committedRecord: HistoryCellRecord = structuredClone({
      ...record,
      lifecycle: 'committed',
    } as HistoryCellRecord);
    this.committed.push(historyCellFromRecord(committedRecord));
    this.active = null;
    this.activeRevision = 0;
  }

  /** Stream assistant answer text into the active assistant cell. */
  onAnswerChunk(chunk: string): void {
    if (!chunk) return;

    if (!this.active || this.active.kind !== 'assistant_message') {
      this.flushActive();
      this.active = createAssistantMessageCell(chunk, this.activeRecordOptions('active'));
      this.activeRevision = 0;
      this.bumpActiveRevision();
      return;
    }

    const payload = this.active.record.payload as AssistantMessagePayload;
    payload.message += chunk;
    this.bumpActiveRevision();
  }

  /** Register a tool call — flushes streaming answer, commits a running tool cell. */
  beginToolCall(toolId: number, tool: string, target: string): void {
    this.flushActive();
    const cell = createToolCallCell(tool, target, 'running', this.committedRecordOptions());
    this.toolIdToCellId.set(toolId, cell.record.cell_id);
    this.committed.push(cell);
  }

  /** Mark a committed running tool cell as completed (or failed). */
  completeToolCall(toolId: number, detail?: string, failed = false): void {
    const cellId = this.toolIdToCellId.get(toolId);
    if (!cellId) return;

    const cell = this.committed.find((entry) => entry.record.cell_id === cellId);
    if (!cell || cell.kind !== 'tool_call') return;

    const payload = cell.record.payload as ToolCallPayload;
    payload.status = failed ? 'failed' : 'completed';
    if (detail !== undefined) payload.detail = detail;
    cell.record.revision += 1;
    this.toolIdToCellId.delete(toolId);
  }

  /** End of turn — flush any remaining active assistant/thinking cell,
   *  then cancel any tool calls still marked 'running' so downstream
   *  consumers never see stuck-in-flight tools. */
  finishTurn(): void {
    this.flushActive();
    for (const cell of this.committed) {
      if (cell.kind !== 'tool_call') continue;
      const payload = cell.record.payload as ToolCallPayload;
      if (payload.status === 'running') {
        payload.status = 'cancelled';
        cell.record.revision += 1;
      }
    }
    this.toolIdToCellId.clear();
  }

  /** Error/cancel path — delegates to finishTurn (identical logic). */
  abortTurn(): void {
    this.finishTurn();
  }

  getCommittedCells(): readonly BaseHistoryCell[] {
    return this.committed;
  }

  getCommittedRecords(): HistoryCellRecord[] {
    return this.committed.map((cell) => structuredClone(cell.toRecord()));
  }

  getActiveCell(): BaseHistoryCell | null {
    return this.active;
  }

  getActiveRecord(): HistoryCellRecord | null {
    return this.active ? structuredClone(this.active.toRecord()) : null;
  }

  /** Cache key for transcript overlay refresh (Codex active_cell_transcript_key). */
  getActiveCacheKey(): string | null {
    return this.active?.cacheKey() ?? null;
  }

  /** Accumulated assistant message from active + committed cells this turn. */
  getAnswerText(): string {
    const parts: string[] = [];
    for (const cell of this.committed) {
      if (cell.kind === 'assistant_message') {
        parts.push((cell.record.payload as AssistantMessagePayload).message);
      }
    }
    if (this.active?.kind === 'assistant_message') {
      parts.push((this.active.record.payload as AssistantMessagePayload).message);
    }
    return parts.join('');
  }

  getAllRecords(): HistoryCellRecord[] {
    const records = this.getCommittedRecords();
    const active = this.getActiveRecord();
    if (active) records.push(active);
    return records;
  }
}