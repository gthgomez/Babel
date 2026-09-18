import type { ChatEvent } from '../../agent/chatEngine.js';
import type { InteractiveTurn } from '../../interactive/types.js';
import {
  createAssistantMessageCell,
  createUserMessageCell,
} from '../historyCells/cells.js';
import { HistoryTranscript } from '../historyCells/transcript.js';
import { HistoryCellViewport } from '../historyCells/viewport.js';
import type { HistoryCellRecord } from '../historyCells/types.js';
import { ShellConversationStore } from './shellConversationStore.js';

export type ShellActivity = 'idle' | 'preparing' | 'running' | 'cancelling';

export interface ShellRuntimeSnapshot {
  readonly activity: ShellActivity;
  readonly lastOutcome: string | null;
  readonly threadId: string | undefined;
  readonly turnId: number | undefined;
  readonly epoch: number;
}

function stableCellId(turnId: number, role: 'user' | 'assistant'): string {
  return `interactive-turn:${turnId}:${role}`;
}

/**
 * Presentation-only bridge from canonical Chat events to the existing
 * history-cell/store/viewport stack. It owns no persistence or authorization
 * decisions; durable records are only supplied to ShellConversationStore
 * after their owning runtime has accepted them.
 */
export class ShellRuntimeBinding {
  readonly store: ShellConversationStore;
  readonly viewport: HistoryCellViewport;

  private readonly transcript = new HistoryTranscript();
  private currentTurnId: number | undefined;
  private currentTurnEpoch: number | undefined;
  private currentUserRecord: HistoryCellRecord | undefined;
  private readonly toolIds = new Map<string, number>();
  private readonly toolIdQueue: number[] = [];
  private activity: ShellActivity = 'idle';
  private lastOutcome: string | null = null;
  private readonly onChange: (() => void) | undefined;

  constructor(options: { threadId?: string; width?: number; onChange?: () => void } = {}) {
    this.store = new ShellConversationStore(
      options.threadId !== undefined ? { threadId: options.threadId } : {},
    );
    this.viewport = new HistoryCellViewport(options.width ?? 80);
    this.onChange = options.onChange;
  }

  hydrateTurns(turns: readonly InteractiveTurn[], threadId?: string): void {
    const records: HistoryCellRecord[] = [];
    for (const turn of turns) {
      if (turn.role === 'user') {
        const message = turn.input ?? turn.resolved_task ?? '';
        if (message) {
          records.push(
            createUserMessageCell(message, {
              cell_id: stableCellId(turn.turn_id, 'user'),
              turn_id: turn.turn_id,
              ...(threadId !== undefined ? { thread_id: threadId } : {}),
            }).toRecord(),
          );
        }
      } else if (turn.answer) {
        records.push(
          createAssistantMessageCell(turn.answer, {
            cell_id: stableCellId(turn.turn_id, 'assistant'),
            turn_id: turn.turn_id,
            ...(threadId !== undefined ? { thread_id: threadId } : {}),
          }).toRecord(),
        );
      }
    }
    this.currentTurnId = undefined;
    this.currentTurnEpoch = undefined;
    this.currentUserRecord = undefined;
    this.toolIds.clear();
    this.toolIdQueue.length = 0;
    this.store.startSession(threadId, records);
    this.syncViewport();
  }

  beginTurn(turnId: number, input: string, threadId?: string): void {
    if (this.currentTurnId !== undefined) {
      this.transcript.finishTurn();
    }
    if (threadId !== undefined && threadId !== this.store.threadId) {
      this.store.startSession(threadId, this.store.getRecords());
    }
    const epoch = this.store.epoch;
    if (!this.store.beginTurn(turnId, epoch)) return;
    this.transcript.beginTurn({ turn_id: turnId, ...(threadId ? { thread_id: threadId } : {}) });
    this.currentTurnId = turnId;
    this.currentTurnEpoch = epoch;
    this.currentUserRecord = createUserMessageCell(input, {
      cell_id: stableCellId(turnId, 'user'),
      turn_id: turnId,
      ...(threadId !== undefined ? { thread_id: threadId } : {}),
    }).toRecord();
    this.store.observePersistedUserRecord(this.currentUserRecord, epoch);
    this.activity = 'preparing';
    this.lastOutcome = null;
    this.toolIds.clear();
    this.toolIdQueue.length = 0;
    this.syncViewport();
  }

