import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

test('Desktop streaming Plan uses the canonical read-only plan lane even with automatic application saved',()=>{
  const fixture=prepareSyntheticProviderFixture();
  try{
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{plans:{autoApply:true},budgetUsd:'unlimited'}}));
    const preload=join(fixture.root,'desktop-plan.mjs');
    writeFileSync(preload,"process.env.BABEL_DESKTOP_IPC='1';process.env.BABEL_LITE_OFFLINE='1';process.env.BABEL_OFFLINE='1';process.env.BABEL_PIPELINE_V9_OFFLINE='1';");
    const child=spawnSync(process.execPath,[
      '--experimental-wasm-modules','--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),'--import',pathToFileURL(preload).href,fileURLToPath(new URL('../index.ts',import.meta.url)),
      'run','--mode','plan','--model','glm-5.3-flash','--output-format','stream-json','--project-root',fixture.cwd,'--',
      'Inspect calc.js and plan a validation change. Do not modify any files.',
    ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error,undefined);
    assert.equal(child.status,0,child.stderr.slice(-1000));
    const events=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
    const result=events.find(event=>event.type==='run_complete')?.result;
    assert.ok(events.some(event=>event.type==='tool.started'),'actual read-only discovery activity reaches the stream');
    assert.ok(events.some(event=>event.type==='tool.completed'));
    assert.equal(result?.status,'PLAN_READY');
    assert.equal(result.command,'plan');
    assert.equal(typeof result.plan_id,'string');
    assert.match(result.answer.answer,/Steps:|plan/i);
    assert.deepEqual(result.changed_files,[]);
    assert.equal(readFileSync(join(fixture.cwd,'calc.js'),'utf8'),'export const value=1;\n');
    assert.doesNotMatch(child.stdout+child.stderr,/Automatic application enabled|MANUAL_BRIDGE_REQUIRED/);
  }finally{removeSyntheticProviderFixture(fixture.root);}
});
