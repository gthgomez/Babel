/**
 * Compact, invalidatable WorkingState injected each turn. Compaction must
 * preserve this block; stale failures are not authoritative after new evidence.
 */

import type { ChatMessage } from '../chatToolDefinitions.js'
import type { FailureSurface, RepairDiagnosis, RepairDiagnosisKind } from './failureSurface.js'

export const WORKING_STATE_NAME = 'working_state'
export const WORKING_STATE_MARKER = '<!-- BABEL_WORKING_STATE -->'

/** Frozen identity of the failed candidate, supplied by the controller. */
export interface RecoveryCandidateBinding {
  schemaVersion: 1
  taskId: string
  contractHash: string
  repositoryIdentity: string
  workspaceRevision: string
}

export interface WorkingState {
  goal: string
  currentHypothesis: string
  evidence: string[]
  filesOfInterest: string[]
  lastMutation?: { path: string; at: number; fingerprint?: string }
  lastVerifier?: { identity: string; exitCode: number; summary: string; fresh: boolean }
  failureSurface?: FailureSurface
  /** Controller-captured red result observed before any mutation in this task. */
  baselineFailureSignature?: string
  repairDiagnosis?: RepairDiagnosis
  openQuestions: string[]
  invalidatedAssumptions: string[]
  nextExperiment: string
  /**
   * Observation keys already consumed to clear a recovery gate, scoped to the
   * failure signature they addressed. Re-observing the same target for the same
   * failure is not new discriminating evidence, even across gate recreation.
   */
  consumedRecoveryEvidence: string[]
  /** Controller-owned gate after a red verifier; model prose cannot clear it. */
  recoveryGate?: {
    failureSignature: string
    binding?: RecoveryCandidateBinding
    requiredEvidence: string
    mutationFingerprint?: string
    /**
     * Concrete targets implicated by the failure (failing files and the
     * mutation target). Discriminating evidence must localize one of these.
     */
    failingTargets?: string[]
    /**
     * Gate-scoped set of accepted observation keys. This is deliberately
     * separate from the capped `evidence` list so that evidence churn cannot
     * resurrect an already-consumed observation.
     */
    observedKeys?: string[]
    hypothesisAtFailure: string
    strategyAtFailure?: string
    satisfied: boolean
    strategyChanged: boolean
  }
  revision: number
}

export function createWorkingState(goal = ''): WorkingState {
  return {
    goal,
    currentHypothesis: '',
    evidence: [],
    filesOfInterest: [],
    openQuestions: [],
    invalidatedAssumptions: [],
    nextExperiment: '',
    consumedRecoveryEvidence: [],
    revision: 0,
  }
}

/**
 * Tools whose output carries inspectable content and can therefore localize a
 * failure. Directory listings and globs are deliberately excluded.
 */
export const RECOVERY_EVIDENCE_TOOLS = [
  'read_file',
  'read_range',
  'grep',
  'semantic_search',
] as const

/**
 * Controller-owned provenance for an observation that claims to be
 * discriminating. A bare `discriminating: true` boolean is not authority: the
 * reducer additionally requires this record to agree with the live recovery
 * gate's failure signature. The provenance is produced by the controller from
 * the tool identity and the failure surface, never by model prose.
 */
export interface RecoveryEvidenceProvenance {
  /** Tool that produced the observation (one of `RECOVERY_EVIDENCE_TOOLS`). */
  tool: string
  /** Concrete file/range the observation inspected. */
  target: string
  /** Failure signature the observation is claimed to discriminate. */
  failureSignature: string
  /** Workspace revision the observation was taken against, when known. */
  revision?: string
  binding?: RecoveryCandidateBinding
  /** Digest of the actual inspected content, independent of tool-call ID. */
  observationDigest?: string
}

