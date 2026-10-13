// License: Apache-2.0 — see LICENSE
// Real registered callback/import evidence with isolated Electron lifecycle bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {saveProviderCredential} from '../native/credentials.mjs';
const FIXTURE_VALUE = 'BabelTestCredentialPlaceholder0000';

async function registeredHandler(source, config, channel = 'babel:save-provider-credential', lifecycle = {}) {
  const channels = Array.isArray(channel) ? channel : [channel];
  const callbacks = channels.map(name => {
    const callback = source.match(new RegExp(`handle\\('${name}',([\\s\\S]+?)\\n  \\}\\);`))?.[1];
    assert.ok(callback, `registered ${name} callback must be found`);
    return `(${callback}\n})`;
  });
  const bindings = {
    assertIdle() {}, runtimeEnvironment: () => ({BABEL_CONFIG_DIR: config}),
    preferences: {projectRoot: null, projectCredentialRoot: null},
    savePreferences: async () => {}, diagnostics: null,
    connectionChangeBusy: false, runAdmission: false, runner: null, remoteBridge: null, updateBusy: false,
    ...lifecycle,
  };
  const busy = source.match(/const busy=([^;]+);/)?.[1];
  const idle = source.match(/function assertIdle\(\)\{[^\n]+\}/)?.[0];
  const connection = source.match(/async function withConnectionChange\(fn\)\{[\s\S]+?\n\}/)?.[0] ?? '';
  assert.ok(busy && idle);
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/(credentials|provider-routing|provider-route-save)\.mjs['"]/g)) {
    const module = await import(`../native/${match[2]}.mjs`);
    for (const entry of match[1].split(',')) {
      const [exported, local = exported] = entry.trim().split(/\s+as\s+/);
      assert.equal(typeof module[exported], 'function');
      bindings[local] = module[exported];
    }
  }
  const handlers = runInNewContext(`const busy=${busy};\n${idle}\n${connection}\n[${callbacks.join(',')}]`, bindings);
  return Array.isArray(channel) ? handlers : handlers[0];
}

test('registered route save rejects concurrent connection changes until persistence settles', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-ipc-route-concurrency-'));
  try {
    const source = readFileSync(new URL('../native/main.mjs', import.meta.url), 'utf8');
    let release;
    const persisted = new Promise(resolve => {release = resolve;});
    const preferences = {projectRoot: null, projectCredentialRoot: null};
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    const [handler, legacy] = await registeredHandler(source, config, ['babel:save-provider-route', 'babel:save-provider-credential'], {preferences, savePreferences: () => persisted});
    const options = {provider: 'ollama', model: 'deepseek-v4-flash', scope: 'private', apiKey: ''};
    const first = handler(options);
    const releaseDeadline = setTimeout(release, 50);
    try {
      await assert.rejects(() => handler(options), /Wait for the current Babel run/);
      await assert.rejects(() => legacy({provider: 'deepseek', model: 'deepseek-v4-pro', scope: 'private', apiKey: ''}), /Wait for the current Babel run/);
    }
    finally { clearTimeout(releaseDeadline); release(); await first; }
    assert.equal((await handler(options)).credentialUpdated, false);
  } finally { rmSync(config, {recursive: true, force: true}); }
});

test('registered legacy handler saves blank-key existing credentials using its declared imports', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-ipc-credential-'));
  try {
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    const source = readFileSync(new URL('../native/main.mjs', import.meta.url), 'utf8');
    const options = {provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: '', scope: 'private'};
    const result = await (await registeredHandler(source, config))(options);
    assert.equal(result.configured, true);
    assert.equal(result.scope, 'private');
    const missing = source.replace(/\bhasProviderCredential\s*,\s*/, '');
    assert.notEqual(missing, source);
    await assert.rejects(() => registeredHandler(missing, config).then(handler => handler(options)), /hasProviderCredential is not defined/);
  } finally { rmSync(config, {recursive: true, force: true}); }
});

test('registered legacy handler restores the last persisted scope after preference failure', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-ipc-legacy-failure-'));
  try {
    const source = readFileSync(new URL('../native/main.mjs', import.meta.url), 'utf8');
    const preferences = {projectRoot: join(config, 'fixture-project'), projectCredentialRoot: null};
    const handler = await registeredHandler(source, config, 'babel:save-provider-credential', {
      preferences, savePreferences: async () => { throw new Error('Fixture preferences rejected'); },
    });
    await assert.rejects(() => handler({provider: 'ollama', model: 'deepseek-v4-flash', scope: 'project', apiKey: ''}), /Fixture preferences rejected/);
    assert.equal(preferences.projectCredentialRoot, null);
  } finally { rmSync(config, {recursive: true, force: true}); }
});
