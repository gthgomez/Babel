import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'
import { resolveTaskShape } from '../config/chatTaskClass.js'
import { classifyChatTaskIntent } from '../agent/chatEngineTaskIntent.js'

const prompt = 'Turn meeting-notes.txt into a short, readable HTML brief I can open locally. Choose sensible headings, formatting and a filename; no need to ask about cosmetic choices. Preserve the decisions, dates, action owners and unresolved question. Save one self-contained HTML file in this directory, report its exact path, and do not fetch external resources.'
const notes = 'Decision: ship CSV on 2026-11-02. Team A drafts release notes by 2026-10-30. Dark theme is unresolved.\n'
const html = '<!doctype html><html><body><h1>Brief</h1><p>Ship CSV on 2026-11-02. Team A drafts release notes by 2026-10-30. Dark theme is unresolved.</p></body></html>\n'

for (const [task, writable] of [
  [prompt, true],
  ['Save one HTML file from meeting-notes.txt. Do not fetch external resources.', true],
  ['Turn the notes into an HTML file. Do not fetch external resources.', true],
  ['Explain how to save an HTML file without editing any files.', false],
  ['Inspect meeting-notes.txt only. Do not save or write any files.', false],
  ['Save one HTML file, but do not edit any files.', false],
  ['Save money by explaining the notes. Do not edit files.', false],
  ['If I save an HTML file, what happens?', false],
  ['Should I save an HTML file?', false],

  ['If I save an HTML file, what happens? Then save a brief.html copy.', true],
  ['If the notes are complete, save one HTML file.', true],
  ['Save one HTML file. If I save another file, what happens?', true],
  ['Save brief.html from the notes. Do not fetch external resources.', true],
  ['Explain the notes and save a brief.html copy locally.', true],
] as const) {
  test(`artifact intent preserves explicit write scope: ${task}`, () => {
    assert.equal(resolveTaskShape(task).operation !== 'READ_ONLY', writable)
    assert.equal(classifyChatTaskIntent(task), writable ? 'execute' : 'explain')
  })
}

test('hypothetical advice and money-saving are not file mutation authority', () => {
  assert.equal(resolveTaskShape('Tell me whether to save an HTML file.').operation, 'READ_ONLY')
  assert.equal(resolveTaskShape('Save money by comparing the options.').operation, 'READ_ONLY')
})

for (const variant of ['save', 'worktree', 'explicit-read-only', 'inspect-only', 'advice'] as const) {
  test(`ordinary CLI ${variant} advertises effective tools and preserves actual artifacts`, () => {
    const fixture = prepareSyntheticProviderFixture()
    try {
      const trustedGitCommonDir = variant === 'worktree' ? join(fixture.root, 'main', '.git') : undefined
      if (trustedGitCommonDir) {
        const main = join(fixture.root, 'main')
        renameSync(fixture.cwd, main)
        execFileSync('git', ['worktree', 'add', '--detach', fixture.cwd], { cwd: main, env: fixture.env })
      }
      writeFileSync(join(fixture.cwd, 'meeting-notes.txt'), notes)
      execFileSync('git', ['add', 'meeting-notes.txt'], { cwd: fixture.cwd, env: fixture.env })
      execFileSync('git', ['commit', '-qm', 'source-owned notes baseline'], { cwd: fixture.cwd, env: fixture.env })
      const task = variant === 'advice' ? 'Should I save an HTML file from these notes?' : variant === 'inspect-only' ? 'Inspect meeting-notes.txt only. Do not save or write any files.' : prompt
      const writable = variant === 'save' || variant === 'worktree'
      const evidence = join(fixture.root, 'provider-observation.json')
      const preload = join(fixture.root, 'response.mjs')
      writeFileSync(preload, `import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        process.env.COMMAND_CODE_API_KEY = 'synthetic-command-code-only';
        let calls=0;
        globalThis.fetch=async(url,init)=>{
          assert.equal(String(url),'https://api.commandcode.ai/provider/v1/chat/completions');
          const body=JSON.parse(init.body);
          assert.equal(body.model,'deepseek/deepseek-v4.1-flash');
          assert.equal(body.max_tokens,32000);
          assert.ok(body.messages.some(m=>m.role==='user' && m.content===${JSON.stringify(task)}),'CONTROL_FROZEN_PROMPT');
          const names=(body.tools??[]).map(t=>t.function.name);
          assert.equal(names.includes('write_file'),${writable},'CONTROL_WRITER_ADVERTISEMENT');
          calls++;
          const tool=(name,args,id)=>({index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}});
          let delta,finish='tool_calls';
          if(calls===1)delta={tool_calls:[tool('read_file',{path:'meeting-notes.txt'},'read')]};
          else if(calls===2) {
            assert.ok(JSON.stringify(body.messages).includes('Dark theme is unresolved'));
            delta={tool_calls:[tool('write_file',{path:'brief.html',content:${JSON.stringify(html)}},'write')]};
          } else if(calls===3 && ${writable})delta={tool_calls:[tool('read_file',{path:'brief.html'},'readback')]};
          else{assert.equal(calls,${writable ? 4 : 3});delta={content:${JSON.stringify(writable ? 'Saved brief.html; readback retained the dates and unresolved dark-theme question. No external resources were fetched.' : 'Inspected notes; no files were written. The write attempt was rejected.')}};finish='stop';}
          writeFileSync(${JSON.stringify(evidence)},JSON.stringify({calls,names}));
          return new Response('data: '+JSON.stringify({model:body.model,choices:[{index:0,delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
        };`)
      const args = [
        '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
        '--import', import.meta.resolve('tsx'), '--import', pathToFileURL(preload).href,
        fileURLToPath(new URL('../index.ts', import.meta.url)), 'run', '--mode', 'chat', task,
        '--model', 'command-code/deepseek-v4.1-flash', '--project-root', fixture.cwd, '--json',
        ...(trustedGitCommonDir ? ['--trusted-git-common-dir', trustedGitCommonDir] : []),
        ...(variant === 'explicit-read-only' ? ['--read-only'] : []),
      ]
      const child = spawnSync(process.execPath, args, { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
      assert.equal(child.error, undefined, 'native CLI must finish before watchdog')
      const diagnostic = (() => { try { const p = JSON.parse(child.stdout); return { status: p.status, outcome: p.terminal_outcome, markers: [...`${child.stdout}${child.stderr}`.matchAll(/CONTROL_[A-Z_]+/g)].map(x => x[0]) } } catch { return { parseable: false } } })()
      assert.equal(child.status, 0, `native CLI must retain a useful answer: ${JSON.stringify(diagnostic)}`)
      const payload = JSON.parse(child.stdout)
      assert.equal(readFileSync(join(fixture.cwd, 'meeting-notes.txt'), 'utf8'), notes)
      assert.equal(existsSync(join(fixture.cwd, 'brief.html')), writable)
      if (writable) {
        assert.equal(readFileSync(join(fixture.cwd, 'brief.html'), 'utf8'), html)
        assert.equal(payload.terminal_outcome, 'UNVERIFIED_PATCH')
        assert.ok(payload.answer.answer.includes('brief.html'))
        assert.ok(payload.toolCalls.some((x: { tool: string; target: string }) => x.tool === 'read_file' && x.target.includes('brief.html')))
      } else assert.equal(payload.terminal_outcome, 'NO_CHANGE_REQUIRED')
      assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).calls, writable ? 4 : 3)
    } finally { removeSyntheticProviderFixture(fixture.root) }
  })
}
