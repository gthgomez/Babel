import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixturePrompt } from '../fixtures/claude-babel-astra-lab/fixtures.js'
import { digest, type ArmIdentity, type Harness, type PairContract } from './comparison-contract.js'
import { runComparisonCampaign, type ComparisonAdapter } from './comparison-runner.js'
import { freezeEvaluator } from './frozen-evaluator.js'
import { buildNeutralReceipt } from './receipt.js'
import { aggregateResults } from './comparison-report.js'
import { runnerIdentity } from './runner-identity.js'

function definition(pairId: string): PairContract {
  const arm = (harness: Harness): ArmIdentity => ({ harness, version: harness === 'babel-live' ? 'd'.repeat(40) : 'fake-observed-v1', configurationDigest: digest(harness), route: 'deterministic-fake/opencode-go', requestedProvider: 'opencode-go', requestedModel: 'mimo-v2.5', capabilities: { filesystem: { read: ['fixture/**'], write: ['fixture/src/**'] }, network: [], process: [], environment: ['deterministic-fixture'], limits: { timeoutMs: 1000, modelCalls: 1, toolCalls: 1, outputTokens: null } }, capabilityEvidence: ['fake-adapter fixed authority'] })
  const verifier = freezeEvaluator('T2')
  return { schemaVersion: 2, experimentId: 'deterministic-runner', pairId, taskId: 'T2', fixtureSha: '0537fa2a8bf45a338243c2c94f9cf655de5d087f', baseSha: '0537fa2a8bf45a338243c2c94f9cf655de5d087f', runnerSha: runnerIdentity().sha, instructions: fixturePrompt('T2'), verifier: { id: verifier.id, digest: verifier.digest, command: [...verifier.command] }, arms: { 'claude-code': arm('claude-code'), 'babel-live': arm('babel-live') } }
}

function adapter(identity: ArmIdentity, calls: string[], source = 'export function add(a, b) { return a + b; }\n'): ComparisonAdapter {
  return {
    describe: async () => structuredClone(identity),
    execute: async ({ fixture, contract, outputRoot }) => {
      calls.push(`${contract.pairId}:${identity.harness}`)
      writeFileSync(join(fixture.root, 'src/math.js'), source)
      const rawTrajectory = join(outputRoot, 'fake-trajectory.jsonl')
      writeFileSync(rawTrajectory, '{"event":"fake_contestant_write"}\n')
      const receipt = buildNeutralReceipt({
        EXPERIMENT_ID: contract.experimentId, PAIR_ID: contract.pairId, RUN_ID: `${contract.pairId}-${identity.harness}`, SUPERVISOR: 'deterministic-test', HARNESS: identity.harness, HARNESS_VERSION: identity.version, HARNESS_ADAPTER: 'fake', HARNESS_ADAPTER_VERSION: '1', PROVIDER: 'opencode-go', PROVIDER_ROUTE: identity.route, REQUESTED_MODEL: 'mimo-v2.5', OBSERVED_MODEL: 'mimo-v2.5', TASK_ID: 'T2', REPOSITORY: fixture.root, BASE_SHA: fixture.baseSha, HEAD_SHA: fixture.baseSha, START_TIME: '2026-01-01T00:00:00Z', END_TIME: '2026-01-01T00:00:01Z', WALL_TIME: 1, PROCESS_IDS: [], PROCESS_COUNT: 0, PEAK_WORKING_SET: 'UNKNOWN', CPU_TIME: 'UNKNOWN', DISK_READ_BYTES: 'UNKNOWN', DISK_WRITE_BYTES: 'UNKNOWN', MODEL_CALLS: 0, INPUT_TOKENS: 'UNKNOWN', OUTPUT_TOKENS: 'UNKNOWN', CACHED_TOKENS: 'UNKNOWN', TOOL_CALLS: 1, FILES_READ: [], FILES_CHANGED: ['src/math.js'], TEST_COMMANDS: ['node --test --test-name-pattern=nonexistent test/math.test.js'], TEST_RESULTS: { result: 'PASS' }, REPAIR_LOOPS: 0, CONTEXT_COMPACTIONS: 0, TERMINAL_CLAIM: 'complete', VERIFIER_RESULT: 'PASS', FALSE_COMPLETION: 'UNKNOWN', POLICY_VIOLATION: false, HUMAN_INTERVENTIONS: 0, RAW_TRAJECTORY_PATH: rawTrajectory, NORMALIZED_TRAJECTORY_PATH: rawTrajectory, FALLBACK_USED: false,
      })
      return { receipt, profile: 'benchmark-mimo', exactModel: 'mimo-v2.5', fixtureSha: fixture.baseSha, verifier: { result: 'PASS', deterministic: true }, rawTrajectory, normalizedTrajectory: rawTrajectory, resourceMetrics: { processCount: 0, childProcessCount: 0, peakWorkingSet: 'UNKNOWN', cpuTimeMs: 'UNKNOWN', diskReadBytes: 'UNKNOWN', diskWriteBytes: 'UNKNOWN', processCleanup: 'PASS' }, audit: { executionSuccess: true, termination: { kind: 'NORMAL', evidence: ['fake adapter completed'] }, observedProvider: 'opencode-go', observedModel: 'mimo-v2.5', fallback: false, failures: [], retries: 0, recoverySuccess: 'UNKNOWN' } }
    },
  }
}

