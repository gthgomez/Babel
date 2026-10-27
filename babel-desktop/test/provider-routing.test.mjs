import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyProviderRoute, qualifiedProviders, readProviderRoute, saveProviderRoute, validateProviderRoute} from '../native/provider-routing.mjs';
import {parseModelCatalog} from '../native/model-catalog.mjs';
import {buildRunArgs} from '../native/child.mjs';

test('Desktop supports certified Go and rejects stale unqualified Zen selections', () => {
  const config=mkdtempSync(join(tmpdir(),'babel-route-certification-'));
  try {
    saveProviderRoute({configDirectory:config,provider:'opencode-go',model:'opencode-go/deepseek-v4.1-flash'});
    const file=join(config,'desktop-routing.json'),before=readFileSync(file);
    assert.throws(()=>saveProviderRoute({configDirectory:config,provider:'opencode',model:'ox-alpha-free'}),/qualified provider/);
    assert.deepEqual(readFileSync(file),before);
    writeFileSync(file,JSON.stringify({provider:'opencode',model:'ox-alpha-free'}));
    assert.equal(readProviderRoute(config),null);
    assert.deepEqual(applyProviderRoute({PATH:'/bin'},config),{PATH:'/bin'});
  } finally {rmSync(config,{recursive:true,force:true});}
});

test('qualified providers lists certified providers', () => {
  const providers = qualifiedProviders();
  const ids = providers.map(p => p.id);
  assert.deepEqual(ids.sort(), ['command-code', 'deepinfra', 'deepseek', 'ollama', 'opencode-go', 'openrouter']);
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
  saveProviderRoute({configDirectory: config, provider: 'deepinfra', model: 'qwen3'});
  assert.deepEqual(readProviderRoute(config), {provider: 'deepinfra', model: 'qwen3'});
  env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'deepinfra');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'qwen3');
  assert.equal(env.BABEL_LITE_OFFLINE, '0');

  // Local routes must be discovered from the actual Ollama service.
  writeFileSync(join(config,'desktop-model-catalog.json'),JSON.stringify({models:[{id:'ollama/local-fixture',provider:'ollama',modelId:'local-fixture',label:'Local fixture',enabled:true}]}));
  saveProviderRoute({configDirectory:config,provider:'ollama',model:'ollama/local-fixture'});
  assert.deepEqual(readProviderRoute(config),{provider:'ollama',model:'ollama/local-fixture'});
  env=applyProviderRoute({PATH:'/bin'},config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER,'ollama');
  assert.equal(env.BABEL_LITE_OFFLINE,'1');

  // OpenCode Go route
  saveProviderRoute({configDirectory: config, provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash'});
  assert.deepEqual(readProviderRoute(config), {provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash'});
  env = applyProviderRoute({PATH: '/bin'}, config);
  assert.equal(env.BABEL_DESKTOP_PROVIDER, 'opencode-go');
  assert.equal(env.BABEL_DESKTOP_MODEL_ROUTE, 'opencode-go/deepseek-v4.1-flash');

  rmSync(config, {recursive: true, force: true});
});

test('discovered catalog routes stay selectable when parseModelCatalog marks enabled false', () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-route-discovered-'));
  const fetchedAt = new Date().toISOString();
  const discovered = parseModelCatalog('openrouter', {
    data: [{id: 'vendor/new-code', name: 'Vendor New Code'}],
  }, [], fetchedAt);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].enabled, false);
  assert.equal(discovered[0].qualification, 'unverified');
  writeFileSync(join(config, 'desktop-model-catalog.json'), JSON.stringify({
    schemaVersion: 1,
    models: discovered,
  }));
  const route = validateProviderRoute({provider: 'openrouter', model: 'openrouter/vendor/new-code'}, config);
  assert.equal(route.model, 'openrouter/vendor/new-code');
  rmSync(config, {recursive: true, force: true});
});

test('invalid provider/model pairs are rejected before persistence', () => {
  assert.throws(() => validateProviderRoute({provider: 'deepseek', model: 'unknown-model'}), /not supported/);
  const config = mkdtempSync(join(tmpdir(), 'babel-route-invalid-'));
  assert.throws(() => saveProviderRoute({configDirectory: config, provider: 'ollama', model: 'deepseek-v4-pro'}), /not supported/);
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

