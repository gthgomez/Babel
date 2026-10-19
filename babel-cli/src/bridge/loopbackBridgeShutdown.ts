/**
 * Signal-driven graceful shutdown for long-running loopback bridge CLIs.
 * Closes WebSocket transports before `server.close()` via `BridgeServer.stop()`.
 */

import type { BridgeServer } from './sessionServer.js';

const SHUTDOWN_BUDGET_MS = 8_000;

/**
 * Keep the CLI process alive until SIGINT/SIGTERM, then stop the owned server
 * within a bounded budget and exit (turn cancellation is owned by sessionRunner).
 */
export async function awaitLoopbackBridgeUntilSignal(server: BridgeServer): Promise<void> {
  let shuttingDown = false;

  const finish = async (_signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => {
      process.exitCode = 1;
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    try {
      await server.stop();
      clearTimeout(forceTimer);
      process.exitCode = 0;
      process.exit(0);
    } catch {
      clearTimeout(forceTimer);
      process.exitCode = 1;
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void finish('SIGINT');
  });
  process.once('SIGTERM', () => {
    void finish('SIGTERM');
  });

  await new Promise<void>(() => {
    /* held open by the listening server until a signal arrives */
  });
}
