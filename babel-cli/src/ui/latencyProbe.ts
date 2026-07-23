/**
 * SSH latency detector for the Babel TUI.
 *
 * Detects whether the session is running over SSH and, when on a TTY,
 * measures round-trip time via DSR (Device Status Report) probes.
 * Classifies connections into latency buckets used by LatencyAdapter
 * to tune frame rates and disable expensive features on slow links.
 *
 * DSR probe: sends \x1b[6n, terminal responds with \x1b[<row>;<col>R.
 * We time the response to estimate network RTT. Falls back to null on
 * non-TTY (piped stdin) or if the terminal doesn't respond.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Latency bucket based on measured or inferred RTT. */
export type LatencyBucket = 'local' | 'lan' | 'wan';

/** Result of a latency measurement. */
export interface LatencyResult {
  /** Measured round-trip time in milliseconds. */
  rttMs: number;
  /** When the measurement was taken (Date.now()). */
  measuredAt: number;
  /** Classification bucket. */
  bucket: LatencyBucket;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DSR_PROBE_TIMEOUT_MS = 2000;
const DSR_PROBE_RETRIES = 3;

// ── SshLatencyDetector ─────────────────────────────────────────────────────

export class SshLatencyDetector {
  private static instance: SshLatencyDetector | null = null;

  private _rtt: number | null = null;
  private _rttMeasuredAt: number = 0;
  private _isSsh: boolean;

  private constructor() {
    this._isSsh = SshLatencyDetector.detectSsh();
  }

  /** Get the singleton instance. */
  static getInstance(): SshLatencyDetector {
    if (!SshLatencyDetector.instance) {
      SshLatencyDetector.instance = new SshLatencyDetector();
    }
    return SshLatencyDetector.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    SshLatencyDetector.instance = null;
  }

  /** Detect whether running over SSH via environment variables. */
  static detectSsh(): boolean {
    return !!(process.env['SSH_CLIENT'] || process.env['SSH_TTY'] || process.env['SSH_CONNECTION']);
  }

  /** Whether the session is running over SSH. */
  get isSsh(): boolean {
    return this._isSsh;
  }

  /** Most recent measured RTT in ms, or null if not measured. */
  get rtt(): number | null {
    return this._rtt;
  }

  /** Timestamp of the most recent measurement. */
  get rttMeasuredAt(): number {
    return this._rttMeasuredAt;
  }

  /**
   * Classify the current connection into a latency bucket.
   * - local:  < 5ms RTT (or not yet measured on a local connection)
   * - lan:    5–50ms RTT
   * - wan:    > 50ms RTT (or SSH with unknown RTT)
   */
  getBucket(): LatencyBucket {
    if (this._rtt === null) {
      return this._isSsh ? 'wan' : 'local';
    }
    if (this._rtt < 5) return 'local';
    if (this._rtt < 50) return 'lan';
    return 'wan';
  }

  /**
   * Measure RTT by sending DSR probes and timing the terminal response.
   * Returns the average RTT in ms, or null if the probe failed.
   *
   * Only works when stdin is a TTY. On non-TTY (CI, pipes), returns null
   * immediately without blocking.
   */
  async measureRtt(): Promise<number | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return null;
    }

    let totalRtt = 0;
    let successful = 0;

    for (let attempt = 0; attempt < DSR_PROBE_RETRIES; attempt++) {
      const rtt = await this.singleProbe();
      if (rtt !== null) {
        totalRtt += rtt;
        successful++;
      }
    }

    if (successful === 0) return null;

    const avgRtt = Math.round(totalRtt / successful);
    this._rtt = avgRtt;
    this._rttMeasuredAt = Date.now();
    return avgRtt;
  }

  /**
   * Send a single DSR probe and return the RTT.
   * Writes \x1b[6n to stdout, waits for \x1b[<row>;<col>R on stdin.
   * Times out after DSR_PROBE_TIMEOUT_MS.
   */
  private singleProbe(): Promise<number | null> {
    return new Promise((resolve) => {
      const startTime = performance.now();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let cleanup: (() => void) | null = null;

      const handler = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        // Terminal cursor position report: \x1b[<row>;<col>R
        if (text.includes('\x1b[') && text.includes('R')) {
          const rtt = performance.now() - startTime;
          cleanup?.();
          if (timeout) clearTimeout(timeout);
          resolve(Math.round(rtt));
        }
      };

      cleanup = () => {
        process.stdin.off('data', handler);
      };

      timeout = setTimeout(() => {
        cleanup?.();
        resolve(null);
      }, DSR_PROBE_TIMEOUT_MS);

      process.stdin.on('data', handler);
      // Raw stdout write: this is a DSR (Device Status Report) probe that
      // requires an immediate response from the terminal. It participates in
      // a synchronous read-response timing cycle (measureRtt). Routing through
      // OutputBuffer could delay the write if a frame is active, skewing the
      // RTT measurement. OutputBuffer's a11y stripping is intentionally
      // bypassed — the probe is terminal protocol, not user-facing output.
      process.stdout.write('\x1b[6n');
    });
  }

  /**
   * Return a human-readable latency summary.
   */
  getLatencySummary(): string {
    const bucket = this.getBucket();
    const labels: Record<LatencyBucket, string> = {
      local: 'Local',
      lan: 'LAN',
      wan: 'WAN',
    };
    const rttStr = this._rtt !== null ? `${this._rtt}ms` : 'not measured';
    const sshStr = this._isSsh ? ' (SSH)' : '';
    return `${labels[bucket]} ${rttStr}${sshStr}`;
  }
}
