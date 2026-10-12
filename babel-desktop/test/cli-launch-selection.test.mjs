// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolvePackagedEngine, buildInstallId, writeActiveEngine, installDir} from '../native/engine-manager.mjs';

const SHA = 'c'.repeat(40);

/** Mirrors production `scripts/cli-launch.mjs` entry selection (no child spawn). */
function selectPackagedCliEntry({userData, resourcesPath, bundled}) {
  let entryPath = bundled.path;
  try {
    const resolved = resolvePackagedEngine({userData, resourcesPath, bundled});
    if (resolved?.ready && resolved?.path) entryPath = resolved.path;
  } catch {
    entryPath = bundled.path;
  }
  return entryPath;
}

test('production launch selection uses installed CLI when ready', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-cli-launch-'));
  const resources = join(userData, 'resources');
  const bundledCli = join(resources, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = join(resources, 'babel-runtime', 'node', 'node.exe');
  mkdirSync(dirname(bundledCli), {recursive: true});
  mkdirSync(dirname(node), {recursive: true});
  writeFileSync(bundledCli, 'bundled');
  writeFileSync(node, '');
  const installId = buildInstallId(SHA);
  const installRoot = installDir(userData, installId);
  const installedEntry = join(installRoot, 'cli', 'dist', 'index.js');
  mkdirSync(dirname(installedEntry), {recursive: true});
  writeFileSync(installedEntry, 'installed');
  writeActiveEngine(userData, {id: installId, channelPreference: 'stable'});
  const bundled = {path: bundledCli, label: 'Bundled', executable: node, ready: true, source: 'bundled'};
  const selected = selectPackagedCliEntry({userData, resourcesPath: resources, bundled});
  assert.equal(selected, installedEntry);
  rmSync(userData, {recursive: true, force: true});
});

test('production launch selection keeps bundled entry when install is missing but bundled is ready', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-cli-launch-fallback-'));
  const resources = join(userData, 'resources');
  const bundledCli = join(resources, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = join(resources, 'babel-runtime', 'node', 'node.exe');
  mkdirSync(dirname(bundledCli), {recursive: true});
  mkdirSync(dirname(node), {recursive: true});
  writeFileSync(bundledCli, 'bundled');
  writeFileSync(node, '');
  writeActiveEngine(userData, {id: 'missing-install', channelPreference: 'stable'});
  const bundled = {path: bundledCli, label: 'Bundled', executable: node, ready: true, source: 'bundled'};
  const selected = selectPackagedCliEntry({userData, resourcesPath: resources, bundled});
  assert.equal(selected, bundledCli);
  rmSync(userData, {recursive: true, force: true});
});

test('production launch selection does not select missing bundled runtime', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-cli-launch-missing-'));
  const resources = join(userData, 'resources');
  const bundledCli = join(resources, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = join(resources, 'babel-runtime', 'node', 'node.exe');
  const bundled = {path: bundledCli, label: 'Bundled', executable: node, ready: false, source: 'bundled'};
  const selected = selectPackagedCliEntry({userData, resourcesPath: resources, bundled});
  assert.equal(selected, bundledCli);
  rmSync(userData, {recursive: true, force: true});
});
