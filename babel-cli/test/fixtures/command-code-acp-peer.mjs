#!/usr/bin/env node
/**
 * Deterministic fake Command Code ACP peer (real child process, stdio JSON-RPC).
 * Activated via BABEL_COMMAND_CODE_ACP_COMMAND + BABEL_COMMAND_CODE_ACP_ARGS.
 */

import { createInterface } from 'node:readline';

const sessions = new Map();
let nextSession = 1;

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handleInitialize(id) {
  write({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: 2,
      capabilities: { session: {} },
      info: { name: 'fixture-command-code-acp', version: '0.0.0-fixture' },
    },
  });
}

function handleSessionNew(id, params) {
  const sessionId = `sess_fixture_${nextSession++}`;
  sessions.set(sessionId, { cwd: params.cwd, messages: [] });
  write({ jsonrpc: '2.0', id, result: { sessionId } });
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { type: 'state_update', state: 'idle', stopReason: 'end_turn' },
    },
  });
}

function handleSessionResume(id, params) {
  const sessionId = String(params.sessionId ?? '');
  if (!sessions.has(sessionId)) {
    write({ jsonrpc: '2.0', id, error: { code: -32001, message: 'session not found' } });
    return;
  }
  write({ jsonrpc: '2.0', id, result: { sessionId } });
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { type: 'state_update', state: 'idle', stopReason: 'end_turn' },
    },
  });
}

function handleSessionList(id, params) {
  const cwd = params?.cwd;
  const listed = [...sessions.entries()]
    .filter(([, row]) => !cwd || row.cwd === cwd)
    .map(([sessionId]) => ({ sessionId, title: 'fixture' }));
  write({ jsonrpc: '2.0', id, result: { sessions: listed } });
}

const permissionWaiters = new Map();

function waitForPermissionResponse(requestId) {
  return new Promise((resolve) => {
    permissionWaiters.set(String(requestId), resolve);
  });
}

async function handleSessionPrompt(id, params) {
  const sessionId = String(params.sessionId ?? '');
  const session = sessions.get(sessionId);
  if (!session) {
    write({ jsonrpc: '2.0', id, error: { code: -32001, message: 'session not found' } });
    return;
  }
  const text =
    Array.isArray(params.prompt) && params.prompt[0]?.text
      ? String(params.prompt[0].text)
      : String(params.text ?? '');
  session.messages.push(text);
  const messageId = `msg_${session.messages.length}`;
  write({ jsonrpc: '2.0', id, result: { messageId } });

  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { type: 'state_update', state: 'running' } },
  });

  if (process.env.BABEL_COMMAND_CODE_FIXTURE_PERMISSION === '1' && !session.permissionDone) {
    session.permissionDone = true;
    const requestId = `perm_${messageId}`;
    write({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        title: 'fixture permission',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await waitForPermissionResponse(requestId);
  }

  const chunk = `fixture:${text}`;
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { type: 'message_chunk', text: chunk },
    },
  });

  if (process.env.BABEL_COMMAND_CODE_FIXTURE_TOOL === '1') {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { type: 'tool_call', tool: 'read_file', target: 'README.md', status: 'started' },
      },
    });
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { type: 'tool_call', tool: 'read_file', target: 'README.md', status: 'completed' },
      },
    });
  }

  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        type: 'usage_update',
        usage: { totalCostUSD: 0.01, totalInputTokens: 3, totalOutputTokens: 5, totalTokens: 8 },
      },
    },
  });

  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { type: 'state_update', state: 'idle', stopReason: 'end_turn' },
    },
  });
}

function handleSessionCancel(id, params) {
  const sessionId = String(params.sessionId ?? '');
  write({ jsonrpc: '2.0', id, result: { cancelled: true } });
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { type: 'state_update', state: 'idle', stopReason: 'cancelled' },
    },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed === 'CRASH') {
    process.exit(2);
  }
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.exit(3);
  }
  const { id, method, params, result } = msg;
  if (id !== undefined && result !== undefined && permissionWaiters.has(String(id))) {
    permissionWaiters.get(String(id))();
    permissionWaiters.delete(String(id));
    return;
  }
  switch (method) {
    case 'initialize':
      handleInitialize(id);
      break;
    case 'session/new':
      handleSessionNew(id, params ?? {});
      break;
    case 'session/resume':
      handleSessionResume(id, params ?? {});
      break;
    case 'session/list':
      handleSessionList(id, params ?? {});
      break;
    case 'session/prompt':
      void handleSessionPrompt(id, params ?? {});
      break;
    case 'session/cancel':
      handleSessionCancel(id, params ?? {});
      break;
    case 'session/set_config_option':
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported in fixture' } });
      break;
    default:
      if (id !== undefined) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method ${method}` } });
      }
  }
});
