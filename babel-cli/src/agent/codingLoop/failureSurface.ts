/**
 * Deterministic FailureSurface classification from compiled observations.
 * Does not infer WRONG_HYPOTHESIS from regex — that belongs to RepairDiagnosis.
 */

import type { CompiledObservation } from './observationCompiler.js'

export const FAILURE_SURFACES = [
  'TEST_FAILURE',
  'TYPECHECK_FAILURE',
  'BUILD_FAILURE',
  'LINT_FAILURE',
  'RUNTIME_FAILURE',
  'DEPENDENCY_FAILURE',
  'BASELINE_FAILURE',
  'ENVIRONMENT_FAILURE',
  'TOOL_FAILURE',
  'PROVIDER_FAILURE',
  'POLICY_FAILURE',
  'UNKNOWN_FAILURE',
] as const

export type FailureSurfaceKind = (typeof FAILURE_SURFACES)[number]

export const REPAIR_DIAGNOSES = [
  'IMPLEMENTATION_DEFECT',
  'WRONG_HYPOTHESIS',
  'INCOMPLETE_LOCALIZATION',
  'TEST_EXPECTATION_MISUNDERSTOOD',
  'WRONG_TARGET_FILE',
  'WRONG_API_ASSUMPTION',
  'REGRESSION_OUTSIDE_TARGET',
  'BASELINE_MISUNDERSTOOD',
  'BUILD_CONFIGURATION_MISUNDERSTOOD',
  'UNKNOWN_DIAGNOSIS',
] as const

export type RepairDiagnosisKind = (typeof REPAIR_DIAGNOSES)[number]

export interface FailureSurface {
  kind: FailureSurfaceKind
  errorSignature: string
  failingTests: string[]
  failingFiles: string[]
  exitCode: number
  verifierId?: string
  workspaceRevision?: string
  changedSincePrevious: boolean
  evidenceRefs: string[]
}

export interface RepairDiagnosis {
  kind: RepairDiagnosisKind
  hypothesis: string
  evidence: string[]
  falsifier?: string
  missingEvidence: string[]
  nextExperiment: string
}

/**
 * Classify a compiled observation into a deterministic failure surface.
 */
export function classifyFailureSurface(input: {
  observation: CompiledObservation
  previousSignature?: string
  knownBaselineSignature?: string
  verifierId?: string
  workspaceRevision?: string
}): FailureSurface {
  const obs = input.observation
  const kind = surfaceFromObservation(obs, input.knownBaselineSignature)
  const failingTests = obs.failures.map((f) => f.test).filter((t): t is string => Boolean(t))
  const failingFiles = obs.failures.map((f) => f.file).filter((f): f is string => Boolean(f))
  const errorSignature = buildErrorSignature(kind, obs)
  return {
    kind,
    errorSignature,
    failingTests,
    failingFiles,
    exitCode: obs.exitCode,
    ...(input.verifierId !== undefined ? { verifierId: input.verifierId } : {}),
    ...(input.workspaceRevision !== undefined ? { workspaceRevision: input.workspaceRevision } : {}),
    changedSincePrevious:
      input.previousSignature !== undefined && input.previousSignature !== errorSignature,
    evidenceRefs: [
      ...(obs.rawSpillPath ? [obs.rawSpillPath] : []),
      ...failingFiles.slice(0, 6),
    ],
  }
}

/**
 * Whether two surfaces share the same error signature (no new evidence).
 */
export function isRepeatedSameError(
  previous: FailureSurface | undefined,
  next: FailureSurface,
): boolean {
  if (!previous) return false
  return previous.errorSignature === next.errorSignature && previous.kind === next.kind
}

function surfaceFromObservation(
  obs: CompiledObservation,
  knownBaselineSignature?: string,
): FailureSurfaceKind {
  const blob = `${obs.tool} ${obs.target} ${obs.command ?? ''} ${obs.summary} ${obs.stderrHead} ${obs.stdoutHead}`.toLowerCase()
  const parser = obs.parserName ?? ''

  if (obs.exitCode === 0) return 'UNKNOWN_FAILURE'

  if (knownBaselineSignature && buildErrorSignature('BASELINE_FAILURE', obs) === knownBaselineSignature) {
    return 'BASELINE_FAILURE'
  }

  if (/policy blocked|permission denied|not allowed|sandbox/i.test(blob)) {
    return 'POLICY_FAILURE'
  }
  if (/econnreset|enotfound|api key|rate limit|provider|401|403/i.test(blob) && /provider|model|llm/i.test(blob)) {
    return 'PROVIDER_FAILURE'
  }
  if (/enoent|command not found|not recognized as an internal|no such file or directory.*bin/i.test(blob)) {
    return 'ENVIRONMENT_FAILURE'
  }
  if (/cannot find module|modulenotfound|npm err!|yarn error|pnpm err|unresolved dependency/i.test(blob)) {
    return 'DEPENDENCY_FAILURE'
  }
  if (parser === 'tsc' || /error ts\d+/i.test(blob)) {
    return 'TYPECHECK_FAILURE'
  }
  if (parser === 'jest_vitest' || parser === 'pytest' || parser === 'go' || /failing|tests failed|failed \d+/i.test(blob)) {
    if (/eslint|lint error|ruff_|clippy/i.test(blob)) return 'LINT_FAILURE'
    return 'TEST_FAILURE'
  }
  if (parser === 'cargo' && /error\[e\d+\]/i.test(blob)) {
    return 'BUILD_FAILURE'
  }
  if (/eslint|lint error|prettier|ruff /i.test(blob)) {
    return 'LINT_FAILURE'
  }
  if (/build failed|compilation error|cargo build|gradle|mvn |webpack/i.test(blob)) {
    return 'BUILD_FAILURE'
  }
  if (parser === 'node_trace' || /typeerror|referenceerror|panic|segfault/i.test(blob)) {
    return 'RUNTIME_FAILURE'
  }
  if (/tool failed|unknown tool|invalid tool/i.test(blob)) {
    return 'TOOL_FAILURE'
  }
  return 'UNKNOWN_FAILURE'
}

function buildErrorSignature(kind: FailureSurfaceKind, obs: CompiledObservation): string {
  const failKey = obs.failures
    .slice(0, 6)
    .map((f) => `${f.file ?? ''}:${f.line ?? ''}:${f.test ?? ''}:${f.message}`)
    .join('|')
  return `${kind}|exit=${obs.exitCode}|parser=${obs.parserName ?? 'none'}|${failKey || obs.summary}`
}
