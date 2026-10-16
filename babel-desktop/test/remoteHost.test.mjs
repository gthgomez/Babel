// License: Apache-2.0 - see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {RemoteBridgeChild, buildRemoteServeArgs} from '../native/remoteHost.mjs';

test('RemoteBridgeChild exposes stopped lifecycle state before start', () => {
  const entry = join(tmpdir(), 'babel-cli', 'dist', 'index.js');
  const root = join(tmpdir(), 'project');
  const bridge = new RemoteBridgeChild({executable: process.execPath, entry, projectRoot: root});
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.running, false);
  assert.throws(() => buildRemoteServeArgs(entry, root, {port: 80}), /Invalid remote listen port/);
});

test('remote startup diagnostics never forward child stdout or stderr payloads',async()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-remote-safe-diagnostics-'));
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const entry=join(root,'fixture.mjs');
  writeFileSync(entry,`import {createServer} from 'node:http';
const key=process.env.DEEPSEEK_API_KEY;
for(let i=0;i<32;i++){process.stdout.write('startup '+key+String.fromCharCode(27)+'[31m\\n');process.stderr.write('diagnostic '+key+String.fromCharCode(27)+'[31m\\n');}
createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
  const env={};for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,DEEPSEEK_API_KEY:'fixture-sensitive'});
  const bridge=new RemoteBridgeChild({executable:process.execPath,entry,projectRoot:root,env,inheritEnv:false}),lines=[];
  try{
    const result=await bridge.start({port,onLine:line=>lines.push(line),readyTimeoutMs:5000});
    assert.equal(result.port,port);assert.equal(bridge.state,'ready');
    assert.equal(JSON.stringify(lines).includes('fixture-sensitive'),false,'Remote IPC exposed a synthetic credential');
    assert.equal(JSON.stringify(lines).includes('\\u001b'),false,'Remote IPC exposed child control characters');
    assert.equal(lines.length<=3,true,'Remote diagnostics were not bounded');
    assert.equal(lines.some(line=>line.diagnosticAvailable===true),true);
  }finally{bridge.stop();rmSync(root,{recursive:true,force:true});}
});
