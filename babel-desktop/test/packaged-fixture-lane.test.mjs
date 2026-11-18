// License: Apache-2.0 — see LICENSE
// Resolver/history fixture controls use inert files, not installed engine execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assertAcceptanceSource, assertFixtureTaskReceipt, assertReadOnlyDenial, buildPackagedLaunchEnvironment, writePackagedAcceptanceProfile, MISSING_INSTALL_ID, HISTORY_SESSION_ID} from './packaged-electron-acceptance/packaged-fixture-lane.mjs';
import {readActiveEngine, resolvePackagedEngine} from '../native/engine-manager.mjs';
import {bundledNodeFileName, resolveOfficialCli, resolveBundledCli} from '../native/runtime.mjs';
import {readSavedChat} from '../native/sessions.mjs';
import {assertRepairBaseline} from './packaged-electron-acceptance/packaged-repair-fixture.mjs';

test('read-only control requires a plan-specific denial, not an unrelated access error', () => {
  assert.doesNotThrow(() => assertReadOnlyDenial([{type: 'tool.failed', tool: 'str_replace', detail: 'hard-plan-mode'}]));
  assert.throws(() => assertReadOnlyDenial([{type: 'tool.failed', tool: 'str_replace', detail: 'access denied'}]));
});

test('task receipts reject contradictory or incomplete terminal and transport evidence', () => {
  const terminal = {kind: 'event', type: 'run_complete', outcome: 'VERIFIED_COMPLETE', userStatus: 'completed'};
  const exit = {kind: 'exit', code: 0, displayLimited: false};
  assert.doesNotThrow(() => assertFixtureTaskReceipt([terminal, exit], 'VERIFIED_COMPLETE'));
  for (const events of [
    [{...terminal, userStatus: 'failed'}, exit],
    [{...terminal, verification: 'unverified'}, exit],
    [terminal, {kind: 'event', type: 'run_error'}, exit],
    [terminal, {...exit, displayLimited: true}],
    [terminal, {kind: 'transport-error'}, exit],
  ]) assert.throws(() => assertFixtureTaskReceipt(events, 'VERIFIED_COMPLETE'));
});

test('packaged acceptance launch keeps operating-system paths but drops ambient credentials and runtime overrides', () => {
  const profile = join(tmpdir(), 'acceptance-profile');
  const env = buildPackagedLaunchEnvironment({PATH: 'system-path', SystemRoot: 'windows-root',
    AWS_ACCESS_KEY_ID: 'canary', NODE_OPTIONS: 'injected', BABEL_READ_ONLY: 'true',
    BABEL_PROVIDER: 'openrouter', CUSTOM_CREDENTIAL: 'canary'}, profile);
  assert.equal(env.PATH, 'system-path');
  assert.equal(env.SystemRoot, 'windows-root');
  assert.equal(env.HOME, profile);
  assert.equal(env.USERPROFILE, profile);
  assert.equal(env.APPDATA, join(profile, 'launch-config'));
  for (const name of ['AWS_ACCESS_KEY_ID', 'NODE_OPTIONS', 'BABEL_READ_ONLY', 'BABEL_PROVIDER', 'CUSTOM_CREDENTIAL']) {
    assert.equal(env[name], undefined);
  }
});

test('installed acceptance refuses unknown BUILD provenance even without an expected SHA', () => {
  for (const build of [null, {}, {sourceSha: 'invalid'}]) assert.throws(() => assertAcceptanceSource(build), /missing or invalid/);
  assert.throws(() => assertAcceptanceSource({sourceSha: 'a'.repeat(40)}), /expected source/);
  assert.throws(() => assertAcceptanceSource({sourceSha: 'a'.repeat(40)}, 'b'.repeat(40)), /does not match/);
  assert.doesNotThrow(() => assertAcceptanceSource({sourceSha: 'a'.repeat(40)}, 'a'.repeat(40)));
});

test('missing installed selection stays on disk while real resolvers and history readers use bundled fallback fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-packaged-fallback-fixture-'));
  try {
    const profile = join(root, 'profile');
    const resourcesPath = join(root, 'resources');
    const packageRoot = join(resourcesPath, 'app');
    const fixtures = await writePackagedAcceptanceProfile(profile);
    assert.equal((await assertRepairBaseline(fixtures.projectRoot)).clean, true);
    assert.equal(fixtures.missingInstallId, MISSING_INSTALL_ID);
    assert.equal(readActiveEngine(profile).id, MISSING_INSTALL_ID);
    const selectionFile = join(profile, 'engine', 'active-engine.json');
    const before = await readFile(selectionFile);
    for (const path of [join(resourcesPath, 'babel-runtime', 'cli', 'dist', 'index.js'), join(resourcesPath, 'babel-runtime', 'node', bundledNodeFileName())]) {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, 'inert resolver fixture');
    }
    const official = resolveOfficialCli(packageRoot, {isPackaged: true, resourcesPath, userData: profile});
    const packaged = resolvePackagedEngine({userData: profile, resourcesPath, bundled: resolveBundledCli(packageRoot, {resourcesPath})});
    for (const resolved of [official, packaged]) {
      assert.equal(resolved.ready, true);
      assert.equal(resolved.source, 'bundled');
      assert.equal(resolved.fallbackFrom, MISSING_INSTALL_ID);
    }
    assert.deepEqual(await readFile(selectionFile), before);
    const options = {runsDir: join(profile, 'engine', 'state', 'runs')};
    const latest = await readSavedChat(packageRoot, HISTORY_SESSION_ID, options);
    const older = await readSavedChat(packageRoot, HISTORY_SESSION_ID, {...options, olderOffset: 150});
    assert.equal(latest.messages.length, 150);
    assert.equal(latest.messages[0].text, 'm-010');
    assert.equal(latest.messages.at(-1).text, 'm-159');
    assert.equal(older.messages.length, 10);
    assert.equal(older.messages.at(-1).text, 'm-009');
    assert.equal((await assertRepairBaseline(fixtures.projectRoot)).testExit, 1,
      'read-only history and engine fallback must leave the repair fixture unchanged');
  } finally { await rm(root, {recursive: true, force: true}); }
});
