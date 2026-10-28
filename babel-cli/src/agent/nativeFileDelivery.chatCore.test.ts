import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'

if (!process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']) {
  test('normal native file delivery in a credential-free transport fixture', () => {
    const fixture = prepareSyntheticProviderFixture()
    try {
      const result = spawnSync(process.execPath, ['--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href, '--import', import.meta.resolve('tsx'), '--test', import.meta.filename], { cwd: process.cwd(), env: fixture.env, encoding: 'utf8', timeout: 120000 })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      assert.equal(result.status, 0)
    } finally { removeSyntheticProviderFixture(fixture.root) }
  })
} else {
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const { ChatEngine } = await import('./chatEngine.js')
  const { DIFF_CRITIC_SYSTEM_PROMPT } = await import('./diffCritic.js')
  const prompt = 'Update REPO_MAP.md to match the current tree. Use another available method if a command cannot run; verify the listed paths.'
  const corrected = '# Repository map\n- apps/web/main.mjs\n- packages/api/server.mjs\n'
  const root = process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!
  const tool = (name: string, args: object, id: string) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  for (const variant of ['correct', 'no-op', 'wrong-file', 'required-tests', 'host-required', 'no-readback', 'critic-reject'] as const) {
    test(`normal entrypoint: ${variant} retains honest delivery and verification status`, async t => {
      if (variant === 'critic-reject') {
        const before = process.env['BABEL_HEADLESS']
        process.env['BABEL_HEADLESS'] = '1'
        t.after(() => { if (before === undefined) delete process.env['BABEL_HEADLESS']; else process.env['BABEL_HEADLESS'] = before })
      }
      const dir = join(root, variant)
      mkdirSync(join(dir, 'apps/web'), { recursive: true }); mkdirSync(join(dir, 'packages/api'), { recursive: true })
      writeFileSync(join(dir, 'REPO_MAP.md'), '# Repository map\n- src/client\n- src/server\n')
      writeFileSync(join(dir, 'apps/web/main.mjs'), 'export const page = "web"\n')
      writeFileSync(join(dir, 'packages/api/server.mjs'), 'export const service = "api"\n')
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['add', '.'], { cwd: dir })
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: dir })
      let calls = 0
      let criticCalls = 0
      let engine: InstanceType<typeof ChatEngine> | undefined
      const target = variant === 'wrong-file' ? 'OTHER_MAP.md' : 'REPO_MAP.md'
      const answer = 'The repository map was updated. The native readback is available; project tests could not run because shell isolation is unavailable.'
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions')
        const body = JSON.parse(String(init?.body))
        if (body.messages.some((m: { role: string; content: unknown }) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(DIFF_CRITIC_SYSTEM_PROMPT))) {
          criticCalls++
          return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: 'reject', confidence: 1, reasons: ['Controlled independent review rejects this edit.'] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }), { headers: { 'content-type': 'application/json' } })
        }
        calls++
        assert.equal(body.model, 'deepseek/deepseek-v4-flash-0731')
        assert.equal(body.max_tokens, 32000)
        let delta: object, finish = 'tool_calls'
        if (calls === 1) delta = { tool_calls: [tool('run_command', { command: 'ls', cwd: '.' }, 'shell')] }
        else if (calls === 2) {
          const denied = body.messages.find((m: { role: string; tool_call_id: string }) => m.role === 'tool' && m.tool_call_id === 'shell')
          assert.match(String(denied?.content), /isolation_unavailable/)
          delta = { tool_calls: ['REPO_MAP.md', 'apps/web/main.mjs', 'packages/api/server.mjs'].map((path, index) => ({ ...tool('read_file', { path }, `read-${index}`), index })) }
        } else if (calls === 3 && variant !== 'no-op') delta = { tool_calls: [tool('write_file', { path: target, content: corrected }, 'write')] }
        else if (calls === 4 && variant !== 'no-op' && variant !== 'no-readback') delta = { tool_calls: [tool('read_file', { path: target }, 'readback')] }
        else { delta = { content: answer }; finish = 'stop' }
        return new Response(`data: ${JSON.stringify({ id: `fixture-${calls}`, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.000001 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      const result = await runCliChatTask({ task: variant === 'required-tests' ? `${prompt} Run tests before completing.` : prompt, projectRoot: dir, model: 'deepseek-v4-flash-openrouter', outputFormat: 'json', engineFactory(options) { engine = new ChatEngine(variant === 'host-required' ? { ...options, requiredVerifierCommands: ['npm test'] } : options); return engine } })
      assert.ok(engine)
      const outcome = result.payload['terminal_outcome']
      const delivered = variant === 'correct' || variant === 'wrong-file'
      assert.notEqual(outcome, 'VERIFIED_COMPLETE')
      if (delivered) {
        assert.equal(outcome, 'UNVERIFIED_PATCH')
        assert.equal(result.exitCode, 0)
        assert.equal(calls, 5, 'unavailable verification must not cause repeated inference')
        assert.match(JSON.stringify(result.payload['answer']), /UNVERIFIED/)
        assert.match(JSON.stringify(result.payload['answer']), /native readback/)
        assert.notEqual(result.payload['reason_code'], 'verification_failed', 'unavailable verification is not a failed verifier run')
      } else {
        assert.equal(result.exitCode, 1)
        assert.equal(outcome, variant === 'no-op' ? 'AGENT_FAILURE' : 'BLOCKED_POLICY')
        if (variant === 'no-op') assert.match(JSON.stringify(result.payload), /response_evidence_invalid|RESPONSE_EVIDENCE_INVALID/)
      }
      if (variant === 'critic-reject') assert.ok(criticCalls > 0, 'default headless critic must execute before retained delivery')
      const map = readFileSync(join(dir, 'REPO_MAP.md'), 'utf8')
      assert.equal(map === corrected, variant === 'correct' || variant === 'required-tests' || variant === 'host-required' || variant === 'no-readback' || variant === 'critic-reject')
      assert.equal(readFileSync(join(dir, 'apps/web/main.mjs'), 'utf8'), 'export const page = "web"\n')
      assert.equal(readFileSync(join(dir, 'packages/api/server.mjs'), 'utf8'), 'export const service = "api"\n')
    })
  }
}
