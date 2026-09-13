import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapabilityManifest, CellResult } from './comparison-contract.js'
import { digest, normalizeCapabilities } from './comparison-contract.js'
import {
  cellInvalidReasonsV3,
  compareExperiment,
  contractDigestV3,
  preflightV3,
  type CellResultV3,
  type ExperimentArm,
  type ExperimentContractV3,
} from './comparison-contract-v3.js'

const caps: CapabilityManifest = {
  filesystem: { read: ['repo'], write: ['workdir'] },
  network: ['opencode-go'],
  process: ['node'],
  environment: ['PATH'],
  limits: { timeoutMs: 600_000, modelCalls: null, toolCalls: null, outputTokens: null },
}

function arm(role: 'M' | 'B' | 'I', overrides: Partial<ExperimentArm> = {}): ExperimentArm {
  return {
    role,
    harness: role === 'M' ? 'claude-code' : 'babel-live',
    version: role === 'M' ? 'reference-v1' : 'a'.repeat(40),
    configurationDigest: 'c'.repeat(64),
    route: 'primary',
    requestedProvider: 'opencode-go',
    requestedModel: 'mimo-v2.5',
    capabilities: caps,
    capabilityEvidence: ['manifest@v1'],
    ...overrides,
  }
}

const intervention = { id: 'I01_investigate_hard_cap_observe_only', digest: 'd'.repeat(64) }

function contract(overrides: Partial<ExperimentContractV3> = {}): ExperimentContractV3 {
  return {
    schemaVersion: 3,
    experimentId: 'exp-1',
    pairId: 'pair-1',
    taskId: 'T1',
    taskVersion: 'task-v7',
    fixtureSha: '1'.repeat(64),
    baseSha: '2'.repeat(64),
    runnerSha: '3'.repeat(64),
    instructions: 'do the task',
    verifier: { id: 'astra-frozen-T1-v1', digest: '4'.repeat(64), command: ['node', 'verify.mjs'] },
    arms: { M: arm('M'), B: arm('B'), I: arm('I', { configurationDigest: 'e'.repeat(64), intervention }) },
    ...overrides,
  }
}

function cell(role: 'M' | 'B' | 'I', fullContract: ExperimentContractV3, overrides: Partial<CellResultV3> = {}): CellResultV3 {
  const armContract = fullContract.arms[role]!
  const base: Omit<CellResult, 'harness' | 'contract' | 'CONTRACT_DIGEST'> = {
    EFFECTIVE_CAPABILITY_MANIFEST: caps,
    CAPABILITY_DIGEST: digest(normalizeCapabilities(caps)),
    REQUESTED_PROVIDER: 'opencode-go',
    REQUESTED_MODEL: 'mimo-v2.5',
    OBSERVED_PROVIDER: 'opencode-go',
    OBSERVED_MODEL: 'mimo-v2.5',
    fallback: false,
    attempted: true,
    invalidReasons: [],
    EXECUTION_SUCCESS: true,
    VERIFIER_SUCCESS: true,
    TASK_CORRECTNESS: 'PASS',
    HARNESS_EFFECT: 'CONTROLLED_DIFFERENCE',
    VERIFIER_ID: fullContract.verifier.id,
    VERIFIER_DIGEST: fullContract.verifier.digest,
    VERIFIER_COMMAND: fullContract.verifier.command,
    VERIFIER_RESULT: 'PASS',
    VERIFIER_PRODUCER: 'independent-evaluator',
    termination: { kind: 'NORMAL', evidence: [] },
    FAILURES_ENCOUNTERED: [],
    ACTIONABLE_DIAGNOSTICS_OBSERVED: false,
    RETRIES: 0,
    RECOVERY_SUCCESS: false,
    CAUSE_IDENTIFICATION: 'UNKNOWN',
    metrics: { wallTimeMs: 1000, modelCalls: 3, toolCalls: 5, inputTokens: 100, outputTokens: 50, cost: 0.01 },
    changedFiles: [],
    evidence: { packet: 'p', trajectory: 't', receipt: 'r', verifier: 'v' },
  }
  const result: CellResultV3 = {
    ...base,
    role,
    contract: fullContract,
    CONTRACT_DIGEST: contractDigestV3(fullContract),
    missing_fields: [],
    ...(armContract.intervention ? { intervention: armContract.intervention } : {}),
    ...overrides,
  }
  void armContract
  return result
}

