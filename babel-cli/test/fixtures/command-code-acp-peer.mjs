#!/usr/bin/env node
/**
 * Strict ACP-shaped fake peer (v1 + v2 initialize). Real stdio child for deterministic tests.
 */

import { createInterface } from 'node:readline';

const sessions = new Map();
let nextSession = 1;
let negotiatedVersion = 2;
const permissionWaiters = new Map();

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sessionUpdate(sessionId, sessionUpdateBody) {
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: sessionUpdateBody } },
  });
}

function handleInitialize(id, params) {
  const version = params?.protocolVersion === 1 ? 1 : 2;
  negotiatedVersion = version;
  if (version === 2) {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 2,
        capabilities: { session: {} },
        info: { name: 'fixture-command-code-acp', version: '0.0.0-fixture' },
      },
    });
    return;
  }
  write({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { session: {} },
      agentInfo: { name: 'fixture-command-code-acp', version: '0.0.0-fixture' },
    },
  });
}

function handleSessionNew(id, params) {
  const sessionId = `sess_fixture_${nextSession++}`;
  sessions.set(sessionId, { cwd: params.cwd, messages: [], permissionDone: false });
  write({ jsonrpc: '2.0', id, result: { sessionId } });
}

function handleSessionResume(id, params) {
  const sessionId = String(params.sessionId ?? '');
  if (!sessions.has(sessionId)) {
    write({ jsonrpc: '2.0', id, error: { code: -32001, message: 'session not found' } });
    return;
  }
  if (params.replayFrom?.type === 'start') {
    sessionUpdate(sessionId, {
      type: 'agent_message_chunk',
      content: { type: 'text', text: 'fixture:history-replay' },
    });
  }
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
  const messageId = `msg_${session.messages.length}`;
  write({ jsonrpc: '2.0', id, result: { messageId } });

  sessionUpdate(sessionId, { type: 'state_update', state: 'running' });

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
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        ],
        toolCall: { title: 'run_fixture', kind: 'execute', input: { command: 'fixture-cmd' } },
      },
    });
    await waitForPermissionResponse(requestId);
  }

  if (process.env.BABEL_COMMAND_CODE_FIXTURE_SLOW === '1') {
    await new Promise((r) => setTimeout(r, 500));
  }

  const chunk = `fixture:${text}`;
  sessionUpdate(sessionId, {
    type: 'agent_message_chunk',
    content: { type: 'text', text: chunk },
  });

  sessionUpdate(sessionId, {
    type: 'usage_update',
    usage: { cost: { amount: 0.01, currency: 'USD' }, used: 8, size: 100 },
  });

  sessionUpdate(sessionId, { type: 'state_update', state: 'idle', stopReason: 'end_turn' });
}

function handleSessionCancelNotification(params) {
  const sessionId = String(params.sessionId ?? '');
  if (process.env.BABEL_COMMAND_CODE_FIXTURE_NO_CANCEL_TERMINAL === '1') return;
  sessionUpdate(sessionId, { type: 'state_update', state: 'idle', stopReason: 'cancelled' });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed === 'CRASH') process.exit(2);
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
  if (method === 'session/cancel') {
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
    case 'session/resume':
      handleSessionResume(id, params ?? {});
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
