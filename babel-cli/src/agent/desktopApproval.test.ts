import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parseDesktopApprovalLine, parseDesktopDecision, waitForDesktopApproval } from './desktopApproval.js';

test('uninspectable oversized operation previews fail closed before asking for approval',async()=>{
  const prior=process.env['BABEL_DESKTOP_IPC'];
  process.env['BABEL_DESKTOP_IPC']='1';
  try {
    const request={request_id:'preview',thread_id:'thread',turn_id:'turn',operation_digest:'a'.repeat(64)};
    assert.equal(await waitForDesktopApproval({command:'apply_patch',reason:'fixture',details:'x'.repeat(250001),request}),false);
    assert.equal(await waitForDesktopApproval({command:' ',reason:'fixture',request}),false);
  }finally{if(prior===undefined)delete process.env['BABEL_DESKTOP_IPC'];else process.env['BABEL_DESKTOP_IPC']=prior;}
});

test('desktop approval accepts only an explicit allow_once decision', () => {
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_once"}'), 'allow_once');
  assert.equal(parseDesktopApprovalLine('{"decision":"deny"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_session"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('not-json'), 'deny');
  assert.equal(parseDesktopDecision('{"decision":"cancel"}'), 'cancel');
  assert.equal(parseDesktopApprovalLine('{"decision":"cancel"}'), 'deny');
});

test('stdin rejects unscoped and previous-turn allow replies before the current denial',async()=>{
  const home=mkdtempSync(join(tmpdir(),'babel-desktop-approval-'));
  const moduleUrl=new URL('./desktopApproval.ts',import.meta.url).href;
  const request={request_id:'approval-1',thread_id:'thread-1',turn_id:'turn-1',operation_digest:'a'.repeat(64)};
  const script=`const ipc=await import(${JSON.stringify(moduleUrl)}); const request=${JSON.stringify(request)}; const first=await ipc.waitForDesktopApproval({command:'fixture',reason:'fixture',request}); const second=await ipc.waitForDesktopApproval({command:'fixture',reason:'fixture',request:{...request,request_id:'approval-2',turn_id:'turn-2'}}); ipc.stopDesktopIpc(); console.log(JSON.stringify({results:{first,second}}));`;
  const env:NodeJS.ProcessEnv={BABEL_DESKTOP_IPC:'1',BABEL_DESKTOP_RUN_ID:'run-1',BABEL_CONFIG_DIR:home,BABEL_RUNS_DIR:join(home,'runs'),HOME:home,USERPROFILE:home};
  for(const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  const child=spawn(process.execPath,['--import','tsx','--import','./src/testinfra/register-no-ambient-inference.mjs','--input-type=module','-e',script],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),env,stdio:['pipe','pipe','pipe'],windowsHide:true,
  });
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const deadline=setTimeout(()=>child.kill(),15000);
  let prior:unknown,results:unknown,approvals=0;
  const lines=createInterface({input:child.stdout});
  try{
    for await(const line of lines){
      const value=JSON.parse(line);
      if(value.type==='approval.required'){
        const binding=value.item?.approval;
        assert.equal(binding?.schemaVersion,2);
        approvals++;
        const send=(decision:string,approval:unknown)=>child.stdin.write(JSON.stringify({decision,approval})+'\n');
        if(approvals===1){child.stdin.write('{"decision":"allow_once"}\n');prior=binding;send('allow_once',binding);}
        else {send('allow_once',prior);send('allow_once',{...binding,turn_id:'wrong-turn'});send('deny',binding);}
      }
      if(value.results)results=value.results;
    }
    assert.equal(await exited,0);
    assert.equal(approvals,2);
    assert.deepEqual(results,{first:true,second:false});
  }finally{clearTimeout(deadline);lines.close();child.kill();await exited;rmSync(home,{recursive:true,force:true});}
});

test('a completed Desktop turn exits with the parent stdin pipe still open', async () => {
  const moduleUrl = new URL('./desktopApproval.ts', import.meta.url).href;
  const script = `const ipc = await import(${JSON.stringify(moduleUrl)}); ipc.startDesktopIpc(); ipc.stopDesktopIpc?.(); if (ipc.stopDesktopIpc) { const approval = ipc.waitForDesktopApproval({command:'synthetic fixture',reason:'test'}); ipc.stopDesktopIpc(); if (await approval) throw Error('Closed channel approved'); ipc.startDesktopIpc(); ipc.stopDesktopIpc(); } console.log('turn finished');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, BABEL_DESKTOP_IPC: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('turn finished') && !exitTimer) {
      clearTimeout(startupTimer);
      exitTimer = setTimeout(() => child.kill(), 2000);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const startupTimer = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, `Completed turn stayed alive or failed: ${stderr}`);
    assert.match(stdout, /turn finished/);
  } finally { clearTimeout(startupTimer); clearTimeout(exitTimer); child.kill(); }
});
