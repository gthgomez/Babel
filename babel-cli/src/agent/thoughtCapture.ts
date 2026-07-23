/**
 * B1: Thought/deliberation capture for postmortem observability.
 *
 * When BABEL_CHAT_CAPTURE_THOUGHTS=1, appends provider thought_delta /
 * thinking chunks to thoughts.jsonl under the session run_dir. Never
 * re-injects thoughts into the model context.
 *
 * DeepSeek constraint: thinking+tools = HTTP 400. Tool streams remain
 * thinking-off by default (BABEL_DEEPSEEK_THINKING_WITH_TOOLS must
 * explicitly be "1" to enable — do not change the default).
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTruthyEnvFlag } from '../utils/envFlags.js';

export interface ThoughtCaptureEntry {
  turn: number;
  ts: string;
  text: string;
}

export class ThoughtCaptureWriter {
  private readonly _path: string;
  readonly enabled: boolean;

  constructor(runDir: string) {
    this.enabled = isTruthyEnvFlag(process.env['BABEL_CHAT_CAPTURE_THOUGHTS']);
    this._path = join(runDir, 'thoughts.jsonl');
  }

  /** Append one thought chunk to the JSONL file. No-op when disabled. */
  capture(turn: number, text: string): void {
    if (!this.enabled) return;
    const line: ThoughtCaptureEntry = { turn, ts: new Date().toISOString(), text };
    appendFileSync(this._path, JSON.stringify(line) + '\n', 'utf-8');
  }
}

// ── Module-level singleton for chatEngine wire-in ────

const _writers = new Map<string, ThoughtCaptureWriter>();

/**
 * Capture a thought chunk for the given run directory.
 * Lazily creates a writer on first call per runDir.
 * No-op when BABEL_CHAT_CAPTURE_THOUGHTS is not truthy.
 */
export function captureThought(runDir: string, turn: number, text: string): void {
  let writer = _writers.get(runDir);
  if (!writer) {
    writer = new ThoughtCaptureWriter(runDir);
    _writers.set(runDir, writer);
  }
  writer.capture(turn, text);
}
