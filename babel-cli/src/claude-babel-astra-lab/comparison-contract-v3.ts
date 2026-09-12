/**
 * Comparison contract v3 — minimal-reference / baseline / intervention (M/B/I).
 *
 * Additive, versioned successor to the v2 PairContract. Historical v2 (and v1)
 * evidence stays under its original schema and verdicts; nothing here re-scores
 * or re-labels it. v3 exists so a campaign can compare:
 *
 *   M = minimal reference harness (exact configuration pinned)
 *   B = Babel baseline (identical configuration to M except harness identity)
 *   I = Babel + exactly one intervention (identity bound into the contract)
 *
 * Arms may differ ONLY by harness identity and the recorded intervention;
 * model, provider, capabilities, and resource envelope must match across all
 * three roles, so any measured difference is attributable to the harness or
 * the single recorded intervention — never to silent configuration drift.
 */

import { createHash } from 'node:crypto'
import type {
  ArmIdentity,
  CellResult,
} from './comparison-contract.js'
import { canonical, digest, normalizeCapabilities } from './comparison-contract.js'

export type ExperimentRole = 'M' | 'B' | 'I'
export const EXPERIMENT_ROLES: readonly ExperimentRole[] = ['M', 'B', 'I'] as const

export interface InterventionIdentity {
  /** Stable mechanism id (e.g. 'I01_investigate_hard_cap_observe_only'). */
  id: string
  /** SHA-256 over the intervention's implementation/configuration bytes. */
  digest: string
}

export type ExperimentArm = ArmIdentity & {
  role: ExperimentRole
  /** Required on I, forbidden on M and B. */
  intervention?: InterventionIdentity
}

export interface ExperimentContractV3 {
  schemaVersion: 3
  experimentId: string
  pairId: string
  taskId: string
  /** Exact task version — fixtures are content-addressed separately. */
  taskVersion: string
  /** Exact initial state (content-addressed fixture). */
  fixtureSha: string
  baseSha: string
  /** Exact harness/runner source SHA. */
  runnerSha: string
  instructions: string
  verifier: { id: string; digest: string; command: string[] }
  arms: Record<ExperimentRole, ExperimentArm>
}

export interface CellResultV3 extends Omit<CellResult, 'harness' | 'contract' | 'CONTRACT_DIGEST'> {
  role: ExperimentRole
  contract: ExperimentContractV3
  CONTRACT_DIGEST: string
  /** Echo of the contract's intervention for this role (binding check). */
  intervention?: InterventionIdentity
  /** Digest over the execution environment (image, OS, toolchain pins). */
  ENVIRONMENT_DIGEST?: string
  /** Final workspace revision produced by this cell, when observable. */
  final_revision?: string
  /** The trial this cell retries — retries belong to the original trial. */
  retry_of?: string
  /** The persisted state this cell resumed from, if any. */
  resumed_from?: string
  /** Explicit missingness: every field that could not be observed. */
  missing_fields: string[]
}

export type ExperimentVerdict = 'REFERENCE_SUPERIOR' | 'CANDIDATE_SUPERIOR' | 'TIE' | 'INCONCLUSIVE' | 'INVALID_COMPARISON'

export interface PairwiseVerdict {
  comparison: 'M_vs_B' | 'B_vs_I'
  PAIR_VALIDITY: 'VALID' | 'INVALID_COMPARISON'
  PAIR_VERDICT: ExperimentVerdict
  reasons: string[]
}

export interface ExperimentResult {
  experimentId: string
  VALIDITY: 'VALID' | 'INVALID_COMPARISON'
  verdicts: PairwiseVerdict[]
  /** Conservative summary: INVALID > any INCONCLUSIVE/INVALID pair > differing verdicts > TIE. */
  EXPERIMENT_VERDICT: ExperimentVerdict
  reasons: string[]
}

