import process from 'node:process';

import type { BaseHistoryCell } from '../../ui/historyCells/historyCell.js';
import { historyCellFromRecord } from '../../ui/historyCells/cells.js';
import { HistoryCellViewport } from '../../ui/historyCells/viewport.js';
import type { HistoryCellViewport as HistoryCellViewportType } from '../../ui/historyCells/viewport.js';
import type { ScreenManager } from '../../ui/screenManager.js';
import type { ReplContext } from '../../interactive/context.js';
import { loadThreadCells, threadStoreExists } from './threadStore.js';

export function loadThreadCellsAsHistoryCells(threadId: string): BaseHistoryCell[] {
  return loadThreadCells(threadId).map((record) => historyCellFromRecord(record));
}

export function hydrateViewportFromThreadStore(
  viewport: HistoryCellViewportType,
  threadId: string,
): number {
  const cells = loadThreadCellsAsHistoryCells(threadId);
  viewport.setCells(cells);
  viewport.warmSearchIndex();
  return cells.length;
}

/** Attach or refresh ScreenManager viewport from thread-store (resume / rewind). */
export function hydrateResumedThreadToScreen(ctx: ReplContext, threadId: string): number {
  if (!threadStoreExists(threadId)) return 0;

  const sm: ScreenManager | undefined = ctx.screenManager;
  if (!sm) {
    return loadThreadCellsAsHistoryCells(threadId).length;
  }

  let viewport = sm.getHistoryCellViewport();
  if (!viewport) {
    viewport = new HistoryCellViewport(process.stdout.columns ?? 80);
    sm.attachHistoryCellViewport(viewport);
  }
  return hydrateViewportFromThreadStore(viewport, threadId);
}