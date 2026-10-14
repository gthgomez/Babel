import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'

for (const actionKind of ['write_file', 'run_command', 'failed_command', 'in_tree_child', 'isolated_child'] as const) {
  test(`${actionKind}: next submitted request reflects parent context`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'babel-context-freshness-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/main.ts'), 'export const OLD_SYMBOL = 1\n')
    writeFileSync(join(root, '.gitignore'), '.babel/\n')
    for (const args of [['init', '-q'], ['add', 'src/main.ts', '.gitignore'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0)
    }
    const settings = {
      BABEL_NATIVE_TOOLS: 'disabled', BABEL_COMPACTION: 'off', BABEL_TOOL_PROFILE: 'legacy',
      BABEL_BENCHMARK_MODE: '1', BABEL_BENCHMARK_AUTO_APPROVE: '1',
      BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_ALLOW_HOST_FALLBACK: '1',
      BABEL_LITE_OFFLINE: '1', BABEL_LIVE: 'true', BABEL_DRY_RUN: 'false',
      BABEL_IMPLEMENT_WORKTREE: actionKind === 'isolated_child' ? '1' : '0',
      BABEL_AUTONOMY_LEASE: JSON.stringify({ version: 2, leaseId: 'freshness-fixture',
        scope: { repository: 'fixture', objective: 'context freshness' },
        allowedCapabilities: ['inspect_repository', 'search_repository', 'run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files'] }),
    }
    const prior = new Map(Object.keys(settings).map(key => [key, process.env[key]]))
    Object.assign(process.env, settings)
    t.after(() => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    const captures: string[] = []
    class Receiver extends DeepInfraApiRunner {
      protected override async dispatchFetch(_url: string, init: RequestInit): Promise<Response> {
        const body = JSON.parse(String(init.body))
        captures.push(body.messages[0].content)
        const answer = JSON.stringify(captures.length === 1
          ? { type: 'tool_calls', actions: [action] }
          : { type: 'completion', answer: 'Fixture result observed.' })
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
    }
    // A registered receiver model + synthetic usage keeps the real cost gate
    // complete; missing pricing/usage correctly stops after the first request.
    const runner = new Receiver('deepseek-ai/DeepSeek-V3-0324', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} })
    const engine = new ChatEngine({ task: 'Fix TASK_SENTINEL', projectRoot: root,
      model: 'deepseek-v4-flash', providerRunner: runner, runtimeMode: 'direct', maxTurns: 4 })
    // Keep map generation deterministic; production owns caching, invalidation and request compilation.
    const host = engine as any
    host.repoMapCache = '## Project map\nOLD_MAP_SENTINEL\n'
    host.generateRepoMap = async () => `## Project map\nNEW_MAP_SENTINEL\n${readFileSync(join(root, 'src/main.ts'), 'utf8')}`
    host.getOrBuildSystemPrompt('legacy')
    writeFileSync(join(root, 'mutate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('src/main.ts', 'export const NEW_SYMBOL = 2\\n');" + (actionKind === 'failed_command' ? 'process.exitCode = 1;' : ''))
    const action = actionKind === 'write_file'
      ? { type: 'write_file', path: 'src/main.ts', content: 'export const NEW_SYMBOL = 2\n' }
      : actionKind.endsWith('child')
        ? { type: 'sub_agent', task: 'Write a result under src', mutation: true, write_scope: ['src'] }
        : { type: 'run_command', command: 'node mutate.mjs' }
    const events = []
    for await (const event of engine.submitMessageStream('Fix TASK_SENTINEL using the specified fixture action; report the actual result')) events.push(event)
    assert.notEqual(host.toolCallLog.at(-1)?.error, 'blocked')
    assert.ok(host.toolCallLog.length > 0, 'the fixture action must reach executor settlement')
    assert.ok(captures.length >= 2, `next request missing: ${events.map(event => event.type === 'failed' ? event.error : event.type).join(', ')}`)
    if (actionKind === 'isolated_child') {
      assert.match(captures[1]!, /OLD_MAP_SENTINEL/)
    } else {
      assert.doesNotMatch(captures[1]!, /OLD_MAP_SENTINEL/)
      assert.match(captures[1]!, /NEW_MAP_SENTINEL/)
    }
  })
}