function known(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

/**
 * Versioned contract preflight. Mirrors the v2 rules per arm (provider and
 * model allowlist, capability envelope, babel arm pinned to a source SHA) and
 * adds the role/intervention law: exactly M, B, I; intervention only on I;
 * M and B byte-identical in configuration; cross-arm model/provider/capability
 * parity so differences stay attributable.
 */
export function preflightV3(contract: ExperimentContractV3): string[] {
  const reasons: string[] = []
  if (!contract || contract.schemaVersion !== 3) return ['INVALID_CONTRACT']
  for (const field of ['experimentId', 'pairId', 'taskId', 'taskVersion', 'instructions'] as const) {
    if (!known(contract[field])) reasons.push(`MISSING_${field}`)
  }
  for (const field of ['fixtureSha', 'baseSha', 'runnerSha'] as const) {
    if (!sha(contract[field])) reasons.push(`MISSING_${field}`)
  }
  if (!known(contract.verifier?.id) || !sha(contract.verifier?.digest) || !Array.isArray(contract.verifier?.command) || !contract.verifier.command.length || contract.verifier.command.some((v) => !known(v))) {
    reasons.push('MISSING_VERIFIER')
  }
  const roles = contract.arms
  if (!roles || EXPERIMENT_ROLES.some((role) => !roles[role])) return [...new Set([...reasons, 'MISSING_ARM'])]

  for (const role of EXPERIMENT_ROLES) {
    const arm = roles[role]!
    if (arm.role !== role) reasons.push('AMBIGUOUS_ROLE_IDENTITY')
    if (!known(arm.version) || !sha(arm.configurationDigest)) reasons.push('AMBIGUOUS_HARNESS_IDENTITY')
    if (role !== 'M' && !/^[a-f0-9]{40}$/i.test(arm.version)) reasons.push('MISSING_BABEL_SHA')
    if (!known(arm.route)) reasons.push('MISSING_ROUTE')
    if (arm.requestedProvider !== 'opencode-go') reasons.push('PROVIDER_MISMATCH')
    if (!['mimo-v2.5', 'longcat-2.0', 'deepseek-v4-flash'].includes(arm.requestedModel)) reasons.push('MODEL_MISMATCH')
    if (!Array.isArray(arm.capabilityEvidence) || !arm.capabilityEvidence.length || arm.capabilityEvidence.some((v) => !known(v))) reasons.push('MISSING_CAPABILITY_EVIDENCE')
    const caps = arm.capabilities
    if (!caps?.filesystem || !Array.isArray(caps.filesystem.read) || !Array.isArray(caps.filesystem.write) || !Array.isArray(caps.network) || !Array.isArray(caps.process) || !Array.isArray(caps.environment) || !caps.limits) {
      reasons.push('MISSING_CAPABILITY_MANIFEST')
      continue
    }
    if ([...caps.filesystem.read, ...caps.filesystem.write, ...caps.network, ...caps.process, ...caps.environment].some((v) => !known(v))) reasons.push('UNKNOWN_CAPABILITY')
    if (!(Number.isFinite(caps.limits.timeoutMs) && caps.limits.timeoutMs > 0)) reasons.push('INVALID_RESOURCE_ENVELOPE')
    for (const key of ['modelCalls', 'toolCalls', 'outputTokens'] as const) {
      if (caps.limits[key] !== null && (!Number.isInteger(caps.limits[key]) || Number(caps.limits[key]) <= 0)) reasons.push('INVALID_RESOURCE_ENVELOPE')
    }
    if (role === 'I') {
      const intervention = arm.intervention
      if (!intervention || !known(intervention.id) || !sha(intervention.digest)) reasons.push('MISSING_INTERVENTION_IDENTITY')
    } else if (arm.intervention !== undefined) {
      reasons.push('INTERVENTION_ON_NON_INTERVENTION_ARM')
    }
  }

  // B must be byte-identical to M except for harness identity.
  if (roles.M && roles.B && roles.B.configurationDigest !== roles.M.configurationDigest) {
    reasons.push('BASELINE_REFERENCE_CONFIGURATION_MISMATCH')
  }
  // I must not silently reuse the baseline configuration: if it is identical,
  // the intervention cannot have been applied to the harness configuration.
  if (roles.B && roles.I && roles.I.configurationDigest === roles.B.configurationDigest) {
    reasons.push('INTERVENTION_CONFIGURATION_NOT_DISTINCT')
  }
  // Model/provider parity across all roles.
  const models = new Set(EXPERIMENT_ROLES.map((role) => roles[role]!.requestedModel))
  const providers = new Set(EXPERIMENT_ROLES.map((role) => roles[role]!.requestedProvider))
  if (models.size > 1 || providers.size > 1) reasons.push('MODEL_PROVIDER_CONFIGURATION_MISMATCH')
  // Capability parity across all roles.
  try {
    const capDigests = new Set(EXPERIMENT_ROLES.map((role) => digest(normalizeCapabilities(roles[role]!.capabilities))))
    if (capDigests.size > 1) reasons.push('INVALID_CAPABILITY_MISMATCH')
  } catch {
    reasons.push('MISSING_CAPABILITY_MANIFEST')
  }
  return [...new Set(reasons)]
}

/** Validate one canonical v3 cell without discarding valid siblings. */
export function cellInvalidReasonsV3(cell: CellResultV3): string[] {
  const reasons: string[] = [...cell.invalidReasons]
  reasons.push(...preflightV3(cell.contract))
  if (cell.CONTRACT_DIGEST !== contractDigestV3(cell.contract)) reasons.push('CONTRACT_DIGEST_MISMATCH')
  const arm = cell.contract?.arms?.[cell.role]
  try {
    if (cell.CAPABILITY_DIGEST !== digest(normalizeCapabilities(cell.EFFECTIVE_CAPABILITY_MANIFEST)) || cell.CAPABILITY_DIGEST !== digest(normalizeCapabilities(arm.capabilities))) reasons.push('INVALID_CAPABILITY_MISMATCH')
  } catch {
    reasons.push('MISSING_CAPABILITY_MANIFEST')
  }
  const normal = cell.termination.kind === 'NORMAL'
  if (cell.REQUESTED_PROVIDER !== 'opencode-go' || ((normal || cell.OBSERVED_PROVIDER !== 'UNKNOWN') && cell.REQUESTED_PROVIDER !== cell.OBSERVED_PROVIDER) || cell.REQUESTED_PROVIDER !== arm?.requestedProvider) reasons.push('PROVIDER_MISMATCH')
  if (((normal || cell.OBSERVED_MODEL !== 'UNKNOWN') && cell.REQUESTED_MODEL !== cell.OBSERVED_MODEL) || cell.REQUESTED_MODEL !== arm?.requestedModel) reasons.push('MODEL_MISMATCH')
  if (cell.fallback === true || (normal && cell.fallback !== false)) reasons.push('FALLBACK_DETECTED_OR_UNKNOWN')
  if (cell.VERIFIER_ID !== cell.contract?.verifier?.id || cell.VERIFIER_DIGEST !== cell.contract?.verifier?.digest || digest(cell.VERIFIER_COMMAND) !== digest(cell.contract?.verifier?.command) || cell.VERIFIER_PRODUCER !== 'independent-evaluator' || cell.VERIFIER_RESULT === 'INVALID') reasons.push('INVALID_VERIFIER')
  // Intervention binding: the cell must echo the contract's intervention.
  const contractIntervention = arm?.intervention
  const cellIntervention = cell.intervention
  if (JSON.stringify(contractIntervention ?? null) !== JSON.stringify(cellIntervention ?? null)) reasons.push('INTERVENTION_BINDING_MISMATCH')
  return [...new Set(reasons)]
}

function established(cell: CellResultV3): boolean {
  return cell.attempted === true && cell.termination.kind === 'NORMAL' && cell.EXECUTION_SUCCESS === true && cell.TASK_CORRECTNESS !== 'UNKNOWN' && cell.VERIFIER_SUCCESS !== 'UNKNOWN'
}

function passed(cell: CellResultV3): boolean {
  return cell.TASK_CORRECTNESS === 'PASS' && cell.VERIFIER_SUCCESS === true
}

function pairwise(
  comparison: 'M_vs_B' | 'B_vs_I',
  reference: CellResultV3,
  candidate: CellResultV3,
): PairwiseVerdict {
  const reasons = [...cellInvalidReasonsV3(reference), ...cellInvalidReasonsV3(candidate)]
  if (reference.CONTRACT_DIGEST !== candidate.CONTRACT_DIGEST) reasons.push('PAIR_CONTRACT_MISMATCH')
  const unique = [...new Set(reasons)]
  let verdict: ExperimentVerdict = 'INCONCLUSIVE'
  if (unique.length) verdict = 'INVALID_COMPARISON'
  else if ([reference, candidate].every(established)) {
    const r = passed(reference)
    const c = passed(candidate)
    verdict = r === c ? 'TIE' : c ? 'CANDIDATE_SUPERIOR' : 'REFERENCE_SUPERIOR'
  }
  return {
    comparison,
    PAIR_VALIDITY: unique.includes('INVALID_CAPABILITY_MISMATCH') ? 'INVALID_COMPARISON' : unique.length ? 'INVALID_COMPARISON' : 'VALID',
    PAIR_VERDICT: verdict,
    reasons: unique,
  }
}

/**
 * Compare one M/B/I experiment: the M_vs_B pair establishes the harness
 * baseline; the B_vs_I pair isolates the single recorded intervention.
 * Timeouts and invalid cells never award a win.
 */
export function compareExperiment(cells: Record<ExperimentRole, CellResultV3>): ExperimentResult {
  const verdicts = [
    pairwise('M_vs_B', cells.M, cells.B),
    pairwise('B_vs_I', cells.B, cells.I),
  ]
  const reasons = [...new Set(verdicts.flatMap((v) => v.reasons))]
  let experiment: ExperimentVerdict
  if (verdicts.some((v) => v.PAIR_VERDICT === 'INVALID_COMPARISON')) experiment = 'INVALID_COMPARISON'
  else if (verdicts.some((v) => v.PAIR_VERDICT === 'INCONCLUSIVE')) experiment = 'INCONCLUSIVE'
  else {
    const baseline = verdicts[0]!.PAIR_VERDICT
    const intervention = verdicts[1]!.PAIR_VERDICT
    if (intervention === 'TIE' && baseline === 'TIE') experiment = 'TIE'
    else if (intervention === 'CANDIDATE_SUPERIOR') experiment = 'CANDIDATE_SUPERIOR'
    else if (intervention === 'REFERENCE_SUPERIOR') experiment = 'REFERENCE_SUPERIOR'
    else experiment = 'INCONCLUSIVE'
  }
  return {
    experimentId: cells.M.contract?.experimentId ?? 'UNKNOWN',
    VALIDITY: verdicts.some((v) => v.PAIR_VALIDITY !== 'VALID') ? 'INVALID_COMPARISON' : 'VALID',
    verdicts,
    EXPERIMENT_VERDICT: experiment,
    reasons,
  }
}

/** Content-address the contract (v3 digest domain, distinct from v2). */
export function contractDigestV3(contract: ExperimentContractV3): string {
  return createHash('sha256').update(canonical({ kind: 'babel_experiment_contract_v3', contract })).digest('hex')
}
