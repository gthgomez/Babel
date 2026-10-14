// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync,readFileSync} from 'node:fs';
import {dirname, join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import {bundledEnvironment} from '../native/runtime.mjs';
import {applyProviderRoute,saveProviderRoute} from '../native/provider-routing.mjs';
import {tmpdir} from 'node:os';
import {resolvePackagedEngine, buildInstallId, writeActiveEngine, installDir} from '../native/engine-manager.mjs';

const SHA = 'c'.repeat(40);

test('installed launcher pins both critic tiers and excludes inherited summarizer credentials',()=>{
  const profile=mkdtempSync(join(tmpdir(),'babel-launch-aux-'));
  try {
    const config=join(profile,'engine','config');
    const scriptUrl=new URL('../scripts/cli-launch.mjs',import.meta.url).href;
    const source=readFileSync(new URL(scriptUrl),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url','scriptUrl');
    for(const [provider,model,modelId] of [['openrouter','deepseek-v4-flash-openrouter','deepseek/deepseek-v4-flash-0731'],['opencode-go','opencode-go/deepseek-v4.1-flash','deepseek-v4.1-flash']]) {
      saveProviderRoute({configDirectory:config,provider,model,enabledModels:[model]});
      const inherited={APPDATA:profile,BABEL_COMPACTION_API_KEY:'synthetic',BABEL_COMPACTION_API_BASE:'https://other.invalid',BABEL_DIFF_CRITIC_PRO_MODEL:'disabled-model'};
      let launch;
      new Script(source).runInNewContext({scriptUrl,dirname,join,isAbsolute,fileURLToPath,resolvePackagedEngine,
        bundledEnvironment:userData=>bundledEnvironment(userData,inherited),applyProviderRoute,
        process:{argv:['node','launcher',`--profile-dir=${profile}`,'doctor'],env:inherited},
        spawn:(exe,args,options)=>{launch={exe,args,options};return {on(){}};},console});
      for(const key of ['BABEL_COMPACTION_MODEL','BABEL_DIFF_CRITIC_MODEL','BABEL_DIFF_CRITIC_PRO_MODEL'])assert.equal(launch.options.env[key],modelId);
      assert.equal(launch.options.env.BABEL_COMPACTION_API_KEY,undefined);
      if(provider!=='openrouter')assert.equal(launch.options.env.BABEL_COMPACTION_API_BASE,undefined);
    }
  }finally{rmSync(profile,{recursive:true,force:true});}
});

test('actual installed launcher consumes the same saved provider/default/private policy as Desktop',()=>{
  const profile=mkdtempSync(join(tmpdir(),'babel-launch-route-'));
  try{
    const config=join(profile,'engine','config');
    saveProviderRoute({configDirectory:config,provider:'opencode-go',model:'opencode-go/deepseek-v4.1-flash'});
    const scriptUrl=new URL('../scripts/cli-launch.mjs',import.meta.url).href;
    const source=readFileSync(new URL(scriptUrl),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url','scriptUrl');
    let launch;
    new Script(source).runInNewContext({scriptUrl,dirname,join,isAbsolute,fileURLToPath,resolvePackagedEngine,
      bundledEnvironment:userData=>bundledEnvironment(userData,{APPDATA:profile}),applyProviderRoute,
      process:{argv:['node','launcher',`--profile-dir=${profile}`,'doctor','--json'],env:{APPDATA:profile}},
      spawn:(exe,args,options)=>{launch={exe,args,options};return {on(){}};},console});
    assert.equal(launch.options.env.BABEL_DESKTOP_PROVIDER,'opencode-go');
    assert.equal(launch.options.env.BABEL_DESKTOP_MODEL_ROUTE,'opencode-go/deepseek-v4.1-flash');
    assert.equal(launch.options.env.BABEL_MODEL_POLICY_PATH,join(config,'model-policy.json'));
    assert.deepEqual(Array.from(launch.args).slice(1),['doctor','--json']);
  }finally{rmSync(profile,{recursive:true,force:true});}
});

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
