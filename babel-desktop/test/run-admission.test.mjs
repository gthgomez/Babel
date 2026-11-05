import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RunAdmissionLedger} from '../native/run-admission.mjs';

test('one durable claim wins across instances and distinct submissions remain usable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-run-admission-'));
  try{
    const directory=join(root,'claims'),first=new RunAdmissionLedger(directory),second=new RunAdmissionLedger(directory);
    const claims=await Promise.all([first.claim('submission'),second.claim('submission')]);
    assert.deepEqual(claims.sort(),[false,true]);
    assert.equal(await new RunAdmissionLedger(directory).claim('submission'),false);
    assert.equal(await first.claim('distinct'),true);
    const receipts=await Promise.all((await readdir(directory)).map(async name=>JSON.parse(await readFile(join(directory,name),'utf8'))));
    assert.deepEqual(receipts.find(receipt=>receipt.runId==='submission'),{schemaVersion:1,runId:'submission'});
    for(const id of ['NUL','con','COM1','Case','case']){
      assert.equal(await first.claim(id),true);
      assert.equal(await new RunAdmissionLedger(directory).claim(id),false);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('invalid IDs and unavailable storage fail before admission; uncertain receipts stay consumed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'babel-run-admission-fail-'));
  try{
    const directory=join(root,'claims'),ledger=new RunAdmissionLedger(directory);
    for(const id of ['../escape','',null,'a'.repeat(101)])await assert.rejects(()=>ledger.claim(id),/run ID/);
    await ledger.claim('interrupted');
    await writeFile(join(directory,(await readdir(directory))[0]),'');
    assert.equal(await ledger.claim('interrupted'),false,'an interrupted claim must never replay');
    const blocked=join(root,'not-directory');await writeFile(blocked,'preserve');
    await assert.rejects(()=>new RunAdmissionLedger(blocked).claim('never-started'));
    assert.equal(await readFile(blocked,'utf8'),'preserve');
  }finally{await rm(root,{recursive:true,force:true});}
});
