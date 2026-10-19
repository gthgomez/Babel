#!/usr/bin/env node
/**
 * Strict canonical ACP v1 peer for Command Code harness integration tests.
 */

import { createInterface } from 'node:readline';

const sessions = new Map();
let nextSession = 1;
const permissionWaiters = new Map();
const pendingPrompts = new Map();

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sessionUpdate(sessionId, sessionUpdateKind, fields = {}) {
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: sessionUpdateKind, ...fields },
    },
  });
}

function handleInitialize(id, params) {
  if (!params?.clientInfo || params?.protocolVersion !== 1) {
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid v1 initialize' } });
    return;
  }
  write({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
      },
      agentInfo: { name: 'fixture-command-code-acp', version: '0.0.0-fixture' },
    },
  });
}

function handleSessionNew(id, params) {
  const sessionId = `sess_fixture_${nextSession++}`;
  sessions.set(sessionId, { cwd: params.cwd, messages: [], permissionDone: false, cancelled: false });
  write({ jsonrpc: '2.0', id, result: { sessionId } });
  if (process.env.BABEL_COMMAND_CODE_FIXTURE_STARTUP_IDLE === '1') {
    sessionUpdate(sessionId, 'state_update', { state: 'idle', stopReason: 'end_turn' });
  }
}

function handleSessionLoad(id, params) {
  const sessionId = String(params.sessionId ?? '');
  if (!sessions.has(sessionId)) {
    write({ jsonrpc: '2.0', id, error: { code: -32001, message: 'session not found' } });
    return;
  }
  sessionUpdate(sessionId, 'user_message_chunk', {
    content: { type: 'text', text: 'fixture:user-history' },
  });
  sessionUpdate(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: 'fixture:history-replay' },
  });
  write({ jsonrpc: '2.0', id, result: { sessionId } });
}

function handleSessionList(id) {
  const listed = [...sessions.keys()].map((sessionId) => ({ sessionId, title: 'fixture' }));
  write({ jsonrpc: '2.0', id, result: { sessions: listed } });
}

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
  pendingPrompts.set(sessionId, id);

  sessionUpdate(sessionId, 'state_update', { state: 'running' });

  const honorCancel = process.env.BABEL_COMMAND_CODE_FIXTURE_NO_CANCEL_TERMINAL !== '1';
  if (session.cancelled && honorCancel) {
    pendingPrompts.delete(sessionId);
    write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    return;
  }

  if (process.env.BABEL_COMMAND_CODE_FIXTURE_PERMISSION === '1' && !session.permissionDone) {
    session.permissionDone = true;
    const requestId = `perm_${session.messages.length}`;
    write({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        title: 'fixture permission',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        ],
        toolCall: {
          toolCallId: 'tool_fixture_1',
          kind: 'execute',
          title: 'run_fixture',
          rawInput: { command: 'fixture-cmd' },
        },
      },
    });
    const outcome = await waitForPermissionResponse(requestId);
    if (outcome === 'cancelled') {
      pendingPrompts.delete(sessionId);
      write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
      return;
    }
  }

  if (process.env.BABEL_COMMAND_CODE_FIXTURE_SLOW === '1') {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (session.cancelled && honorCancel) {
    pendingPrompts.delete(sessionId);
    write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    return;
  }

  const chunk = `fixture:${text}`;
  sessionUpdate(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: chunk },
  });

  pendingPrompts.delete(sessionId);
  write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

function handleSessionCancelNotification(params) {
  if (process.env.BABEL_COMMAND_CODE_FIXTURE_NO_CANCEL_TERMINAL === '1') return;
  const sessionId = String(params.sessionId ?? '');
  const session = sessions.get(sessionId);
  if (session) session.cancelled = true;
  const pendingId = pendingPrompts.get(sessionId);
  if (pendingId !== undefined) {
    pendingPrompts.delete(sessionId);
    write({ jsonrpc: '2.0', id: pendingId, result: { stopReason: 'cancelled' } });
  }
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
  const { id, method, params, result } = msg;
  if (id !== undefined && result !== undefined && permissionWaiters.has(String(id))) {
    const outcome = result.outcome;
    if (outcome?.outcome === 'selected' && outcome.optionId === 'allow_once') {
      permissionWaiters.get(String(id))('selected');
      permissionWaiters.delete(String(id));
      return;
    }
    if (outcome?.outcome === 'cancelled') {
      permissionWaiters.get(String(id))('cancelled');
      permissionWaiters.delete(String(id));
      return;
    }
    return;
  }
  if (method === 'session/cancel') {
    if (id !== undefined) return;
    handleSessionCancelNotification(params ?? {});
    return;
  }
  switch (method) {
    case 'initialize':
      handleInitialize(id, params ?? {});
      break;
    case 'session/new':
      handleSessionNew(id, params ?? {});
      break;
    case 'session/load':
      handleSessionLoad(id, params ?? {});
      break;
    case 'session/list':
      handleSessionList(id);
      break;
    case 'session/prompt':
      void handleSessionPrompt(id, params ?? {});
      break;
    default:
      if (id !== undefined) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method ${method}` } });
      }
  }
});
