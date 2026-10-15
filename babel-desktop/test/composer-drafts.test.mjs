import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm,readdir,link,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComposerDraftStore,composerDraftScope} from '../native/composer-drafts.mjs';

async function fixture(body){const root=await mkdtemp(join(tmpdir(),'babel-drafts-'));try{await body(root);}finally{await rm(root,{recursive:true,force:true});}}
const draft=(text='Unsent fixture')=>({id:'draft-one',sessionId:null,title:'New session',text,scrollTop:480,historyOffset:150});

test('drafts survive a new native owner with explicit canonical chat mapping and project isolation',()=>fixture(async root=>{
  const scope=composerDraftScope(null),store=new ComposerDraftStore(root);
  const initial=await store.read(scope);
  await store.write(scope,{...initial,drafts:[draft()]});
  const restarted=new ComposerDraftStore(root),restored=await restarted.read(scope);
  assert.deepEqual(restored.drafts,[draft()]);
  await restarted.write(scope,{...restored,drafts:[{...draft(),sessionId:'actual-cli-session'}]});
  assert.equal((await restarted.read(scope)).drafts[0].sessionId,'actual-cli-session');
  assert.deepEqual((await restarted.read(composerDraftScope(root))).drafts,[]);
}));

test('concurrent writes and stale or cross-scope snapshots cannot overwrite accepted drafts',()=>fixture(async root=>{
  const scope=composerDraftScope(null),store=new ComposerDraftStore(root),initial=await store.read(scope);
  const results=await Promise.allSettled([store.write(scope,{...initial,drafts:[draft('first accepted')]}),store.write(scope,{...initial,drafts:[draft('stale replacement')]})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  const accepted=await store.read(scope);
  await assert.rejects(store.write(composerDraftScope(root),{...accepted,drafts:[draft('wrong project')]}),/changed/);
  assert.equal((await store.read(scope)).drafts[0].text,'first accepted');
}));

test('newer, malformed and oversized draft data are preserved on refused writes',()=>fixture(async root=>{
  const scope=composerDraftScope(null),directory=join(root,'composer-drafts'),path=join(directory,`${scope}.json`),store=new ComposerDraftStore(root);
  await mkdir(directory);
  for(const bytes of [JSON.stringify({version:2,future:'preserved'}),'{broken json','x'.repeat(8*1024*1024+1)]){
    await writeFile(path,bytes);
    await assert.rejects(store.write(scope,{scope,revision:0,drafts:[draft()]}));
    assert.equal(await readFile(path,'utf8'),bytes);
  }
  await writeFile(path,JSON.stringify({version:2,future:'preserved'}));
  assert.equal((await store.read(scope)).readOnly,true);
}));

test('draft storage refuses hard-linked files and invalid payloads without revealing contents',()=>fixture(async root=>{
  const scope=composerDraftScope(null),store=new ComposerDraftStore(root),initial=await store.read(scope);
  await assert.rejects(store.write(scope,{...initial,drafts:[draft('x'.repeat(24001))]}),/Invalid/);
  await assert.rejects(store.write(scope,{...initial,drafts:[draft(),draft()]}),/Invalid/);
  await assert.rejects(store.write('../escape',{...initial,drafts:[]}),/Invalid/);
  const outside=join(root,'synthetic-private.txt'),path=join(root,'composer-drafts',`${scope}.json`);
  await writeFile(outside,'synthetic-private-canary');await link(outside,path);
  await assert.rejects(store.read(scope),error=>error.message==='Draft storage is unsafe or too large'&&!error.message.includes('synthetic-private-canary'));
  assert.equal(await readFile(outside,'utf8'),'synthetic-private-canary');
  assert.deepEqual((await readdir(join(root,'composer-drafts'))).filter(name=>name.endsWith('.tmp')),[]);
}));
