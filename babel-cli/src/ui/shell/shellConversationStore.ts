import { historyCellFromRecord } from '../historyCells/cells.js';
import type { BaseHistoryCell } from '../historyCells/historyCell.js';
import type { HistoryCellRecord } from '../historyCells/types.js';

export interface ShellConversationStoreOptions {
  threadId?: string;
  records?: readonly HistoryCellRecord[];
}

export interface ShellConversationSnapshot {
  epoch: number;
  threadId?: string;
  turnId?: number;
  records: HistoryCellRecord[];
}

function cloneRecord(record: HistoryCellRecord): HistoryCellRecord {
  return structuredClone(record);
}

function mergeRecords(
  base: readonly HistoryCellRecord[],
  incoming: readonly HistoryCellRecord[],
): HistoryCellRecord[] {
  const records = base.map(cloneRecord);
  const indexById = new Map(records.map((record, index) => [record.cell_id, index]));

  for (const record of incoming) {
    const index = indexById.get(record.cell_id);
    if (index === undefined) {
      indexById.set(record.cell_id, records.length);
      records.push(cloneRecord(record));
    } else {
      records[index] = cloneRecord(record);
    }
  }

  return records;
}

function dedupeRecords(records: readonly HistoryCellRecord[]): HistoryCellRecord[] {
  return mergeRecords([], records);
}

/**
 * Derived session conversation state for a hosted shell.
 *
 * This store owns no persistence authority. Durable records are supplied by
 * the thread store and current-turn records are replaced or settled only
 * after the owning transport reports the corresponding outcome.
 */
export class ShellConversationStore {
  private committedRecords: HistoryCellRecord[] = [];
  private currentTurnRecords: HistoryCellRecord[] = [];
  private viewEpoch = 0;
  private activeThreadId: string | undefined;
  private activeTurnId: number | undefined;

  constructor(options: ShellConversationStoreOptions = {}) {
    if (options.threadId !== undefined || options.records !== undefined) {
      this.startSession(options.threadId, options.records ?? []);
    }
  }

  /** The generation that fences observers from an older session view. */
  get epoch(): number {
    return this.viewEpoch;
  }

  /** The thread currently represented by the derived view. */
  get threadId(): string | undefined {
    return this.activeThreadId;
  }

  /** The current turn represented by the live segment, when one is active. */
  get turnId(): number | undefined {
    return this.activeTurnId;
  }

  /**
   * Start a new derived session view from already-loaded durable records.
   * Returns the new source epoch for observer fencing.
   */
  startSession(
    threadId?: string,
    records: readonly HistoryCellRecord[] = [],
  ): number {
    this.viewEpoch += 1;
    this.activeThreadId = threadId;
    this.activeTurnId = undefined;
    this.committedRecords = dedupeRecords(records);
    this.currentTurnRecords = [];
    return this.viewEpoch;
  }

  /** Alias for callers that describe resume/new-view work as a session begin. */
  beginSession(
    threadId?: string,
    records: readonly HistoryCellRecord[] = [],
  ): number {
    return this.startSession(threadId, records);
  }

  /** Start a turn-local live segment without changing durable records. */
  beginTurn(turnId: number, sourceEpoch = this.viewEpoch): boolean {
    if (!this.accepts(sourceEpoch)) return false;
    this.activeTurnId = turnId;
    this.currentTurnRecords = [];
    return true;
  }

  /**
   * Observe the canonical persisted user record after its append succeeds.
   * Repeated observations of the same cell ID replace rather than duplicate.
   */
  observePersistedUserRecord(
    record: HistoryCellRecord,
    sourceEpoch = this.viewEpoch,
  ): boolean {
    if (!this.accepts(sourceEpoch) || record.kind !== 'user_message') return false;
    this.currentTurnRecords = mergeRecords(this.currentTurnRecords, [record]);
    return true;
  }

  /** Generic read-only observer for a canonical record published by transport. */
  observePersistedRecord(
    record: HistoryCellRecord,
    sourceEpoch = this.viewEpoch,
  ): boolean {
    if (!this.accepts(sourceEpoch)) return false;
    this.currentTurnRecords = mergeRecords(this.currentTurnRecords, [record]);
    return true;
  }

  /** Replace the renderer's current-turn segment while retaining its canonical user cell. */
  replaceCurrentTurn(
    records: readonly HistoryCellRecord[],
    sourceEpoch = this.viewEpoch,
  ): boolean {
    if (!this.accepts(sourceEpoch)) return false;
    const userRecords = this.currentTurnRecords.filter(
      (record) => record.kind === 'user_message',
    );
    this.currentTurnRecords = mergeRecords(userRecords, records);
    return true;
  }

  /** Add or replace live records without removing other current-turn cells. */
  upsertCurrentTurn(
    records: readonly HistoryCellRecord[],
    sourceEpoch = this.viewEpoch,
  ): boolean {
    if (!this.accepts(sourceEpoch)) return false;
    this.currentTurnRecords = mergeRecords(this.currentTurnRecords, records);
    return true;
  }

  /** Alias used by renderer adapters that publish a new live projection. */
  updateCurrentTurn(
    records: readonly HistoryCellRecord[],
    sourceEpoch = this.viewEpoch,
  ): boolean {
    return this.replaceCurrentTurn(records, sourceEpoch);
  }

  /**
   * Replace the live segment with records whose persistence has already
   * succeeded, then clear the transient tail. The store itself never writes.
   */
  settleTurn(
    records: readonly HistoryCellRecord[],
    sourceEpoch = this.viewEpoch,
  ): boolean {
    if (!this.accepts(sourceEpoch)) return false;
    const settled = mergeRecords(this.currentTurnRecords, records);
    this.committedRecords = mergeRecords(this.committedRecords, settled);
    this.currentTurnRecords = [];
    return true;
  }

  /** Return durable and live records as one ordered, ID-deduplicated view. */
  getRecords(): HistoryCellRecord[] {
    return mergeRecords(this.committedRecords, this.currentTurnRecords);
  }

  /** Return the derived display cells for the current session view. */
  getCells(): BaseHistoryCell[] {
    return this.getRecords().map((record) => historyCellFromRecord(record));
  }

  /** Return the current-turn records, including the observed canonical user cell. */
  getCurrentTurnRecords(): HistoryCellRecord[] {
    return this.currentTurnRecords.map(cloneRecord);
  }

  /** Return an immutable-by-convention snapshot for a frame or viewport adapter. */
  snapshot(): ShellConversationSnapshot {
    const snapshot: ShellConversationSnapshot = {
      epoch: this.viewEpoch,
      records: this.getRecords(),
    };
    if (this.activeThreadId !== undefined) snapshot.threadId = this.activeThreadId;
    if (this.activeTurnId !== undefined) snapshot.turnId = this.activeTurnId;
    return snapshot;
  }

  private accepts(sourceEpoch: number): boolean {
    return sourceEpoch === this.viewEpoch;
  }
}

/** Factory for hosts that prefer a function-shaped construction seam. */
export function createShellConversationStore(
  options: ShellConversationStoreOptions = {},
): ShellConversationStore {
  return new ShellConversationStore(options);
}

/** Compatibility alias for callers that use the generic session-store name. */
export const SessionConversationStore = ShellConversationStore;
