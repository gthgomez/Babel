// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hasProviderCredential, saveProviderCredential} from '../native/credentials.mjs';
import {readProviderRoute, saveProviderRoute, validateProviderRoute} from '../native/provider-routing.mjs';

const FIXTURE_VALUE = 'BabelTestCredentialPlaceholder0000';

function simulateTrustedSave({configDirectory, provider, model, apiKey, scope, projectRoot}) {
  const route = validateProviderRoute({provider, model});
  const requiresKey = route.provider !== 'ollama';
  if (requiresKey && !apiKey && !hasProviderCredential({configDirectory, provider: route.provider, scope, projectRoot})) {
    throw new Error('Enter a provider API key.');
  }
  if (apiKey) {
    saveProviderCredential({provider: route.provider, apiKey, scope, configDirectory, projectRoot});
  }
  saveProviderRoute({configDirectory, ...route});
  return route;
}

test('invalid model is rejected before any credential file mutation', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-boundary-'));
  try {
    assert.throws(
      () => simulateTrustedSave({configDirectory: config, provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: FIXTURE_VALUE, scope: 'private'}),
      /not supported/,
    );
    assert.equal(existsSync(join(config, '.env')), false);
    assert.equal(readProviderRoute(config), null);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});

test('route-only save succeeds when private credential already exists', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-route-only-'));
  try {
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    const route = simulateTrustedSave({configDirectory: config, provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: '', scope: 'private'});
    assert.deepEqual(route, {provider: 'deepseek', model: 'deepseek-v4-pro'});
    assert.equal(readFileSync(join(config, '.env'), 'utf8').match(/DEEPSEEK_API_KEY=/g)?.length, 1);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});

test('opencode route persists without deepseek provider alias', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-opencode-'));
  try {
    saveProviderCredential({provider: 'opencode', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    saveProviderRoute({configDirectory: config, provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash'});
    assert.deepEqual(readProviderRoute(config), {provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash'});
    assert.match(readFileSync(join(config, '.env'), 'utf8'), /^OPENCODE_API_KEY=/);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});
