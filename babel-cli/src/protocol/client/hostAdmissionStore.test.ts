/**
 * A4 (Task 2 — R1/P11 closure): session-scoped admission stores on the
 * protocol host.
 *
 * A materialization that throws during hydration is a designed path ("hydrate
 * before publishing so a failed restore cannot leave a poisoned engine
 * cached"). The retry must release the store reference recorded by the failed
 * attempt — otherwise the orphaned ref is never closed by
 * `closeProtocolHostState` — and the teardown must drain what remains.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getOpenAdmissionStoreCount } from '../../runtime/admissionTestHooks.js';
import type { RestoreReport } from '../../executor/modeAdapters.js';
import {
  closeProtocolHostState,
  createProtocolHostState,
  handleProtocolRequest,
} from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-admission-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a hydration-throw retry never orphans the previous admission reference', async () => {
  const fixture = withTempRunsDir();
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0, 'no leaked handles before the test');
    const host = createProtocolHostState({ executeWithoutNotifications: true });

    const created = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 1, method: 'thread.create', params: { project_root: fixture.root } },
      host,
    );
    assert.ok('result' in created, JSON.stringify(created));
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;

    // Designed hydration-throw: a resumable report naming a durable source
    // that no longer exists → hydrateEngineFromRestore throws AFTER
    // materializeEngine has opened and recorded the store.
    host.restoreReports.set(threadId, {
      threadId,
      resumable: true,
      source: 'thread_event_log',
      turnCount: 1,
    } as unknown as RestoreReport);

    const attempt1 = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'turn.submit', params: { thread_id: threadId, message: 'one' } },
      host,
    );
    assert.ok('error' in attempt1, 'hydration throw must surface as an error response');
    assert.equal(getOpenAdmissionStoreCount(), 1, 'first attempt recorded exactly one handle');
    assert.equal(host.admissionStores.size, 1);

    const attempt2 = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'turn.submit', params: { thread_id: threadId, message: 'two' } },
      host,
    );
    assert.ok('error' in attempt2, 'retry hits the same designed throw');
    // The retry replaced the record — the orphaned first reference must have
    // been released: exactly ONE handle remains, not two.
    assert.equal(
      getOpenAdmissionStoreCount(),
      1,
      'hydration-throw retry must not leak the prior reference',
    );
    assert.equal(host.admissionStores.size, 1);

    closeProtocolHostState(host);
    assert.equal(
      getOpenAdmissionStoreCount(),
      0,
      'closeProtocolHostState drains the recorded handle',
    );
    closeProtocolHostState(host); // idempotent
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    fixture.cleanup();
  }
});
