import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { redactSecrets } from '../utils/redaction.js';
import { sanitizeLlmOutput } from '../ui/sanitize.js';

/** Retain bounded, safe startup context even when the optional log sink fails. */
export function createDaemonStartupDiagnostics(sink: (channel: 'stdout' | 'stderr' | 'status', message: string) => void): {
  receive: (channel: 'stdout' | 'stderr' | 'status', message: string) => void;
  failureMessage: (summary: string) => string;
} {
  let first = '';
  let tail = '';
  return {
    receive(channel, message) {
      if (channel === 'stderr') {
        const safe = sanitizeLlmOutput(redactSecrets(message)).trim();
        if (!first) first = safe.slice(0, 1024);
        tail = (tail + '\n' + safe).slice(-2048);
      }
      sink(channel, message);
    },
    failureMessage(summary) {
      const context = first && tail.trim() === first ? first : [first, tail.trim()].filter(Boolean).join('\n');
      return context ? `${summary} Daemon error: ${context}` : summary;
    },
  };
}

/** Reassemble transport chunks before redaction/persistence, including UTF-8. */
export function attachDaemonDiagnosticStream(
  stream: Readable | null,
  channel: 'stdout' | 'stderr',
  sink: (channel: 'stdout' | 'stderr', line: string) => void,
): void {
  if (!stream) return;
  const lines = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });
  lines.on('line', (line) => sink(channel, line));
}