  observeInteractiveTurn(turn: InteractiveTurn): void {
    if (turn.role === 'user') {
      this.beginTurn(turn.turn_id, turn.input ?? turn.resolved_task ?? '');
      return;
    }

    if (this.currentTurnId !== undefined) {
      if (this.currentTurnEpoch !== this.store.epoch) {
        this.clearActiveTurn();
        return;
      }
      if (turn.turn_id !== this.currentTurnId) return;
      if (this.transcript.getAnswerText().length === 0 && turn.answer) {
        this.transcript.onAnswerChunk(turn.answer);
      }
      this.transcript.finishTurn();
      this.settleTurn();
    } else if (turn.answer) {
      // An assistant record without a matching active shell turn has no safe
      // epoch provenance. Hydration and the active-turn path already cover
      // legitimate records; ignoring this path prevents stale late events
      // from crossing a session boundary.
      return;
    }
    this.activity = 'idle';
    this.syncViewport();
  }

  onChatEvent(event: ChatEvent, sourceEpoch = this.store.epoch): void {
    if (this.currentTurnId === undefined) return;
    if (sourceEpoch !== this.currentTurnEpoch) return;
    if (this.store.epoch !== this.currentTurnEpoch || this.store.turnId !== this.currentTurnId) {
      this.clearActiveTurn();
      return;
    }
    const epoch = this.store.epoch;
    switch (event.type) {
      case 'thinking':
        this.activity = 'running';
        break;
      case 'answer_chunk':
        this.activity = 'running';
        this.transcript.onAnswerChunk(event.text);
        break;
      case 'thought':
      case 'context_compacted':
        this.activity = 'running';
        this.transcript.onThought(event.type === 'thought' ? event.text : event.message);
        break;
      case 'tool_start': {
        this.activity = 'running';
        const numericId = this.toolIds.size + 1;
        if (event.toolCallId) this.toolIds.set(event.toolCallId, numericId);
        this.toolIdQueue.push(numericId);
        this.transcript.beginToolCall(numericId, event.tool, event.target);
        break;
      }
      case 'tool_complete':
      case 'tool_failed': {
        const numericId = event.toolCallId
          ? this.toolIds.get(event.toolCallId)
          : this.toolIdQueue.shift();
        if (numericId !== undefined) {
          this.transcript.completeToolCall(
            numericId,
            event.detail ?? event.error,
            event.type === 'tool_failed',
          );
          const queuedIndex = this.toolIdQueue.indexOf(numericId);
          if (queuedIndex >= 0) this.toolIdQueue.splice(queuedIndex, 1);
          if (event.toolCallId) this.toolIds.delete(event.toolCallId);
        }
        this.activity = 'running';
        break;
      }
      case 'cancelled':
        this.activity = 'cancelling';
        this.lastOutcome = event.outcome ?? 'CANCELLED';
        break;
      case 'done':
        this.activity = 'idle';
        this.lastOutcome = event.outcome ?? event.status ?? 'completed';
        break;
      case 'failed':
        this.activity = 'idle';
        this.lastOutcome = event.outcome ?? event.status ?? 'failed';
        break;
      default:
        break;
    }
    this.store.replaceCurrentTurn(
      [...(this.currentUserRecord ? [this.currentUserRecord] : []), ...this.transcript.getAllRecords()],
      epoch,
    );
    this.syncViewport();
  }

  setWidth(width: number): void {
    this.viewport.setWidth(width);
    this.syncViewport();
  }

  getVisibleRows(width: number, height: number): string[] {
    this.setWidth(width);
    return this.viewport.getVisibleRows(height);
  }

  getSnapshot(): ShellRuntimeSnapshot {
    return {
      activity: this.activity,
      lastOutcome: this.lastOutcome,
      threadId: this.store.threadId,
      turnId: this.store.turnId,
      epoch: this.store.epoch,
    };
  }

  /** Settle the active presentation turn and clear its transient identity. */
  settleTurn(outcome?: string, sourceEpoch = this.store.epoch): void {
    if (this.currentTurnId === undefined) return;
    if (sourceEpoch !== this.currentTurnEpoch) return;
    if (this.store.epoch !== this.currentTurnEpoch || this.store.turnId !== this.currentTurnId) {
      // A session epoch change invalidates the old live segment. Do not let a
      // late completion settle records into the replacement session.
      this.clearActiveTurn();
      return;
    }
    this.transcript.finishTurn();
    const settled = this.store.settleTurn(this.transcript.getAllRecords(), this.store.epoch);
    if (!settled) return;
    this.currentTurnId = undefined;
    this.currentTurnEpoch = undefined;
    this.currentUserRecord = undefined;
    this.toolIds.clear();
    this.toolIdQueue.length = 0;
    this.activity = 'idle';
    this.lastOutcome = outcome ?? this.lastOutcome ?? 'completed';
    this.syncViewport();
  }

  private clearActiveTurn(): void {
    this.currentTurnId = undefined;
    this.currentTurnEpoch = undefined;
    this.currentUserRecord = undefined;
    this.toolIds.clear();
    this.toolIdQueue.length = 0;
    this.activity = 'idle';
  }

  private syncViewport(): void {
    this.viewport.setCells(this.store.getCells());
    this.onChange?.();
  }
}
