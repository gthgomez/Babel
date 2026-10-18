import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeUserStateRoot } from '../config/runtimePaths.js';
import { redactSecrets } from '../utils/redaction.js';

/** Private local diagnostics. Never write asynchronous messages into a live composer. */
export function interactiveDiagnosticPath(): string {
  return join(resolveRuntimeUserStateRoot(), 'diagnostics', `interactive-${process.pid}.jsonl`);
}

export function recordInteractiveDiagnostic(channel: string, message: string): boolean {
  try {
    const file = interactiveDiagnosticPath();
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), channel,
      message: redactSecrets(message) }) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}
