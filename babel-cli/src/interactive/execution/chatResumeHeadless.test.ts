import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { chatSessionDir, transcriptPath } from '../../cli/runsLayout.js';
import { isSafeChatSessionId, openResumedChatEngine } from './chatResumeHeadless.js';
import { ChatEngine } from '../../agent/chatEngine.js';
import type { ResolvedModelPolicy } from '../../modelPolicy.js';
import { acquireSessionPolicyLease } from '../../config/sessionPolicyLease.js';
import { recordNewSessionPolicy } from '../../config/sessionExecutionPolicy.js';
import { attachSessionAdmissionStore } from './chatTransport.js';
import { bindBdnsAfterCanonicalFlush } from '../../diagnostics/bdns/sessionAttach.js';

const previousRuns = process.env['BABEL_RUNS_DIR'];
const root = await mkdtemp(join(tmpdir(), 'babel-resume-'));

after(async () => {
  if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
  else process.env['BABEL_RUNS_DIR'] = previousRuns;
  await rm(root, { recursive: true, force: true });
});

test('chat session ids reject path segments', () => {
  assert.equal(isSafeChatSessionId('chat-abc123'), true);
  assert.equal(isSafeChatSessionId('../chat-abc'), false);
  assert.equal(isSafeChatSessionId('chat/abc'), false);
  assert.equal(isSafeChatSessionId(''), false);
});

test('resume refuses a transcript whose repository identity is unproven', async () => {
  process.env['BABEL_RUNS_DIR'] = root;
  const sessionId = 'chat-unproven';
  await mkdir(chatSessionDir(sessionId), { recursive: true });
  await writeFile(transcriptPath(sessionId), `${JSON.stringify({ role: 'user', content: 'hi' })}\n`);
  await assert.rejects(
    () => openResumedChatEngine(sessionId, { task: 'next', projectRoot: root }),
    /Cannot resume chat session chat-unproven/,
  );
});

test('headless resume retains policy and exclusive ownership with durable admission evidence', {timeout:20000}, async () => {
  process.env['BABEL_RUNS_DIR']=root;
  const priorProfile=process.env['BABEL_EXECUTION_PROFILE'];process.env['BABEL_EXECUTION_PROFILE']='host_native';
  const project=join(root,'project');await mkdir(project,{recursive:true});
  const runner={
    executeRawStream:async function*(){yield JSON.stringify({type:'completion',answer:'Fixture response.'});},
    executeRaw:async()=> 'Fixture response.',execute:async()=>({type:'completion',answer:'Fixture response.'}),
    getLastInvocationMetadata:()=>null,
  };
  const policy:ResolvedModelPolicy={policyPath:'fixture',family:'fixture',selectedTier:'cheap',resolvedBackendKey:'fixture',provider:'opencode-go',providerModelId:'fixture-model',expensive:false,enabled:true,experimental:true,blockedWithoutExplicitOptIn:false,approximateInputTokens:0,approximateOutputTokens:0,warnings:[],waterfall:[],stagePolicies:[],contextWindow:128000,contextLimit:128000,maxOutputTokens:1024,nativeToolUse:false};
  const selection={profile:'host_native',source:'default',expectedBoundary:'host'} as const;
  const options={task:'Inspect the fixture.',projectRoot:project,model:'fixture-model',providerRunner:runner as never,providerPolicy:policy};
  const original=new ChatEngine({...options,executionPolicy:selection});
  const id=original.getEngineRunId();
  try {
    const owner=acquireSessionPolicyLease(id);
    try{recordNewSessionPolicy(original,{});original.attachSessionPolicyLease(owner);}catch(error){owner.release();throw error;}
    attachSessionAdmissionStore(original);
    let terminal=false;
    for await(const event of original.submitMessageStream('Inspect the fixture.','explain'))if(event.type==='done')terminal=true;
    assert.equal(terminal,true);
    original.closeAdmissionStore();
    const restored=await openResumedChatEngine(id,{...options,executionPolicy:{profile:'host_native',source:'persisted',expectedBoundary:'host'}});
    try{
      assert.equal(restored.getEngineRunId(),id);
      assert.deepEqual(restored.getExecutionPolicy(),{profile:'host_native',source:'persisted',expectedBoundary:'host'});
      const parity=(restored as unknown as {parity:{admissionStore?:{listAdmissions:(id:string)=>{records:unknown[]}}}}).parity;
      assert.ok(parity.admissionStore);
      assert.ok(parity.admissionStore.listAdmissions(id).records.length>0);
      assert.throws(()=>acquireSessionPolicyLease(id),/already owned|unavailable/i);
    }finally{restored.closeAdmissionStore();}
    const next=acquireSessionPolicyLease(id);next.release();
  }finally{
    original.closeAdmissionStore();
    await bindBdnsAfterCanonicalFlush({sessionId:id,runDir:chatSessionDir(id),close:true});
    if(priorProfile===undefined)delete process.env['BABEL_EXECUTION_PROFILE'];else process.env['BABEL_EXECUTION_PROFILE']=priorProfile;
  }
});
