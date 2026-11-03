import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateDesktopProfile, DESKTOP_PROFILE_DIRECTORY, LEGACY_DESKTOP_PROFILE_DIRECTORY, PROFILE_MIGRATION_MARKER} from '../native/profile-migration.mjs';

function tree(parent) {
  const oldRoot = join(parent, LEGACY_DESKTOP_PROFILE_DIRECTORY);
  const nextRoot = join(parent, DESKTOP_PROFILE_DIRECTORY);
  return {oldRoot, nextRoot, marker: join(nextRoot, PROFILE_MIGRATION_MARKER)};
}

test('a fresh profile does not create either settings directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'babel-profile-fresh-'));
  try {
    const result = migrateDesktopProfile(parent);
    assert.equal(result.action, 'fresh');
    assert.equal(result.profile, join(parent, DESKTOP_PROFILE_DIRECTORY));
    assert.equal(statExists(result.profile), false);
    assert.equal(statExists(join(parent, LEGACY_DESKTOP_PROFILE_DIRECTORY)), false);
  } finally { rmSync(parent, {recursive: true, force: true}); }
});

test('an old profile is copied, verified, and left in place', () => {
  const parent = mkdtempSync(join(tmpdir(), 'babel-profile-old-'));
  const {oldRoot, nextRoot, marker} = tree(parent);
  try {
    mkdirSync(join(oldRoot, 'engine', 'config'), {recursive: true});
    writeFileSync(join(oldRoot, 'ui-connection.json'), '{"provider":"ollama"}\n', {mode: 0o600});
    writeFileSync(join(oldRoot, 'engine', 'config', '.env'), 'OLLAMA_HOST=local\n', {mode: 0o600});
    const result = migrateDesktopProfile(parent);
    assert.equal(result.action, 'copied');
    assert.equal(result.filesCopied, 2);
    assert.equal(readFileSync(join(nextRoot, 'ui-connection.json'), 'utf8'), '{"provider":"ollama"}\n');
    assert.equal(readFileSync(join(nextRoot, 'engine', 'config', '.env'), 'utf8'), 'OLLAMA_HOST=local\n');
    assert.equal(statSync(join(nextRoot, 'ui-connection.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(oldRoot, 'ui-connection.json'), 'utf8'), '{"provider":"ollama"}\n');
    const record = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(record.status, 'copied');
    assert.equal(record.verified, true);
    assert.equal(migrateDesktopProfile(parent).action, 'already-migrated');
    assert.equal(readFileSync(join(oldRoot, 'engine', 'config', '.env'), 'utf8'), 'OLLAMA_HOST=local\n');
  } finally { rmSync(parent, {recursive: true, force: true}); }
});

test('when both profiles exist, newer files stay and missing history is copied', () => {
  const parent = mkdtempSync(join(tmpdir(), 'babel-profile-both-'));
  const {oldRoot, nextRoot, marker} = tree(parent);
  try {
    mkdirSync(join(oldRoot, 'engine', 'state'), {recursive: true});
    mkdirSync(join(nextRoot), {recursive: true});
    writeFileSync(join(oldRoot, 'ui-connection.json'), '{"provider":"old"}\n');
    writeFileSync(join(nextRoot, 'ui-connection.json'), '{"provider":"new"}\n');
    writeFileSync(join(oldRoot, 'engine', 'state', 'history.json'), '{"sessions":["kept"]}\n');
    const result = migrateDesktopProfile(parent);
    assert.equal(result.action, 'copied');
    assert.equal(result.filesKept, 1);
    assert.equal(result.filesCopied, 1);
    assert.equal(readFileSync(join(nextRoot, 'ui-connection.json'), 'utf8'), '{"provider":"new"}\n');
    assert.equal(readFileSync(join(nextRoot, 'engine', 'state', 'history.json'), 'utf8'), '{"sessions":["kept"]}\n');
    assert.equal(readFileSync(join(oldRoot, 'ui-connection.json'), 'utf8'), '{"provider":"old"}\n');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).verified, true);
  } finally { rmSync(parent, {recursive: true, force: true}); }
});

test('a failed copy leaves the old profile untouched and writes no success marker', () => {
  const parent = mkdtempSync(join(tmpdir(), 'babel-profile-fail-'));
  const {oldRoot, marker} = tree(parent);
  try {
    mkdirSync(oldRoot, {recursive: true});
    writeFileSync(join(oldRoot, 'ui-connection.json'), '{"provider":"kept"}\n', {mode: 0o600});
    const before = readFileSync(join(oldRoot, 'ui-connection.json'));
    assert.throws(() => migrateDesktopProfile(parent, {copyFile() { throw new Error('disk full'); }}), /disk full/);
    assert.deepEqual(readFileSync(join(oldRoot, 'ui-connection.json')), before);
    assert.equal(statExists(marker), false);
    assert.equal(statExists(oldRoot), true);
  } finally { rmSync(parent, {recursive: true, force: true}); }
});

function statExists(path) {
  try { statSync(path); return true; } catch { return false; }
}
