/**
 * Ring buffer of last-N tool observation tails for postmortem export.
 * Stores only on terminal payload — never re-injected into model context.
 */

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_TAIL_CHARS = 2048;

// Common secret patterns to redact
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/([A-Za-z0-9+/]{40,}={0,2})/g, '[REDACTED_TOKEN]'],
  [/(sk-[A-Za-z0-9]{20,})/gi, '[REDACTED_API_KEY]'],
  [/(AIza[0-9A-Za-z\-_]{35})/g, '[REDACTED_API_KEY]'],
  [/(-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----)/g, '[REDACTED_PRIVATE_KEY]'],
  [/(eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)/g, '[REDACTED_JWT]'],
];

export interface ObservationTailEntry {
  tool: string;
  target: string;
  exit_code?: number;
  tail: string;  // truncated + redacted
}

export interface ObservationTailsOptions {
  maxEntries?: number;
  tailChars?: number;
}

export class ObservationTailBuffer {
  private buffer: ObservationTailEntry[] = [];
  private readonly maxEntries: number;
  private readonly tailChars: number;

  constructor(opts?: ObservationTailsOptions) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.tailChars = opts?.tailChars ?? DEFAULT_TAIL_CHARS;
  }

  /** Record a completed tool observation. Skips empty stdout/stderr. */
  record(tool: string, target: string, observation: string, exitCode?: number): void {
    const trimmed = observation.trim();
    if (!trimmed) return;

    const tail = this.redactAndTruncate(trimmed);

    this.buffer.push({ tool, target, ...(exitCode !== undefined ? { exit_code: exitCode } : {}), tail });
    // Keep only last N
    if (this.buffer.length > this.maxEntries) {
      this.buffer = this.buffer.slice(-this.maxEntries);
    }
  }

  all(): ReadonlyArray<ObservationTailEntry> {
    return this.buffer;
  }

  toJSON(): ObservationTailEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  private redactAndTruncate(text: string): string {
    let result = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    if (result.length > this.tailChars) {
      result = '…' + result.slice(-(this.tailChars - 1));
    }
    return result;
  }
}

/** Config from env: BABEL_CHAT_OBSERVATION_TAIL_CHARS (default 2048). */
export function resolveObservationTailChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['BABEL_CHAT_OBSERVATION_TAIL_CHARS']?.trim();
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TAIL_CHARS;
}
