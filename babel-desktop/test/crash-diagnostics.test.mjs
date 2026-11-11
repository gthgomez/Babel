import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCrashDiagnosticRecorder} from '../native/crash-diagnostics.mjs';

test('crash records retain bounded technical facts without arbitrary event content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-crash-log-'));
  try{
    const record=createCrashDiagnosticRecorder({directory:root,build:{version:'0.2.1',sourceSha:'a'.repeat(40)},clock:()=>new Date('2026-01-02T03:04:05.000Z')});
    assert.equal(await record('renderer',{reason:'crashed',exitCode:7,message:'private-fixture-content'}),true);
    assert.equal(await record('Utility',{reason:'private-fixture-content',exitCode:9,serviceName:'private-fixture-content'}),true);
    const text=await readFile(join(root,'diagnostics','desktop-crashes.jsonl'),'utf8');
    const entries=text.trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(entries[0],{version:1,processType:'renderer',reason:'crashed',exitCode:7,time:'2026-01-02T03:04:05.000Z',build:{version:'0.2.1',sourceSha:'a'.repeat(40)}});
    assert.equal(entries[1].reason,'unknown');
    assert.equal(text.includes('private-fixture-content'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a full diagnostics file is preserved rather than silently overwritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-crash-cap-'));
  try{
    const dir=join(root,'diagnostics');await mkdir(dir);
    const path=join(dir,'desktop-crashes.jsonl');await writeFile(path,'existing-evidence');
    const record=createCrashDiagnosticRecorder({directory:root,maxBytes:16});
    assert.equal(await record('renderer',{reason:'crashed',exitCode:1}),false);
    assert.equal(await readFile(path,'utf8'),'existing-evidence');
  }finally{await rm(root,{recursive:true,force:true});}
});
