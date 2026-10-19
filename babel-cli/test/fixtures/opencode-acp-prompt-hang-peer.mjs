#!/usr/bin/env node
/**
 * ACP peer that admits session/prompt but never completes the RPC until the process is stopped.
 * Exits slowly after SIGTERM so harness death-fence tests can observe delayed child death.
 */

import { createInterface } from 'node:readline';

const delayMs = Number(process.env.BABEL_OPENCODE_FIXTURE_EXIT_DELAY_MS ?? 150);

process.on('SIGTERM', () => {
  setTimeout(() => process.exit(0), delayMs);
});
process.on('SIGINT', () => {
  setTimeout(() => process.exit(0), delayMs);
});

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const sessions = new Map();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.exit(3);
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } },
          agentInfo: { name: 'hang-peer', version: '0.0.0' },
        },
      });
      break;
    case 'session/new': {
      const sessionId = 'hang-session-1';
      sessions.set(sessionId, { cwd: params?.cwd });
      write({ jsonrpc: '2.0', id, result: { sessionId } });
      break;
    }
    case 'session/prompt':
      // Intentionally never respond — harness RPC timeout must fire.
      break;
    default:
      if (id !== undefined) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } });
      }
  }
});