test('actual runner and task repository SHAs are checked before provider calls', async () => {
  const good = definition('actual-source')
  const wrongRunner = structuredClone(good); wrongRunner.pairId = 'wrong-runner'; wrongRunner.runnerSha = '0'.repeat(40)
  const wrongBase = structuredClone(good); wrongBase.pairId = 'wrong-base'; wrongBase.baseSha = '0'.repeat(40)
  const calls: string[] = []
  const pairs = await runComparisonCampaign([wrongRunner, wrongBase, good], {
    outputRoot: mkdtempSync(join(tmpdir(), 'astra-source-identity-')),
    adapters: { 'claude-code': adapter(good.arms['claude-code'], calls), 'babel-live': adapter(good.arms['babel-live'], calls) },
  })
  assert.deepEqual(calls, ['actual-source:claude-code', 'actual-source:babel-live'])
  assert.ok(pairs[0]!.reasons.includes('RUNNER_SHA_MISMATCH'))
  assert.ok(pairs[1]!.reasons.includes('FIXTURE_OR_INSTRUCTIONS_MISMATCH'))
  assert.equal(pairs[2]!.PAIR_VERDICT, 'TIE')
  assert.equal(pairs[2]!.claude.RUNNER_SOURCE_DIGEST, runnerIdentity().sourceDigest)
})

test('invalid cell does not stop its valid sibling or subsequent valid pair; packets link real independent evidence', async () => {
  const good = definition('good')
  const bad = definition('bad'); bad.arms['claude-code'].route = ''
  const calls: string[] = []
  const outputRoot = mkdtempSync(join(tmpdir(), 'astra-comparison-runner-test-'))
  const pairs = await runComparisonCampaign([bad, good], { outputRoot, adapters: { 'claude-code': adapter(good.arms['claude-code'], calls), 'babel-live': adapter(good.arms['babel-live'], calls) } })
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.equal(pairs[0]!.claude.attempted, false)
  assert.equal(pairs[0]!.babel.attempted, true)
  assert.equal(pairs[1]!.PAIR_VERDICT, 'TIE')
  assert.deepEqual(calls, ['bad:babel-live', 'good:claude-code', 'good:babel-live'])
  for (const cell of [pairs[1]!.claude, pairs[1]!.babel]) {
    assert.equal(cell.VERIFIER_RESULT, 'PASS')
    assert.equal(cell.TASK_CORRECTNESS, 'PASS')
    assert.equal(cell.VERIFIER_PRODUCER, 'independent-evaluator')
    for (const path of Object.values(cell.evidence)) assert.ok(existsSync(path), path)
    const evidence = JSON.parse(readFileSync(cell.evidence.verifier, 'utf8'))
    assert.ok(evidence.structural.command.includes('test/structural.test.mjs'))
    assert.equal(evidence.structural.command.some((s: string) => s.includes('test-name-pattern')), false)
  }
  const aggregate = JSON.parse(readFileSync(join(outputRoot, 'reports/aggregate.json'), 'utf8'))
  assert.equal(aggregate.invalidComparisons, 1)
  assert.equal(aggregate.ties, 1)
  assert.equal(aggregate.totalCellsAttempted, 3)
})

