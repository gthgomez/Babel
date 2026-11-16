// Local offline tarball smoke. Dependencies are reused, so this is not a clean install.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,symlinkSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const npmCandidates=[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),
  resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
const npm=npmCandidates.find(existsSync);
const staged=existsSync(join(root,'dist','cliEntryDispatch.js'))&&existsSync(join(root,'resources','prompt_catalog.yaml'));
const bootstrap=new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href;

test('offline npm tarball starts with its packaged model catalog', {skip:!npm||!staged,timeout:180000},()=>{
  const fixture=prepareSyntheticProviderFixture();
  let dependencyLink,linkCreated=false;
  try{
    const npmEnv={...fixture.env,NPM_CONFIG_USERCONFIG:join(fixture.root,'npm-user.conf'),
      NPM_CONFIG_GLOBALCONFIG:join(fixture.root,'npm-global.conf'),NPM_CONFIG_CACHE:join(fixture.root,'cache')};
    delete npmEnv.OPENROUTER_API_KEY;delete npmEnv.DEEPSEEK_API_KEY;
    const packed=spawnSync(process.execPath,[npm,'pack','--offline','--ignore-scripts','--json','--pack-destination',fixture.root],
      {cwd:root,env:npmEnv,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:12000000});
    assert.equal(packed.status,0,`offline pack failed: ${packed.status}, ${packed.signal}`);
    const metadata=JSON.parse(packed.stdout)[0];
    assert.match(metadata.filename,/^[a-zA-Z0-9_.-]+\.tgz$/);
    const files=new Set(metadata.files.map(entry=>entry.path));
    for(const path of ['bin/babel.js','dist/config/offlineMode.js','resources/prompt_catalog.yaml','resources/config/model-policy.json'])assert.ok(files.has(path),`missing packaged ${path}`);
    const packageRoot=join(fixture.root,'package');mkdirSync(packageRoot);
    const unpacked=spawnSync('tar',['-xzf',join(fixture.root,metadata.filename),'-C',fixture.root],
      {env:fixture.env,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(unpacked.status,0,`local tar extraction failed: ${unpacked.status}; ${String(unpacked.stderr??'').slice(0,1000)}`);
    dependencyLink=join(packageRoot,'node_modules');
    symlinkSync(join(root,'node_modules'),dependencyLink,process.platform==='win32'?'junction':'dir');
    linkCreated=true;
    const run=args=>{
      const child=spawnSync(process.execPath,['--import',bootstrap,join(packageRoot,'bin','babel.js'),...args],
        {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:30000});
      const output=(child.stdout??'')+(child.stderr??'');
      assert.equal(child.status,0,`packaged command failed: ${args.join(' ')}; ${child.status}; ${child.signal}`);
      assert.doesNotMatch(output,/SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED|synthetic-router-credential|synthetic-deepseek-credential/);
      return JSON.parse(child.stdout);
    };
    assert.equal(run(['setup','--json']).state,'setup_required');
    run(['provider','connect','openrouter','--model','vendor/fixture']);
    run(['provider','use','openrouter','--save','user']);
    const models=run(['model','list','--json']);
    assert.ok(models.models.some(model=>typeof model.id==='string'&&model.id.includes('/')),'the installed layout must load bundled provider choices');
  }finally{if(linkCreated)unlinkSync(dependencyLink);removeSyntheticProviderFixture(fixture.root);}
});
