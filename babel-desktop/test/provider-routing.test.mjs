import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyProviderRoute, readProviderRoute, saveProviderRoute} from '../native/provider-routing.mjs';

test('provider route is persisted and applied to child env', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-route-'));
  saveProviderRoute({configDirectory: config, provider: 'openrouter', model: 'deepseek-v4-pro-openrouter'});
  assert.deepEqual(readProviderRoute(config), {provider: 'openrouter', model: 'deepseek-v4-pro-openrouter'});
  const env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'openrouter');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'deepseek-v4-pro-openrouter');
  rmSync(config, {recursive: true, force: true});
});
