// License: Apache-2.0 — see LICENSE
// Resolver/history fixture controls use inert files, not installed engine execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assertAcceptanceSource, writePackagedAcceptanceProfile, MISSING_INSTALL_ID, HISTORY_SESSION_ID} from './packaged-electron-acceptance/packaged-fixture-lane.mjs';
import {readActiveEngine, resolvePackagedEngine} from '../native/engine-manager.mjs';
import {resolveOfficialCli, resolveBundledCli} from '../native/runtime.mjs';
import {readSavedChat} from '../native/sessions.mjs';

test('installed acceptance refuses unknown BUILD provenance even without an expected SHA', () => {
  for (const build of [null, {}, {sourceSha: 'invalid'}]) assert.throws(() => assertAcceptanceSource(build), /missing or invalid/);
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
    assert.equal(fixtures.missingInstallId, MISSING_INSTALL_ID);
    assert.equal(readActiveEngine(profile).id, MISSING_INSTALL_ID);
    const selectionFile = join(profile, 'engine', 'active-engine.json');
    const before = await readFile(selectionFile);
    for (const path of [join(resourcesPath, 'babel-runtime', 'cli', 'dist', 'index.js'), join(resourcesPath, 'babel-runtime', 'node', 'node.exe')]) {
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
  } finally { await rm(root, {recursive: true, force: true}); }
});
