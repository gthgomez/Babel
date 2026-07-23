/**
 * Background warmup for the interactive REPL — reduces perceived cold-start latency.
 *
 * - Prefers compiled `dist/` entry (bin/babel.js already does).
 * - Optionally auto-spawns the background daemon when enabled.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function isDaemonWarmEnabled(): boolean {
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
 * Never throws — failures are logged to stderr only.
 */
export function warmReplRuntime(): void {
  const dist = resolveCompiledDist();
  if (!dist && process.env['NODE_ENV'] !== 'test') {
    console.error(
      '[babel] Tip: run "npm --prefix babel-cli run build" for faster REPL startup (compiled dist missing).',
    );
  }

  if (!isDaemonWarmEnabled()) {
    return;
  }

  void import('../daemon/client.js')
    .then(({ ensureDaemon }) => ensureDaemon())
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (process.env['BABEL_DAEMON_WARM_QUIET'] !== '1') {
        console.error(`[babel] Daemon warmup skipped: ${message}`);
      }
    });
}