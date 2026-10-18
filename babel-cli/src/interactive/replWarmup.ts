/**
 * Background warmup for the interactive REPL — reduces perceived cold-start latency.
 *
 * - Prefers compiled `dist/` entry (bin/babel.js already does).
 * - Optionally auto-spawns the background daemon when enabled.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordInteractiveDiagnostic, interactiveDiagnosticPath } from '../ui/interactiveDiagnostics.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { redactSecrets } from '../utils/redaction.js';
import { sanitizeLlmOutput } from '../ui/sanitize.js';
import { getWarningRouteFailure } from '../cli/interactiveWarningRoute.js';

let pendingWarmup: Promise<unknown> | undefined;

/** Keep an actionable, redacted failure even when the diagnostic sink is unavailable. */
export function reportWarmupFailure(task: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const persisted = recordInteractiveDiagnostic('startup-error', message);
  backgroundTaskRegistry.fail(task, persisted
    ? `Unavailable. Diagnostics: ${interactiveDiagnosticPath()}`
    : `Unavailable: ${sanitizeLlmOutput(redactSecrets(message))} (diagnostic log unavailable)`);
}

/** Wait for warmup and stop its owned daemon before interactive exit. */
export async function stopReplWarmup(): Promise<void> {
  await pendingWarmup;
  const { stopOwnedDaemon } = await import('../daemon/client.js');
  await stopOwnedDaemon();
}

function isDaemonWarmEnabled(): boolean {
  if (process.env['NODE_ENV'] === 'test' || process.env['BABEL_TEST'] === '1') {
    return false;
  }
  const raw = process.env['BABEL_DAEMON_WARM']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
    return false;
  }
  // Default on for interactive REPL unless explicitly disabled.
  return true;
}

function resolveCompiledDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const distEntry = join(here, '..', '..', 'dist', 'index.js');
  return existsSync(distEntry) ? distEntry : null;
}

/**
 * Fire-and-forget warmup tasks for interactive sessions.
 * Never throws — diagnostics go to private files; failures get a scoped status.
 */
export function warmReplRuntime(): void {
  const warningFailure = getWarningRouteFailure();
  if (warningFailure) {
    const warningTask = backgroundTaskRegistry.register('Warning diagnostics');
    backgroundTaskRegistry.fail(warningTask, warningFailure);
  }
  const dist = resolveCompiledDist();
  if (!dist && process.env['NODE_ENV'] !== 'test') {
    recordInteractiveDiagnostic('startup',
      '[babel] Tip: run "npm --prefix babel-cli run build" for faster REPL startup (compiled dist missing).',
    );
  }

  if (!isDaemonWarmEnabled()) {
    return;
  }

  const task = backgroundTaskRegistry.register('Daemon startup');
  pendingWarmup = import('../daemon/client.js')
    .then(({ ensureDaemon }) => ensureDaemon({ onDiagnostic: recordInteractiveDiagnostic }))
    .then(() => backgroundTaskRegistry.complete(task))
    .catch((err: unknown) => reportWarmupFailure(task, err));
}
