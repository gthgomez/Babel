/**
 * Latency-based TUI feature adapter.
 *
 * Reads the current latency bucket from SshLatencyDetector and provides
 * recommendations for frame rate, animation, and feature flags. The
 * recommendations can be applied to components at registration time.
 *
 * Usage:
 *   const recs = LatencyAdapter.getInstance().getRecommendations();
 *   scheduler.scheduleComponent('spinner', fn, { intervalMs: recs.frameIntervalMs });
 */

import { SshLatencyDetector, type LatencyBucket } from './latencyProbe.js';
import { FrameScheduler } from './frameScheduler.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LatencyRecommendations {
  /** Recommended minimum frame interval in ms. */
  frameIntervalMs: number;
  /** Whether spinner animation should be enabled. */
  enableSpinner: boolean;
  /** Whether mouse tracking should be enabled. */
  enableMouseTracking: boolean;
  /** Whether DEC 2026 sync update should be used. */
  enableSyncUpdate: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const BUCKET_INTERVALS: Record<LatencyBucket, number> = {
  local: 33, // ~30 FPS
  lan: 66, // ~15 FPS
  wan: 200, // ~5 FPS
};

const BUCKET_FEATURES: Record<LatencyBucket, Omit<LatencyRecommendations, 'frameIntervalMs'>> = {
  local: { enableSpinner: true, enableMouseTracking: true, enableSyncUpdate: true },
  lan: { enableSpinner: true, enableMouseTracking: true, enableSyncUpdate: true },
  wan: { enableSpinner: false, enableMouseTracking: false, enableSyncUpdate: false },
};

// ── LatencyAdapter ─────────────────────────────────────────────────────────

export class LatencyAdapter {
  private static instance: LatencyAdapter | null = null;

  private constructor() {}

  /** Get the singleton instance. */
  static getInstance(): LatencyAdapter {
    if (!LatencyAdapter.instance) {
      LatencyAdapter.instance = new LatencyAdapter();
    }
    return LatencyAdapter.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    LatencyAdapter.instance = null;
  }

  /** Get current recommendations based on detected latency. */
  getRecommendations(): LatencyRecommendations {
    const detector = SshLatencyDetector.getInstance();
    const bucket = detector.getBucket();
    return {
      frameIntervalMs: BUCKET_INTERVALS[bucket],
      ...BUCKET_FEATURES[bucket],
    };
  }

  /**
   * Whether the connection is too slow for rich TUI features.
   * Renderers should check this before enabling mouse tracking,
   * spinners, or other continuous-output features.
   */
  get isHighLatency(): boolean {
    return SshLatencyDetector.getInstance().getBucket() === 'wan';
  }

  /** Return a human-readable summary of the latency adaptation state. */
  getSummary(): string {
    const detector = SshLatencyDetector.getInstance();
    const recs = this.getRecommendations();
    return [
      `Latency: ${detector.getLatencySummary()}`,
      `  Frame interval: ${recs.frameIntervalMs}ms`,
      `  Spinner:        ${recs.enableSpinner ? 'enabled' : 'disabled'}`,
      `  Mouse:          ${recs.enableMouseTracking ? 'enabled' : 'disabled'}`,
      `  Sync update:    ${recs.enableSyncUpdate ? 'enabled' : 'disabled'}`,
    ].join('\n');
  }
}
