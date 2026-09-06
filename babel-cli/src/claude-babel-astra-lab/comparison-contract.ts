import { createHash } from 'node:crypto'

export type KnownResult = 'PASS' | 'FAIL' | 'UNKNOWN'
export type Metric = number | 'UNKNOWN'
export type Harness = 'claude-code' | 'babel-live'
export type Termination = 'NORMAL' | 'PROVIDER_TIMEOUT' | 'HARNESS_TIMEOUT' | 'RUNNER_TIMEOUT' | 'RUNNER_CANCELLED' | 'BUDGET_EXCEEDED' | 'PROCESS_HANG' | 'EXTERNAL_INTERRUPTION' | 'UNKNOWN_TIMEOUT' | 'UNKNOWN_FAILURE'
export interface CapabilityManifest {
  filesystem: { read: string[]; write: string[] }
  network: string[]
  process: string[]
  environment: string[]
  limits: { timeoutMs: number; modelCalls: number | null; toolCalls: number | null; outputTokens: number | null }
}
export interface ArmIdentity {
  harness: Harness
  version: string
  configurationDigest: string
  route: string
  requestedProvider: string
  requestedModel: string
  capabilities: CapabilityManifest
  capabilityEvidence: string[]
}
export interface PairContract {
  schemaVersion: 2
  experimentId: string
  pairId: string
  taskId: string
  fixtureSha: string
  baseSha: string
  runnerSha: string
  instructions: string
  verifier: { id: string; digest: string; command: string[] }
  arms: Record<Harness, ArmIdentity>
}
export interface CellResult {
  harness: Harness
  contract: PairContract
  CONTRACT_DIGEST: string
  RUNNER_SOURCE_DIGEST?: string
  EFFECTIVE_CAPABILITY_MANIFEST: CapabilityManifest
  CAPABILITY_DIGEST: string
  REQUESTED_PROVIDER: string
  REQUESTED_MODEL: string
  OBSERVED_PROVIDER: string
  OBSERVED_MODEL: string
  fallback: boolean | 'UNKNOWN'
  attempted: boolean
  invalidReasons: string[]
  EXECUTION_SUCCESS: boolean | 'UNKNOWN'
  VERIFIER_SUCCESS: boolean | 'UNKNOWN'
  TASK_CORRECTNESS: KnownResult
  HARNESS_EFFECT: 'INCONCLUSIVE' | 'CONTROLLED_DIFFERENCE'
  VERIFIER_ID: string
  VERIFIER_DIGEST: string
  VERIFIER_COMMAND: string[]
  VERIFIER_RESULT: 'PASS' | 'FAIL' | 'INVALID' | 'UNKNOWN'
  VERIFIER_PRODUCER: string
  termination: { kind: Termination; evidence: string[] }
  FAILURES_ENCOUNTERED: Array<{ category: string; diagnostic: string; action?: string }>
  ACTIONABLE_DIAGNOSTICS_OBSERVED: boolean | 'UNKNOWN'
  RETRIES: Metric
  RECOVERY_SUCCESS: boolean | 'UNKNOWN'
  CAUSE_IDENTIFICATION: KnownResult
  metrics: { wallTimeMs: Metric; modelCalls: Metric; toolCalls: Metric; inputTokens: Metric; outputTokens: Metric; cost: Metric }
  changedFiles: string[]
  evidence: { packet: string; trajectory: string; receipt: string; verifier: string }
}
export interface PairResult {
  pairId: string
  PAIR_VALIDITY: string
  PAIR_VERDICT: 'CLAUDE_WIN' | 'BABEL_WIN' | 'TIE' | 'INCONCLUSIVE' | 'INVALID_COMPARISON'
  reasons: string[]
  claude: CellResult
  babel: CellResult
}

/** Canonical serialization binds definitions, independent of object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
/** Hash a complete immutable experiment definition. */
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

