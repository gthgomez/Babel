/**
 * Thread fork and rewind — branch or truncate durable HistoryCell logs.
 */

import type { HistoryCellKind, HistoryCellRecord } from '../../ui/historyCells/types.js';
import {
  ensureThread,
  getThreadMeta,
  loadThreadCells,
  replaceThreadRecords,
  setThreadBranchMeta,
  threadStoreExists,
} from './threadStore.js';
import { allocateThreadId } from './threadIds.js';

function findCellIndex(cells: HistoryCellRecord[], cellId: string): number {
  return cells.findIndex((cell) => cell.cell_id === cellId);
}

/** @deprecated Use replaceThreadRecords — kept for existing imports. */
export async function rebuildThreadIndex(threadId: string, records: HistoryCellRecord[]): Promise<void> {
  await replaceThreadRecords(threadId, records);
}

export interface ForkThreadOptions {
  upToCellId?: string;
  newThreadId?: string;
  project_root?: string | null;
}

export interface ForkThreadResult {
  new_thread_id: string;
  source_thread_id: string;
  fork_point_cell_id: string;
  copied_cell_count: number;
}

export async function forkThread(
  sourceThreadId: string,
  options: ForkThreadOptions = {},
): Promise<ForkThreadResult> {
  if (!threadStoreExists(sourceThreadId)) {
    throw new Error(`Thread store not found: ${sourceThreadId}`);
  }

  const sourceCells = loadThreadCells(sourceThreadId);
  if (sourceCells.length === 0) {
    throw new Error(`Thread "${sourceThreadId}" has no cells to fork`);
  }

  const upToCellId = options.upToCellId ?? sourceCells[sourceCells.length - 1]!.cell_id;
  const endIndex = findCellIndex(sourceCells, upToCellId);
  if (endIndex < 0) {
    throw new Error(`Cell not found in thread "${sourceThreadId}": ${upToCellId}`);
  }

  const newThreadId = options.newThreadId ?? allocateThreadId();
  const copied = sourceCells.slice(0, endIndex + 1).map((record) => ({
    ...structuredClone(record),
    thread_id: newThreadId,
  }));

  const sourceMeta = getThreadMeta(sourceThreadId);
  ensureThread(newThreadId, {
    project_root: options.project_root ?? sourceMeta?.project_root ?? null,
    preview: sourceMeta?.preview ?? null,
  });
  await replaceThreadRecords(newThreadId, copied);
  setThreadBranchMeta(newThreadId, sourceThreadId, upToCellId);

  return {
    new_thread_id: newThreadId,
    source_thread_id: sourceThreadId,
    fork_point_cell_id: upToCellId,
    copied_cell_count: copied.length,
  };
}

export interface RewindThreadResult {
  thread_id: string;
  rewind_point_cell_id: string;
  kept_cell_count: number;
  truncated_cell_count: number;
}

export async function rewindThread(threadId: string, afterCellId: string): Promise<RewindThreadResult> {
  if (!threadStoreExists(threadId)) {
    throw new Error(`Thread store not found: ${threadId}`);
  }

  const cells = loadThreadCells(threadId);
  if (cells.length === 0) {
    throw new Error(`Thread "${threadId}" has no cells to rewind`);
  }

  const endIndex = findCellIndex(cells, afterCellId);
  if (endIndex < 0) {
    throw new Error(`Cell not found in thread "${threadId}": ${afterCellId}`);
  }

  const kept = cells.slice(0, endIndex + 1);
  const truncated = cells.length - kept.length;
  await replaceThreadRecords(threadId, kept);

  return {
    thread_id: threadId,
    rewind_point_cell_id: afterCellId,
    kept_cell_count: kept.length,
    truncated_cell_count: truncated,
  };
}

export function listThreadCheckpoints(threadId: string): Array<{
  cell_id: string;
  turn_id: number | undefined;
  kind: HistoryCellKind;
  preview: string;
}> {
  return loadThreadCells(threadId).map((cell) => {
    let preview: string = cell.kind;
    if (cell.kind === 'user_message') {
      preview = (cell.payload as { message: string }).message.slice(0, 60);
    } else if (cell.kind === 'assistant_message') {
      preview = (cell.payload as { message: string }).message.slice(0, 60);
    }
    return {
      cell_id: cell.cell_id,
      turn_id: cell.turn_id,
      kind: cell.kind,
      preview,
    };
  });
}