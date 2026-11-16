import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const worker=join(packageRoot,'dist','config','sharedCredential.worker.js');
test('built Linux keyring worker uses pinned Secret Service options with a synthetic native binding',
  {skip:process.platform!=='linux'||!existsSync(worker)},()=>{
    const root=mkdtempSync(join(tmpdir(),'babel-keyring-worker-'));
    const config=join(root,'dist','config'),binding=join(root,'node_modules','@napi-rs','keyring');
    mkdirSync(config,{recursive:true});mkdirSync(binding,{recursive:true});
    writeFileSync(join(root,'package.json'),'{"type":"module"}');
    copyFileSync(worker,join(config,'sharedCredential.worker.js'));
    copyFileSync(join(packageRoot,'dist','config','sharedCredentialStore.js'),join(config,'sharedCredentialStore.js'));
    writeFileSync(join(binding,'package.json'),'{"main":"index.cjs"}');
    writeFileSync(join(binding,'index.cjs'),`exports.Entry=class {constructor(service,id,options){if(service!=='Babel'||options?.linux?.store!=='secret-service')throw Error('wrong backend')} getPassword(){return 'synthetic-only'} setPassword(value){if(value!=='synthetic-only')throw Error('wrong value')} deletePassword(){return true}}`);
    const run=(request)=>spawnSync(process.execPath,[join(config,'sharedCredential.worker.js')],{input:JSON.stringify(request),encoding:'utf8',timeout:5000,env:{},shell:false});
    const id='11111111-1111-4111-8111-111111111111';
    for(const [operation,expected] of [['get','synthetic-only'],['set',true],['remove',true]]){
      const response=run({operation,id,...(operation==='set'?{value:'synthetic-only'}:{})});
      assert.equal(response.status,0);assert.deepEqual(JSON.parse(response.stdout),{ok:true,result:expected});
      assert.equal(response.stderr,'');
    }
    const invalid=run({operation:'get',id:'../other-app'});
    assert.equal(invalid.status,1);assert.deepEqual(JSON.parse(invalid.stdout),{ok:false,result:null});
  });
