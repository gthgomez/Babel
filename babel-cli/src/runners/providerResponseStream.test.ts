import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readStreamingResponse,
  type StreamingState,
} from './providerResponseStream.js';

function state(): StreamingState {
  return {
    ttftMs: null,
    generationMs: null,
    usage: null,
    observedModelId: null,
    upstreamProvider: null,
    routerMetadata: null,
    finishReason: null,
    partialModelOutput: false,
    outputReceipt: '',
    sawDone: false,
  };
}

function sseFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function read(text: string): Promise<{ text: string; state: StreamingState }> {
  const streamState = state();
  const startedAt = Date.now();
  const value = await readStreamingResponse(
    new Response(text, { headers: { 'content-type': 'text/event-stream' } }),
    undefined,
    1_000,
    startedAt,
    streamState,
    undefined,
    undefined,
    undefined,
    undefined,
    Date.now() + 5_000,
    5_000,
  );
  return { text: value, state: streamState };
}

test('a stop stream returns the answer', async () => {
  const result = await read(
    `${sseFrame({ content: 'grounded answer' }, 'stop')}data: [DONE]\n\n`,
  );
  assert.equal(result.text, 'grounded answer');
  assert.equal(result.state.finishReason, 'stop');
});

test('a missing finish reason fails while preserving partial output diagnostically', async () => {
  const streamState = state();
  await assert.rejects(
    readStreamingResponse(
      new Response(`${sseFrame({ content: 'partial prose' }, null)}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
      undefined,
      1_000,
      Date.now(),
      streamState,
      undefined,
      undefined,
      undefined,
      undefined,
      Date.now() + 5_000,
      5_000,
    ),
    /finish reason/i,
  );
  assert.equal(streamState.partialModelOutput, true);
  assert.match(streamState.outputReceipt, /partial prose/);
});

test('filtered and truncated text fails instead of becoming a completed answer', async () => {
  for (const finish of ['content_filter', 'recitation', 'length']) {
    const streamState = state();
    await assert.rejects(
      readStreamingResponse(
        new Response(`${sseFrame({ content: 'diagnostic text' }, finish)}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
        undefined,
        1_000,
        Date.now(),
        streamState,
        undefined,
        undefined,
        undefined,
        undefined,
        Date.now() + 5_000,
        5_000,
      ),
      new RegExp(finish === 'length' ? 'budget exhausted' : finish),
    );
    assert.equal(streamState.partialModelOutput, true);
    assert.match(streamState.outputReceipt, /diagnostic text/);
  }
});

test('an unknown finish reason fails rather than becoming a stop', async () => {
  await assert.rejects(
    read(
      `${sseFrame({ content: 'text' }, 'gateway_magic')}data: [DONE]\n\n`,
    ),
    /unrecognized finish reason/i,
  );
});

test('a stream that closes without [DONE] still fails as truncated', async () => {
  await assert.rejects(
    read(sseFrame({ content: 'text' }, 'stop')),
    /terminal \[DONE\] marker/i,
  );
});

test('conflicting text finishes cannot turn a truncated answer into success', async () => {
  await assert.rejects(
    read(`${sseFrame({ content: 'partial' }, 'length')}${sseFrame({}, 'stop')}data: [DONE]\n\n`),
    /conflicting provider stream finish reasons/i,
  );
});

test('cancellation from the text callback rejects a buffered completion marker', async () => {
  const controller = new AbortController();
  await assert.rejects(readStreamingResponse(
    new Response(`${sseFrame({ content: 'partial' }, 'stop')}data: [DONE]\n\n`),
    { onChunk: () => { controller.abort(); } },
    1_000, Date.now(), state(), undefined, undefined, undefined, controller.signal,
  ), { name: 'AbortError' });
});
