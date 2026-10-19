#!/usr/bin/env node
/**
 * Strict OpenCode-shaped ACP v1 peer (see openCodeAcpContract.ts pin + documented capabilities).
 */

import { createInterface } from 'node:readline';

const sessions = new Map();
let nextSession = 1;
const permissionWaiters = new Map();
const activePromptBySession = new Map();
const settledPromptIds = new Set();

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
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: { name: 'fixture-opencode-acp', version: '0.0.0-fixture' },
    },
  });
}

async function handleSessionNew(id, params) {
  const deferMs = Number(process.env.BABEL_OPENCODE_FIXTURE_DEFER_SESSION_NEW_MS ?? 0);
  if (deferMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, deferMs));
  }
  const sessionId = `sess_fixture_${nextSession++}`;
  sessions.set(sessionId, { cwd: params.cwd, messages: [], permissionDone: false });
  write({ jsonrpc: '2.0', id, result: { sessionId } });
  if (process.env.BABEL_OPENCODE_FIXTURE_STARTUP_IDLE === '1') {
    sessionUpdate(sessionId, 'state_update', { state: 'idle', stopReason: 'end_turn' });
  }
}

function handleSessionLoad(id, params) {
  const sessionId = String(params.sessionId ?? '');
  if (process.env.BABEL_OPENCODE_FIXTURE_LOAD_FAIL === '1') {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'OPENCODE_FIXTURE_LOAD_FAILED' },
    });
    return;
  }
  const delayMs = Number(process.env.BABEL_OPENCODE_FIXTURE_LOAD_DELAY_MS ?? 0);
  const finish = () => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { cwd: params.cwd, messages: [], permissionDone: false });
    }
    sessionUpdate(sessionId, 'user_message_chunk', {
      messageId: 'hist-user-1',
      content: { type: 'text', text: 'fixture:user-history' },
    });
    sessionUpdate(sessionId, 'agent_message_chunk', {
      messageId: 'hist-assistant-1',
      content: { type: 'text', text: 'fixture:history-replay' },
    });
    write({ jsonrpc: '2.0', id, result: { sessionId } });
  };
  if (delayMs > 0) setTimeout(finish, delayMs);
  else finish();
}

function handleSessionList(id, params) {
  const all = [...sessions.keys()].map((sessionId) => ({
    sessionId,
    title: 'fixture',
    cwd: sessions.get(sessionId)?.cwd,
  }));
  const pageSize = Number(process.env.BABEL_OPENCODE_FIXTURE_LIST_PAGE_SIZE ?? 0);
  if (pageSize > 0) {
    const cursorRaw = params?.cursor;
    const page = cursorRaw !== undefined && cursorRaw !== null ? Number(cursorRaw) : 0;
    const slice = all.slice(page * pageSize, (page + 1) * pageSize);
    const nextPage = (page + 1) * pageSize < all.length ? String(page + 1) : undefined;
    write({
      jsonrpc: '2.0',
      id,
      result: {
        sessions: slice,
        ...(nextPage ? { nextCursor: nextPage } : {}),
      },
    });
    return;
  }
  write({ jsonrpc: '2.0', id, result: { sessions: all } });
}

function waitForPermissionResponse(requestId) {
  return new Promise((resolve) => {
    permissionWaiters.set(String(requestId), resolve);
  });
}

function settlePrompt(sessionId, promptId, stopReason) {
  if (settledPromptIds.has(promptId)) return false;
  settledPromptIds.add(promptId);
  activePromptBySession.delete(sessionId);
  write({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
  return true;
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
  activePromptBySession.set(sessionId, { id, aborted: false });

  sessionUpdate(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: 'fixture:prompt-admitted' },
  });

  sessionUpdate(sessionId, 'state_update', { state: 'running' });

  if (process.env.BABEL_OPENCODE_FIXTURE_PERMISSION === '1' && !session.permissionDone) {
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
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
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
      settlePrompt(sessionId, id, 'cancelled');
      return;
    }
  }

  if (process.env.BABEL_OPENCODE_FIXTURE_SLOW === '1') {
    await new Promise((r) => setTimeout(r, 500));
  }

  const activeAfterSlow = activePromptBySession.get(sessionId);
  if (!activeAfterSlow || activeAfterSlow.aborted || activeAfterSlow.id !== id) {
    settlePrompt(sessionId, id, 'cancelled');
    return;
  }

  const chunk = `fixture:${text}`;
  sessionUpdate(sessionId, 'agent_message_chunk', {
    content: { type: 'text', text: chunk },
  });

  const activeBeforeSettle = activePromptBySession.get(sessionId);
  if (!activeBeforeSettle || activeBeforeSettle.aborted || activeBeforeSettle.id !== id) {
    settlePrompt(sessionId, id, 'cancelled');
    return;
  }

  settlePrompt(sessionId, id, 'end_turn');
}

function handleSessionCancelNotification(params) {
  if (process.env.BABEL_OPENCODE_FIXTURE_NO_CANCEL_TERMINAL === '1') return;
  const sessionId = String(params.sessionId ?? '');
  const active = activePromptBySession.get(sessionId);
  if (!active) return;
  active.aborted = true;
  settlePrompt(sessionId, active.id, 'cancelled');
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
    if (outcome?.outcome === 'selected' && outcome.optionId === 'once') {
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
      void handleSessionNew(id, params ?? {});
      break;
    case 'session/load':
      handleSessionLoad(id, params ?? {});
      break;
    case 'session/list':
      handleSessionList(id, params ?? {});
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