test('independent semantics distinguish hardcoded answer despite both structural tests passing', async () => {
  const contract = definition('semantic')
  const outputRoot = mkdtempSync(join(tmpdir(), 'astra-comparison-semantics-test-'))
  const pairs = await runComparisonCampaign([contract], { outputRoot, adapters: { 'claude-code': adapter(contract.arms['claude-code'], [], 'export function add() { return 5; }\n'), 'babel-live': adapter(contract.arms['babel-live'], []) } })
  assert.equal(pairs[0]!.claude.VERIFIER_RESULT, 'PASS')
  assert.equal(pairs[0]!.babel.VERIFIER_RESULT, 'PASS')
  assert.equal(pairs[0]!.claude.TASK_CORRECTNESS, 'FAIL')
  assert.equal(pairs[0]!.babel.TASK_CORRECTNESS, 'PASS')
  assert.equal(pairs[0]!.PAIR_VERDICT, 'BABEL_WIN')
})

test('malformed missing manifests and arms stay local and later valid pairs execute', async () => {
  const good = definition('after-malformed')
  const missingManifest = definition('missing-manifest')
  Reflect.deleteProperty(missingManifest.arms['claude-code'], 'capabilities')
  const missingArms = definition('missing-arms')
  Reflect.deleteProperty(missingArms, 'arms')
  const calls: string[] = []
  const pairs = await runComparisonCampaign([missingManifest, missingArms, good], { outputRoot: mkdtempSync(join(tmpdir(), 'astra-malformed-test-')), adapters: { 'claude-code': adapter(good.arms['claude-code'], calls), 'babel-live': adapter(good.arms['babel-live'], calls) } })
  assert.equal(pairs.length, 3)
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.equal(pairs[1]!.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.equal(pairs[2]!.PAIR_VERDICT, 'TIE')
  assert.deepEqual(calls, ['after-malformed:claude-code', 'after-malformed:babel-live'])
})

test('pre-execution AbortSignal cancellation remains inconclusive without inventing identity mismatch', async () => {
  const contract = definition('cancelled')
  const controller = new AbortController(); controller.abort()
  const calls: string[] = []
  const pairs = await runComparisonCampaign([contract], { signal: controller.signal, outputRoot: mkdtempSync(join(tmpdir(), 'astra-cancel-test-')), adapters: { 'claude-code': adapter(contract.arms['claude-code'], calls), 'babel-live': adapter(contract.arms['babel-live'], calls) } })
  assert.deepEqual(calls, [])
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INCONCLUSIVE')
  assert.equal(pairs[0]!.claude.termination.kind, 'RUNNER_CANCELLED')
  assert.equal(pairs[0]!.babel.termination.kind, 'RUNNER_CANCELLED')
  assert.equal(aggregateResults(pairs).modelProviderMismatches, 0)
})

test('runner deadline aborts cooperative adapter and records inconclusive timeout', async () => {
  const contract = definition('deadline')
  for (const arm of Object.values(contract.arms)) arm.capabilities.limits.timeoutMs = 15
  const aborted: string[] = []
  const slow = (harness: Harness): ComparisonAdapter => ({
    describe: async () => contract.arms[harness],
    execute: async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted.push(harness); reject(new Error('fake adapter acknowledged abort')) }, { once: true })
    }),
  })
  const pairs = await runComparisonCampaign([contract], { outputRoot: mkdtempSync(join(tmpdir(), 'astra-deadline-test-')), adapters: { 'claude-code': slow('claude-code'), 'babel-live': slow('babel-live') } })
  assert.deepEqual(aborted, ['claude-code', 'babel-live'])
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INCONCLUSIVE')
  for (const cell of [pairs[0]!.claude, pairs[0]!.babel]) {
    assert.equal(cell.termination.kind, 'RUNNER_TIMEOUT')
    assert.equal(cell.evidence.verifier, 'UNKNOWN')
    assert.match(cell.termination.evidence.join(' '), /settled=true/)
  }
  assert.equal(aggregateResults(pairs).modelProviderMismatches, 0)
})

