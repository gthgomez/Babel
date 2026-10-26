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
  test('financial-fault native acceptance runs in an isolated synthetic fixture', async t => {
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
    assert.equal(inventory.tests, 7)
    assert.equal(inventory.passed, 7)
    assert.equal(inventory.failed, 0)
    assert.equal(inventory.skipped, 0)
  })
} else {
  process.env['COMMAND_CODE_API_KEY'] = 'synthetic-command-code-credential'
  process.env['BABEL_LIVE'] = '1'
  process.env['BABEL_HEADLESS'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = await import('node:fs')
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
  const toolCallId = 'read-readme-unlimited-defaults'
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
    delete process.env['BABEL_CHAT_MAX_COST']
    const fixtureRoot = process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']
    assert.ok(fixtureRoot)
    const root = mkdtempSync(join(fixtureRoot, 'tmp', 'unlimited-defaults-factory-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    initMinimalGitProject(root)
    writeFileSync(join(root, 'README.md'), contents)
    execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true })
    execFileSync('git', ['commit', '-q', '-m', 'inspection input'], { cwd: root, windowsHide: true })
    const originalFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = originalFetch })
    return root
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
  function persistedBudget(payload: Record<string, unknown>) {
    assert.equal(typeof payload['session_id'], 'string')
    const budget = JSON.parse(readFileSync(join(chatSessionDir(payload['session_id'] as string), 'task-budget.json'), 'utf8'))
    assert.equal(budget.lastTurnRuntime.effectiveOperation, 'READ_ONLY')
    assert.equal(budget.lastTurnRuntime.taskClass, 'investigate')
    assert.equal(budget.grant.turnCap, 120)
    assert.equal(budget.grant.wallCapMs, 720_000)
    assert.equal(typeof budget.taskOwnerId, 'string')
    return budget
  }
  const toolDelta = { tool_calls: [{ index: 0, id: toolCallId, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
  }] }

  const { default: fs } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  const { chatSessionsDir } = await import('../cli/runsLayout.js')
  const { mkdirSync, readdirSync } = await import('node:fs')
  const warning = 'Owner charge journal unavailable; telemetry may be unpersisted'
  const pricedUsage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 }

  function journalFault(t: TestContext, failOnSecondCharge = false) {
    const original = fs.writeFileSync
    let active = false
    let failures = 0
    fs.writeFileSync = ((path, ...args) => {
      if (String(path).replaceAll('\\', '/').includes('/task-charges/') &&
          (active || (failOnSecondCharge && JSON.parse(String(args[0])).chargeIds?.length >= 2))) {
        failures++
        throw Object.assign(new Error('fixture financial journal I/O failure'), { code: 'EIO' })
      }
      return original(path, ...args)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    const restore = () => { fs.writeFileSync = original; syncBuiltinESMExports() }
    t.after(restore)
    return { activate: () => { active = true }, restore, failures: () => failures }
  }

  function usefulFetch(onFirst?: () => void) {
    const bodies: WireBody[] = []
    globalThis.fetch = async (input, init) => {
      const body = captureRequest(input, init)
      bodies.push(body)
      assert.ok(bodies.length <= 2)
      if (bodies.length === 1) {
        onFirst?.()
        return sse(toolDelta, 'tool_calls', pricedUsage)
      }
      const observation = body.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId)
      assert.ok(observation)
      assert.match(String(observation.content), /cobalt-lantern/)
      assert.match(String(observation.content), /exit_code: 0/)
      return sse({ content: 'README.md preserves the cobalt-lantern evidence marker. No files were changed.' }, 'stop', pricedUsage)
    }
    return bodies
  }

  for (const finite of [false, true]) {
    test(`${finite ? 'finite' : 'unbudgeted'} priced native task under financial-file-only I/O failure`, async t => {
      const root = fixture(t)
      if (finite) process.env['BABEL_CHAT_MAX_COST'] = '0.75'
      const fault = journalFault(t)
      const bodies = usefulFetch(fault.activate)
      const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
      assert.ok(fault.failures() > 0)
      const budget = persistedBudget(result.payload)
      const summary = globalCostTracker.getTaskSummary(budget.taskOwnerId)
      assert.equal(summary.unknownChargeCount, 0, 'priced response must not masquerade as missing usage')
      assert.equal(summary.estimateComplete, true)
      assert.equal(summary.costComplete, false, 'an estimated cost remains distinct from an invoice')
      assert.ok(summary.totalCostUSD > 0)
      assert.ok(budget.accountingFaults.length > 0)
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), contents)
      if (finite) {
        assert.equal(bodies.length, 1)
        assert.notEqual(result.exitCode, 0)
        assert.deepEqual(budget.grant.costCap, { kind: 'finite', usd: 0.75 })
      } else {
        assert.equal(bodies.length, 2)
        assert.equal(result.exitCode, 0)
        assert.equal(result.payload['terminal_outcome'], 'NO_CHANGE_REQUIRED')
        assert.match((result.payload['answer'] as { answer: string }).answer, /cobalt-lantern/)
        assert.deepEqual(budget.grant.costCap, { kind: 'unlimited' })
        assert.ok(budget.accountingFaults.every((entry: { persistenceFailureClass: string }) => entry.persistenceFailureClass === 'financial-journal-io'))
        assert.deepEqual(result.payload['warnings'], [warning])
      }
      t.diagnostic(JSON.stringify({ physicalFetches: bodies.length, journalFailures: fault.failures(), unknownChargeCount: summary.unknownChargeCount }))
    })
  }

  test('actual runtime-checkpoint I/O failure blocks an otherwise valid priced unbudgeted task', async t => {
    const root = fixture(t)
    const before = new Set(readdirSync(chatSessionsDir()))
    let blocker: string | undefined
    const bodies = usefulFetch(() => {
      const added = readdirSync(chatSessionsDir()).filter(name => !before.has(name))
      assert.equal(added.length, 1)
      const dir = chatSessionDir(added[0]!)
      const valid = JSON.parse(readFileSync(join(dir, 'task-budget.json'), 'utf8'))
      assert.ok(valid.lastTurnRuntime)
      assert.deepEqual(valid.grant.costCap, { kind: 'unlimited' })
      blocker = join(dir, `task-budget.json.tmp-${process.pid}`)
      mkdirSync(blocker)
    })
    t.after(() => { if (blocker) rmSync(blocker, { recursive: true, force: true }) })
    const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.equal(bodies.length, 1)
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.payload['reason_code'], 'cost_accounting_incomplete')
    assert.ok(blocker && fs.statSync(blocker).isDirectory())
    const budget = persistedBudget(result.payload)
    assert.equal(globalCostTracker.getTaskSummary(budget.taskOwnerId).unknownChargeCount, 0)
    assert.ok(!budget.accountingFaults?.length, 'runtime failure is not misclassified as financial-only')
  })

  for (const journal of ['pending', 'missing', 'complete-cost', 'complete-ids'] as const) test(`cold process restores ${journal} financial journal with consumed unlimited state`, async t => {
    const root = fixture(t)
    const completeJournal = journal.startsWith('complete-')
    const fault = journalFault(t, completeJournal)
    if (journal === 'missing') fault.activate()
    const bodies = usefulFetch(completeJournal ? undefined : fault.activate)
    const first = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.equal(first.exitCode, 0)
    assert.equal(bodies.length, 2)
    const saved = persistedBudget(first.payload)
    assert.ok(saved.consumed.turns > 0)
    assert.ok(saved.consumed.costUsd > 0)
    assert.ok(saved.accountingFaults.length > 0)
    if (completeJournal) {
      const journals = readdirSync(join(chatSessionDir(first.payload['session_id'] as string), 'task-charges'))
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(chatSessionDir(first.payload['session_id'] as string), 'task-charges', name), 'utf8')))
      const stale = journals.find(entry => entry.taskOwnerId === saved.taskOwnerId)
      assert.ok(stale)
      assert.equal(stale.unknownChargeCount, 0)
      assert.equal(stale.chargeIds.length, 1)
      assert.equal(saved.accountedChargeIds.length, 2)
      assert.ok(stale.totalCostUSD > 0 && stale.totalCostUSD < saved.consumed.costUsd)
    }
    fault.restore()
    const script = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      process.env.COMMAND_CODE_API_KEY = 'synthetic-command-code-credential';
      const base = pathToFileURL(process.env.BABEL_ROOT + '/babel-cli/src/');
      const { openResumedChatEngine } = await import(new URL('interactive/execution/chatResumeHeadless.ts', base));
      const { runCliChatTask } = await import(new URL('interactive/execution/chatCore.ts', base));
      const { globalCostTracker } = await import(new URL('services/costTracker.ts', base));
      const task = ${JSON.stringify(task)}, root = ${JSON.stringify(root)}, backend = ${JSON.stringify(backendKey)};
      const sessionId = ${JSON.stringify(first.payload['session_id'])};
      const engine = await openResumedChatEngine(sessionId, { task, projectRoot: root, model: backend });
      const restored = engine.getTaskAllowanceSnapshot();
      assert.ok(restored);
      assert.equal(restored.taskOwnerId, ${JSON.stringify(saved.taskOwnerId)});
      assert.deepEqual(restored.grant, ${JSON.stringify(saved.grant)});
      const assertIds = () => assert.deepEqual(globalCostTracker.getTaskChargeIds(restored.taskOwnerId).sort(), ${JSON.stringify(saved.accountedChargeIds)}.slice().sort(), 'newer checkpoint charge IDs must survive');
      const assertCost = () => assert.equal(restored.consumed.costUsd, ${JSON.stringify(saved.consumed.costUsd)}, 'newer checkpoint consumed cost must survive');
      if (${JSON.stringify(journal === 'complete-ids')}) { assertIds(); assertCost(); }
      else { assertCost(); assertIds(); }

      assert.deepEqual(restored.accountingFaults, ${JSON.stringify(saved.accountingFaults)});
      const usage = globalCostTracker.getTaskSummary(restored.taskOwnerId);
      const observations = globalCostTracker.getTaskChargeObservations(restored.taskOwnerId);
      const missingId = restored.accountedChargeIds.find(id => !observations.some(receipt => receipt.attribution.chargeId === id));
      assert.ok(missingId, 'the lost financial receipt must remain absent');
      const duplicate = globalCostTracker.settleUsage(${JSON.stringify(model)}, 30, 5, null, null,
        {taskOwnerId:restored.taskOwnerId,chargeId:missingId},true,'command-code');
      assert.equal(duplicate.kind,'duplicate','replaying a retained charge ID must not count it again');
      assert.deepEqual(globalCostTracker.getTaskSummary(restored.taskOwnerId),usage);
      assert.equal(globalCostTracker.getTaskChargeObservations(restored.taskOwnerId).length,observations.length);
      assert.ok(usage.totalCostUSD >= restored.consumed.costUsd);


      engine.closeAdmissionStore();
      let fetches = 0;
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init.body));
        fetches++;
        assert.ok(fetches <= 2);
        const delta = fetches === 1 ? { tool_calls: [{ index: 0, id: 'cold-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({path:'README.md'}) } }] } : { content: 'README.md preserves the cobalt-lantern marker. No files changed.' };
        if (fetches === 2) assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'cold-read' && String(message.content).includes('cobalt-lantern')));
        return new Response('data: ' + JSON.stringify({ model: ${JSON.stringify(model)}, choices: [{ index: 0, delta, finish_reason: fetches === 1 ? 'tool_calls' : 'stop' }], usage: ${JSON.stringify(pricedUsage)} }) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
      };
      const result = await runCliChatTask({task,projectRoot:root,model:backend,sessionId,outputFormat:'json'});
      assert.equal(result.exitCode,0);
      assert.equal(fetches,2);
      assert.equal(result.payload.terminal_outcome,'NO_CHANGE_REQUIRED');
      assert.match(result.payload.answer.answer,/cobalt-lantern/);
      assert.deepEqual(result.payload.warnings,[${JSON.stringify(warning)}]);
      assert.equal(restored.consumed.costUsd, ${JSON.stringify(saved.consumed.costUsd)});
      assert.equal(restored.consumed.activeWallMs, ${JSON.stringify(saved.consumed.activeWallMs)});
      assert.equal(restored.consumed.turns, ${JSON.stringify(saved.consumed.turns)});
      assert.deepEqual(restored.accountedChargeIds, ${JSON.stringify(saved.accountedChargeIds)});
      assert.ok(usage.unknownChargeCount > 0, 'lost financial receipts must remain honestly unknown');
      assert.equal(usage.estimateComplete, false);
      assert.equal(usage.costComplete, false);
      console.log(JSON.stringify({restoredConsumed:true,restoredOwner:true,unlimited:true,fetches,usefulFinal:true,warning:true,uncertainty:true}));
    `
    const env = { ...process.env }
    delete env['COMMAND_CODE_API_KEY']
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href,
      '--input-type=module', '--eval', script,
    ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += String(bytes) })
    child.stderr.on('data', bytes => { output += String(bytes) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    assert.equal(code, 0, output)
    assert.match(output, /"restoredConsumed":true/)
    t.diagnostic(output.trim())
  })
}
