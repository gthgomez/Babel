import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { compareCells, digest, normalizeCapabilities, preflight, type CellResult, type Harness, type PairContract } from './comparison-contract.js'
import { aggregateResults, pairMarkdown } from './comparison-report.js'

function contract(): PairContract {
  const capabilities = { filesystem: { read: ['fixture/**'], write: ['fixture/src/**'] }, network: [], process: ['node'], environment: ['node-24'], limits: { timeoutMs: 1000, modelCalls: 8, toolCalls: 20, outputTokens: null } }
  const arm = (harness: Harness) => ({ harness, version: harness === 'babel-live' ? 'd'.repeat(40) : 'test-v1', configurationDigest: digest({ harness }), route: 'test-adapter/opencode-go', requestedProvider: 'opencode-go', requestedModel: 'deepseek-v4-flash', capabilities: structuredClone(capabilities), capabilityEvidence: ['deterministic-test-authority-probe'] })
  return { schemaVersion: 2, experimentId: 'deterministic', pairId: 'pair-1', taskId: 'T2', fixtureSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), runnerSha: 'c'.repeat(40), instructions: 'Repair add.', verifier: { id: 'frozen-test-v1', digest: digest('test-definition'), command: ['node', '--test', 'test/math.test.js'] }, arms: { 'claude-code': arm('claude-code'), 'babel-live': arm('babel-live') } }
}

function cell(harness: Harness, bound = contract()): CellResult {
  const capability = bound.arms[harness].capabilities
  const root = resolve('deterministic-evidence', harness)
  return { harness, contract: bound, CONTRACT_DIGEST: digest(bound), EFFECTIVE_CAPABILITY_MANIFEST: structuredClone(capability), CAPABILITY_DIGEST: digest(normalizeCapabilities(capability)), REQUESTED_PROVIDER: 'opencode-go', REQUESTED_MODEL: 'deepseek-v4-flash', OBSERVED_PROVIDER: 'opencode-go', OBSERVED_MODEL: 'deepseek-v4-flash', fallback: false, attempted: true, invalidReasons: [], EXECUTION_SUCCESS: true, VERIFIER_SUCCESS: true, TASK_CORRECTNESS: 'PASS', HARNESS_EFFECT: 'INCONCLUSIVE', VERIFIER_ID: bound.verifier.id, VERIFIER_DIGEST: bound.verifier.digest, VERIFIER_COMMAND: bound.verifier.command, VERIFIER_RESULT: 'PASS', VERIFIER_PRODUCER: 'independent-evaluator', termination: { kind: 'NORMAL', evidence: [] }, FAILURES_ENCOUNTERED: [], ACTIONABLE_DIAGNOSTICS_OBSERVED: 'UNKNOWN', RETRIES: 0, RECOVERY_SUCCESS: 'UNKNOWN', CAUSE_IDENTIFICATION: 'UNKNOWN', metrics: { wallTimeMs: 10, modelCalls: 1, toolCalls: 1, inputTokens: 'UNKNOWN', outputTokens: 'UNKNOWN', cost: 'UNKNOWN' }, changedFiles: ['src/math.js'], evidence: { packet: join(root, 'cell.json'), trajectory: join(root, 'trajectory.jsonl'), receipt: join(root, 'receipt.json'), verifier: join(root, 'verifier.json') } }
}

test('valid matched pair is a tie and capability set order is immaterial', () => {
  const c = contract()
  c.arms['claude-code'].capabilities.process = ['node', 'git', 'node']
  c.arms['babel-live'].capabilities.process = ['git', 'node']
  assert.deepEqual(preflight(c, 'claude-code'), [])
  const pair = compareCells(cell('claude-code', c), cell('babel-live', c))
  assert.equal(pair.PAIR_VALIDITY, 'VALID')
  assert.equal(pair.PAIR_VERDICT, 'TIE')
})

