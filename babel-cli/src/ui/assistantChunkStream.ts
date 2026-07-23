import type { BabelEventBus } from '../pipeline.js';
import { MultiFieldStreamExtractor } from '../runners/base.js';

export interface AssistantChunkStreamField {
  fieldName: string;
  onChunk: (chunk: string) => void;
}

export interface AssistantChunkStreamOptions {
  eventBus?: BabelEventBus;
  turnId?: number;
  /** Single-field convenience (backward compat). Writes to answer accumulator. */
  onVisibleChunk?: (chunk: string) => void;
  /** Multi-field extraction: extract any top-level string field from the stream. */
  fields?: AssistantChunkStreamField[];
}

export function createAssistantChunkStream(options: AssistantChunkStreamOptions = {}): {
  onChunk: (chunk: string) => void;
  onStreamReset: () => void;
  getVisibleText: () => string;
} {
  const visibleChunks: string[] = [];

  const emitAnswerChunk = (chunk: string): void => {
    if (!chunk) return;
    visibleChunks.push(chunk);
    options.onVisibleChunk?.(chunk);
    options.eventBus?.emit('assistant_chunk', { chunk, turn_id: options.turnId, field: 'answer' });
  };

  // Build field callback map. 'answer' always accumulates to visibleChunks.
  const fieldMap = new Map<string, (chunk: string) => void>();
  const userAnswerCallback = options.fields?.find((f) => f.fieldName === 'answer')?.onChunk;

  // Answer always accumulates to visible text + fires user callback if provided
  fieldMap.set('answer', (chunk: string) => {
    if (!chunk) return;
    visibleChunks.push(chunk);
    options.onVisibleChunk?.(chunk);
    userAnswerCallback?.(chunk);
    options.eventBus?.emit('assistant_chunk', { chunk, turn_id: options.turnId, field: 'answer' });
  });

  // Additional non-answer fields from options.fields
  if (options.fields) {
    for (const f of options.fields) {
      if (f.fieldName === 'answer') continue; // already handled above
      fieldMap.set(f.fieldName, (chunk: string) => {
        if (!chunk) return;
        f.onChunk(chunk);
        options.eventBus?.emit('assistant_chunk', {
          chunk,
          turn_id: options.turnId,
          field: f.fieldName,
        });
      });
    }
  }

  const extractor = new MultiFieldStreamExtractor(fieldMap);

  return {
    onChunk: (chunk: string) => {
      extractor.feedText(chunk);
    },
    onStreamReset: () => {
      visibleChunks.length = 0;
    },
    getVisibleText: () => visibleChunks.join(''),
  };
}
