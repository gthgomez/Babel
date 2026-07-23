/**
 * Turn-level thread-store persistence — owned by chat orchestration, not the UI renderer.
 */

import { appendTurnCells } from '../../services/threadStore/index.js';
import { createUserMessageCell } from '../../ui/historyCells/index.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';

export class TurnPersistence {
  private assistantCellsPersisted = false;

  constructor(
    readonly threadId: string,
    readonly turnId: number,
  ) {}

  persistUserMessage(message: string): void {
    if (!message.trim() || this.turnId <= 0) return;
    const record = createUserMessageCell(message, {
      lifecycle: 'committed',
      thread_id: this.threadId,
      turn_id: this.turnId,
    }).toRecord();
    appendTurnCells(this.threadId, this.turnId, [record]);
  }

  persistAssistantAndToolCells(records: HistoryCellRecord[]): void {
    if (this.turnId <= 0 || this.assistantCellsPersisted || records.length === 0) return;
    appendTurnCells(this.threadId, this.turnId, records);
    this.assistantCellsPersisted = true;
  }
}