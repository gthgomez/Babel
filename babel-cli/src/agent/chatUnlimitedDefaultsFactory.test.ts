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
  test('unlimited-defaults factory acceptance runs in an isolated synthetic fixture', async t => {
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
    assert.equal(inventory.tests, 12)
    assert.equal(inventory.passed, 12)
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
    assert.deepEqual(budget.grant.wallAllowance, { kind: 'unlimited' })
    assert.equal(budget.grant.wallCapMs, null)
    assert.equal(typeof budget.taskOwnerId, 'string')
    return budget
  }
  const toolDelta = { tool_calls: [{ index: 0, id: toolCallId, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
  }] }

  test('default unlimited grant continues after natural unknown usage on first native SSE', async t => {
    const root = fixture(t)
    const bodies: WireBody[] = []
    globalThis.fetch = async (input, init) => {
      const body = captureRequest(input, init)
      bodies.push(body)
      assert.ok(bodies.length <= 2, 'no unexpected critic, retry, fallback or third inference')
      if (bodies.length === 1) return sse(toolDelta, 'tool_calls')
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
    const budget = persistedBudget(result.payload)
    assert.deepEqual(budget.grant.costCap, { kind: 'unlimited' })
    const summary = globalCostTracker.getTaskSummary(budget.taskOwnerId)
    assert.equal(summary.unknownChargeCount, 1)
    assert.equal(summary.estimateComplete, false)
  })

  test('explicit finite env cap stops before a second inference when usage is unknown', async t => {
    const root = fixture(t)
    process.env['BABEL_CHAT_MAX_COST'] = '0.75'
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
    const budget = persistedBudget(result.payload)
    assert.deepEqual(budget.grant.costCap, { kind: 'finite', usd: 0.75 })
  })

  test('unlimited grant survives EACCES on owner-charge journal and still writes task-budget', async t => {
    const root = fixture(t)
    const { ChatEngineOwnerAccounting } = await import('./chatEngineOwnerAccounting.js')
    const originalPersist = ChatEngineOwnerAccounting.prototype.persistOwnerCharges
    ChatEngineOwnerAccounting.prototype.persistOwnerCharges = function persistOwnerChargesEacces() {
      const err = new Error('EACCES') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    t.after(() => { ChatEngineOwnerAccounting.prototype.persistOwnerCharges = originalPersist })
    const bodies: WireBody[] = []
    globalThis.fetch = async (input, init) => {
      const body = captureRequest(input, init)
      bodies.push(body)
      if (bodies.length === 1) return sse(toolDelta, 'tool_calls')
      return sse({ content: 'README.md preserves the cobalt-lantern evidence marker without edits.' }, 'stop', {
        prompt_tokens: 20, completion_tokens: 4, total_tokens: 24,
      })
    }
    const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.equal(result.exitCode, 0)
    assert.equal(bodies.length, 2)
    const budget = persistedBudget(result.payload)
    assert.deepEqual(budget.grant.costCap, { kind: 'unlimited' })
    assert.ok(Array.isArray(budget.accountingFaults) && budget.accountingFaults.length > 0)
    assert.ok(budget.accountingFaults.some((fault: { persistenceFailureClass?: string; reason?: string }) =>
      fault.persistenceFailureClass === 'financial-journal-io' &&
      fault.reason === 'Owner charge journal unavailable; telemetry may be unpersisted'))
    assert.ok(existsSync(join(chatSessionDir(result.payload['session_id'] as string), 'task-budget.json')))
  })

  test('cold restore keeps unlimited runtime authority after financial-journal-io fault', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const { ownerAccountingFaultBlocksRuntime } = await import('./ownerChargePersistPolicy.js')
    const persisted = {
      schemaVersion: 2,
      taskOwnerId: 'restore-owner',
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      grant: {
        grantId: 'g1',
        revision: 0,
        provenance: 'test',
        costCap: { kind: 'unlimited' },
        wallCapMs: 720_000,
        turnCap: 120,
      },
      consumed: { costUsd: 0, unknownChargeCount: 1, activeWallMs: 0, turns: 1 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime: {
        submissionIndex: 0,
        writeCount: 0,
        gateStrikes: 0,
        effectiveOperation: 'READ_ONLY',
        taskClass: 'investigate',
      },
      accountingFaults: [{
        taskOwnerId: 'restore-owner',
        ownerGeneration: 0,
        accountingEpoch: globalCostTracker.getAccountingEpoch(),
        chargeId: null,
        persistenceScope: 'owner-charge-receipt',
        kind: 'persistence-failure',
        reason: 'Owner charge journal unavailable; telemetry may be unpersisted',
        persistenceFailureClass: 'financial-journal-io' as const,
      }],
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-allowance-')),
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null as typeof persisted | null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null as number | null,
      lastTurnRuntime: null as typeof persisted.lastTurnRuntime | null,
      criticRepairCostCapUsd: null as number | null,
      postWriteRepairWallCapMs: null as number | null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget(persisted as never)
    assert.equal(host.taskCostScopeUnavailable, false)
    const restoredFault = persisted.accountingFaults[0]!
    assert.ok(!ownerAccountingFaultBlocksRuntime({
      ...restoredFault,
      persistenceScope: 'owner-charge-receipt',
      kind: 'persistence-failure',
    }, { kind: 'unlimited' }))
  })

  test('cold restore blocks finite runtime authority for the same financial-journal-io fault', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const { ownerAccountingFaultBlocksRuntime } = await import('./ownerChargePersistPolicy.js')
    const fault = {
      taskOwnerId: 'finite-owner',
      ownerGeneration: 0,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      chargeId: null,
      persistenceScope: 'owner-charge-receipt' as const,
      kind: 'persistence-failure' as const,
      reason: 'Owner charge journal unavailable; telemetry may be unpersisted',
      persistenceFailureClass: 'financial-journal-io' as const,
    }
    assert.ok(ownerAccountingFaultBlocksRuntime(fault, { kind: 'finite', usd: 0.75 }))
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-finite-')),
      limits: { maxCostUsd: 0.75, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime: null,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget({
      schemaVersion: 2,
      taskOwnerId: 'finite-owner',
      accountingEpoch: fault.accountingEpoch,
      grant: { grantId: 'g', revision: 0, provenance: 't', costCap: { kind: 'finite', usd: 0.75 }, wallCapMs: 720_000, turnCap: 120 },
      consumed: { costUsd: 0, unknownChargeCount: 1, activeWallMs: 0, turns: 0 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime,
      accountingFaults: [fault],
    } as never)
    assert.equal(host.taskCostScopeUnavailable, true)
  })

  test('cold restore blocks unlimited runtime for legacy unclassified persistence fault', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const { ownerAccountingFaultBlocksRuntime } = await import('./ownerChargePersistPolicy.js')
    const fault = {
      taskOwnerId: 'legacy-owner',
      ownerGeneration: 0,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      chargeId: null,
      persistenceScope: 'owner-charge-receipt' as const,
      kind: 'persistence-failure' as const,
      reason: 'Owner charge receipts are incomplete',
    }
    assert.ok(ownerAccountingFaultBlocksRuntime(fault, { kind: 'unlimited' }))
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-legacy-')),
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime: null,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget({
      schemaVersion: 2,
      taskOwnerId: 'legacy-owner',
      accountingEpoch: fault.accountingEpoch,
      grant: {
        grantId: 'g',
        revision: 0,
        provenance: 't',
        costCap: { kind: 'unlimited' },
        wallCapMs: 720_000,
        turnCap: 120,
      },
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 1 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime,
      accountingFaults: [fault],
      taskCostBaselineUsd: 0,
    } as never)
    assert.equal(host.taskCostScopeUnavailable, true)
  })

  test('cold restore blocks unlimited runtime for authority-class persistence fault', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const { ownerAccountingFaultBlocksRuntime } = await import('./ownerChargePersistPolicy.js')
    const fault = {
      taskOwnerId: 'authority-owner',
      ownerGeneration: 0,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      chargeId: null,
      persistenceScope: 'owner-charge-receipt' as const,
      kind: 'persistence-failure' as const,
      reason: 'Owner charge receipt authority conflict',
      persistenceFailureClass: 'authority' as const,
    }
    assert.ok(ownerAccountingFaultBlocksRuntime(fault, { kind: 'unlimited' }))
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-authority-')),
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime: null,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget({
      schemaVersion: 2,
      taskOwnerId: 'authority-owner',
      accountingEpoch: fault.accountingEpoch,
      grant: {
        grantId: 'g',
        revision: 0,
        provenance: 't',
        costCap: { kind: 'unlimited' },
        wallCapMs: 720_000,
        turnCap: 120,
      },
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 1 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime,
      accountingFaults: [fault],
      taskCostBaselineUsd: 0,
    } as never)
    assert.equal(host.taskCostScopeUnavailable, true)
  })

  test('cold restore admits unlimited task when checkpoint has no blocking faults', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-clean-')),
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime: null,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget({
      schemaVersion: 2,
      taskOwnerId: 'clean-owner',
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      grant: {
        grantId: 'g',
        revision: 0,
        provenance: 't',
        costCap: { kind: 'unlimited' },
        wallCapMs: 720_000,
        turnCap: 120,
      },
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 1 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime,
      taskCostBaselineUsd: 0,
    } as never)
    assert.equal(host.taskCostScopeUnavailable, false)
    assert.deepEqual(allowance.getTaskAllowanceSnapshot()?.grant.costCap, { kind: 'unlimited' })
  })

  test('finite grant refuses further dispatch when owner-charge journal fails', async t => {
    const root = fixture(t)
    process.env['BABEL_CHAT_MAX_COST'] = '0.75'
    const { ChatEngineOwnerAccounting } = await import('./chatEngineOwnerAccounting.js')
    const originalPersist = ChatEngineOwnerAccounting.prototype.persistOwnerCharges
    let persistCalls = 0
    ChatEngineOwnerAccounting.prototype.persistOwnerCharges = function persistOwnerChargesFiniteEacces(
      ...args: unknown[]
    ) {
      persistCalls += 1
      if (persistCalls > 1) {
        const err = new Error('EACCES') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return originalPersist.apply(this, args as never)
    }
    t.after(() => { ChatEngineOwnerAccounting.prototype.persistOwnerCharges = originalPersist })
    let fetches = 0
    globalThis.fetch = async (input, init) => {
      captureRequest(input, init)
      fetches++
      assert.ok(fetches <= 2, 'finite journal failure must not admit a third inference')
      if (fetches === 1) return sse(toolDelta, 'tool_calls', { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 })
      return sse({ content: 'Should not run after finite journal refusal.' }, 'stop', {
        prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
      })
    }
    const result = await runCliChatTask({ task, projectRoot: root, model: backendKey, outputFormat: 'json' })
    assert.ok(fetches <= 1, 'unsafe second dispatch must be refused after journal failure')
    assert.notEqual(result.exitCode, 0)
    const budget = persistedBudget(result.payload)
    assert.deepEqual(budget.grant.costCap, { kind: 'finite', usd: 0.75 })
    assert.ok(Array.isArray(budget.accountingFaults) && budget.accountingFaults.length > 0)
    assert.ok(budget.accountingFaults.some((fault: { persistenceFailureClass?: string }) =>
      fault.persistenceFailureClass === 'authority'))
  })

  test('cold restore blocks runtime for settlement-conflict faults', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const fault = {
      taskOwnerId: 'conflict-owner',
      ownerGeneration: 0,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      chargeId: 'charge-1',
      persistenceScope: 'owner-charge-receipt' as const,
      kind: 'settlement-conflict' as const,
      reason: 'Charge settlement conflict',
    }
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'restore-conflict-')),
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: null,
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: true,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime: null,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.restorePersistedTaskBudget({
      schemaVersion: 2,
      taskOwnerId: 'conflict-owner',
      accountingEpoch: fault.accountingEpoch,
      grant: {
        grantId: 'g',
        revision: 0,
        provenance: 't',
        costCap: { kind: 'unlimited' },
        wallCapMs: 720_000,
        turnCap: 120,
      },
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 1 },
      repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
      accountedChargeIds: [],
      lastTurnRuntime,
      accountingFaults: [fault],
      taskCostBaselineUsd: 0,
    } as never)
    assert.equal(host.taskCostScopeUnavailable, true)
  })

  test('task-budget checkpoint failure blocks runtime authority', async t => {
    const { ChatEngineTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const { OpenCodeGoBudgetError } = await import('../runners/openCodeGoBudget.js')
    const { mkdirSync } = await import('node:fs')
    const runDir = mkdtempSync(join(process.env['BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT']!, 'tmp', 'checkpoint-fail-'))
    const lastTurnRuntime = {
      submissionIndex: 0,
      writeCount: 0,
      gateStrikes: 0,
      effectiveOperation: 'READ_ONLY',
      taskClass: 'investigate',
    }
    const host = {
      engineRunDir: runDir,
      limits: { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 },
      taskAllowance: {
        schemaVersion: 2,
        taskOwnerId: 'checkpoint-owner',
        accountingEpoch: globalCostTracker.getAccountingEpoch(),
        grant: {
          grantId: 'g',
          revision: 0,
          provenance: 't',
          costCap: { kind: 'unlimited' },
          wallCapMs: 720_000,
          turnCap: 120,
        },
        consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 0 },
        repair: { criticRepairCostCapUsd: null, postWriteRepairWallCapMs: null, postWriteRepairRestrict: false },
        accountedChargeIds: [],
        lastTurnRuntime,
        taskCostBaselineUsd: 0,
      },
      taskCostBaselineUsd: 0,
      taskCostScopeUnavailable: false,
      activeExecutionCheckpointMs: null,
      lastTurnRuntime,
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
      budgetExceeded: false,
      budgetLastChanceDone: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      ownerAccountingFaults: new Map(),
      ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
    }
    const blockedTemporary = join(runDir, `task-budget.json.tmp-${process.pid}`)
    mkdirSync(blockedTemporary)
    t.after(() => rmSync(runDir, { recursive: true, force: true }))
    const allowance = new ChatEngineTaskAllowance(host as never)
    allowance.persistTaskAllowance()
    assert.equal(host.taskCostScopeUnavailable, true)
    assert.throws(() => allowance.resolveGoRunnerOptions(), OpenCodeGoBudgetError)
  })

  test('on-disk session task-budget restores unlimited and finite grants', async t => {
    const { ChatEngineTaskAllowance, parseTaskAllowance } = await import('./chatEngineTaskAllowance.js')
    const restoreFromRunDir = (runDir: string, limits: { maxCostUsd: number; maxWallMs: number; maxTurns: number }) => {
      const persisted = parseTaskAllowance(JSON.parse(readFileSync(join(runDir, 'task-budget.json'), 'utf8')))
      assert.ok(persisted)
      const reloadHost = {
        engineRunDir: runDir,
        limits,
        taskAllowance: null,
        taskCostBaselineUsd: 0,
        taskCostScopeUnavailable: true,
        activeExecutionCheckpointMs: null,
        lastTurnRuntime: null,
        criticRepairCostCapUsd: null,
        postWriteRepairWallCapMs: null,
        postWriteRepairRestrict: false,
        budgetExceeded: false,
        budgetLastChanceDone: false,
        terminatingLimiter: null,
        terminalLimiterReason: null,
        ownerAccountingFaults: new Map(),
        ownerAccounting: { recordOwnerAccountingFault: () => {}, persistOwnerCharges: () => {} },
      }
      const reloaded = new ChatEngineTaskAllowance(reloadHost as never)
      reloaded.restorePersistedTaskBudget(persisted)
      return { reloadHost, reloaded, persisted }
    }

    const unlimitedRoot = fixture(t)
    const unlimitedBodies: WireBody[] = []
    globalThis.fetch = async (input, init) => {
      const body = captureRequest(input, init)
      unlimitedBodies.push(body)
      if (unlimitedBodies.length === 1) return sse(toolDelta, 'tool_calls')
      return sse({ content: 'README preserves cobalt-lantern without edits.' }, 'stop', {
        prompt_tokens: 20, completion_tokens: 4, total_tokens: 24,
      })
    }
    const unlimitedRun = await runCliChatTask({ task, projectRoot: unlimitedRoot, model: backendKey, outputFormat: 'json' })
    assert.equal(unlimitedRun.exitCode, 0)
    const unlimitedSession = unlimitedRun.payload['session_id'] as string
    const unlimitedDir = chatSessionDir(unlimitedSession)
    assert.ok(existsSync(join(unlimitedDir, 'task-budget.json')))
    const unlimitedLimits = { maxCostUsd: Infinity, maxWallMs: 720_000, maxTurns: 120 }
    const unlimitedReload = restoreFromRunDir(unlimitedDir, unlimitedLimits)
    assert.equal(unlimitedReload.reloadHost.taskCostScopeUnavailable, false)
    assert.deepEqual(unlimitedReload.reloaded.getTaskAllowanceSnapshot()?.grant.costCap, { kind: 'unlimited' })
    assert.deepEqual(unlimitedReload.persisted.grant.costCap, { kind: 'unlimited' })

    const finiteRoot = fixture(t)
    process.env['BABEL_CHAT_MAX_COST'] = '0.75'
    let finiteFetches = 0
    globalThis.fetch = async (input, init) => {
      captureRequest(input, init)
      finiteFetches++
      return sse(toolDelta, 'tool_calls')
    }
    const finiteRun = await runCliChatTask({ task, projectRoot: finiteRoot, model: backendKey, outputFormat: 'json' })
    assert.equal(finiteFetches, 1)
    assert.notEqual(finiteRun.exitCode, 0)
    const finiteSession = finiteRun.payload['session_id'] as string
    const finiteDir = chatSessionDir(finiteSession)
    assert.ok(existsSync(join(finiteDir, 'task-budget.json')))
    const finiteLimits = { maxCostUsd: 0.75, maxWallMs: 720_000, maxTurns: 120 }
    const finiteReload = restoreFromRunDir(finiteDir, finiteLimits)
    assert.deepEqual(finiteReload.persisted.grant.costCap, { kind: 'finite', usd: 0.75 })
    assert.deepEqual(finiteReload.reloaded.getTaskAllowanceSnapshot()?.grant.costCap, { kind: 'finite', usd: 0.75 })
  })
}
