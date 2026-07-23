/**
 * streamingVcr.ts — VCR (Video Cassette Recorder) for deterministic streaming tests
 *
 * Provides record and playback modes for SSE streaming responses, controlled
 * by environment variables:
 *
 *   BABEL_VCR_MODE  - "record" | "playback" | "off" (default: "off")
 *   BABEL_VCR_FILE  - Path to the fixture file (e.g. "fixtures/my-stream.jsonl")
 *
 * In RECORD mode: captures SSE `data:` lines and writes them (one per line) to
 *   a fixture file. Each line is a complete SSE data payload, stored verbatim
 *   (e.g. `data: {"choices":[{"delta":{"content":"Hello"}}]}`).
 *
 * In PLAYBACK mode: reads the fixture file and yields the stored SSE lines
 *   instead of making real HTTP calls. The caller processes each line through
 *   the same SSE parsing logic used in normal streaming.
 *
 * In OFF mode: no-op — normal HTTP-based streaming proceeds unchanged.
 *
 * Usage (during VCR recording):
 *   BABEL_VCR_MODE=record BABEL_VCR_FILE=fixtures/test-run.jsonl npm run dev
 *
 * Usage (during VCR playback):
 *   BABEL_VCR_MODE=playback BABEL_VCR_FILE=fixtures/test-run.jsonl npm run test:unit
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

// ─── Types ─────────────────────────────────────────────────────────────────

export type VcrMode = 'record' | 'playback' | 'off';

export interface VcrConfig {
  mode: VcrMode;
  filePath: string | null;
}

// ─── Configuration ─────────────────────────────────────────────────────────

const VALID_MODES = new Set<string>(['record', 'playback', 'off']);

/**
 * Read VCR configuration from environment variables.
 */
export function getVcrConfig(): VcrConfig {
  const rawMode = process.env['BABEL_VCR_MODE'] ?? 'off';
  const mode = VALID_MODES.has(rawMode) ? (rawMode as VcrMode) : 'off';
  const filePath = process.env['BABEL_VCR_FILE'] ?? null;
  return { mode, filePath };
}

// ─── VCR Recorder ──────────────────────────────────────────────────────────

/**
 * Records SSE data lines to a fixture file.
 *
 * One instance should handle one streaming session. The file is opened
 * with the `'w'` flag, so it is created or truncated on construction.
 * Call {@link close} when recording is complete to flush and release the
 * file handle.
 */
export class VcrRecorder {
  private stream: WriteStream;
  private closed = false;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, {
      flags: 'w',
      encoding: 'utf-8',
    });
  }

  /**
   * Record a single SSE data line (e.g. `data: {"choices":[...]}`).
   * The line is written to the fixture file followed by a newline.
   * Calling record() after close() is a no-op.
   */
  record(line: string): void {
    if (this.closed) return;
    this.stream.write(line + '\n');
  }

  /**
   * Close the output file. Must be called to flush and release the file handle.
   * Calling close() multiple times is safe — subsequent calls are no-ops.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.end();
  }
}

// ─── VCR Player ────────────────────────────────────────────────────────────

/**
 * Reads a fixture file previously recorded by {@link VcrRecorder}.
 *
 * Returns the SSE data lines in order. Each line is a verbatim SSE payload
 * (e.g. `data: {"choices":[{"delta":{"content":"Hello"}}]}` or
 * `data: [DONE]`).
 */
export class VcrPlayer {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read all recorded SSE data lines from the fixture file.
   * Returns lines as they were recorded, including the `data: ` prefix.
   * Empty lines are filtered out.
   *
   * Throws if the file does not exist or cannot be read.
   */
  async readAllLines(): Promise<string[]> {
    const content = await readFile(this.filePath, 'utf-8');
    return content.split('\n').filter((line) => line.length > 0);
  }
}

// ─── Factory functions ─────────────────────────────────────────────────────

/**
 * Create a {@link VcrRecorder} if BABEL_VCR_MODE is "record".
 *
 * Returns `null` when VCR is not in record mode, or when BABEL_VCR_FILE
 * is not set (with a console warning).
 */
export function createVcrRecorder(): VcrRecorder | null {
  const { mode, filePath } = getVcrConfig();
  if (mode !== 'record') return null;
  if (!filePath) {
    console.warn(
      '[streamingVcr] BABEL_VCR_MODE=record but BABEL_VCR_FILE is not set. VCR disabled.',
    );
    return null;
  }
  return new VcrRecorder(filePath);
}

/**
 * Create a {@link VcrPlayer} if BABEL_VCR_MODE is "playback".
 *
 * Returns `null` when VCR is not in playback mode, or when BABEL_VCR_FILE
 * is not set (with a console warning).
 */
export function createVcrPlayer(): VcrPlayer | null {
  const { mode, filePath } = getVcrConfig();
  if (mode !== 'playback') return null;
  if (!filePath) {
    console.warn(
      '[streamingVcr] BABEL_VCR_MODE=playback but BABEL_VCR_FILE is not set. VCR disabled.',
    );
    return null;
  }
  return new VcrPlayer(filePath);
}
