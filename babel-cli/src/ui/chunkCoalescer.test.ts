/**
 * Tests for ChunkCoalescer — batching + G5 arrival-timestamp metrics.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkCoalescer, type BatchFlushMetrics } from './chunkCoalescer.js';

describe('ChunkCoalescer', () => {
  it('coalesces multiple pushes into one flush after the window', async () => {
    const flushed: string[] = [];
    const c = new ChunkCoalescer((batch: string) => {
      flushed.push(batch);
    }, 20);

    c.push('a');
    c.push('b');
    c.push('c');
    assert.equal(c.pending, true);
    assert.deepEqual(flushed, []);

    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(flushed, ['abc']);
    assert.equal(c.pending, false);
    c.dispose();
  });

  it('flush() forces immediate emit and clears pending', () => {
    const flushed: string[] = [];
    const c = new ChunkCoalescer((batch: string) => {
      flushed.push(batch);
    }, 1000);

    c.push('hello');
    c.push(' world');
    c.flush();
    assert.deepEqual(flushed, ['hello world']);
    assert.equal(c.pending, false);
    c.dispose();
  });

  it('records G5 metrics with injectable clock', () => {
    let t = 1000;
    const metricsLog: BatchFlushMetrics[] = [];
    const c = new ChunkCoalescer(
      () => {
        /* noop */
      },
      {
        batchWindowMs: 50,
        now: () => t,
        onMetrics: (m) => metricsLog.push(m),
      },
    );

    c.push('a'); // t=1000
    t = 1005;
    c.push('bb'); // t=1005
    t = 1012;
    c.push('ccc'); // t=1012
    t = 1030;
    c.flush();

    assert.equal(metricsLog.length, 1);
    const m = metricsLog[0]!;
    assert.equal(m.chunkCount, 3);
    assert.equal(m.totalChars, 6);
    assert.equal(m.firstArrivalMs, 1000);
    assert.equal(m.lastArrivalMs, 1012);
    assert.equal(m.flushedAtMs, 1030);
    assert.equal(m.timeInBufferMs, 30);
    assert.equal(m.maxInterChunkGapMs, 7); // max(5, 7)
    assert.deepEqual(c.lastMetrics, m);
    c.dispose();
  });

  it('single-chunk batch has zero inter-chunk gap', () => {
    let t = 50;
    const metricsLog: BatchFlushMetrics[] = [];
    const c = new ChunkCoalescer(() => {}, {
      now: () => t,
      onMetrics: (m) => {
        metricsLog.push(m);
      },
    });

    c.push('x');
    t = 60;
    c.flush();

    assert.equal(metricsLog.length, 1);
    assert.equal(metricsLog[0]!.chunkCount, 1);
    assert.equal(metricsLog[0]!.maxInterChunkGapMs, 0);
    assert.equal(metricsLog[0]!.timeInBufferMs, 10);
    c.dispose();
  });

  it('drain discards without calling onFlush or onMetrics', () => {
    const onFlush = mock.fn();
    const onMetrics = mock.fn();
    const c = new ChunkCoalescer(onFlush, { onMetrics, batchWindowMs: 100 });
    c.push('lost');
    c.drain();
    assert.equal(onFlush.mock.callCount(), 0);
    assert.equal(onMetrics.mock.callCount(), 0);
    assert.equal(c.pending, false);
    c.dispose();
  });

  it('dispose prevents further pushes', () => {
    const flushed: string[] = [];
    const c = new ChunkCoalescer((b: string) => flushed.push(b), 10);
    c.dispose();
    c.push('nope');
    c.flush();
    assert.deepEqual(flushed, []);
  });

  it('ignores empty chunks', () => {
    let t = 0;
    const metricsLog: BatchFlushMetrics[] = [];
    const c = new ChunkCoalescer(() => {}, {
      now: () => t,
      onMetrics: (m) => {
        metricsLog.push(m);
      },
    });
    c.push('');
    c.push('a');
    t = 5;
    c.push('');
    c.flush();
    assert.equal(metricsLog.length, 1);
    assert.equal(metricsLog[0]!.chunkCount, 1);
    assert.equal(metricsLog[0]!.totalChars, 1);
    c.dispose();
  });

  it('swallows onFlush errors to keep stream alive', () => {
    const c = new ChunkCoalescer(() => {
      throw new Error('boom');
    }, 10);
    c.push('x');
    assert.doesNotThrow(() => c.flush());
    c.dispose();
  });
});