export type WorkingStateEvent =
  | { type: 'set_goal'; goal: string }
  | { type: 'set_hypothesis'; hypothesis: string; evidence?: string[] }
  | {
      type: 'add_evidence'
      evidence: string
      file?: string
      discriminating?: boolean
      provenance?: RecoveryEvidenceProvenance
    }
  | { type: 'recovery_strategy'; strategy: string; evidence?: string[] }
  | { type: 'mutation'; path: string; fingerprint?: string }
  | { type: 'verifier'; identity: string; exitCode: number; summary: string }
  | { type: 'failure_surface'; surface: FailureSurface }
  | { type: 'diagnosis'; diagnosis: RepairDiagnosis }
  | { type: 'invalidate'; assumption: string }
  | { type: 'next_experiment'; experiment: string }
  | { type: 'recovery_candidate_drift' }
  | {
      type: 'recovery_gate'
      failureSignature: string
      requiredEvidence: string
      mutationFingerprint?: string
      failingTargets?: string[]
      hypothesisAtFailure?: string
      binding?: RecoveryCandidateBinding
    }

/**
 * Apply an event. New evidence invalidates a stale red verifier and drops
 * an obsolete failure surface when the signature changes.
 */
export function applyWorkingStateEvent(state: WorkingState, event: WorkingStateEvent): WorkingState {
  const next: WorkingState = {
    ...state,
    evidence: [...state.evidence],
    filesOfInterest: [...state.filesOfInterest],
    openQuestions: [...state.openQuestions],
    invalidatedAssumptions: [...state.invalidatedAssumptions],
    consumedRecoveryEvidence: [...state.consumedRecoveryEvidence],
    ...(state.recoveryGate && !state.recoveryGate.binding
      ? { recoveryGate: { ...state.recoveryGate, satisfied: false, strategyChanged: false } }
      : {}),
    revision: state.revision + 1,
  }

  switch (event.type) {
    case 'set_goal':
      next.goal = event.goal
      break
    case 'set_hypothesis':
      if (state.currentHypothesis && state.currentHypothesis !== event.hypothesis) {
        next.invalidatedAssumptions = pushUnique(
          next.invalidatedAssumptions,
          `hypothesis:${state.currentHypothesis}`,
        )
      }
      next.currentHypothesis = event.hypothesis
      if (event.evidence) next.evidence = pushAll(next.evidence, event.evidence)
      if (
        next.recoveryGate?.satisfied &&
        event.hypothesis.trim() !== '' &&
        event.hypothesis !== next.recoveryGate.hypothesisAtFailure
      ) {
        next.recoveryGate = { ...next.recoveryGate, strategyChanged: true }
      }
      break
    case 'add_evidence': {
      next.evidence = pushUnique(next.evidence, event.evidence)
      if (event.file) next.filesOfInterest = pushUnique(next.filesOfInterest, event.file)
      if (next.lastVerifier && !next.lastVerifier.fresh) {
        next.lastVerifier = { ...next.lastVerifier, fresh: false }
      }
      const gate = next.recoveryGate
      if (gate && !gate.satisfied && event.discriminating === true) {
        // A boolean claim is not authority. The observation must carry
        // provenance that agrees with the gate's frozen failure signature and
        // must not already have been consumed for this gate.
        const provenance = event.provenance
        const observationKey = provenance?.binding && provenance.observationDigest
          ? recoveryEvidenceKey(provenance, gate.failureSignature)
          : ''
        const alreadyObserved =
          (observationKey !== '' && (gate.observedKeys ?? []).includes(observationKey)) ||
          (observationKey !== '' && next.consumedRecoveryEvidence.includes(observationKey))
        const bound =
          gate.binding !== undefined &&
          provenance !== undefined &&
          provenance.binding !== undefined &&
          sameRecoveryBinding(gate.binding, provenance.binding) &&
          typeof provenance.observationDigest === 'string' &&
          provenance.observationDigest.length > 0 &&
          provenance.failureSignature === gate.failureSignature &&
          provenance.failureSignature.length > 0 &&
          (RECOVERY_EVIDENCE_TOOLS as readonly string[]).includes(provenance.tool) &&
          provenance.target.trim().length > 0 &&
          targetMatchesGate(provenance.target, gate.failingTargets) &&
          !alreadyObserved
        if (bound) {
          next.recoveryGate = {
            ...gate,
            satisfied: true,
            observedKeys: [...(gate.observedKeys ?? []), observationKey].slice(-64),
          }
          next.consumedRecoveryEvidence = next.consumedRecoveryEvidence.includes(observationKey)
            ? next.consumedRecoveryEvidence
            : [...next.consumedRecoveryEvidence, observationKey]
        }
      }
      break
    }
    case 'mutation':
      if (next.recoveryGate) {
        next.recoveryGate = { ...next.recoveryGate, satisfied: false, strategyChanged: false }
      }
      next.lastMutation = {
        path: event.path,
        at: Date.now(),
        ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
      }
      next.filesOfInterest = pushUnique(next.filesOfInterest, event.path)
      if (next.lastVerifier) {
        next.lastVerifier = { ...next.lastVerifier, fresh: false }
      }
      break
    case 'recovery_candidate_drift':
      if (next.recoveryGate) {
        next.recoveryGate = { ...next.recoveryGate, satisfied: false, strategyChanged: false }
        next.nextExperiment = 'The failed candidate changed. Rerun the verifier before acquiring recovery evidence.'
      }
      break
    case 'verifier':
      next.lastVerifier = {
        identity: event.identity,
        exitCode: event.exitCode,
        summary: event.summary,
        fresh: true,
      }
      if (event.exitCode === 0) {
        delete next.failureSurface
        delete next.recoveryGate
      }
      break
    case 'failure_surface':
      if (
        state.failureSurface &&
        state.failureSurface.errorSignature !== event.surface.errorSignature
      ) {
        next.invalidatedAssumptions = pushUnique(
          next.invalidatedAssumptions,
          `failure:${state.failureSurface.errorSignature}`,
        )
      }
      next.failureSurface = event.surface
      if (
        !next.lastMutation &&
        next.baselineFailureSignature === undefined &&
        ['TEST_FAILURE', 'TYPECHECK_FAILURE', 'BUILD_FAILURE', 'LINT_FAILURE', 'RUNTIME_FAILURE'].includes(event.surface.kind)
      ) {
        next.baselineFailureSignature = event.surface.errorSignature
      }
      break
    case 'diagnosis':
      next.repairDiagnosis = event.diagnosis
      next.currentHypothesis = event.diagnosis.hypothesis || next.currentHypothesis
      next.nextExperiment = event.diagnosis.nextExperiment
      break
    case 'invalidate':
      next.invalidatedAssumptions = pushUnique(next.invalidatedAssumptions, event.assumption)
      if (next.failureSurface && event.assumption.includes(next.failureSurface.errorSignature)) {
        delete next.failureSurface
      }
      if (event.assumption.startsWith('hypothesis:')) {
        next.currentHypothesis = ''
      }
      break
    case 'next_experiment':
      next.nextExperiment = event.experiment
      break
    case 'recovery_gate':
      next.recoveryGate = {
        failureSignature: event.failureSignature,
        ...(event.binding ? { binding: event.binding } : {}),
        requiredEvidence: event.requiredEvidence,
        ...(event.mutationFingerprint ? { mutationFingerprint: event.mutationFingerprint } : {}),
        ...(event.failingTargets && event.failingTargets.length > 0
          ? { failingTargets: [...event.failingTargets] }
          : {}),
        observedKeys: [],
        hypothesisAtFailure: event.hypothesisAtFailure ?? next.currentHypothesis,
        strategyAtFailure: next.currentHypothesis,
        satisfied: false,
        strategyChanged: false,
      }
      next.nextExperiment = event.requiredEvidence
      break
    case 'recovery_strategy':
      if (event.evidence) next.evidence = pushAll(next.evidence, event.evidence)
      next.nextExperiment = event.strategy
      if (
        next.recoveryGate?.satisfied &&
        event.strategy.trim() !== '' &&
        event.strategy !== (next.recoveryGate.strategyAtFailure ?? next.recoveryGate.hypothesisAtFailure)
      ) {
        next.recoveryGate = {
          ...next.recoveryGate,
          strategyAtFailure: event.strategy,
          strategyChanged: true,
        }
      }
      break
  }
  return next
}

