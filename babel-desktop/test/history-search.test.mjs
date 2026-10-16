import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as sessions from '../native/sessions.mjs';

test('archive search finds retained content outside the loaded session and message windows',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-history-search-'));
  try{
    const runsDir=join(root,'runs');
    for(let index=0;index<35;index++){
      const dir=join(runsDir,'chat-sessions',`chat-${index}`);
      await mkdir(dir,{recursive:true});
      const records=[{role:'user',content:`Title ${index}`}];
      if(index===0)for(let n=0;n<170;n++)records.push({role:'assistant',content:n===0?'An EARLY retained needle':`later-${n}`});
      if(index===34)records.push({role:'user',content:'needle in another archive'});
      await writeFile(join(dir,'transcript.jsonl'),records.map(value=>JSON.stringify(value)).join('\n')+'\n');
    }
    assert.equal(typeof sessions.searchSavedChats,'function');
    const found=await sessions.searchSavedChats(root,'NEEDLE',{runsDir});
    assert.equal(found.totalMatches,2);
    assert.equal(found.results.length,2);
    const early=found.results.find(result=>result.sessionId==='chat-0');
    assert.equal(early.olderOffset,150);
    assert.match(early.excerpt,/EARLY retained needle/);
    const page=await sessions.readSavedChat(root,early.sessionId,{runsDir,olderOffset:early.olderOffset});
    assert.ok(page.messages.some(message=>message.text.includes('EARLY retained needle')));
    const capped=await sessions.searchSavedChats(root,'needle',{runsDir,limit:1});
    assert.equal(capped.results.length,1);
    assert.equal(capped.totalMatches,2);
    assert.equal(capped.hasMore,true);
    await assert.rejects(()=>sessions.searchSavedChats(root,'x'.repeat(501),{runsDir}),/query/i);
    await assert.rejects(()=>sessions.searchSavedChats(root,'needle',{runsDir,limit:10000}),/limit/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('history readers and search never follow linked session directories or transcript files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'babel-history-links-'));
  try{
    const runsDir=join(root,'runs'),base=join(runsDir,'chat-sessions'),outside=join(root,'outside');
    await mkdir(base,{recursive:true});await mkdir(outside);
    await writeFile(join(outside,'transcript.jsonl'),JSON.stringify({role:'user',content:'synthetic outside marker'})+'\n');
    await symlink(outside,join(base,'linked-session'),'junction');
    await assert.rejects(()=>sessions.readSavedChat(root,'linked-session',{runsDir}),/link|scope/i);
    const local=join(base,'linked-transcript');await mkdir(local);
    await t.test('linked transcript file',async context=>{
      try{await symlink(join(outside,'transcript.jsonl'),join(local,'transcript.jsonl'),'file');}
      catch(error){if(error.code==='EPERM'){context.skip('Host permits directory junctions but not file symlinks');return;}throw error;}
      await assert.rejects(()=>sessions.readSavedChat(root,'linked-transcript',{runsDir}),/link|scope/i);
    });
    const found=await sessions.searchSavedChats(root,'outside marker',{runsDir});
    assert.equal(found.totalMatches,0);
    assert.equal((await sessions.listSavedChats(root,{runsDir})).total,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('search hits beyond a message display boundary have a paged full-message path',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-history-message-'));
  try{
    const runsDir=join(root,'runs'),dir=join(runsDir,'chat-sessions','long-message');await mkdir(dir,{recursive:true});
    const content='x'.repeat(260000)+'NEEDLE-BEYOND-DISPLAY'+'z'.repeat(10000);
    await writeFile(join(dir,'transcript.jsonl'),JSON.stringify({role:'assistant',content})+'\n');
    const found=await sessions.searchSavedChats(root,'NEEDLE-BEYOND-DISPLAY',{runsDir});
    assert.equal(found.results[0].matchOffset,260000);
    const loaded=await sessions.readSavedChat(root,'long-message',{runsDir});
    assert.equal(loaded.messages[0].textTruncated,true);
    assert.equal(loaded.messages[0].messageIndex,0);
    const expanded=await sessions.readSavedMessage(root,'long-message',0,{runsDir,charOffset:250000});
    assert.ok(expanded.text.includes('NEEDLE-BEYOND-DISPLAY'));
    assert.equal(expanded.totalCharacters,content.length);
    assert.equal(expanded.hasPrevious,true);
    assert.equal(expanded.hasNext,false);
    await assert.rejects(()=>sessions.readSavedMessage(root,'long-message',-1,{runsDir}),/index/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('case-insensitive search retains original Unicode offsets and treats query syntax literally',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-history-unicode-'));
  try{
    const runsDir=join(root,'runs'),dir=join(runsDir,'chat-sessions','unicode');await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'transcript.jsonl'),JSON.stringify({role:'user',content:'İ'.repeat(150000)+'NEEDLE [a.*]'})+'\n');
    const found=await sessions.searchSavedChats(root,'needle',{runsDir});
    assert.equal(found.results[0].matchOffset,150000);
    assert.match(found.results[0].excerpt,/NEEDLE/);
    assert.equal((await sessions.searchSavedChats(root,'[a.*]',{runsDir})).totalMatches,1);
    assert.equal((await sessions.searchSavedChats(root,'[a.+]',{runsDir})).totalMatches,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