test('existing nonempty output directory refuses before any adapter execution and preserves evidence', async () => {
  const contract = definition('duplicate')
  const outputRoot = mkdtempSync(join(tmpdir(), 'astra-duplicate-test-'))
  const marker = join(outputRoot, 'prior-evidence.json'); writeFileSync(marker, '{"immutable":true}\n')
  const calls: string[] = []
  await assert.rejects(runComparisonCampaign([contract], { outputRoot, adapters: { 'claude-code': adapter(contract.arms['claude-code'], calls), 'babel-live': adapter(contract.arms['babel-live'], calls) } }))
  assert.deepEqual(calls, [])
  assert.equal(readFileSync(marker, 'utf8'), '{"immutable":true}\n')
})

test('string capability evidence and verifier command cannot globally stop subsequent valid pair', async () => {
  const good = definition('after-invalid-shape')
  const evidence = definition('string-evidence')
  Reflect.set(evidence.arms['claude-code'], 'capabilityEvidence', 'not-an-array')
  const command = definition('string-command')
  Reflect.set(command.verifier, 'command', 'node --test')
  const calls: string[] = []
  const pairs = await runComparisonCampaign([evidence, command, good], { outputRoot: mkdtempSync(join(tmpdir(), 'astra-shape-test-')), adapters: { 'claude-code': adapter(good.arms['claude-code'], calls), 'babel-live': adapter(good.arms['babel-live'], calls) } })
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.equal(pairs[1]!.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.equal(pairs[2]!.PAIR_VERDICT, 'TIE')
  assert.deepEqual(calls, ['string-evidence:babel-live', 'after-invalid-shape:claude-code', 'after-invalid-shape:babel-live'])
})

test('cooperative timeout preserves flushed trajectory identity and metrics without evaluating', async () => {
  const contract = definition('flushed-timeout')
  for (const arm of Object.values(contract.arms)) arm.capabilities.limits.timeoutMs = 15
  const flushed = (harness: Harness): ComparisonAdapter => {
    const delegate = adapter(contract.arms[harness], [])
    return {
      describe: delegate.describe,
      execute: async input => {
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
        return delegate.execute(input)
      },
    }
  }
  const pairs = await runComparisonCampaign([contract], { outputRoot: mkdtempSync(join(tmpdir(), 'astra-flushed-timeout-test-')), adapters: { 'claude-code': flushed('claude-code'), 'babel-live': flushed('babel-live') } })
  assert.equal(pairs[0]!.PAIR_VERDICT, 'INCONCLUSIVE')
  for (const cell of [pairs[0]!.claude, pairs[0]!.babel]) {
    assert.equal(cell.termination.kind, 'RUNNER_TIMEOUT')
    assert.equal(cell.EXECUTION_SUCCESS, false)
    assert.equal(cell.OBSERVED_PROVIDER, 'opencode-go')
    assert.equal(cell.OBSERVED_MODEL, 'mimo-v2.5')
    assert.equal(cell.fallback, false)
    assert.equal(cell.metrics.wallTimeMs, 1)
    assert.equal(cell.metrics.toolCalls, 1)
    assert.ok(existsSync(cell.evidence.trajectory))
    assert.match(readFileSync(cell.evidence.trajectory, 'utf8'), /fake_contestant_write/)
    assert.equal(cell.evidence.verifier, 'UNKNOWN')
    assert.equal(cell.VERIFIER_RESULT, 'UNKNOWN')
  }
})
