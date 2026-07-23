/**
 * Debug stats aggregator for TUI frame timing.
 *
 * Queries OutputBuffer and FrameScheduler singletons to produce a
 * human-readable summary. Useful for debug commands and performance
 * monitoring.
 */

import { FrameScheduler } from './frameScheduler.js';
import { OutputBuffer } from './outputBuffer.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DebugStats {
  /** Estimated frames per second based on recent frame intervals. */
  fps: number;
  /** Average render duration in ms across all recorded frames. */
  avgRenderMs: number;
  /** Total bytes written through the OutputBuffer. */
  totalBytesWritten: number;
  /** Bytes written in the most recent frame. */
  lastFrameBytes: number;
  /** Number of frames recorded in the metrics buffer. */
  recordedFrames: number;
  /** Whether the FrameScheduler is actively running. */
  isRunning: boolean;
}

// ── Collection ─────────────────────────────────────────────────────────────

/**
 * Collect current debug stats from the active singletons.
 * Safe to call at any time — handles missing singletons gracefully.
 */
export function collectDebugStats(): DebugStats {
  const fs = FrameScheduler.getInstance();
  const ob = OutputBuffer.getInstance();
  const latest = fs.getLatestMetrics();
  const history = fs.getFrameHistory();

  // Estimate FPS from the last two frames if available
  let fps = 0;
  if (history.length >= 2) {
    const last = history[history.length - 1]!;
    const prev = history[history.length - 2]!;
    const delta = last.tickTime - prev.tickTime;
    if (delta > 0) {
      fps = Math.round(1000 / delta);
    }
  }

  return {
    fps,
    avgRenderMs: fs.getAverageRenderDuration(),
    totalBytesWritten: ob.totalBytesWritten,
    lastFrameBytes: ob.lastFrameBytes,
    recordedFrames: history.length,
    isRunning: fs.isRunning(),
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format debug stats as a human-readable multi-line string.
 */
export function formatDebugStats(stats: DebugStats): string {
  const kb = (bytes: number) => (bytes / 1024).toFixed(1);
  return [
    `Frame stats: ${stats.fps} FPS | avg ${stats.avgRenderMs.toFixed(1)}ms render | ${stats.recordedFrames} frames`,
    `Output:     ${kb(stats.totalBytesWritten)}KB written | ${kb(stats.lastFrameBytes)}KB last frame`,
    `Scheduler:  ${stats.isRunning ? 'running' : 'stopped'}`,
  ].join('\n');
}

/**
 * One-shot: collect and format current debug stats.
 */
export function getFrameStats(): string {
  return formatDebugStats(collectDebugStats());
}
