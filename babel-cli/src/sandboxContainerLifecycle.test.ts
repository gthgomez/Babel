import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as lifecycle from './sandboxContainerLifecycle.js';

test('owned container command keeps production isolation and allocates distinct ownership', () => {
  const options = { dockerImage: 'unit/image', projectRoot: process.cwd(), cwd: process.cwd(), command: 'node test.mjs' };
  const a = lifecycle.buildOwnedContainerCommand(options), b = lifecycle.buildOwnedContainerCommand(options);
  assert.notEqual(a.ownedContainerName, b.ownedContainerName);
  assert.match(a.ownedContainerName, /^babel-run-[a-f0-9-]{36}$/);
  assert.equal(a.args[a.args.indexOf('--name') + 1], a.ownedContainerName);
  assert.ok(a.args.includes('--rm'));
  assert.ok(a.args.includes('--cap-drop=ALL'));
  assert.ok(a.args.includes('--security-opt=no-new-privileges'));
  assert.equal(a.args[a.args.indexOf('--network') + 1], 'none');
});

test('cleanup rejects arbitrary container identities before invoking Docker', async () => {
  assert.throws(() => lifecycle.removeOwnedContainerSync('unrelated-user-container', {}), /Babel-owned identity/);
  await assert.rejects(lifecycle.removeOwnedContainer('unrelated-user-container', {}), /Babel-owned identity/);
});

test('sync cleanup tolerates already removed containers but preserves daemon failures', (t) => {
  let failure = false;
  const name = 'babel-run-00000000-0000-0000-0000-000000000000';
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['rm', '--force', name]);
    return { pid: 1, output: ['', '', ''], stdout: '', stderr: failure ? 'daemon unreachable' : 'Error: No such container: ' + name, status: 1, signal: null };
  });
  syncBuiltinESMExports();
  try {
    lifecycle.removeOwnedContainerSync(name, {});
    failure = true;
    assert.throws(() => lifecycle.removeOwnedContainerSync(name, {}), /daemon unreachable/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('async cleanup preserves daemon errors and accepts only a confirmed absent container', async (t) => {
  let missing = false;
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    assert.equal(args[0], 'docker');
    const callback = args.at(-1);
    assert.equal(typeof callback, 'function');
    if (typeof callback === 'function') callback(new Error('Docker exit 1'), '', missing ? 'No such container: owned' : 'daemon unreachable');
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  const name = 'babel-run-00000000-0000-0000-0000-000000000000';
  try {
    await assert.rejects(lifecycle.removeOwnedContainer(name, {}), /daemon unreachable/);
    missing = true;
    await lifecycle.removeOwnedContainer(name, {});
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('interrupted launch absence remains uncertain after bounded reconciliation', async (t) => {
  let calls = 0;
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    calls++;
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(new Error('Docker exit 1'), '', 'No such container: owned'));
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(lifecycle.removeOwnedContainer('babel-run-00000000-0000-0000-0000-000000000000', {}, true), /uncertain/i);
    assert.equal(calls, 3);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('interrupted launch reconciliation removes a container created after the first absence', async (t) => {
  let calls = 0;
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    calls++;
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(calls === 1 ? new Error('Docker exit 1') : null, '', calls === 1 ? 'No such container: owned' : ''));
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  try {
    await lifecycle.removeOwnedContainer('babel-run-00000000-0000-0000-0000-000000000000', {}, true);
    assert.equal(calls, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