/**
 * Record a controller-owned strategy revision after accepted discriminating
 * evidence. This is separate from model hypothesis prose: only a novel,
 * relevant target can open this transition, and it makes no claim about
 * semantic equivalence of repair attempts.
 */
export function recordControllerRecoveryStrategy(
  state: WorkingState,
  input: { target: string; evidence: string },
): WorkingState {
  if (!state.recoveryGate?.satisfied || state.recoveryGate.strategyChanged) return state
  return applyWorkingStateEvent(state, {
    type: 'recovery_strategy',
    strategy: `controller-investigate:${input.target}`,
    evidence: [input.evidence],
  })
}

/**
 * Compact YAML-like block for model injection.
 */
export function formatWorkingStateBlock(state: WorkingState): string {
  const lines = [
    WORKING_STATE_MARKER,
    'working_state:',
    `  goal: ${yamlScalar(state.goal)}`,
    `  current_hypothesis: ${yamlScalar(state.currentHypothesis)}`,
    `  evidence: ${yamlList(state.evidence, 6)}`,
    `  files_of_interest: ${yamlList(state.filesOfInterest, 8)}`,
    `  last_mutation: ${state.lastMutation ? yamlScalar(`${state.lastMutation.path}`) : 'none'}`,
    `  last_verifier: ${
      state.lastVerifier
        ? yamlScalar(
            `${state.lastVerifier.identity} exit=${state.lastVerifier.exitCode} fresh=${state.lastVerifier.fresh} ${state.lastVerifier.summary}`,
          )
        : 'none'
    }`,
    `  failure_surface: ${state.failureSurface ? state.failureSurface.kind : 'none'}`,
    `  failure_causality: ${state.failureSurface?.causality ?? 'unknown'}`,
    `  baseline_failure_signature: ${state.baselineFailureSignature ?? 'none'}`,
    `  repair_diagnosis: ${state.repairDiagnosis ? state.repairDiagnosis.kind : 'none'}`,
    `  open_questions: ${yamlList(state.openQuestions, 4)}`,
    `  invalidated_assumptions: ${yamlList(state.invalidatedAssumptions, 4)}`,
    `  next_experiment: ${yamlScalar(state.nextExperiment)}`,
  ]
  if (state.recoveryGate) {
    lines.push(
      `  recovery_gate: ${state.recoveryGate.satisfied ? 'satisfied' : 'evidence_required'}`,
      `  recovery_evidence: ${yamlScalar(state.recoveryGate.requiredEvidence)}`,
      `  recovery_strategy: ${state.recoveryGate.strategyChanged ? 'changed' : 'unchanged'}`,
    )
  }
  if (state.lastVerifier && !state.lastVerifier.fresh) {
    lines.push('  note: last_verifier is stale after newer evidence/mutation — do not treat as current')
  }
  return lines.join('\n')
}