/** Normalize authority sets; tool names are deliberately absent. */
export function normalizeCapabilities(m: CapabilityManifest): CapabilityManifest {
  const set = (v: string[]): string[] => [...new Set(v)].sort()
  return { filesystem: { read: set(m.filesystem.read), write: set(m.filesystem.write) }, network: set(m.network), process: set(m.process), environment: set(m.environment), limits: { ...m.limits } }
}
const sha = (v: unknown): boolean => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v)
const known = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v !== 'UNKNOWN'

/** Cell-local preflight. No credential reads, executables, or provider calls. */
export function preflight(contract: PairContract, harness: Harness): string[] {
  const reasons: string[] = []
  if (!contract || contract.schemaVersion !== 2) return ['INVALID_CONTRACT']
  for (const field of ['experimentId', 'pairId', 'taskId', 'instructions'] as const) if (!known(contract[field])) reasons.push(`MISSING_${field}`)
  for (const field of ['fixtureSha', 'baseSha', 'runnerSha'] as const) if (!sha(contract[field])) reasons.push(`MISSING_${field}`)
  if (!known(contract.verifier?.id) || !sha(contract.verifier?.digest) || !Array.isArray(contract.verifier?.command) || !contract.verifier.command.length || contract.verifier.command.some(v => !known(v))) reasons.push('MISSING_VERIFIER')
  const arm = contract.arms?.[harness]
  if (!arm) return [...reasons, 'MISSING_HARNESS']
  if (arm.harness !== harness || !known(arm.version) || !sha(arm.configurationDigest)) reasons.push('AMBIGUOUS_HARNESS_IDENTITY')
  if (harness === 'babel-live' && !/^[a-f0-9]{40}$/i.test(arm.version)) reasons.push('MISSING_BABEL_SHA')
  if (!known(arm.route)) reasons.push('MISSING_ROUTE')
  if (arm.requestedProvider !== 'opencode-go') reasons.push('PROVIDER_MISMATCH')
  if (!['mimo-v2.5', 'longcat-2.0', 'deepseek-v4-flash'].includes(arm.requestedModel)) reasons.push('MODEL_MISMATCH')
  if (!Array.isArray(arm.capabilityEvidence) || !arm.capabilityEvidence.length || arm.capabilityEvidence.some(v => !known(v))) reasons.push('MISSING_CAPABILITY_EVIDENCE')
  const caps = arm.capabilities
  if (!caps?.filesystem || !Array.isArray(caps.filesystem.read) || !Array.isArray(caps.filesystem.write) || !Array.isArray(caps.network) || !Array.isArray(caps.process) || !Array.isArray(caps.environment) || !caps.limits) return [...reasons, 'MISSING_CAPABILITY_MANIFEST']
  if ([...caps.filesystem.read, ...caps.filesystem.write, ...caps.network, ...caps.process, ...caps.environment].some(v => !known(v))) reasons.push('UNKNOWN_CAPABILITY')
  if (!(Number.isFinite(caps.limits.timeoutMs) && caps.limits.timeoutMs > 0)) reasons.push('INVALID_RESOURCE_ENVELOPE')
  for (const key of ['modelCalls', 'toolCalls', 'outputTokens'] as const) if (caps.limits[key] !== null && (!Number.isInteger(caps.limits[key]) || Number(caps.limits[key]) <= 0)) reasons.push('INVALID_RESOURCE_ENVELOPE')
  const other = contract.arms[harness === 'claude-code' ? 'babel-live' : 'claude-code']
  if (other) {
    if (arm.requestedModel !== other.requestedModel || arm.requestedProvider !== other.requestedProvider) reasons.push('MODEL_PROVIDER_CONFIGURATION_MISMATCH')
    try {
      if (digest(normalizeCapabilities(caps)) !== digest(normalizeCapabilities(other.capabilities))) reasons.push('INVALID_CAPABILITY_MISMATCH')
    } catch { reasons.push('MISSING_CAPABILITY_MANIFEST') }
  }
  return [...new Set(reasons)]
}

