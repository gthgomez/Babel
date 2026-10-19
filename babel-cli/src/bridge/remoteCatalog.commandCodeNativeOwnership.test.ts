import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createProtocolHostState } from '../protocol/client/host.js';
import type { SessionDescriptor } from '../executor/contracts.js';
import {
  commandCodeNativeOwnershipViolation,
  conflictingPersistedCommandCodeNativeOwner,
  findCanonicalCommandCodeNativeOwnerForProject,
  listPersistedCommandCodeNativeOwnerThreadIds,
} from './remoteCatalog.js';
import { ensureThread, writeSessionDescriptor } from '../services/threadStore/index.js';

function commandCodeDescriptor(
  threadId: string,
  projectRoot: string,
  nativeId: string,
): SessionDescriptor {
  return {
    schemaVersion: 1,
    threadId,
    projectRoot,
    mode: 'chat',
    provider: 'default',
    model: 'default',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    harness_adapter_id: 'command-code',
    harness_native_session_id: nativeId,
  };
}


describe('command-code native ownership (persisted bindings)', () => {
  let tmp = '';
  let tmpB = '';
  let prevRuns: string | undefined;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-owner-'));
    tmpB = mkdtempSync(join(tmpdir(), 'babel-cc-owner-b-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
  });

  after(() => {
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  });

  it('lists both persisted owners for dual bindings (corrupt state)', async () => {
    const state = createProtocolHostState();
    const nativeId = 'sess_fixture_dual_owner';
    const t1 = 'thread-owner-a';
    const t2 = 'thread-owner-b';
    for (const threadId of [t1, t2]) {
      const descriptor = commandCodeDescriptor(threadId, tmp, nativeId);
      ensureThread(threadId, { project_root: tmp });
      writeSessionDescriptor(descriptor);
      state.descriptors.set(threadId, descriptor);
    }
    const owners = await listPersistedCommandCodeNativeOwnerThreadIds(state, tmp, nativeId);
    assert.deepEqual(owners, [t1, t2].sort());
    assert.equal(await commandCodeNativeOwnershipViolation(state, tmp, nativeId), 'corrupt');
    assert.equal(await findCanonicalCommandCodeNativeOwnerForProject(state, tmp, nativeId), undefined);
  });

  it('detects conflict when excluding one of two persisted owners', async () => {
    const state = createProtocolHostState();
    const nativeId = 'sess_fixture_dual_except';
    const t1 = 'thread-except-a';
    const t2 = 'thread-except-b';
    for (const threadId of [t1, t2]) {
      const descriptor = commandCodeDescriptor(threadId, tmp, nativeId);
      ensureThread(threadId, { project_root: tmp });
      writeSessionDescriptor(descriptor);
      state.descriptors.set(threadId, descriptor);
    }
    assert.equal(await commandCodeNativeOwnershipViolation(state, tmp, nativeId, t1), 'conflict');
    assert.equal(await commandCodeNativeOwnershipViolation(state, tmp, nativeId, t2), 'conflict');
    assert.equal(await conflictingPersistedCommandCodeNativeOwner(state, tmp, nativeId, t1), t2);
    assert.equal(await conflictingPersistedCommandCodeNativeOwner(state, tmp, nativeId, t2), t1);
  });

  it('keeps distinct canonical projects independent for the same native id', async () => {
    const state = createProtocolHostState();
    const nativeId = 'sess_fixture_cross_project';
    const tA = 'thread-proj-a';
    const tB = 'thread-proj-b';
    const descA = commandCodeDescriptor(tA, tmp, nativeId);
    const descB = commandCodeDescriptor(tB, tmpB, nativeId);
    ensureThread(tA, { project_root: tmp });
    ensureThread(tB, { project_root: tmpB });
    writeSessionDescriptor(descA);
    writeSessionDescriptor(descB);
    state.descriptors.set(tA, descA);
    state.descriptors.set(tB, descB);
    assert.deepEqual(await listPersistedCommandCodeNativeOwnerThreadIds(state, tmp, nativeId), [tA]);
    assert.deepEqual(await listPersistedCommandCodeNativeOwnerThreadIds(state, tmpB, nativeId), [tB]);
    assert.equal(await findCanonicalCommandCodeNativeOwnerForProject(state, tmp, nativeId), tA);
    assert.equal(await findCanonicalCommandCodeNativeOwnerForProject(state, tmpB, nativeId), tB);
    assert.equal(await commandCodeNativeOwnershipViolation(state, tmp, nativeId), 'conflict');
    assert.equal(await commandCodeNativeOwnershipViolation(state, tmpB, nativeId), 'conflict');
  });
});
