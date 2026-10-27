import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('native campaign delegation runs in an isolated no-wire fixture', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, ['--experimental-wasm-modules',
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
    assert.deepEqual(JSON.parse(diagnostic), { exitCode: 0, tests: 10, passed: 10, failed: 0, skipped: 0, isolationRejected: false, networkDispatchBlocked: false })
  })
} else {
  const { join } = await import('node:path')
  const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const { ChatEngine } = await import('./chatEngine.js')
  const { CampaignBudgetStore } = await import('../eval/campaign-budget-store.js')
  const { CampaignDispatchGate } = await import('../runners/campaignDispatchGate.js')
  const { globalCostTracker } = await import('../services/costTracker.js')
  const { chatSessionDir } = await import('../cli/runsLayout.js')
  const { initMinimalGitProject } = await import('../testUtils/chatAdmissionFixture.js')
  const { getExecutionContext } = await import('./executionContext.js')
  const { executeSubAgentAction } = await import('./chatEngineChildExecution.js')
  const { createRunControl } = await import('../runtime/run-control.js')
  const task = 'Inspect README.md and report its purpose without editing files.'
  const answer = 'README.md identifies the cobalt-lantern fixture; no files changed.'
  const model = 'deepseek/deepseek-v4-flash-0731'

  test('delegation boundary rejects missing, mismatched or retired campaign parent control', async t => {
    const savedFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected controlled dispatch') }
    t.after(() => { globalThis.fetch = savedFetch })
    const control = createRunControl({ runId: 'negative-control', turnId: 'turn', generation: 1 })
    const root = process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!
    const gate = new CampaignDispatchGate({ campaignId: 'negative-control', taskOwnerId: 'external-cell', store: new CampaignBudgetStore({ statePath: join(root, 'negative-ledger.json'), campaignId: 'negative-control', limitMicroUsd: 2000000 }) })
    // Denial-only boundary fixtures supply no approval grants or runnable child.
    for (const runControl of [undefined, control]) await assert.rejects(executeSubAgentAction({
      action: { type: 'sub_agent', task }, ownerGeneration: 2,
      host: { options: { campaignDispatchGate: gate }, runControl, isSubmissionCurrent: () => false },
    } as never), /Campaign delegation requires a current parent run control/)
    control.requestStop({ owner: control.owner, kind: 'cancelled', reasonCode: 'cancelled', source: 'user' })
    await assert.rejects(executeSubAgentAction({ action: { type: 'sub_agent', task }, ownerGeneration: 1,
      host: { options: { campaignDispatchGate: gate }, runControl: control, isSubmissionCurrent: () => true },
    } as never), /Campaign delegation requires a current parent run control/)
    assert.equal(calls, 0)
  })

  for (const mode of ['campaign', 'exhausted', 'ordinary', 'retry', 'cancel-admission', 'cancel-inflight', 'superseded-admission', 'mutating-in-tree', 'mutating-worktree'] as const) test(`native delegation: ${mode}`, async t => {
    const mutation = mode === 'mutating-in-tree' || mode === 'mutating-worktree'
    const nativeTask = mutation ? 'Update README.md to document its stated purpose.' : task
    globalCostTracker.resetSession()
    const root = mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'campaign-child-'))
    initMinimalGitProject(root)
    writeFileSync(join(root, 'README.md'), '# cobalt-lantern fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true })
    execFileSync('git', ['commit', '-q', '-m', 'input'], { cwd: root, windowsHide: true })
    const store = new CampaignBudgetStore({ statePath: join(root, '..', `${mode}-campaign.json`), campaignId: mode, limitMicroUsd: mode === 'exhausted' ? 155761 : 2000000 })
    const gate = new CampaignDispatchGate({ campaignId: mode, store, taskOwnerId: 'external-cell' })
    let engine: InstanceType<typeof ChatEngine> | undefined
    if (mode === 'cancel-admission' || mode === 'superseded-admission') {
      const transact = store.transactAsync.bind(store)
      store.transactAsync = async mutate => {
        const value = await transact(mutate)
        if (store.readSnapshot().operations.length === 2) {
          if (mode === 'cancel-admission') engine!.cancel()
          else {
            const control = getExecutionContext()?.campaignRunControl
            assert.ok(control, 'child must retain the real parent run-control owner')
            assert.equal(control.requestStop({ owner: { ...control.owner, generation: control.owner.generation + 1 }, kind: 'superseded', reasonCode: 'replacement', source: 'supersession' }), false, 'another owner cannot stop this cell')
            assert.equal(control.requestStop({ owner: control.owner, kind: 'superseded', reasonCode: 'replacement', source: 'supersession' }), true)
          }
        }
        return value
      }
    }
    const savedFetch = globalThis.fetch
    t.after(() => { globalThis.fetch = savedFetch; globalCostTracker.resetSession(); rmSync(root, { recursive: true, force: true }) })
    let parentCalls = 0, childCalls = 0
    const reservationsAtWire: number[] = []
    let childCapsPresent = false
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions')
      const body = JSON.parse(String(init?.body)) as { model: string; tools?: Array<{ function: { name: string } }>; provider?: { max_price?: object }; messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> }
      assert.equal(body.model, model)
      if (mode !== 'ordinary') reservationsAtWire.push(store.readSnapshot().operations.filter(x => x.actualMicroUsd === null).length)
      if (!body.tools) {
        childCalls++
        if (mode === 'retry' && childCalls === 1) return new Response('{}', { status: 408 })
        if (mode === 'cancel-inflight') { engine!.cancel(); throw new DOMException('Cancelled controlled request', 'AbortError') }
        // This is the real child's schema-based inference, not a mocked child.
        childCapsPresent = !!body.provider?.max_price
        if (!mutation || childCalls > 1) assert.ok(body.messages.some(x => String(x.content).includes('cobalt-lantern')), 'child must have read the actual file')
        const actions = mutation && childCalls === 1 ? [{ type: 'read_file', path: 'README.md' }] : [{ type: 'finish', summary: answer, verification: ['README.md inspected'] }]
        return Response.json({ model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ actions }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, cost: 0.000001 } })
      }
      parentCalls++
      let delta: object, finish: string
      if (parentCalls === 1) {
        assert.ok(body.tools.some(x => x.function.name === 'sub_agent'), 'ordinary native task must advertise delegation')
        delta = { tool_calls: [{ index: 0, id: 'real-child', type: 'function', function: { name: 'sub_agent', arguments: JSON.stringify({ task: nativeTask, mutation, ...(mode === 'mutating-worktree' ? { write_scope: ['README.md'] } : {}) }) } }] }; finish = 'tool_calls'
      } else {
        assert.equal(parentCalls, 2)
        assert.ok(body.messages.some(x => x.role === 'tool' && x.tool_call_id === 'real-child' &&
          (mode === 'mutating-in-tree' ? String(x.content).includes('changed_files: none') && String(x.content).includes('steps: 2')
            : mode === 'mutating-worktree' ? String(x.content).includes('isolation: git_worktree') && String(x.content).includes('candidate_postimages: []')
              : String(x.content).includes('cobalt-lantern'))), 'parent must receive the actual child evidence for its execution branch')
        // These two cases qualify the distinct child accounting branches, not
        // edit completion. Stop through the normal user control after the
        // parent consumes the child's real file-read evidence. Empty in-tree
        // write scope deliberately grants no mutation authority.
        if (mutation) engine!.cancel()
        delta = { content: answer }; finish = 'stop'
      }
      return new Response(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason: finish }], ...(mode === 'exhausted' ? {} : { usage: { prompt_tokens: 100, completion_tokens: 40, cost: 0.000001 } }) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const result = await runCliChatTask({ task: nativeTask, projectRoot: root, model: 'deepseek-v4-flash-openrouter', outputFormat: 'json', engineFactory(options) { engine = new ChatEngine({ ...options, ...(mode === 'ordinary' ? {} : { campaignDispatchGate: gate }) }); return engine } })
    const operations = mode === 'ordinary' ? [] : store.readSnapshot().operations
    if (mode === 'cancel-admission' || mode === 'cancel-inflight' || mode === 'superseded-admission') {
      assert.equal(parentCalls, 1, 'cancelled parent must not continue')
      assert.equal(childCalls, mode === 'cancel-inflight' ? 1 : 0, 'cancellation/supersession must prevent another child dispatch')
      assert.equal(operations.length, 2)
      assert.equal(operations[1]!.actualMicroUsd, mode === 'cancel-inflight' ? null : 0)
      assert.equal(operations[1]!.settledUnknown, mode === 'cancel-inflight')
      assert.notEqual(result.exitCode, 0)
    } else if (mode === 'exhausted') {
      assert.equal(childCalls, 0, 'shared exhausted campaign must stop child before its physical request')
      assert.equal(parentCalls, 1, 'parent continuation must share the exhausted campaign')
      assert.equal(operations.length, 1)
      assert.equal(operations[0]!.settledUnknown, true)
      assert.equal(operations[0]!.actualMicroUsd, null)
      assert.notEqual(result.exitCode, 0)
    } else {
      if (!mutation) assert.equal(result.exitCode, 0)
      else assert.notEqual(result.exitCode, 0, 'branch qualification deliberately cancels after child evidence')
      assert.equal(childCalls, mode === 'retry' || mutation ? 2 : 1)
      assert.equal(parentCalls, 2)
      if (!mutation) assert.equal((result.payload['answer'] as { answer: string }).answer, answer)
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# cobalt-lantern fixture\n')
      const budget = JSON.parse(readFileSync(join(chatSessionDir(engine!.getEngineRunId()), 'task-budget.json'), 'utf8'))
      assert.deepEqual(budget.grant.costCap, { kind: 'unlimited' })
      if (mode !== 'ordinary') {
        assert.equal(operations.length, parentCalls + childCalls, 'every physical request must have its own operation')
        assert.equal(childCapsPresent, true, 'child wire must carry campaign routing caps')
        assert.equal(reservationsAtWire.length, parentCalls + childCalls)
        assert.ok(reservationsAtWire.every(x => x >= 1), 'each physical request must already have a durable pending reservation')
        assert.ok(operations.every(x => x.operationId.includes(':external-cell:chat:')))
        assert.equal(new Set(operations.map(x => x.operationId)).size, parentCalls + childCalls)
        assert.equal(operations.filter(x => x.actualMicroUsd === 1).length, 3)
        if (mutation) {
          assert.equal(operations[3]!.settledUnknown, true, 'cancelled parent response remains unknown without consumed usage')
          assert.equal(operations[3]!.actualMicroUsd, null)
        }
        if (mode === 'retry') assert.equal(operations[1]!.settledUnknown, true, 'unknown first child request must retain its hold')
      } else assert.equal(operations.length, 0, 'ordinary delegation needs no external campaign')
    }
  })
}
