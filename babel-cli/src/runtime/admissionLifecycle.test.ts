/**
 * P05 admission-store lifetime + A1 fencing conformance.
 *
 * Covers the Task-2 wiring requirements that live at the store itself:
 * - one inner SQLite handle per DB path (a second in-process open shares it),
 *   reference-counted close, repeated open/close leaks nothing,
 * - fail-closed behavior of a released façade,
 * - A1 hazards: owner advancement is exactly +1 with optional current-token
 *   proof (no gen-99 seizure), a superseded gen-N claim settles only into a
 *   non-success terminal state, corrupt owner/admission rows read as null,
 * - crash/restart: a fresh PROCESS reopens the store and recovers the owner
 *   while the pre-crash claim stays fail-closed as `claimed`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  ADMISSION_REASONS,
  type CommandDigestInput,
} from './admissionContracts.js';
import { openAdmissionStore, type AdmissionStore } from './admission.js';
import { getOpenAdmissionStoreCount } from './admissionTestHooks.js';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'admissionRestartChild.ts');

interface Fixture {
  readonly root: string;
  readonly runDir: string;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'babel-admission-lifecycle-'));
  const runDir = join(root, 'runs', 'run-1');
  return {
    root,
    runDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function openStore(fixture: Fixture): AdmissionStore {
  const result = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir });
  if (!result.ok) throw new Error(`open failed: ${result.reasonCode}: ${result.detail}`);
  return result.store;
}

function commandInput(overrides: Partial<CommandDigestInput> = {}): CommandDigestInput {
  return {
    threadId: 'thread-1',
    taskId: 'task-1',
    commandId: 'cmd-1',
    mode: 'chat',
    resolvedOperationPolicy: { mutation: 'normal' },
    taskShapeClass: 'edit',
    targetRoot: '/work',
    offeredToolSchemaVersion: 'tools-v1',
    contextSnapshotId: 'ctx-1',
    payload: { command: 'noop' },
    ...overrides,
  };
}

function admit(store: AdmissionStore, generation: number, token: string, commandId = 'cmd-1') {
  return store.admitCommand({
    digestInput: commandInput({ commandId }),
    ownerGeneration: generation,
    ownerToken: token,
    ...(generation > 1 ? { previousOwnerToken: 'token-1' } : {}),
    effectClass: 'read_only',
    operationId: `op-${commandId}`,
  });
}

test('lifecycle: a second open shares one handle; close releases references independently', () => {
  const fixture = makeFixture();
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0, 'no leaked handles before the test');
    const first = openStore(fixture);
    assert.equal(getOpenAdmissionStoreCount(), 1);
    const second = openStore(fixture);
    assert.equal(getOpenAdmissionStoreCount(), 1, 'a second open must not double-own the handle');
    assert.equal(second.dbPath, first.dbPath);

    // Writes through one façade are visible through the other (one inner DB).
    const decision = admit(first, 1, 'token-1');
    assert.equal(decision.kind, 'admitted');
    assert.equal(second.readOwner('thread-1')?.generation, 1);

    // Closing the first reference must not disturb the second...
    first.close();
    assert.equal(getOpenAdmissionStoreCount(), 1, 'handle stays open while a reference remains');
    assert.equal(second.readOwner('thread-1')?.generation, 1);
    // ...and the released façade fails closed rather than touching the handle.
    assert.equal(first.readOwner('thread-1'), null, 'a released façade proves nothing (null)');
    assert.equal(first.readAdmission('thread-1', 'cmd-1'), null);
    const lateAdmit = admit(first, 1, 'token-1', 'cmd-late');
    assert.equal(lateAdmit.kind, 'rejected');
    if (lateAdmit.kind === 'rejected') {
      assert.equal(lateAdmit.reasonCode, ADMISSION_REASONS.UNAVAILABLE);
      assert.match(lateAdmit.detail ?? '', /store_closed/);
    }
    const lateSettle = first.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
    });
    assert.equal(lateSettle.settled, false);
    first.close(); // idempotent

    // Last release closes the real handle; reopen starts fresh and sees data.
    second.close();
    assert.equal(getOpenAdmissionStoreCount(), 0, 'last close releases the handle');
    const reopened = openStore(fixture);
    assert.equal(getOpenAdmissionStoreCount(), 1);
    assert.equal(reopened.readOwner('thread-1')?.token, 'token-1');
    reopened.close();
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test('lifecycle: repeated open/close leaks nothing', () => {
  const fixture = makeFixture();
  try {
    for (let i = 0; i < 5; i++) {
      const store = openStore(fixture);
      assert.equal(getOpenAdmissionStoreCount(), 1);
      if (i === 0) assert.equal(admit(store, 1, 'token-1').kind, 'admitted');
      store.close();
      assert.equal(getOpenAdmissionStoreCount(), 0, `iteration ${i} must release its handle`);
    }
    const final = openStore(fixture);
    assert.equal(final.readOwner('thread-1')?.generation, 1, 'owner persists across reopen cycles');
    final.close();
  } finally {
    fixture.cleanup();
  }
});

test('A1: owner advancement is exactly +1 and honors current-token proof when presented', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    assert.equal(admit(store, 1, 'token-1').kind, 'admitted');

    // Unprovisioned seizure (gen 99 over gen 1) is fenced.
    const seizure = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-seizure' }),
      ownerGeneration: 99,
      ownerToken: 'token-99',
      effectClass: 'read_only',
      operationId: 'op-seizure',
    });
    assert.equal(seizure.kind, 'rejected');
    if (seizure.kind === 'rejected') {
      assert.equal(seizure.reasonCode, ADMISSION_REASONS.STALE_OWNER);
      assert.match(seizure.detail ?? '', /by exactly one/);
    }
    // Non-sequential jumps over an existing owner are fenced too.
    const jump = admit(store, 3, 'token-3', 'cmd-jump');
    assert.equal(jump.kind, 'rejected');

    // Advancement presenting the WRONG previous token is fenced...
    const wrongProof = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-wrong-proof' }),
      ownerGeneration: 2,
      ownerToken: 'token-2',
      previousOwnerToken: 'stale-holder-token',
      effectClass: 'read_only',
      operationId: 'op-wrong-proof',
    });
    assert.equal(wrongProof.kind, 'rejected');
    if (wrongProof.kind === 'rejected') {
      assert.equal(wrongProof.reasonCode, ADMISSION_REASONS.STALE_OWNER);
      assert.equal(wrongProof.detail, 'previous_owner_token_mismatch');
    }
    assert.equal(store.readOwner('thread-1')?.generation, 1, 'failed takeover wrote nothing');

    // ...and the CURRENT token proves a clean +1 takeover.
    const proven = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-proven' }),
      ownerGeneration: 2,
      ownerToken: 'token-2',
      previousOwnerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-proven',
    });
    assert.equal(proven.kind, 'admitted');
    assert.deepEqual(store.readOwner('thread-1'), {
      threadId: 'thread-1',
      generation: 2,
      token: 'token-2',
    });
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('A1: a gen-N claim superseded by N+1 settles only into non-success terminal states', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    assert.equal(admit(store, 1, 'token-1', 'cmd-n').kind, 'admitted');
    const successor = store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-n1' }),
      ownerGeneration: 2,
      ownerToken: 'token-2',
      previousOwnerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-n1',
    });
    assert.equal(successor.kind, 'admitted');

    // Success under the superseded generation is still fenced (never success)...
    const forged = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-n',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { forged: true },
    });
    assert.equal(forged.settled, false);
    if (!forged.settled) assert.equal(forged.reasonCode, ADMISSION_REASONS.STALE_OWNER);
    assert.equal(store.readAdmission('thread-1', 'cmd-n')?.state, 'claimed');

    // ...but the claim is NOT un-settleable: a non-success terminal lands.
    const abandoned = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-n',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'indeterminate',
      outcome: { superseded: true },
    });
    assert.equal(abandoned.settled, true, 'gen-N must remain settleable after a gen-N+1 takeover');
    assert.equal(store.readAdmission('thread-1', 'cmd-n')?.state, 'indeterminate');

    // The current owner still settles its own claim normally.
    const current = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-n1',
      ownerGeneration: 2,
      ownerToken: 'token-2',
      state: 'settled',
      outcome: { ok: true },
    });
    assert.equal(current.settled, true);
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test('A1: corrupt owner/admission rows read as null instead of throwing', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    assert.equal(admit(store, 1, 'token-1').kind, 'admitted');
    const dbPath = store.dbPath;
    store.close();

    // Corrupt the admission row → readAdmission fails closed to null.
    let raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE admission SET owner_generation = 0");
    raw.close();
    let reopened = openStore(fixture);
    assert.equal(reopened.readAdmission('thread-1', 'cmd-1'), null, 'corrupt admission row → null');
    reopened.close();

    // Corrupt the owner row → readOwner fails closed to null (owner_missing).
    raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE owner SET token = ''");
    raw.close();
    reopened = openStore(fixture);
    assert.equal(reopened.readOwner('thread-1'), null, 'corrupt owner row → null, never a throw');
    reopened.close();
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test('crash/restart: a fresh process reopens the store and recovers the durable owner', () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.runDir, { recursive: true });
    const store = openStore(fixture);
    assert.equal(admit(store, 1, 'token-1', 'cmd-pre-crash').kind, 'admitted');
    // Intentionally leave the claim unsettled and the handle open: the child
    // process is the "restart" and must recover state from the file alone.
    store.close();

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', CHILD_ENTRY, fixture.root, fixture.runDir, 'thread-1', 'cmd-post-restart'],
      { cwd: cliRoot, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const line = child.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    const report = JSON.parse(line) as {
      ok: boolean;
      owner?: { threadId: string; generation: number; token: string };
      admitted?: string;
    };
    assert.equal(report.ok, true, JSON.stringify(report));
    // The owner of record survived the process restart...
    assert.equal(report.owner?.generation, 1);
    assert.equal(report.owner?.token, 'token-1');
    // ...and a fresh process re-admits a new command under THAT owner.
    assert.equal(report.admitted, 'admitted');

    // The child exited WITHOUT closing and left its claim unsettled: the
    // durable record stays fail-closed ('claimed'), never silently terminal.
    const reopened = openStore(fixture);
    const recovered = reopened.readAdmission('thread-1', 'cmd-post-restart');
    assert.equal(recovered?.state, 'claimed');
    assert.equal(reopened.readOwner('thread-1')?.generation, 1);
    reopened.close();
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    fixture.cleanup();
  }
});
