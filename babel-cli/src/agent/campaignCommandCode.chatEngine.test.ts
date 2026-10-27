import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  isSyntheticProviderFixtureReady,
  prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture,
  summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('ordinary Command Code accounting runs in an isolated synthetic fixture', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--test', '--test-concurrency=1', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    const diagnostic = summarizeSyntheticProviderOutput(output, code)
    t.diagnostic(diagnostic)
    if (code !== 0) t.diagnostic(output)
    assert.equal(code, 0)
    const inventory = JSON.parse(diagnostic) as { tests: number; passed: number; failed: number; skipped: number }
    assert.equal(inventory.tests, 2)
    assert.equal(inventory.passed, 2)
    assert.equal(inventory.failed, 0)
    assert.equal(inventory.skipped, 0)
  })
} else {
  // The verified child environment has no ambient credentials or network path.
  // No engine, runner, executor, grant, pricing or owner is replaced below.
  process.env['COMMAND_CODE_API_KEY'] = 'synthetic-command-code-credential'
  process.env['BABEL_LIVE'] = '1'
  process.env['BABEL_HEADLESS'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const { chatSessionDir } = await import('../cli/runsLayout.js')
  const { initMinimalGitProject } = await import('../testUtils/chatAdmissionFixture.js')
  const { globalCostTracker } = await import('../services/costTracker.js')
  const task = 'Explain README.md and its stated purpose without changing any files.'
  const backendKey = 'command-code/deepseek-v4.1-flash'
  const model = 'deepseek/deepseek-v4.1-flash'
  const endpoint = 'https://api.commandcode.ai/provider/v1/chat/completions'
  const contents = '# Inspection fixture\n\nPurpose: preserve the cobalt-lantern evidence marker.\n'
  const toolCallId = 'read-readme-accounting-proof'
  type WireBody = {
    model: string
    stream?: boolean
    tools?: Array<{ function: { name: string } }>
    messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>
  }
  type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  function sse(delta: object, finishReason: 'tool_calls' | 'stop', usage?: Usage): Response {
    return new Response(`data: ${JSON.stringify({ model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  function fixture(t: TestContext): string {
    globalCostTracker.resetSession()
    const fixtureRoot = process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']
    assert.ok(fixtureRoot)
    const root = mkdtempSync(join(fixtureRoot, 'tmp', 'cc-native-accounting-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    initMinimalGitProject(root)
    writeFileSync(join(root, 'README.md'), contents)
    execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true })
    execFileSync('git', ['commit', '-q', '-m', 'inspection input'], { cwd: root, windowsHide: true })
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    return root
  }
  function persistedOwner(payload: Record<string, unknown>): string {
    assert.equal(typeof payload['session_id'], 'string')
    const budget = JSON.parse(readFileSync(join(chatSessionDir(payload['session_id'] as string), 'task-budget.json'), 'utf8'))
    assert.equal(budget.lastTurnRuntime.effectiveOperation, 'READ_ONLY')
    assert.equal(budget.lastTurnRuntime.taskClass, 'investigate')
    assert.deepEqual(budget.grant.costCap, { kind: 'unlimited' })
    assert.equal(budget.grant.turnCap, 120)
    assert.deepEqual(budget.grant.wallAllowance, { kind: 'unlimited' })
    assert.equal(budget.grant.wallCapMs, null)
    assert.equal(typeof budget.taskOwnerId, 'string')
    return budget.taskOwnerId
  }
  function captureRequest(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): WireBody {
    assert.equal(String(input), endpoint)
    assert.equal(init?.redirect, 'error')
    const body = JSON.parse(String(init?.body)) as WireBody
    assert.equal(body.model, model)
    assert.equal(body.stream, true)
    assert.ok(body.tools?.some(tool => tool.function.name === 'read_file'))
    return body
  }
  const toolDelta = { tool_calls: [{ index: 0, id: toolCallId, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
  }] }

  test('ordinary native Command Code continues after priced usage without a reported bill', async t => {
    const root = fixture(t)
    const bodies: WireBody[] = []
    globalThis.fetch = async (input, init) => {
      const body = captureRequest(input, init)
      bodies.push(body)
      assert.ok(bodies.length <= 2, 'no unexpected critic, retry, fallback or third inference')
      if (bodies.length === 1) return sse(toolDelta, 'tool_calls', {
        prompt_tokens: 1_000, completion_tokens: 2_000, total_tokens: 3_000,
      })
      const observation = body.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId)
      assert.ok(observation, 'second native request must contain the actual read_file result')
      assert.match(String(observation.content), /cobalt-lantern/)
      assert.match(String(observation.content), /exit_code: 0/)
      return sse({ content: 'README.md states that this inspection fixture preserves the cobalt-lantern evidence marker. No files were changed.' }, 'stop', {
        prompt_tokens: 30, completion_tokens: 5, total_tokens: 35,
      })
    }
    const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.equal(bodies.length, 2)
    assert.equal(result.exitCode, 0)
    assert.equal(result.payload['terminal_outcome'], 'NO_CHANGE_REQUIRED')
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), contents)
    const owner = persistedOwner(result.payload)
    const summary = globalCostTracker.getTaskSummary(owner)
    const receipts = globalCostTracker.getTaskChargeObservations(owner)
    assert.equal(receipts.length, 2)
    assert.ok(receipts.every(receipt => receipt.usageKnown === true && receipt.costBasis === 'published_usage_estimate'))
    assert.ok(receipts.every(receipt => receipt.knownCostUSD === null && typeof receipt.estimatedCostUSD === 'number' && receipt.estimatedCostUSD > 0))
    assert.equal(summary.unknownChargeCount, 0)
    assert.equal(summary.estimateComplete, true)
    assert.equal(summary.costComplete, false)
    assert.equal(summary.completeCostUSD, null)
    assert.ok(summary.totalCostUSD > 0 && summary.totalCostUSD < 2)
  })

  test('the same valid native SSE without usage or bill stops before another inference', async t => {
    const root = fixture(t)
    process.env['BABEL_CHAT_MAX_COST'] = '2'
    let fetches = 0
    globalThis.fetch = async (input, init) => {
      captureRequest(input, init)
      fetches++
      assert.equal(fetches, 1, 'unknown accounting must not dispatch the next request')
      return sse(toolDelta, 'tool_calls')
    }
    const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.equal(fetches, 1)
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.payload['reason_code'], 'cost_accounting_incomplete')
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), contents)
    assert.equal(typeof result.payload['session_id'], 'string')
    const budget = JSON.parse(readFileSync(join(chatSessionDir(result.payload['session_id'] as string), 'task-budget.json'), 'utf8'))
    assert.deepEqual(budget.grant.costCap, { kind: 'finite', usd: 2 })
    const owner = budget.taskOwnerId as string
    const summary = globalCostTracker.getTaskSummary(owner)
    const receipts = globalCostTracker.getTaskChargeObservations(owner)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0]!.usageKnown, false)
    assert.equal(receipts[0]!.knownCostUSD, null)
    assert.equal(summary.unknownChargeCount, 1)
    assert.equal(summary.estimateComplete, false)
    assert.equal(summary.costComplete, false)
    assert.equal(summary.completeCostUSD, null)
  })
}
