import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'

for (const variant of ['default', 'general_swe', 'partial-readback', 'strict', 'critic-reject'] as const) {
test(`ordinary CLI ${variant} retains only eligible unverified delivery`, (t) => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    mkdirSync(join(fixture.cwd, 'src'))
    writeFileSync(join(fixture.cwd, 'src/feedback.ts'), 'export const emptyMatches = 1\n// unchanged line for partial-readback control\n')
    execFileSync('git', ['add', 'src/feedback.ts'], { cwd: fixture.cwd, env: fixture.env })
    execFileSync('git', ['commit', '-qm', 'source-owned baseline'], { cwd: fixture.cwd, env: fixture.env })
    const baseTask = "When glob finds no paths, tool feedback says '1 matches' even though the body says 'No paths matched.' Fix src/feedback.ts so an empty result reports zero matches and real matches retain accurate counts. Inspect the code, make the smallest change, and run existing tests if available. Explain exactly what verification ran or was unavailable. Do not commit or push, change credentials/security settings, or make unrelated edits."
    const task = variant === 'strict' ? baseTask + ' Run npm test successfully before completing.' : baseTask
    const env = fixture.env
    const evidence = join(fixture.root, 'observed.json')
    const preload = join(fixture.root, 'response.mjs')
    writeFileSync(preload, `import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      process.env.COMMAND_CODE_API_KEY='synthetic-command-code-only';
      ${variant !== 'default' ? "process.env.BABEL_CHAT_TASK_CLASS='general_swe';" : ''}
      ${variant === 'critic-reject' ? "process.env.BABEL_DIFF_CRITIC='1';" : ''}
      let calls=0;
      globalThis.fetch=async(url,init)=>{
        assert.equal(String(url),'https://api.commandcode.ai/provider/v1/chat/completions');
        const body=JSON.parse(init.body);calls++;
        writeFileSync(${JSON.stringify(evidence)},JSON.stringify({calls,stream:body.stream,toolCount:body.tools?.length??0,critic:JSON.stringify(body.messages).includes('diff critic'),isolationTags:(body.messages.filter(m=>m.role==='tool').at(-1)?.content??'').match(/isolation|sandbox|CAPABILITY_DENIED|ISOLATION_REQUIRED/gi)}));
        assert.ok(calls<=20,'CONTROL_UNAVAILABLE_VERIFIER_REDISPATCH');
        if(!body.tools?.length){
          writeFileSync(${JSON.stringify(evidence)},JSON.stringify({calls,critic:true}));
          const content=JSON.stringify({verdict:${JSON.stringify(variant === 'critic-reject' ? 'reject' : 'pass')},confidence:0.99,reasons:${JSON.stringify(variant === 'critic-reject' ? ['CONTROL_REJECT_WRONG_PATCH'] : [])},checks:[]});
          if(body.stream===true)return new Response('data: '+JSON.stringify({model:body.model,choices:[{delta:{content},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');
          return Response.json({model:body.model,choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
        }
        const tool=(name,args)=>({index:0,id:'native-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}});
        let delta,finish='tool_calls';
        if(calls===1)delta={tool_calls:[tool('read_file',{path:'src/feedback.ts'})]};
        else if(calls===2)delta={tool_calls:[tool('str_replace',{file_path:'src/feedback.ts',old_str:'export const emptyMatches = 1',new_str:'export const emptyMatches = 0'})]};
        else if(calls===3)delta={tool_calls:[tool('read_range',{file_path:'src/feedback.ts',start_line:${variant === 'partial-readback' ? 2 : 1},end_line:${variant === 'partial-readback' ? 2 : 1}})]};
        else if(calls===4)delta={tool_calls:[tool('test_run',{command:'npm test'})]};
        else {
          // Assert the actual denial from durable tool events below, not provider-specific tool-message encoding.
          delta={content:'Changed src/feedback.ts and read a line from that path. Tests were NOT RUN because execution isolation is unavailable. This patch is unverified; I do not claim tests passed or task correctness.'};finish='stop';
        }
        writeFileSync(${JSON.stringify(evidence)},JSON.stringify({calls}));
        return new Response('data: '+JSON.stringify({model:body.model,choices:[{index:0,delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
      };`)
    const args = ['--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../index.ts', import.meta.url)), 'run', '--mode', 'chat', task,
      '--model', 'command-code/deepseek-v4.1-flash', '--project-root', fixture.cwd, '--json']
    const child = spawnSync(process.execPath, args, { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(child.error, undefined)
    const payload = JSON.parse(child.stdout)
    const sessionRoot = join(fixture.root, 'runs/chat-sessions')
    const events = readdirSync(sessionRoot).flatMap(name => {
      const file = join(sessionRoot, name, 'thread_events.json')
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).events : []
    })
    const denial = events.find((event: any) => event.kind === 'tool_result' && event.tool_name === 'test_run')
    assert.equal(denial?.exit_code, 1, 'actual native test attempt must fail')
    assert.match(String(denial?.content), /DENY_CAPABILITY_CONSTRAINT|isolation|sandbox/i, 'host must deny the real verifier dispatch')
    if (variant === 'strict' || variant === 'critic-reject') {
      assert.notEqual(payload.status, 'ANSWER_READY', 'strict verifier and critic rejections must remain rejecting')
      assert.notEqual(payload.terminal_outcome, 'UNVERIFIED_PATCH')
      assert.notEqual(payload.terminal_outcome, 'INFRA_FAILURE', 'fixture must not manufacture the rejection through transport failure')
      return
    }
    assert.equal(child.status, 0, `CONTROL_HONEST_DELIVERY: status=${payload.status}; outcome=${payload.terminal_outcome}; controls=${[...`${child.stdout}${child.stderr}`.matchAll(/CONTROL_[A-Z_]+/g)].map(x => x[0]).join(',')}`)
    assert.equal(payload.status, 'ANSWER_READY')
    assert.equal(payload.terminal_outcome, 'UNVERIFIED_PATCH')
    assert.match(JSON.stringify(payload), /Tests were NOT RUN/)
    assert.match(JSON.stringify(payload.answer), /A file change was confirmed and the path was read afterward/)
    assert.doesNotMatch(JSON.stringify(payload.answer), /File changes were read back/)
    assert.equal(readFileSync(join(fixture.cwd, 'src/feedback.ts'), 'utf8'), 'export const emptyMatches = 0\n// unchanged line for partial-readback control\n')
    assert.ok(JSON.parse(readFileSync(evidence, 'utf8')).calls <= 6, 'no impossible verifier recovery request; optional critic remains active')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})
}
