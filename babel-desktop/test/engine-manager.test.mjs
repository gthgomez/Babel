import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
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

test('promoteStagedInstall promotes candidate and updates active engine', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-promote-'));
  try {
    const staging = manager.stageDir(userData, SHA);
    const stagedEntry = join(staging, 'cli', 'dist', 'index.js');
    mkdirSync(dirname(stagedEntry), {recursive: true});
    writeFileSync(stagedEntry, 'new build');

    const result = manager.promoteStagedInstall({
      userData,
      sourceSha: SHA,
      channel: 'stable',
      cliVersion: '0.1.2',
      artifactSha256: 'hash123',
      activate: true,
    });

    assert.equal(result.id, manager.buildInstallId(SHA));
    assert.equal(result.sourceSha, SHA);
    assert.equal(result.cliVersion, '0.1.2');

    const targetDir = manager.installDir(userData, result.id);
    assert.equal(existsSync(staging), false);
    assert.equal(readFileSync(join(targetDir, 'cli', 'dist', 'index.js'), 'utf8'), 'new build');

    const active = manager.readActiveEngine(userData);
    assert.equal(active.id, result.id);
  } finally {
    rmSync(userData, {recursive: true, force: true});
  }
});

test('promoteStagedInstall replaces existing install of same id safely', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-promote-replace-'));
  try {
    const staging1 = manager.stageDir(userData, SHA);
    const stagedEntry1 = join(staging1, 'cli', 'dist', 'index.js');
    mkdirSync(dirname(stagedEntry1), {recursive: true});
    writeFileSync(stagedEntry1, 'v1');
    manager.promoteStagedInstall({userData, sourceSha: SHA, channel: 'stable', cliVersion: '1.0.0'});

    const targetDir = manager.installDir(userData, manager.buildInstallId(SHA));
    assert.equal(readFileSync(join(targetDir, 'cli', 'dist', 'index.js'), 'utf8'), 'v1');

    const staging2 = manager.stageDir(userData, SHA);
    const stagedEntry2 = join(staging2, 'cli', 'dist', 'index.js');
    mkdirSync(dirname(stagedEntry2), {recursive: true});
    writeFileSync(stagedEntry2, 'v2');
    manager.promoteStagedInstall({userData, sourceSha: SHA, channel: 'stable', cliVersion: '2.0.0'});

    assert.equal(readFileSync(join(targetDir, 'cli', 'dist', 'index.js'), 'utf8'), 'v2');
    const manifest = manager.readInstallManifest(userData, manager.buildInstallId(SHA));
    assert.equal(manifest.cliVersion, '2.0.0');
  } finally {
    rmSync(userData, {recursive: true, force: true});
  }
});

test('promoteStagedInstall rejects staging without CLI entry without touching existing install', () => {
  const userData = mkdtempSync(join(tmpdir(), 'babel-promote-fail-'));
  try {
    const staging1 = manager.stageDir(userData, SHA);
    const stagedEntry1 = join(staging1, 'cli', 'dist', 'index.js');
    mkdirSync(dirname(stagedEntry1), {recursive: true});
    writeFileSync(stagedEntry1, 'v1');
    manager.promoteStagedInstall({userData, sourceSha: SHA, channel: 'stable', cliVersion: '1.0.0'});

    const targetDir = manager.installDir(userData, manager.buildInstallId(SHA));

    const staging2 = manager.stageDir(userData, SHA);
    mkdirSync(staging2, {recursive: true});
    assert.throws(() => {
      manager.promoteStagedInstall({userData, sourceSha: SHA, channel: 'stable', cliVersion: '2.0.0'});
    }, /Staged CLI entry is missing/);

    assert.equal(readFileSync(join(targetDir, 'cli', 'dist', 'index.js'), 'utf8'), 'v1');
  } finally {
    rmSync(userData, {recursive: true, force: true});
  }
});

