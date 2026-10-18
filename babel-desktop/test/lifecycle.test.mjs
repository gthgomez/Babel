import test from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../native/lifecycle.mjs';

test('busy close requires an explicit choice; background preserves the owned runtime',async()=>{
  assert.equal(lifecycle.decideWindowClose({busy:true}),'ask');
  const effects=[];
  const request=lifecycle.createCloseRequest({ask:async()=> 'background',background:()=>effects.push('hide'),stopAndClose:()=>effects.push('stop'),onError:error=>{throw error;}});
  await request();assert.deepEqual(effects,['hide']);
});

test('duplicate close signals share one prompt and dismissing it leaves work alone',async()=>{
  let resolve;const effects=[];
  const request=lifecycle.createCloseRequest({ask:()=>new Promise(done=>{resolve=done;effects.push('ask');}),background:()=>effects.push('hide'),stopAndClose:()=>effects.push('stop'),onError:()=>effects.push('error')});
  const pending=request();await request();assert.deepEqual(effects,['ask']);
  resolve('cancel');await pending;assert.deepEqual(effects,['ask']);
});

test('a failed background control leaves the runtime visible and stop is consumed once',async()=>{
  let choice='background';const effects=[];
  const request=lifecycle.createCloseRequest({ask:async()=>choice,background:()=>{throw new Error('tray unavailable');},stopAndClose:()=>effects.push('stop'),onError:error=>effects.push(error.message)});
  await request();assert.deepEqual(effects,['tray unavailable']);
  choice='stop';await request();await request();assert.deepEqual(effects,['tray unavailable','stop']);
});

test('declining a failed final save releases the close latch for later active work',async()=>{
  let finish,attempts=0,prompts=0;
  const request=lifecycle.createCloseRequest({ask:async()=>{prompts++;return 'stop';},background:()=>{},stopAndClose:()=>{attempts++;return new Promise(resolve=>{finish=resolve;});},onError:error=>{throw error;}});
  const first=request();await Promise.resolve();await request();
  assert.equal(prompts,1);assert.equal(attempts,1);
  finish(false);await first;
  const retry=request();await Promise.resolve();
  assert.equal(prompts,2,'an aborted final save must permit a fresh busy-close choice');
  finish(true);await retry;await request();
  assert.equal(attempts,2,'successful quit remains consumed once');
});
