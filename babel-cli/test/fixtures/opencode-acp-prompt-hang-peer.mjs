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
/** @type {Map<string, { id: unknown; aborted?: boolean }>} */
const activePromptBySession = new Map();

function settlePrompt(sessionId, id, stopReason) {
  write({
    jsonrpc: '2.0',
    id,
    result: { stopReason },
  });
  activePromptBySession.delete(sessionId);
}

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
  if (method === 'session/cancel') {
    if (id !== undefined) return;
    if (process.env.BABEL_OPENCODE_FIXTURE_IGNORE_CANCEL === '1') {
      return;
    }
    if (process.env.BABEL_OPENCODE_HANG_PEER_TRACE === '1') {
      process.stderr.write(`${JSON.stringify({ trace: 'session/cancel', params })}\n`);
    }
    const sessionId = String(params?.sessionId ?? '');
    const active = activePromptBySession.get(sessionId);
    if (!active) return;
    active.aborted = true;
    const settleDelayMs = Number(process.env.BABEL_OPENCODE_FIXTURE_CANCEL_SETTLE_DELAY_MS ?? 0);
    const exitAfterMs = Number(process.env.BABEL_OPENCODE_FIXTURE_EXIT_AFTER_CANCEL_MS ?? 0);
    const finishCancel = () => {
      settlePrompt(sessionId, active.id, 'cancelled');
      if (exitAfterMs > 0) {
        setTimeout(() => process.exit(0), exitAfterMs);
      }
    };
    if (settleDelayMs > 0) {
      setTimeout(finishCancel, settleDelayMs);
    } else {
      finishCancel();
    }
    return;
  }
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
    case 'session/prompt': {
      const sessionId = String(params?.sessionId ?? 'hang-session-1');
      activePromptBySession.set(sessionId, { id });
      // Intentionally never respond until cancel/timeout — harness must not fabricate terminal.
      break;
    }
    default:
      if (id !== undefined) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported ${method}` } });
      }
  }
});