/**
 * Insert or replace the working-state conversation message.
 */
export function upsertWorkingStateMessage(
  messages: ChatMessage[],
  state: WorkingState,
): ChatMessage[] {
  const content = formatWorkingStateBlock(state)
  const existing = messages.findIndex(
    (m) => m.name === WORKING_STATE_NAME || (typeof m.content === 'string' && m.content.includes(WORKING_STATE_MARKER)),
  )
  // WorkingState contains controller facts plus model-proposed reasoning. Keep
  // it out of the system-authority role and mark it explicitly advisory.
  const msg: ChatMessage = {
    role: 'assistant',
    name: WORKING_STATE_NAME,
    content,
    provenance: 'mixed',
    authoritative: false,
  }
  if (existing >= 0) {
    const copy = messages.slice()
    copy[existing] = msg
    return copy
  }
  const systemIdx = messages.findIndex((m) => m.role === 'system')
  if (systemIdx >= 0) {
    const copy = messages.slice()
    copy.splice(systemIdx + 1, 0, msg)
    return copy
  }
  return [msg, ...messages]
}

/**
 * Compaction helper: keep the working-state message even when old turns drop.
 */
export function preserveWorkingStateMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.name === WORKING_STATE_NAME || (typeof m.content === 'string' && m.content.includes(WORKING_STATE_MARKER)),
  )
}

