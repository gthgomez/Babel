/**
 * Signal-driven graceful shutdown for long-running loopback bridge CLIs.
 * Closes WebSocket transports before `server.close()` via `BridgeServer.stop()`.
 */

import type { BridgeServer } from './sessionServer.js';

/**
 * Keep the CLI process alive until SIGINT/SIGTERM, then stop the owned server.
 * Uses process.exitCode only (no process.exit) so architectural exit budgets stay clean.
 */
export async function awaitLoopbackBridgeUntilSignal(server: BridgeServer): Promise<void> {
  let shuttingDown = false;
  let releaseHold: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  const finish = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.stop();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
    releaseHold?.();
  };

  process.once('SIGINT', () => {
    void finish();
  });
  process.once('SIGTERM', () => {
    void finish();
  });

  await hold;
}
