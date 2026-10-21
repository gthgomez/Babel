import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as transport from './chatTransport.js';
import { interactiveDiagnosticPath } from '../../ui/interactiveDiagnostics.js';
import { ConversationalRenderer } from '../../ui/waterfall.js';
import { runChatEngineOnce } from './chatCore.js';
import type { ChatEngine, ChatResult } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';

test('the active renderer callback cancels a direct engine without an unregistered protocol call', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-renderer-cancel-'));
  const names = ['BABEL_STATE_DIR', 'BABEL_RUNS_DIR', 'BABEL_INPROCESS', 'BABEL_TUI_CLIENT', 'BABEL_PROTOCOL_CLIENT'] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  process.env['BABEL_STATE_DIR'] = root;
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_INPROCESS'] = '1';
  delete process.env['BABEL_TUI_CLIENT'];
  delete process.env['BABEL_PROTOCOL_CLIENT'];
  let cancel: (() => unknown) | undefined;
  let submitted!: () => void;
  const started = new Promise<void>(resolve => { submitted = resolve; });
  let settle!: (result: ChatResult) => void;
  const pending = new Promise<ChatResult>(resolve => { settle = resolve; });
  let cancellations = 0;
  const renderer = new ConversationalRenderer({ isTTY: false });
  t.mock.method(renderer, 'start', () => {});
  t.mock.method(renderer, 'setCancelTarget', (callback: (...args: unknown[]) => unknown) => { cancel = () => callback(); });
  const engine = {
    getEngineRunId: () => 'chat-unregistered-renderer-cancel',
    submitMessage: async () => { submitted(); return pending; },
    cancel: () => {
      cancellations++;
      settle({ status: 'cancelled', answer: 'Cancelled', usage: globalCostTracker.getSessionSummary(), conversation: [] });
    },
  } as unknown as ChatEngine;
  try {
    const result = runChatEngineOnce({ task: 'prepare and wait for cancellation',
      target: { targetRoot: root, workspaceRoot: null, project: null, source: 'cwd', cwd: root },
      engineFactory: () => engine, convRenderer: renderer, useStreaming: false, preflightContext: '' });
    await started;
    assert.ok(cancel, 'the real runner must wire the renderer cancellation callback');
    cancel();
    assert.equal((await result).status, 'cancelled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancellations, 1);
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct renderer cancellation never contacts an unregistered protocol thread', async () => {
  let cancelled = 0;
  await transport.cancelChatEngineTurn({ cancel() { cancelled++; } }, null);
  assert.equal(cancelled, 1);
});

test('a local cancellation failure retains its synchronous caller-visible behavior', () => {
  assert.throws(() => transport.cancelChatEngineTurn({ cancel() { throw new Error('local cancellation failed'); } }, null), /local cancellation failed/);
});

test('protocol rejection cannot prevent local cancellation or escape as an unhandled rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cancel-protocol-'));
  const prior = process.env['BABEL_STATE_DIR'];
  process.env['BABEL_STATE_DIR'] = root;
  let cancelled = 0;
  try {
    await transport.cancelChatEngineTurn({ cancel() { cancelled++; } },
      new transport.ProtocolTurnSession('unregistered-cancellation-regression', 1));
    assert.equal(cancelled, 1);
    assert.match(readFileSync(interactiveDiagnosticPath(), 'utf8'), /protocol-cancel/);
    assert.match(readFileSync(interactiveDiagnosticPath(), 'utf8'), /Thread not found/);
  } finally {
    if (prior === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