function cells(overrides: Partial<ExperimentContractV3> = {}, cellOverrides: Partial<CellResultV3> = {}): Record<'M' | 'B' | 'I', CellResultV3> {
  const full = contract(overrides)
  return { M: cell('M', full, cellOverrides), B: cell('B', full, cellOverrides), I: cell('I', full, cellOverrides) }
}

test('valid M/B/I contract passes preflight and digest round-trips', () => {
  const full = contract()
  assert.deepEqual(preflightV3(full), [], JSON.stringify(preflightV3(full)))
  assert.deepEqual(cellInvalidReasonsV3(cell('I', full)), [], JSON.stringify(cellInvalidReasonsV3(cell('I', full))))
  assert.equal(contractDigestV3(full), contractDigestV3(contract()))
})

test('v2 evidence cannot pass the v3 gate and vice versa (single versioned authority)', () => {
  const v2Shaped = { ...contract(), schemaVersion: 2 as unknown as 3 }
  assert.deepEqual(preflightV3(v2Shaped), ['INVALID_CONTRACT'])
})

test('intervention is mandatory on I and forbidden on M and B', () => {
  const noIntervention = contract({ arms: { M: arm('M'), B: arm('B'), I: arm('I', { configurationDigest: 'e'.repeat(64) }) } })
  assert.ok(preflightV3(noIntervention).includes('MISSING_INTERVENTION_IDENTITY'))
  const onBaseline = contract({ arms: { M: arm('M', { intervention }), B: arm('B'), I: arm('I', { configurationDigest: 'e'.repeat(64), intervention }) } })
  assert.ok(preflightV3(onBaseline).includes('INTERVENTION_ON_NON_INTERVENTION_ARM'))
})

test('baseline must match the reference configuration and the intervention arm must differ', () => {
  const diverged = contract({ arms: { M: arm('M'), B: arm('B', { configurationDigest: 'f'.repeat(64) }), I: arm('I', { configurationDigest: 'e'.repeat(64), intervention }) } })
  assert.ok(preflightV3(diverged).includes('BASELINE_REFERENCE_CONFIGURATION_MISMATCH'))
  const notDistinct = contract({ arms: { M: arm('M'), B: arm('B'), I: arm('I', { configurationDigest: 'c'.repeat(64), intervention }) } })
  assert.ok(preflightV3(notDistinct).includes('INTERVENTION_CONFIGURATION_NOT_DISTINCT'))
})

test('a real intervention win isolates the B_vs_I pair from the baseline gap', () => {
  const full = cells()
  const result = compareExperiment({
    M: full.M,
    B: cell('B', full.B.contract, { TASK_CORRECTNESS: 'FAIL', VERIFIER_RESULT: 'FAIL', VERIFIER_SUCCESS: false }),
    I: cell('I', full.I.contract),
  })
  assert.equal(result.verdicts[0]!.comparison, 'M_vs_B')
  assert.equal(result.verdicts[0]!.PAIR_VERDICT, 'REFERENCE_SUPERIOR')
  assert.equal(result.verdicts[1]!.comparison, 'B_vs_I')
  assert.equal(result.verdicts[1]!.PAIR_VERDICT, 'CANDIDATE_SUPERIOR')
  assert.equal(result.EXPERIMENT_VERDICT, 'CANDIDATE_SUPERIOR')
})

test('timeouts and unknown correctness stay inconclusive and never award a win', () => {
  const timedOut = cells()
  const result = compareExperiment({
    M: timedOut.M,
    B: timedOut.B,
    I: cell('I', timedOut.I.contract, { termination: { kind: 'PROVIDER_TIMEOUT', evidence: ['t=1'] } }),
  })
  assert.equal(result.verdicts[1]!.PAIR_VERDICT, 'INCONCLUSIVE')
  assert.equal(result.EXPERIMENT_VERDICT, 'INCONCLUSIVE')
})

test('tampered contract digest invalidates the comparison', () => {
  const full = cells()
  const tampered = cell('I', full.I.contract)
  tampered.CONTRACT_DIGEST = '0'.repeat(64)
  const result = compareExperiment({ M: full.M, B: full.B, I: tampered })
  assert.equal(result.EXPERIMENT_VERDICT, 'INVALID_COMPARISON')
  assert.ok(result.reasons.includes('CONTRACT_DIGEST_MISMATCH'))
})
