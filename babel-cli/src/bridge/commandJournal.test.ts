import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { NativeCommandJournal } from './commandJournal.js';

test('native command journal scopes lookup and converts crash-window admission to unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-command-journal-'));
  const path = join(root, 'private', 'commands.sqlite');
  const protectedDirectories: string[] = [];
  const base = {
    commandId: 'command-a', principalId: 'principal-a', projectId: 'project-a', threadId: 'thread-a',
    hostInstanceId: 'instance-a', registrationGeneration: 3, payload: { method: 'turn.submit', text: 'fixture' },
  };
  try {
    const first = new NativeCommandJournal(path, {
      hostInstanceId: 'instance-a', protectStoreDirectory: (directory) => protectedDirectories.push(directory),
    });
    const secondHandle = new NativeCommandJournal(path, {
      hostInstanceId: 'instance-a', protectStoreDirectory: (directory) => protectedDirectories.push(directory),
    });
    const reservation = first.reserve(base);
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    assert.equal(reservation.created, true);
    assert.equal(first.reserve(base).ok, true);
    const duplicate = secondHandle.reserve(base);
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.created, false, 'a second database handle observes the original reservation');
    assert.deepEqual(first.lookup({ commandId: base.commandId, principalId: 'other-principal', projectId: base.projectId }), null);
    assert.deepEqual(first.lookup({ commandId: base.commandId, principalId: base.principalId, projectId: 'other-project' }), null);
    const conflict = first.reserve({ ...base, payload: { method: 'turn.submit', text: 'different fixture' } });
    assert.deepEqual(conflict, { ok: false, reason: 'command_fingerprint_conflict' });
    first.close();
    secondHandle.close();

    const restarted = new NativeCommandJournal(path, {
      hostInstanceId: 'instance-b', protectStoreDirectory: (directory) => protectedDirectories.push(directory),
    });
    const recovered = restarted.lookup({ commandId: base.commandId, principalId: base.principalId, projectId: base.projectId });
    assert.equal(recovered?.state, 'unknown');
    assert.equal(recovered?.hostInstanceId, 'instance-a');
    assert.equal(recovered?.resultJson, null);
    assert.equal(restarted.settle({ commandId: base.commandId, principalId: base.principalId, result: { status: 'ok' } }), false);
    assert.deepEqual(protectedDirectories, [join(root, 'private'), join(root, 'private'), join(root, 'private')]);
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native command journal closes a partially initialized database on schema failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-command-journal-failure-'));
  const path = join(root, 'private', 'commands.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE native_command_journal (command_id TEXT PRIMARY KEY)');
  raw.close();
  assert.throws(() => new NativeCommandJournal(path, {
    hostInstanceId: 'instance-a', protectStoreDirectory: () => undefined,
  }), /no such column|state/i);
  if (process.platform === 'win32') {
    // The failed constructor must have closed its handle; Windows rejects
    // deleting a database file still held open by SQLite.
    rmSync(path);
  }
  rmSync(root, { recursive: true, force: true });
});
