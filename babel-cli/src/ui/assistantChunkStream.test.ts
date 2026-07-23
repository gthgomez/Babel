import assert from 'node:assert/strict';
import test from 'node:test';

import { BabelEventBus } from '../pipeline.js';
import { createAssistantChunkStream } from './assistantChunkStream.js';

test('assistant chunk stream emits visible text and bus events', () => {
  const bus = new BabelEventBus();
  const chunks: Array<{ chunk: string; turn_id?: number; field?: string }> = [];
  bus.on('assistant_chunk', (payload) => {
    chunks.push(payload);
  });

  const stream = createAssistantChunkStream({
    eventBus: bus,
    turnId: 3,
    onVisibleChunk: () => undefined,
  });

  stream.onChunk('{"answer":"Hel');
  stream.onChunk('lo"}');

  assert.equal(stream.getVisibleText(), 'Hello');
  // MultiFieldStreamExtractor emits per-character chunks with field metadata
  assert.ok(chunks.length > 0, 'should emit at least one chunk');
  assert.ok(
    chunks.every((c) => c.field === 'answer'),
    'all chunks should have field=answer',
  );
  assert.equal(chunks.map((c) => c.chunk).join(''), 'Hello');
});

test('multi-field stream extracts multiple fields independently', () => {
  const bus = new BabelEventBus();
  const answerChunks: string[] = [];
  const planChunks: string[] = [];

  const stream = createAssistantChunkStream({
    eventBus: bus,
    turnId: 1,
    fields: [
      { fieldName: 'answer', onChunk: (c) => answerChunks.push(c) },
      { fieldName: 'plan', onChunk: (c) => planChunks.push(c) },
    ],
  });

  stream.onChunk('{"answer":"Done","plan":"Step 1:');
  stream.onChunk(' read files"}');

  assert.equal(answerChunks.join(''), 'Done');
  assert.equal(planChunks.join(''), 'Step 1: read files');
  // answer is always extracted to visible text
  assert.equal(stream.getVisibleText(), 'Done');
});
