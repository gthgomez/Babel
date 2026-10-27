import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  isSyntheticProviderFixtureReady,
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from '../../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('normal CLI wall controls run in an isolated, network-denied fixture', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', new URL('../../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--test', '--test-concurrency=1', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const exitCode = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', code => resolve(code ?? 1))
    })
    t.diagnostic(summarizeSyntheticProviderOutput(output, exitCode))
    for (const line of output.split('\n')) {
      if (line.startsWith('# {"control":')) t.diagnostic(line.slice(2))
      else if (exitCode !== 0 && /^(?:not ok |# Subtest:|  (?:failureType|code):)/.test(line)) t.diagnostic(line)
    }
    assert.equal(exitCode, 0)
    const inventory = JSON.parse(summarizeSyntheticProviderOutput(output, exitCode))
    assert.equal(inventory.tests, 4)
    assert.equal(inventory.passed, 4)
    assert.equal(inventory.skipped, 0)
  })
} else {
  // Isolation is verified before any production/provider import.
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { runCliChatTask } = await import('./chatCore.js')
  const { chatSessionDir } = await import('../../cli/runsLayout.js')
  const { initMinimalGitProject } = await import('../../testUtils/chatAdmissionFixture.js')
  const { globalCostTracker } = await import('../../services/costTracker.js')
  const { ChatEngine } = await import('../../agent/chatEngine.js')
  const { OpenCodeGoApiRunner } = await import('../../runners/openCodeGoApi.js')
  const { babelReviewModelPolicy } = await import('../../services/babelChatReview.js')
  process.env['BABEL_LIVE'] = '1'
  process.env['BABEL_HEADLESS'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'read_only_audit'
  process.env['BABEL_COMPACTION'] = 'off'
  process.env['BABEL_MEMORY_WRITEBACK'] = '0'

  for (const [name, taskClass, elapsed, finiteWall, stall] of [
    ['healthy SWE work continues after 600 seconds', 'general_swe', 60_001, false, false],
    ['healthy inspection continues after 10 seconds', 'quick_inspect', 10_001, false, false],
    ['explicit finite deadline reports exhaustion honestly', 'investigate', 60_001, true, false],
    ['genuine repeated-read stall still terminates without a task deadline', 'investigate', 1000, false, true],
  ] as const) {
    test(name, async t => {
      const fixtureRoot = process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']
      assert.ok(fixtureRoot)
      const root = mkdtempSync(join(fixtureRoot, 'tmp', 'wall-cli-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      initMinimalGitProject(root)
      writeFileSync(join(root, 'README.md'), 'The observed control value is 42.\n')
      for (let i = 2; i <= 11; i++) writeFileSync(join(root, `evidence-${i}.md`), 'The observed control value is 42.\n')
      process.env['BABEL_CHAT_TASK_CLASS'] = taskClass
      process.env['BABEL_CHAT_STALL_TURNS'] = '2'
      if (finiteWall) process.env['BABEL_CHAT_MAX_WALL_MS'] = '600000'
      else delete process.env['BABEL_CHAT_MAX_WALL_MS']
      globalCostTracker.resetSession()
      const originalNow = Date.now
      const originalFetch = globalThis.fetch
      let now = originalNow()
      Date.now = () => now
      t.after(() => { Date.now = originalNow; globalThis.fetch = originalFetch })
      let requests = 0
      const reads = taskClass === 'quick_inspect' ? 1 : 11
      globalThis.fetch = async (_input, init) => {
        requests++
        assert.ok(requests <= 20, 'a real stall must terminate before twenty provider requests')
        const body = JSON.parse(String(init?.body))
        now += elapsed
        const reading = requests <= reads || stall
        if (requests === 2 && !stall) {
          const observation = body.messages.find((message: { role: string }) => message.role === 'tool')
          assert.match(String(observation?.content), /control value is 42/)
        }
        const delta = reading ? { tool_calls: [{ index: 0, id: `read-${requests}`, type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: requests === 1 || stall ? 'README.md' : `evidence-${requests}.md` }) } }] }
          : { content: 'README.md says the observed control value is 42.' }
        return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5',
          choices: [{ index: 0, delta, finish_reason: reading ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      let engine: InstanceType<typeof ChatEngine> | undefined
      const result = await runCliChatTask({
        task: 'Explain the stated control value in README.md and related evidence files without changing files.',
        projectRoot: root, model: 'mimo-v2.5', outputFormat: 'json',
        engineFactory: options => {
          engine = new ChatEngine({ ...options,
            providerRunner: new OpenCodeGoApiRunner('mimo-v2.5', {},
              { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' }),
            providerPolicy: babelReviewModelPolicy('mimo-v2.5', root),
          })
          return engine
        },
      })
      assert.ok(engine)
      const budget = JSON.parse(readFileSync(join(chatSessionDir(engine.getEngineRunId()), 'task-budget.json'), 'utf8'))
      t.diagnostic(JSON.stringify({ control: name, requests, exitCode: result.exitCode, simulatedElapsedMs: elapsed * requests,
        reasonCode: result.payload['reason_code'], outcome: result.payload['outcome'],
        wallAllowance: budget.grant.wallAllowance, budgetExceeded: result.payload['budget_exceeded'] === true }))
      if (finiteWall) {
        assert.equal(result.exitCode, 1)
        assert.equal(result.payload['budget_exceeded'], true)
        assert.equal(budget.grant.wallCapMs, 600_000)
      } else {
        if (!stall) assert.equal(result.exitCode, 0)
        assert.deepEqual(budget.grant.wallAllowance, { kind: 'unlimited' })
        if (stall) {
          assert.ok(requests < 20)
          assert.match(JSON.stringify(result.payload), /stall|no.progress|repetit/i)
        } else {
          assert.equal(requests, reads + 1)
          assert.notEqual(result.payload['budget_exceeded'], true)
          assert.match(JSON.stringify(result.payload), /control value is 42/)
        }
      }

    })
  }
}
