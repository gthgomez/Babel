import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyProviderRoute, qualifiedProviders, readProviderRoute, saveProviderRoute} from '../native/provider-routing.mjs';
import {buildRunArgs} from '../native/child.mjs';

test('qualified providers lists certified providers', () => {
  const providers = qualifiedProviders();
  const ids = providers.map(p => p.id);
  assert.deepEqual(ids.sort(), ['deepinfra', 'deepseek', 'ollama', 'openrouter']);
});

test('provider route is persisted and applied to child env for all supported providers', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-route-'));

  // OpenRouter
  saveProviderRoute({configDirectory: config, provider: 'openrouter', model: 'deepseek-v4-pro-openrouter'});
  assert.deepEqual(readProviderRoute(config), {provider: 'openrouter', model: 'deepseek-v4-pro-openrouter'});
  let env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'openrouter');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'deepseek-v4-pro-openrouter');

  // Direct DeepSeek
  saveProviderRoute({configDirectory: config, provider: 'deepseek', model: 'deepseek-v4-pro'});
  assert.deepEqual(readProviderRoute(config), {provider: 'deepseek', model: 'deepseek-v4-pro'});
  env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'deepseek');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'deepseek-v4-pro');

  // DeepInfra
  saveProviderRoute({configDirectory: config, provider: 'deepinfra', model: 'deepseek-v4-flash'});
  assert.deepEqual(readProviderRoute(config), {provider: 'deepinfra', model: 'deepseek-v4-flash'});
  env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'deepinfra');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'deepseek-v4-flash');
  assert.equal(env.BABEL_LITE_OFFLINE, '1');

  // Ollama
  saveProviderRoute({configDirectory: config, provider: 'ollama', model: 'deepseek-v4-flash'});
  assert.deepEqual(readProviderRoute(config), {provider: 'ollama', model: 'deepseek-v4-flash'});
  env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'ollama');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'deepseek-v4-flash');
  assert.equal(env.BABEL_LITE_OFFLINE, '1');

  rmSync(config, {recursive: true, force: true});
});

test('buildRunArgs passes --model when route model is configured', () => {
  const entry = join(tmpdir(), 'entry', 'index.js');
  const root = join(tmpdir(), 'project');
  const args = buildRunArgs(entry, root, {task: 'hello', mode: 'chat', model: 'deepseek-v4-pro'});
  assert.ok(args.includes('--model'));
  const modelIdx = args.indexOf('--model');
  assert.equal(args[modelIdx + 1], 'deepseek-v4-pro');
  assert.ok(modelIdx < args.lastIndexOf('--'));

  // Without model
  const noModel = buildRunArgs(entry, root, {task: 'hello', mode: 'chat'});
  assert.equal(noModel.includes('--model'), false);

  // Invalid model
  assert.throws(() => buildRunArgs(entry, root, {task: 'hello', mode: 'chat', model: 'bad model; echo hi'}));
});

