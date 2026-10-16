import assert from 'node:assert/strict'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {writeFileSync,readFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs'

test('built CLI bootstraps and completes conversation without opted-in project intake',t=>{
  const fixture=prepareSyntheticProviderFixture()
  try {
    const marker=join(fixture.root,'dispatch.json'),preload=join(fixture.root,'conversation-response.mjs')
    writeFileSync(preload,`
      import assert from 'node:assert/strict';
      import {writeFileSync} from 'node:fs';
      process.env.BABEL_PROJECT_CREDENTIALS_DIR=${JSON.stringify(join(fixture.root,'must-not-inspect'))};
      process.env.BABEL_PROJECT_ROOT=${JSON.stringify(join(fixture.root,'must-not-admit'))};
      process.env.BABEL_ALLOWED_ROOTS=${JSON.stringify(join(fixture.root,'must-not-admit'))};
      process.env.BABEL_LEGACY_CLI_ENV='1';
      let calls=0;
      globalThis.fetch=async(url,init)=>{
        assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(++calls,1);
        assert.equal(process.env.BABEL_PROJECT_ROOT,undefined);
        assert.equal(process.env.BABEL_ALLOWED_ROOTS,undefined);
        const body=JSON.parse(init.body);
        assert.ok(!body.tools||body.tools.length===0);
        assert.notEqual(body.tool_choice,'required');
        if(process.argv.includes('--resume-chat'))assert.ok(body.messages.some(message=>message.role==='assistant'&&message.content.includes('Built CLI conversation response.')));
        writeFileSync(${JSON.stringify(marker)},JSON.stringify({calls,tools:body.tools?.length??0}));
        return new Response('data: '+JSON.stringify({model:'z-ai/glm-5.3-flash',choices:[{delta:{content:'Built CLI conversation response.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };
    `)
    const invoke=(extra:string[]=[])=>spawnSync(process.execPath,[
      '--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',pathToFileURL(preload).href,
      fileURLToPath(new URL('../../dist/index.js',import.meta.url)),
      'run','--mode','chat','--execution-scope','conversation','--model','glm-5.3-flash',
      '--execution-profile','safe_repo','--output-format','json',...extra,'--','Hello',
    ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:45000,windowsHide:true})
    const child=invoke()
    if(child.status!==0){
      const output=String(child.stdout)+String(child.stderr)
      t.diagnostic(JSON.stringify({dispatch:existsSync(marker),moduleMissing:output.includes('ERR_MODULE_NOT_FOUND'),fixtureRejected:output.includes('SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID'),syntax:output.includes('SyntaxError'),projectIntake:output.includes('must-not-inspect'),projectRequired:output.includes('PROJECT_REQUIRED'),policy:output.includes('LIVE_MODEL_POLICY'),assertion:output.includes('AssertionError')}))
    }
    assert.equal(child.error===undefined,true,'isolated built CLI must settle before watchdog')
    assert.equal(child.status,0,'isolated built CLI must complete without project admission')
    assert.equal(existsSync(marker),true,'synthetic provider boundary must be reached')
    assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{calls:1,tools:0})
    // Raw child output is never forwarded to a test diagnostic.
    const payload=JSON.parse(child.stdout)
    assert.equal(payload.scope.project_root,null)
    assert.equal(payload.execution_scope.kind,'conversation')
    assert.equal(payload.answer.answer,'Built CLI conversation response.')
    assert.notEqual(payload.terminal_outcome,'VERIFIED_COMPLETE')
    assert.equal(typeof payload.session_id,'string')
    assert.match(payload.session_id,/^[\w-]{1,80}$/)
    const sessionDir=join(fixture.root,'runs','chat-sessions',payload.session_id)
    assert.equal(resolve(payload.run_dir),resolve(sessionDir))
    const archive=readFileSync(join(sessionDir,'transcript.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(archive.some(message=>message.role==='user'&&message.content==='Hello'),'BUILT_ARCHIVE_MISSING_USER')
    assert.ok(archive.some(message=>message.role==='assistant'&&message.content==='Built CLI conversation response.'),'BUILT_ARCHIVE_MISSING_ASSISTANT')
    const resumed=invoke(['--resume-chat',payload.session_id])
    assert.equal(resumed.error===undefined,true,'built CLI resume must settle before watchdog')
    assert.equal(resumed.status,0,'built CLI must restore the existing conversation')
    const restored=JSON.parse(resumed.stdout)
    assert.equal(restored.session_id,payload.session_id)
    assert.equal(restored.scope.project_root,null)
    const retained=readFileSync(join(sessionDir,'transcript.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.equal(retained.filter(message=>message.role==='user'&&message.content==='Hello').length,2,'BUILT_RESUMED_ARCHIVE_MISSING_USER')
    assert.equal(retained.filter(message=>message.archive_kind==='terminal_response'&&message.content==='Built CLI conversation response.').length,2,'BUILT_RESUMED_ARCHIVE_MISSING_ASSISTANT')
    assert.deepEqual(retained.slice(0,archive.length).map(message=>message.source_event_id),archive.map(message=>message.source_event_id),'BUILT_RESUMED_ARCHIVE_REPLACED_IDENTITIES')
  } finally {removeSyntheticProviderFixture(fixture.root)}
})