/** Validate one canonical result without discarding a valid sibling cell. */
export function cellInvalidReasons(cell: CellResult): string[] {
  const reasons: string[] = [...cell.invalidReasons]
  reasons.push(...preflight(cell.contract, cell.harness))
  if (cell.CONTRACT_DIGEST !== digest(cell.contract)) reasons.push('CONTRACT_DIGEST_MISMATCH')
  const arm = cell.contract?.arms?.[cell.harness]
  try {
    if (cell.CAPABILITY_DIGEST !== digest(normalizeCapabilities(cell.EFFECTIVE_CAPABILITY_MANIFEST)) || cell.CAPABILITY_DIGEST !== digest(normalizeCapabilities(arm.capabilities))) reasons.push('INVALID_CAPABILITY_MISMATCH')
  } catch { reasons.push('MISSING_CAPABILITY_MANIFEST') }
  const normal = cell.termination.kind === 'NORMAL'
  if (cell.REQUESTED_PROVIDER !== 'opencode-go' || ((normal || cell.OBSERVED_PROVIDER !== 'UNKNOWN') && cell.REQUESTED_PROVIDER !== cell.OBSERVED_PROVIDER) || cell.REQUESTED_PROVIDER !== arm?.requestedProvider) reasons.push('PROVIDER_MISMATCH')
  if (((normal || cell.OBSERVED_MODEL !== 'UNKNOWN') && cell.REQUESTED_MODEL !== cell.OBSERVED_MODEL) || cell.REQUESTED_MODEL !== arm?.requestedModel) reasons.push('MODEL_MISMATCH')
  if (cell.fallback === true || (normal && cell.fallback !== false)) reasons.push('FALLBACK_DETECTED_OR_UNKNOWN')
  if (cell.VERIFIER_ID !== cell.contract?.verifier?.id || cell.VERIFIER_DIGEST !== cell.contract?.verifier?.digest || digest(cell.VERIFIER_COMMAND) !== digest(cell.contract?.verifier?.command) || cell.VERIFIER_PRODUCER !== 'independent-evaluator' || cell.VERIFIER_RESULT === 'INVALID') reasons.push('INVALID_VERIFIER')

  return [...new Set(reasons)]
}

/** Compare only bound, independently evaluated cells; timeouts never award a win. */
export function compareCells(claude: CellResult, babel: CellResult): PairResult {
  const reasons = [...cellInvalidReasons(claude), ...cellInvalidReasons(babel)]
  if (claude.harness !== 'claude-code' || babel.harness !== 'babel-live') reasons.push('HARNESS_MISMATCH')
  if (claude.CONTRACT_DIGEST !== babel.CONTRACT_DIGEST) reasons.push('PAIR_CONTRACT_MISMATCH')
  const unique = [...new Set(reasons)]
  let verdict: PairResult['PAIR_VERDICT'] = 'INCONCLUSIVE'
  if (unique.length) verdict = 'INVALID_COMPARISON'
  else if ([claude, babel].every(c => c.attempted && c.termination.kind === 'NORMAL' && c.EXECUTION_SUCCESS === true && c.TASK_CORRECTNESS !== 'UNKNOWN' && c.VERIFIER_SUCCESS !== 'UNKNOWN')) {
    const c = claude.TASK_CORRECTNESS === 'PASS' && claude.VERIFIER_SUCCESS === true
    const b = babel.TASK_CORRECTNESS === 'PASS' && babel.VERIFIER_SUCCESS === true
    verdict = c === b ? 'TIE' : c ? 'CLAUDE_WIN' : 'BABEL_WIN'
  }
  return { pairId: claude.contract?.pairId ?? 'UNKNOWN', PAIR_VALIDITY: unique.includes('INVALID_CAPABILITY_MISMATCH') ? 'INVALID_CAPABILITY_MISMATCH' : unique.length ? 'INVALID_COMPARISON' : 'VALID', PAIR_VERDICT: verdict, reasons: unique, claude, babel }
}
