import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('simplified Chat executes with isolated state and no external inference', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1))
      child.once('close', value => resolve(value ?? 1))
    })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code))
    for (const line of output.split('\n').filter(line => /^not ok \d+ - /.test(line))) t.diagnostic(line)
    if (code !== 0) {
      const lines = output.split('\n')
      const start = lines.findIndex(line => /^not ok \d+ - /.test(line))
      t.diagnostic(start >= 0 ? lines.slice(start, start + 60).join('\n') : output.slice(-12000))
    }
    assert.equal(code, 0, 'isolated Chat execution contracts must pass')
  })
} else {
  process.env['BABEL_LIVE'] = 'true'
  process.env['BABEL_DRY_RUN'] = 'false'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  // This lane exercises tools, not prompt-library discovery. Its governance
  // snapshot must belong to the disposable fixture, never the contributor tree.
  process.env['BABEL_ROOT'] = process.cwd()
  const { EvidenceBundle } = await import('../evidence.js')
  const { SwePlanSchema } = await import('../schemas/agentContracts.js')
  const { runChatExecutorLoop, formatToolCallForDisplay } = await import('./chatExecutorLoop.js')
  const { collectTerminalContext } = await import('./terminalContext.js')
  const { buildPipelineFinalTerminalState } = await import('./finalization.js')
  const { buildVerifierContractArtifacts } = await import('../services/requiredVerifierContract.js')
  const { SafeExecutor } = await import('../sandbox.js')
  const { setDockerAvailableForTest, resetDockerAvailabilityCache } = await import('../config/benchmarkContainer.js')
  const { ConfirmDialog } = await import('../ui/dialog.js')
  const projectRoot = process.cwd()

  function plan(steps: { tool: string; target: string; content?: string }[]) {
    return SwePlanSchema.parse({
      plan_version: '1.0', plan_type: 'IMPLEMENTATION_PLAN', task_summary: 'Execute the requested steps',
      assumptions: [], risks: [], out_of_scope: [], root_cause: 'Fixture',
      minimal_action_set: steps.map((step, index) => ({
        step: index + 1, description: 'Requested operation', rationale: 'Requested',
        reversible: true, verification: 'Inspect result', ...step,
      })),
    })
  }

  function evidence() {
    return new EvidenceBundle('offline-chat-execution', process.env['BABEL_RUNS_DIR']!)
  }

  test('missing write contents halt without truncating an existing file or running later steps', async () => {
    writeFileSync('preserved.txt', 'keep this')
    const result = await runChatExecutorLoop(plan([
      { tool: 'file_write', target: 'preserved.txt' },
      { tool: 'file_read', target: 'preserved.txt' },
    ]), evidence(), 'Update preserved.txt')
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    assert.match(result.haltReason ?? '', /content/i)
    assert.equal(readFileSync('preserved.txt', 'utf8'), 'keep this')
    assert.deepEqual(result.toolCallLog, [])
    assert.deepEqual(result.changedFiles, [])
  })

  for (const [target, content] of [['written.txt', 'requested bytes\n'], ['empty.txt', '']] as const) {
    test(`schema-parsed write produces exact bytes in ${target}`, async () => {
      const result = await runChatExecutorLoop(plan([{ tool: 'file_write', target, content }]), evidence(), `Create ${target}`)
      assert.equal(result.terminalStatus, 'EXECUTION_COMPLETE')
      assert.equal(existsSync(target), true)
      assert.equal(readFileSync(target, 'utf8'), content)
      assert.deepEqual(result.changedFiles, [target])
      assert.equal(result.toolCallLog[0]?.verified, true)
    })
  }

  test('unsupported required actions halt instead of silently completing', async () => {
    const result = await runChatExecutorLoop(plan([{ tool: 'web_search', target: 'required research' }]), evidence(), 'Research this')
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    assert.match(result.haltReason ?? '', /unsupported|not supported/i)
    assert.deepEqual(result.toolCallLog, [])
  })

  test('read-only work can complete without inventing a required mutation', async () => {
    writeFileSync('already-correct.txt', 'correct')
    const result = await runChatExecutorLoop(plan([{ tool: 'file_read', target: 'already-correct.txt' }]), evidence(), 'Check this file; no changes needed')
    assert.equal(result.terminalStatus, 'EXECUTION_COMPLETE', result.haltReason)
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.toolCallLog.length, 1)
    assert.equal(readFileSync('already-correct.txt', 'utf8'), 'correct')
  })

  for (const tool of ['file_write', 'shell_exec', 'test_run'] as const) {
    test(`owner read-only intent blocks generated ${tool} at the kernel boundary`, async t => {
      let dispatched = false
      t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => {
        dispatched = true
        return { exit_code: 0, stdout: '', stderr: '' }
      })
      const target = tool === 'file_write' ? 'readonly-protected.txt' : 'node -e "require(\'fs\').writeFileSync(\'readonly-protected.txt\',\'forbidden\')"'
      const result = await runChatExecutorLoop(plan([{ tool, target, content: 'forbidden' }]), evidence(),
        'Inspect calc.js and explain it. Do not modify any files or run mutating commands.')
      assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
      assert.match(result.toolCallLog[0]?.stderr ?? '', /plan_read_only/)
      assert.equal(dispatched, false)
      assert.equal(existsSync('readonly-protected.txt'), false)
      assert.deepEqual(result.changedFiles, [])
    })
  }

  test('sandbox denial preserves outside bytes and halts subsequent actions', async () => {
    const outside = join(projectRoot, '..', 'outside.txt')
    writeFileSync(outside, 'protected')
    const result = await runChatExecutorLoop(plan([
      { tool: 'file_write', target: '../outside.txt', content: 'forbidden' },
      { tool: 'file_read', target: 'already-correct.txt' },
    ]), evidence(), 'Attempt a write')
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    assert.equal(readFileSync(outside, 'utf8'), 'protected')
    assert.equal(result.toolCallLog.length, 1)
    assert.equal(result.toolCallLog[0]?.verified, false)
    assert.deepEqual(result.changedFiles, [])
  })

  test('a cancelled task never starts a queued write', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runChatExecutorLoop(plan([{ tool: 'file_write', target: 'cancelled.txt', content: 'must not write' }]), evidence(), 'Create cancelled.txt', { signal: controller.signal })
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    assert.match(result.haltReason ?? '', /cancel/i)
    assert.equal(existsSync('cancelled.txt'), false)
    assert.deepEqual(result.toolCallLog, [])
  })

  test('cancellation during a tool records interruption and stops the next write', async t => {
    writeFileSync('cancel-input.txt', 'original')
    const controller = new AbortController()
    const original = SafeExecutor.prototype.fileRead
    t.mock.method(SafeExecutor.prototype, 'fileRead', function (this: InstanceType<typeof SafeExecutor>, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args)
      controller.abort()
      return result
    })
    const bundle = evidence()
    const result = await runChatExecutorLoop(plan([
      { tool: 'file_read', target: 'cancel-input.txt' },
      { tool: 'file_write', target: 'cancel-input.txt', content: 'unwanted' },
    ]), bundle, 'Update cancel-input.txt', { signal: controller.signal })
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    assert.equal(readFileSync('cancel-input.txt', 'utf8'), 'original')
    assert.equal(result.toolCallLog.length, 1)
    assert.equal(result.toolCallLog[0]?.verified, false)
    assert.equal(collectTerminalContext(bundle.runDir).toolCallLog.length, 1)
  })

  test('approving a pending write after cancellation cannot dispatch late bytes', async t => {
    const controller = new AbortController()
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const names = ['BABEL_ASK', 'BABEL_UNIT_TEST', 'CI', 'BABEL_NON_INTERACTIVE'] as const
    const previous = names.map(name => [name, process.env[name]] as const)
    t.after(() => {
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
      for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    })
    process.env['BABEL_ASK'] = 'true'
    process.env['BABEL_UNIT_TEST'] = 'true'
    delete process.env['CI']
    delete process.env['BABEL_NON_INTERACTIVE']
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let approve!: (value: boolean) => void
    t.mock.method(ConfirmDialog, 'show', async () => {
      entered()
      return new Promise<boolean>(resolve => { approve = resolve })
    })
    writeFileSync('late-approval.txt', 'original')
    const pending = runChatExecutorLoop(plan([{ tool: 'file_write', target: 'late-approval.txt', content: 'late write' }]), evidence(), 'Update late-approval.txt', { signal: controller.signal })
    await Promise.race([waiting, pending.then(() => { throw new Error('Write settled before reaching its approval prompt') })])
    controller.abort()
    const result = await pending
    assert.equal(result.terminalStatus, 'EXECUTOR_HALTED')
    approve(true)
    // Give a late dispatch a bounded window to surface; the assertion is about
    // durable bytes, so waiting longer can only catch a violation.
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(readFileSync('late-approval.txt', 'utf8'), 'original')
  })

  test('successful execution persists its log for required-verifier finalization', async t => {
    // Stub the OS-sandbox transport only; keep policy, dispatch, and finalization real.
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/chat:unit'
    setDockerAvailableForTest(true)
    t.after(() => { delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']; resetDockerAvailabilityCache() })
    t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => ({ exit_code: 0, stdout: 'tests passed', stderr: '' }))
    writeFileSync('chat-proof.test.mjs', 'import test from "node:test"; test("passes", () => {})\n')
    const task = 'Run node --test chat-proof.test.mjs before completing.'
    const bundle = evidence()
    const result = await runChatExecutorLoop(plan([{ tool: 'test_run', target: 'node --test chat-proof.test.mjs' }]), bundle, task)
    assert.equal(result.terminalStatus, 'EXECUTION_COMPLETE')
    const terminalContext = collectTerminalContext(bundle.runDir)
    assert.equal(terminalContext.toolCallLog.length, 1)
    const verifiers = buildVerifierContractArtifacts({ task, toolCallLog: terminalContext.toolCallLog, runDir: bundle.runDir })
    assert.equal(verifiers.summary.requiredVerifierCount, 1)
    assert.equal(verifiers.summary.verifierCompletionSatisfied, true)
    assert.equal(buildPipelineFinalTerminalState({ resultStatus: 'COMPLETE', terminalContext, verifierContractSummary: verifiers.summary }).status, 'COMPLETE')
  })

  test('halt evidence preserves the failure reason for finalization', async () => {
    const bundle = evidence()
    await runChatExecutorLoop(plan([{ tool: 'file_write', target: 'missing.txt' }]), bundle, 'Create missing.txt')
    const context = collectTerminalContext(bundle.runDir)
    assert.match(context.condition ?? '', /content/i)
    const report = JSON.parse(readFileSync(join(bundle.runDir, '04_execution_report.json'), 'utf8'))
    assert.equal(report.status, 'EXECUTION_HALTED')
    assert.equal(report.steps_executed, 0)
  })

  test('failed file tools are displayed as failures, not successful reads or writes', () => {
    for (const tool of ['file_write', 'file_read'] as const) {
      const display = formatToolCallForDisplay({ step: 1, tool, target: 'denied.txt', exit_code: 126, stdout: '', stderr: 'denied', verified: false }, projectRoot)
      assert.match(display ?? '', /failed|denied|exit 126/i)
      assert.doesNotMatch(display ?? '', /^(Wrote|Read) /)
    }
  })
}