for (const [name, mutate, reason] of [
  ['model mismatch', (c: CellResult) => { c.OBSERVED_MODEL = 'mimo-v2.5' }, 'MODEL_MISMATCH'],
  ['fallback detected', (c: CellResult) => { c.fallback = true }, 'FALLBACK_DETECTED_OR_UNKNOWN'],
  ['effective capability mismatch', (c: CellResult) => { c.EFFECTIVE_CAPABILITY_MANIFEST.network = ['*']; c.CAPABILITY_DIGEST = digest(normalizeCapabilities(c.EFFECTIVE_CAPABILITY_MANIFEST)) }, 'INVALID_CAPABILITY_MISMATCH'],
  ['contestant filtered verifier cannot substitute for frozen suite', (c: CellResult) => { c.VERIFIER_COMMAND = ['node', '--test', '--test-name-pattern=passing', 'test/math.test.js'] }, 'INVALID_VERIFIER'],
  ['contestant cannot produce independent verification', (c: CellResult) => { c.VERIFIER_PRODUCER = 'contestant' }, 'INVALID_VERIFIER'],
] as const) test(name, () => {
  const b = cell('babel-live'); mutate(b)
  const pair = compareCells(cell('claude-code'), b)
  assert.equal(pair.PAIR_VERDICT, 'INVALID_COMPARISON')
  assert.ok(pair.reasons.includes(reason))
})

for (const kind of ['PROVIDER_TIMEOUT', 'RUNNER_CANCELLED', 'UNKNOWN_TIMEOUT'] as const) test(`${kind} remains inconclusive, never an opponent win`, () => {
  const b = cell('babel-live'); b.termination = { kind, evidence: ['deterministic termination event'] }; b.EXECUTION_SUCCESS = false
  const pair = compareCells(cell('claude-code'), b)
  assert.equal(pair.PAIR_VALIDITY, 'VALID')
  assert.equal(pair.PAIR_VERDICT, 'INCONCLUSIVE')
  assert.deepEqual(aggregateResults([pair]).terminationsByProvenance, { [kind]: 1 })
})

test('one normal arm failing its independent verifier loses the valid comparison', () => {
  const b = cell('babel-live'); b.VERIFIER_SUCCESS = false; b.VERIFIER_RESULT = 'FAIL'; b.TASK_CORRECTNESS = 'FAIL'
  assert.equal(compareCells(cell('claude-code'), b).PAIR_VERDICT, 'CLAUDE_WIN')
})

test('semantic failure remains visible even when structural verifier passes and arm is faster', () => {
  const c = cell('claude-code'); c.TASK_CORRECTNESS = 'FAIL'; c.metrics.wallTimeMs = 1
  const pair = compareCells(c, cell('babel-live'))
  assert.equal(pair.PAIR_VERDICT, 'BABEL_WIN')
  assert.equal(pair.claude.VERIFIER_SUCCESS, true)
  assert.equal(pair.claude.TASK_CORRECTNESS, 'FAIL')
})

test('invalid comparisons excluded from aggregate win/loss counts and costs stay unknown', () => {
  const bad = cell('babel-live'); bad.fallback = true; bad.TASK_CORRECTNESS = 'FAIL'
  const summary = aggregateResults([compareCells(cell('claude-code'), bad), compareCells(cell('claude-code'), cell('babel-live'))])
  assert.equal(summary.totalCellsAttempted, 4)
  assert.equal(summary.invalidComparisons, 1)
  assert.equal(summary.matchedValidPairs, 1)
  assert.equal(summary.claudeWins, 0)
  assert.equal(summary.babelWins, 0)
  assert.equal(summary.ties, 1)
  assert.equal(summary.fallbackEvents, 1)
})

test('side-by-side report links both arms packet, trajectory, receipt and verifier', () => {
  const report = pairMarkdown(compareCells(cell('claude-code'), cell('babel-live')), resolve('deterministic-evidence', 'reports'))
  for (const arm of ['claude-code', 'babel-live']) for (const [label, file] of [['packet', 'cell.json'], ['trajectory', 'trajectory.jsonl'], ['receipt', 'receipt.json'], ['verifier', 'verifier.json']]) assert.ok(report.includes(`[${label}](<../${arm}/${file}>)`))
  assert.match(report, /Cost\/tokens \| UNKNOWN; input=UNKNOWN; output=UNKNOWN/)
  assert.match(report, /PAIR_VALIDITY=VALID/)
})

test('preflight rejects missing identity, missing route and incompatible budgets before execution', () => {
  const c = contract(); c.fixtureSha = ''; c.baseSha = ''; c.arms['claude-code'].version = 'UNKNOWN'; c.arms['claude-code'].route = ''; c.arms['claude-code'].capabilities.limits.timeoutMs = 20
  const reasons = preflight(c, 'claude-code')
  for (const reason of ['MISSING_fixtureSha', 'MISSING_baseSha', 'AMBIGUOUS_HARNESS_IDENTITY', 'MISSING_ROUTE', 'INVALID_CAPABILITY_MISMATCH']) assert.ok(reasons.includes(reason))
})
