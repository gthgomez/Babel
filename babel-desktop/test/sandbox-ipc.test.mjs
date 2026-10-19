// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {isAppUrl,APP_URL} from '../native/security.mjs';
import {extractBusyBinding} from './main-busy-source.mjs';

const source=readFileSync(new URL('../native/main.mjs',import.meta.url),'utf8');
function sandboxHandler(overrides={}){
  const webContents={mainFrame:{url:APP_URL}};
  let registered;
  const context={
    window:{isDestroyed:()=>false,webContents},isAppUrl,
    ipcMain:{handle:(_channel,callback)=>registered=callback},
    runner:null,remoteBridge:null,runAdmission:false,updateBusy:false,connectionChangeBusy:false,
    diagnostics:{ready:false},preferences:{sandboxImage:null,sandboxImageReference:null},
    configureSandboxImage:async()=>({sandboxImage:'sha256:'+'a'.repeat(64),sandboxImageReference:'custom:v1'}),
    savePreferences:async()=>{},getInfo:async()=>({ready:true}),...overrides,
  };
  const registration=source.slice(source.indexOf("  handle('babel:configure-sandbox'"),source.indexOf("  handle('babel:check-cli-update'"));
  const busyBinding=extractBusyBinding(source);
  assert.ok(busyBinding,'busy binding must be extractable from main.mjs');
  const declarations=[
    busyBinding,
    source.match(/function validateSender\(event\)\{[\s\S]+?\n\}/)[0],
    source.match(/function handle\(channel,fn\)\{[^\n]+/)[0],
    source.match(/function assertIdle\(\)\{[^\n]+/)[0],
    source.match(/async function withConnectionChange\(fn\)\{[\s\S]+?\n\}/)[0],
  ].join('\n');
  runInNewContext(declarations+'\n'+registration,context);
  return {call:options=>registered({sender:webContents,senderFrame:webContents.mainFrame},options),untrusted:()=>registered({sender:{},senderFrame:{url:APP_URL}},{}),context};
}

test('sandbox IPC rejects foreign senders and active runs before Docker execution',async()=>{
  let calls=0;
  const handler=sandboxHandler({runner:{busy:true},configureSandboxImage:async()=>{calls++;}});
  await assert.rejects(handler.untrusted,/untrusted/);
  await assert.rejects(()=>handler.call({prepareRecommended:true}),/Wait for the current Babel run/);
  assert.equal(calls,0);
});

test('sandbox IPC reserves the connection through validation and persistence',async()=>{
  let release,entered;
  const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
  const handler=sandboxHandler({savePreferences:async()=>{entered();await pending;}});
  const first=handler.call({reference:'custom:v1'});
  await started;
  await assert.rejects(()=>handler.call({prepareRecommended:true}),/Wait for the current Babel run/);
  release();await first;
  assert.equal(handler.context.preferences.sandboxImage,'sha256:'+'a'.repeat(64));
  assert.equal(handler.context.diagnostics,null);
  assert.equal(handler.context.connectionChangeBusy,false);
});

test('sandbox IPC restores persisted settings and releases admission after a write failure',async()=>{
  const preferences={sandboxImage:'sha256:'+'b'.repeat(64),sandboxImageReference:'previous:v1'};
  const handler=sandboxHandler({preferences,savePreferences:async()=>{throw new Error('Fixture write failure');}});
  await assert.rejects(()=>handler.call({reference:'custom:v1'}),/Fixture write failure/);
  assert.equal(preferences.sandboxImage,'sha256:'+'b'.repeat(64));
  assert.equal(preferences.sandboxImageReference,'previous:v1');
  assert.equal(handler.context.connectionChangeBusy,false);
  await assert.rejects(()=>handler.call(null),/Invalid sandbox setup request/);
});
