import {configureCredentialProtection} from '../native/credentials.mjs';
import {fixtureProtection} from './credential-fixture.mjs';
configureCredentialProtection(fixtureProtection);
// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveProviderCredential} from '../native/credentials.mjs';
import {readProviderRoute, saveProviderRoute} from '../native/provider-routing.mjs';

import {saveDesktopProviderRoute} from '../native/provider-route-save.mjs';
import {applyProjectCredentialScope} from '../native/childEnv.mjs';
import {execFileSync} from 'node:child_process';

const FIXTURE_VALUE = 'BabelTestCredentialPlaceholder0000';

test('manual route identity conflicts and invalid defaults fail before credential mutation',async()=>{
  const config=mkdtempSync(join(tmpdir(),'babel-manual-save-boundary-'));
  try{
    const valid={provider:'openrouter',model:'openrouter/vendor/manual',manualModelId:'vendor/manual',enabledModels:['openrouter/vendor/manual'],apiKey:FIXTURE_VALUE,scope:'private',configDirectory:config};
    for(const change of [{manualModelId:'bad model'},{manualModelId:'x'.repeat(201)},{provider:'deepseek'},{model:'command-code/vendor/manual'},{enabledModels:[]},{enabledModels:['openrouter/missing'] }]){
      await assert.rejects(()=>save({...valid,...change}));
      assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
    }
    writeFileSync(join(config,'model-policy.json'),JSON.stringify({models:{[valid.model]:{provider:'deepseek',model_id:'different',enabled:true}}}));
    await assert.rejects(()=>save(valid),/conflict/i);
    assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
    writeFileSync(join(config,'model-policy.json'),JSON.stringify({models:{}}));
    writeFileSync(join(config,'desktop-routing.json'),'{invalid');
    await assert.rejects(()=>save(valid));
    assert.equal(existsSync(join(config,'desktop-credentials.json')),false);
  }finally{rmSync(config,{recursive:true,force:true});}
});

test('route-only scope changes load the chosen existing credential and clear prior opt-in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-provider-scope-'));
  const project = join(root, 'project');
  const config = join(root, 'private');
  mkdirSync(project);
  execFileSync('git', ['init', project], {stdio: 'ignore'});
  writeFileSync(join(project, '.gitignore'), '.env\n');
  const preferences = {projectRoot: project, projectCredentialRoot: null};
  const persisted = [];
  const savePreferences = async () => { persisted.push({...preferences}); };
  const route = {provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: ''};
  try {
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'project', projectRoot: project});
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    const saveScope = scope => saveDesktopProviderRoute({options: {...route, scope}, configDirectory: config, preferences, savePreferences});
    assert.equal((await saveScope('project')).credentialUpdated, false);
    assert.equal(persisted.at(-1).projectCredentialRoot, project);
    assert.equal(applyProjectCredentialScope({}, preferences).BABEL_PROJECT_CREDENTIALS_DIR, project);
    assert.equal((await saveScope('private')).credentialUpdated, false);
    assert.equal(persisted.at(-1).projectCredentialRoot, null);
    assert.equal(applyProjectCredentialScope({BABEL_PROJECT_CREDENTIALS_DIR: project}, preferences).BABEL_PROJECT_CREDENTIALS_DIR, undefined);
    await assert.rejects(() => saveScope('invalid'), /explicit credential destination/);
    assert.equal(preferences.projectCredentialRoot, null);
    assert.equal(persisted.length, 2);
    await assert.rejects(() => saveDesktopProviderRoute({options: {...route, scope: 'project'}, configDirectory: config, preferences, savePreferences: async () => { throw new Error('fixture persistence failure'); }}), /fixture persistence failure/);
    assert.equal(preferences.projectCredentialRoot, null);
    assert.deepEqual(readProviderRoute(config), {provider: route.provider, model: route.model});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

function save(options) {
  return saveDesktopProviderRoute({
    options, configDirectory: options.configDirectory,
    preferences: {projectRoot: options.projectRoot, projectCredentialRoot: null},
    savePreferences: async () => {},
  });
}

test('invalid model is rejected before any credential file mutation', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-boundary-'));
  try {
    await assert.rejects(
      () => save({configDirectory: config, provider: 'deepseek', model: 'unknown-model', apiKey: FIXTURE_VALUE, scope: 'private'}),
      /not supported/,
    );
    assert.equal(existsSync(join(config, '.env')), false);
    assert.equal(readProviderRoute(config), null);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});

test('route-only save succeeds when private credential already exists', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-route-only-'));
  try {
    saveProviderCredential({provider: 'deepseek', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    const {route} = await save({configDirectory: config, provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: '', scope: 'private'});
    assert.deepEqual(route, {provider: 'deepseek', model: 'deepseek-v4-pro'});
    assert.equal(readFileSync(join(config, 'desktop-credentials.json'), 'utf8').includes(FIXTURE_VALUE), false);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});

test('Go route persists with its own credential namespace', async () => {
  const config = mkdtempSync(join(tmpdir(), 'babel-provider-opencode-'));
  try {
    saveProviderCredential({provider: 'opencode-go', apiKey: FIXTURE_VALUE, scope: 'private', configDirectory: config});
    saveProviderRoute({configDirectory: config, provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash'});
    assert.deepEqual(readProviderRoute(config), {provider: 'opencode-go', model: 'opencode-go/deepseek-v4.1-flash'});
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(config, 'desktop-credentials.json'), 'utf8')).entries, 'opencode-go'), true);
  } finally {
    rmSync(config, {recursive: true, force: true});
  }
});
