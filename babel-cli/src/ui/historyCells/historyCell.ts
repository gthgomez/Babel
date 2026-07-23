import type { HistoryCellKind, HistoryCellRecord } from './types.js';
import { measureDisplayHeight, plainLines, type HistoryRenderMode } from './layout.js';

export interface HistoryCell {
  readonly kind: HistoryCellKind;
  readonly record: HistoryCellRecord;

  displayLines(width: number): string[];
  rawLines(): string[];
  transcriptLines(width: number): string[];
  desiredHeight(width: number): number;
  desiredTranscriptHeight(width: number): number;
  toRecord(): HistoryCellRecord;
  cacheKey(): string;
}

export abstract class BaseHistoryCell implements HistoryCell {
  abstract readonly kind: HistoryCellKind;
  abstract readonly record: HistoryCellRecord;

  displayLines(width: number): string[] {
    return this.displayLinesForMode(width, 'rich');
  }

  rawLines(): string[] {
    return plainLines(this.displayLinesForMode(10_000, 'raw'));
  }

  transcriptLines(width: number): string[] {
    return this.displayLines(width);
  }

  desiredHeight(width: number): number {
    return measureDisplayHeight(this.displayLines(width), width);
  }

  desiredTranscriptHeight(width: number): number {
    return measureDisplayHeight(this.transcriptLines(width), width);
  }

  toRecord(): HistoryCellRecord {
    return this.record;
  }

  cacheKey(): string {
    const { cell_id, revision, lifecycle } = this.record;
    return `${cell_id}:${revision}:${lifecycle}`;
  }

  protected abstract displayLinesForMode(width: number, mode: HistoryRenderMode): string[];
}