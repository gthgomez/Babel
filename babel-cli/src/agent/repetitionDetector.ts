/**
 * repetitionDetector.ts — Safety net for text-tools path.
 *
 * Problem: Gemma3:4b wrote the same file 18 times in a loop because it never
 * got confirmation that its writes succeeded. Even with feedback feeding, we
 * need a circuit breaker that detects when the model calls the same tool with
 * the same parameters repeatedly.
 *
 * Works across both text-tools and native-tools paths.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface ToolCallFingerprint {
  /** Tool name (e.g. "write_file", "read_file", "run_command"). */
  type: string;
  /** Key params joined as "{type}:{target}" — e.g. "write_file:foo.ts". */
  fingerprint: string;
}

export interface LoopDetectionResult {
  loop: boolean;
  /** Set when loop === true — the tool name being repeated. */
  tool?: string;
  /** Set when loop === true — how many consecutive identical calls. */
  count?: number;
  /** Human-readable description, e.g. "Same write_file to foo.ts repeated 5 times". */
  message?: string;
}

// ─── RepetitionDetector ──────────────────────────────────────────────────

export class RepetitionDetector {
  private readonly maxHistory: number;
  private history: ToolCallFingerprint[];

  /**
   * @param maxHistory Maximum number of recent tool calls to retain.
   *                   Default 10. Must be >= 3 to detect loops.
   */
  constructor(maxHistory = 10) {
    this.maxHistory = Math.max(maxHistory, 3);
    this.history = [];
  }

  /**
   * Record a tool call. Oldest entries are dropped when the ring buffer
   * exceeds maxHistory.
   */
  record(action: ToolCallFingerprint): void {
    this.history.push(action);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Check whether the last 3+ recorded calls are identical (same type AND
   * same fingerprint). When the history has fewer than 3 entries, always
   * returns { loop: false }.
   */
  detect(): LoopDetectionResult {
    if (this.history.length < 3) {
      return { loop: false };
    }

    const last = this.history[this.history.length - 1]!;

    // Count consecutive identical fingerprints starting from the end.
    let count = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      const entry = this.history[i]!;
      if (entry.type === last.type && entry.fingerprint === last.fingerprint) {
        count++;
      } else {
        break;
      }
    }

    if (count >= 3) {
      const targetPart = last.fingerprint.substring(last.fingerprint.indexOf(':') + 1);
      const targetDisplay = targetPart ? ` to ${targetPart}` : '';
      return {
        loop: true,
        tool: last.type,
        count,
        message: `Same ${last.type}${targetDisplay} repeated ${count} times`,
      };
    }

    return { loop: false };
  }

  /** Clear all recorded history. */
  reset(): void {
    this.history = [];
  }

  /** Return a copy of the current history (useful for debugging/diagnostics). */
  getHistory(): ToolCallFingerprint[] {
    return [...this.history];
  }
}

/**
 * Build a ToolCallFingerprint from a raw tool type and its key parameter.
 *
 * This is a convenience helper for callers that already extracted the
 * tool name and target from their action representation.
 *
 * @param type  Tool name (e.g. "write_file", "run_command").
 * @param target The primary parameter value (path, pattern, command, etc.).
 */
export function buildFingerprint(type: string, target: string): string {
  return `${type}:${target}`;
}
