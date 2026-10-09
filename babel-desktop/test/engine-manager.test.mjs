import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import * as manager from '../native/engine-manager.mjs';

const SHA = 'a'.repeat(40);

test('resolvePackagedEngine prefers an installed build when present', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-engine-'));
  const resources = join(userData, 'resources');
  const bundledCli = join(resources, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = join(resources, 'babel-runtime', 'node', 'node.exe');
  mkdirSync(dirname(bundledCli), {recursive: true});
  mkdirSync(dirname(node), {recursive: true});
  writeFileSync(bundledCli, 'bundled');
  writeFileSync(node, '');
  const installId = manager.buildInstallId(SHA);
  const installRoot = manager.installDir(userData, installId);
  const installedEntry = join(installRoot, 'cli', 'dist', 'index.js');
  mkdirSync(join(installedEntry, '..'), {recursive: true});
  writeFileSync(installedEntry, 'installed');
  writeFileSync(join(installRoot, 'manifest.json'), JSON.stringify({id: installId, sourceSha: SHA}) + '\n');
  manager.writeActiveEngine(userData, {id: installId, channelPreference: 'stable'});
  const bundled = {path: bundledCli, label: 'Bundled', executable: node, ready: true, source: 'bundled'};
  const resolved = manager.resolvePackagedEngine({userData, resourcesPath: resources, bundled});
  assert.equal(resolved.path, installedEntry);
  assert.equal(resolved.source, 'installed');
  rmSync(userData, {recursive: true, force: true});
});