export function isWorkingStateMessage(message: ChatMessage): boolean {
  return (
    message.name === WORKING_STATE_NAME ||
    (typeof message.content === 'string' && message.content.includes(WORKING_STATE_MARKER))
  )
}

export function diagnosisFromModel(input: {
  kind?: string
  hypothesis: string
  evidence?: string[]
  nextExperiment?: string
  missingEvidence?: string[]
}): RepairDiagnosis {
  const kind = (REPAIR_SET.has(input.kind ?? '') ? input.kind : 'UNKNOWN_DIAGNOSIS') as RepairDiagnosisKind
  return {
    kind,
    hypothesis: input.hypothesis,
    evidence: input.evidence ?? [],
    missingEvidence: input.missingEvidence ?? [],
    nextExperiment: input.nextExperiment ?? '',
  }
}

const REPAIR_SET = new Set<string>([
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
])

/**
 * Normalize a repository-relative target for gate membership checks. `"."` and
 * empty values are never concrete targets, regardless of the failing set.
 */
function normalizeTarget(value: string): string {
  const raw = value.replaceAll('\\', '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return ''
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

export function sameRecoveryBinding(a: RecoveryCandidateBinding, b: RecoveryCandidateBinding): boolean {
  return a.schemaVersion === 1 && b.schemaVersion === 1 &&
    a.taskId.length > 0 && a.taskId === b.taskId &&
    a.contractHash.length > 0 && a.contractHash === b.contractHash &&
    a.repositoryIdentity.length > 0 && a.repositoryIdentity === b.repositoryIdentity &&
    a.workspaceRevision.length > 0 && a.workspaceRevision === b.workspaceRevision
}

/**
 * Identity of an observation for recovery-gate dedup. Scoping by failure
 * signature lets a genuinely new failure re-use an inspection while rejecting
 * repeated reads of the same target for the same failure.
 */
export function recoveryEvidenceKey(provenance: RecoveryEvidenceProvenance, failureSignature: string): string {
  const binding = provenance.binding
  const target = normalizeTarget(provenance.target)
  if (!binding || !target || !provenance.observationDigest) return ''
  return JSON.stringify([
    1, failureSignature, binding.taskId, binding.contractHash,
    binding.repositoryIdentity, binding.workspaceRevision, provenance.tool,
    target, provenance.observationDigest,
  ])
}

/**
 * Whether an inspected target localizes one of the gate's failing targets. An
 * absent/empty failing set fails closed (there is nothing to localize, so the
 * observation cannot be discriminating). The inspected target must name the
 * failing file itself or a path inside it; naming an ancestor directory is a
 * repository-wide search, not a localization.
 */
export function targetMatchesGate(target: string, failingTargets?: string[]): boolean {
  const candidate = normalizeTarget(target)
  if (!candidate || candidate === '.') return false
  if (!failingTargets || failingTargets.length === 0) return false
  return failingTargets.some((raw) => {
    const known = normalizeTarget(raw)
    if (!known) return false
    return candidate === known || candidate.startsWith(`${known}/`)
  })
}

function pushUnique(list: string[], value: string): string[] {
  if (!value || list.includes(value)) return list
  // Generous bound: the recovery-observation ledger must not evict a consumed
  // key under ordinary evidence churn. Rendering already truncates for display.
  return [...list, value].slice(-96)
}

function pushAll(list: string[], values: string[]): string[] {
  let next = list
  for (const v of values) next = pushUnique(next, v)
  return next
}

function yamlScalar(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim()
  if (!v) return '""'
  if (/[:#\n]/.test(v) || v.length > 80) return JSON.stringify(v.slice(0, 240))
  return v
}

function yamlList(values: string[], max: number): string {
  if (values.length === 0) return '[]'
  return `[${values.slice(0, max).map((v) => yamlScalar(v)).join(', ')}]`
}
