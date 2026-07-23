/**
 * Streaming chunk coalescer for the Babel TUI.
 *
 * LLM streaming responses arrive in small chunks (often 1-10 bytes each at
 * 30-60 chunks/second). Writing each chunk directly to the terminal causes
 * excessive render calls, TTY syscalls, and CPU waste. This coalescer
 * buffers incoming chunks and flushes them in batches every `batchWindowMs`
 * (default 16ms — ~60 FPS), reducing terminal writes by 10-30× with no
 * perceptible latency increase.
 *
 * G5 — per-chunk arrival timestamps:
 *   Each push records performance.now() so flush metrics expose time-in-buffer,
 *   inter-chunk gaps, and batch size for latency profiling. Enable logging with
 *   BABEL_STREAM_LATENCY=1 (or pass onMetrics in options).
 *
 * Usage:
 *   const coalescer = new ChunkCoalescer((batch) => process.stdout.write(batch));
 *   coalescer.push(chunk1);
 *   coalescer.push(chunk2);
 *   // ... 16ms later, both chunks are flushed together
 *   coalescer.flush(); // force flush remaining
 *   coalescer.dispose(); // clean up timer
 *
 * @module chunkCoalescer
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Latency accounting for one flushed batch (G5). */
export interface BatchFlushMetrics {
  /** Number of push() calls coalesced into this batch. */
  chunkCount: number;
  /** Total UTF-16 code units in the flushed batch string. */
  totalChars: number;
  /** performance.now() of the first chunk in this batch. */
  firstArrivalMs: number;
  /** performance.now() of the last chunk in this batch. */
  lastArrivalMs: number;
  /** performance.now() when flush ran. */
  flushedAtMs: number;
  /** flushedAtMs - firstArrivalMs (time first chunk waited in buffer). */
  timeInBufferMs: number;
  /** Max gap between consecutive chunk arrivals in this batch (0 if single). */
  maxInterChunkGapMs: number;
}

export type FlushCallback = (batch: string, metrics: BatchFlushMetrics) => void;

export interface ChunkCoalescerOptions {
  /** Max time to buffer before flushing (default 16ms, clamped 1–100). */
  batchWindowMs?: number;
  /**
   * Optional metrics sink. Always invoked on successful flush.
   * Prefer this over env logging for tests and structured telemetry.
   */
  onMetrics?: (metrics: BatchFlushMetrics) => void;
  /**
   * Force latency logging regardless of BABEL_STREAM_LATENCY.
   * When omitted, env BABEL_STREAM_LATENCY=1 enables stderr logs.
   */
  logLatency?: boolean;
  /** Injectable clock for tests (defaults to performance.now). */
  now?: () => number;
}

// ─── ChunkCoalescer ─────────────────────────────────────────────────────────

export class ChunkCoalescer {
  private buffer: string[] = [];
  /** Arrival times aligned with buffer entries (performance.now units). */
  private arrivals: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchWindowMs: number;
  private readonly onFlush: FlushCallback;
  private readonly onMetrics: ((metrics: BatchFlushMetrics) => void) | undefined;
  private readonly logLatency: boolean;
  private readonly now: () => number;
  private disposed = false;
  private _lastMetrics: BatchFlushMetrics | null = null;

  /**
   * @param onFlush  Called with the accumulated text when a batch is flushed.
   *                 Second arg is always the batch metrics (G5).
   * @param batchWindowMsOrOptions  Window ms (legacy) or options object.
   */
  constructor(
    onFlush: FlushCallback | ((batch: string) => void),
    batchWindowMsOrOptions: number | ChunkCoalescerOptions = 16,
  ) {
    // Accept legacy (batch: string) => void and new FlushCallback interchangeably.
    this.onFlush = (batch, metrics) => {
      (onFlush as FlushCallback)(batch, metrics);
    };

    if (typeof batchWindowMsOrOptions === 'number') {
      this.batchWindowMs = Math.max(1, Math.min(batchWindowMsOrOptions, 100));
      this.onMetrics = undefined;
      this.logLatency = process.env['BABEL_STREAM_LATENCY'] === '1';
      this.now = () => performance.now();
    } else {
      const opts = batchWindowMsOrOptions;
      this.batchWindowMs = Math.max(1, Math.min(opts.batchWindowMs ?? 16, 100));
      this.onMetrics = opts.onMetrics;
      this.logLatency =
        opts.logLatency ?? process.env['BABEL_STREAM_LATENCY'] === '1';
      this.now = opts.now ?? (() => performance.now());
    }
  }

  /** Metrics from the most recent successful flush, or null if none yet. */
  get lastMetrics(): BatchFlushMetrics | null {
    return this._lastMetrics;
  }

  /** Push a new chunk into the buffer. Schedules a flush if not already pending. */
  push(chunk: string): void {
    if (this.disposed) return;
    if (!chunk) return;

    this.buffer.push(chunk);
    this.arrivals.push(this.now());

    // Schedule flush on first chunk of a new batch
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchWindowMs);
    }
  }

  /** Flush all buffered chunks immediately and cancel any pending timer. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const batch = this.buffer.join('');
    const arrivals = this.arrivals;
    this.buffer = [];
    this.arrivals = [];

    if (batch.length === 0) return;

    const flushedAtMs = this.now();
    const firstArrivalMs = arrivals[0] ?? flushedAtMs;
    const lastArrivalMs = arrivals[arrivals.length - 1] ?? flushedAtMs;
    let maxInterChunkGapMs = 0;
    for (let i = 1; i < arrivals.length; i++) {
      const gap = (arrivals[i] ?? 0) - (arrivals[i - 1] ?? 0);
      if (gap > maxInterChunkGapMs) maxInterChunkGapMs = gap;
    }

    const metrics: BatchFlushMetrics = {
      chunkCount: arrivals.length,
      totalChars: batch.length,
      firstArrivalMs,
      lastArrivalMs,
      flushedAtMs,
      timeInBufferMs: flushedAtMs - firstArrivalMs,
      maxInterChunkGapMs,
    };
    this._lastMetrics = metrics;

    if (this.onMetrics) {
      try {
        this.onMetrics(metrics);
      } catch {
        // never break the stream on metrics sink errors
      }
    }

    if (this.logLatency) {
      try {
        process.stderr.write(
          `[stream-latency] chunks=${metrics.chunkCount} chars=${metrics.totalChars} ` +
            `bufferMs=${metrics.timeInBufferMs.toFixed(2)} ` +
            `maxGapMs=${metrics.maxInterChunkGapMs.toFixed(2)}\n`,
        );
      } catch {
        // ignore broken stderr
      }
    }

    try {
      this.onFlush(batch, metrics);
    } catch {
      // Swallow callback errors to keep the stream alive
    }
  }

  /** Cancel pending timer and clear buffer. Safe to call multiple times. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.arrivals = [];
  }

  /**
   * Discard all buffered chunks without calling the flush callback.
   * Use when pending content is about to be replaced (e.g., during a
   * terminal resize reflow) and writing it would cause a visible flash.
   */
  drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.arrivals = [];
  }

  /** Whether there are pending chunks waiting to be flushed. */
  get pending(): boolean {
    return this.buffer.length > 0;
  }
}
