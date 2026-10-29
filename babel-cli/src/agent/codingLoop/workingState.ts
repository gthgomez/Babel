import { validFailedVerifierExecution, type SettledFailedVerifierExecution } from './failedVerifierExecution.js'
/**
 * Compact, invalidatable WorkingState injected each turn. Compaction must
 * preserve this block; stale failures are not authoritative after new evidence.
 */

import { isReadDeliveryWindow, type ReadDeliveryWindow } from '../../services/readDelivery.js'
import type { ChatMessage } from '../chatToolDefinitions.js'
import { createHash } from 'node:crypto'
import type { FailureSurface, RepairDiagnosis, RepairDiagnosisKind } from './failureSurface.js'
import type { AdmittedRecoveryPlanV1 } from './recoveryPlan.js'
import type { FailureLocalization } from './failureLocalization.js'

export const WORKING_STATE_NAME = 'working_state'
export const WORKING_STATE_MARKER = '<!-- BABEL_WORKING_STATE -->'

/** Frozen identity of the failed candidate, supplied by the controller. */
export interface RecoveryCandidateBinding {
  schemaVersion: 2
  taskId: string
  contractHash: string
  sessionId: string
  repositoryIdentity: string
  workspaceRevision: string
  /** Hash of host-owned execution policy/runtime identity; never raw env values. */
  executionContextHash: string
}

export interface WorkingState {
  goal: string
  currentHypothesis: string
  evidence: string[]
  filesOfInterest: string[]
  lastMutation?: { path: string; at: number; fingerprint?: string; canonicalFingerprint?: string }
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
  failedVerifierHistory?: SettledFailedVerifierExecution[]
  failedVerifierHistoryOverflow?: true
  settledFailedVerifier?: SettledFailedVerifierExecution
  lastAdmittedPlan?: AdmittedRecoveryPlanV1
  localization?: FailureLocalization
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
    /** Current-episode delivered reads, bounded independently from progress history. */
    readRecords?: RecoveryReadRecord[]
    hypothesisAtFailure: string
    strategyAtFailure?: string
    satisfied: boolean
    strategyChanged: boolean
    planAdmitted?: boolean
    permitConsumed?: boolean
    /** At most one fresh admission follows a controller-proven no-effect edit. */
    noEffectReplans?: number
    admittedPlan?: AdmittedRecoveryPlanV1
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
  window?: ReadDeliveryWindow
}

export interface RecoveryReadEvidence extends RecoveryEvidenceProvenance {
  tool: 'read_file' | 'read_range'
  binding: RecoveryCandidateBinding
  observationDigest: string
  window: ReadDeliveryWindow
}

export interface RecoveryReadRecord extends RecoveryReadEvidence {
  key: string
  id: string
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
  | { type: 'mutation'; path: string; fingerprint?: string; canonicalFingerprint?: string }
  | { type: 'verifier'; identity: string; exitCode: number; summary: string }
  | { type: 'failure_surface'; surface: FailureSurface }
  | { type: 'diagnosis'; diagnosis: RepairDiagnosis }
  | { type: 'invalidate'; assumption: string }
  | { type: 'next_experiment'; experiment: string }
  | { type: 'recovery_candidate_drift' }
  | { type: 'recovery_plan_admitted'; plan: AdmittedRecoveryPlanV1 }
  | { type: 'recovery_plan_consumed' }
  | { type: 'recovery_proven_no_effect'; fingerprint: string }
  | { type: 'localization_begin'; localization: FailureLocalization }
  | { type: 'localization_update'; localization: FailureLocalization }
  | { type: 'localization_import_evidence'; provenance: RecoveryEvidenceProvenance }
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
 * Sentence `verifierEvidenceCaveats` appends when `tests_total === 0`.
 * The verifier event only carries that summary, not the structured count.
 */
export const ZERO_TEST_GREEN_NON_EVIDENCE =
  'verifier executed zero tests: a green exit with no tests is not test evidence'

/**
 * A real green exit may erase an open recovery gate. A zero-test green exit
 * is not evidence that the open failure is gone.
 */
export function greenVerifierClearsRecoveryGate(exitCode: number, summary: string): boolean {
  return exitCode === 0 && !summary.includes(ZERO_TEST_GREEN_NON_EVIDENCE)
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
      break
    case 'add_evidence': {
      next.evidence = pushUnique(next.evidence, event.evidence)
      if (event.file) next.filesOfInterest = pushUnique(next.filesOfInterest, event.file)
      if (next.lastVerifier && !next.lastVerifier.fresh) {
        next.lastVerifier = { ...next.lastVerifier, fresh: false }
      }
      const gate = next.recoveryGate
      const provenance = event.provenance
      const key = gate && provenance ? recoveryEvidenceKey(provenance, gate.failureSignature) : ''
      if (gate?.binding && provenance?.binding && key && provenance.failureSignature === gate.failureSignature &&
          sameRecoveryBinding(gate.binding, provenance.binding)) {
        const read = provenance as RecoveryReadEvidence
        const record: RecoveryReadRecord = { ...structuredClone(read), key, id: recoveryReadObservationId(key) }
        const records = [...(gate.readRecords ?? []).filter(old => old.key !== key), record].slice(-64)
        // Retention is not a progress grant. A typed current reread can re-publish
        // an evicted record without renewing an edit permit or consumed identity.
        next.recoveryGate = { ...gate, readRecords: records, observedKeys: records.map(item => item.key),
          satisfied: gate.satisfied || (!gate.permitConsumed && !gate.planAdmitted) }
        if (!next.consumedRecoveryEvidence.includes(key)) next.consumedRecoveryEvidence = [...next.consumedRecoveryEvidence, key]
      }
      break
    }
    case 'mutation':
      if (next.recoveryGate) {
        next.recoveryGate = { ...next.recoveryGate, satisfied: false, strategyChanged: false, planAdmitted: false, permitConsumed: true, readRecords: [], observedKeys: [] }
      }
      next.lastMutation = {
        path: event.path,
        at: Date.now(),
        ...(event.fingerprint !== undefined ? { fingerprint: event.fingerprint } : {}),
        ...(event.canonicalFingerprint !== undefined ? { canonicalFingerprint: event.canonicalFingerprint } : {}),
      }
      next.filesOfInterest = pushUnique(next.filesOfInterest, event.path)
      if (next.lastVerifier) {
        next.lastVerifier = { ...next.lastVerifier, fresh: false }
      }
      break
    case 'recovery_candidate_drift':
      if (next.recoveryGate) {
        next.recoveryGate = { ...next.recoveryGate, satisfied: false, strategyChanged: false, planAdmitted: false, permitConsumed: true, readRecords: [], observedKeys: [] }
        next.nextExperiment = 'The failed candidate changed. Rerun the verifier before acquiring recovery evidence.'
      }
      break
    case 'recovery_plan_admitted':
      if (next.recoveryGate?.satisfied && !next.recoveryGate.permitConsumed) {
        next.recoveryGate = { ...next.recoveryGate, admittedPlan: event.plan, planAdmitted: true, strategyChanged: true }
      }
      break
    case 'recovery_plan_consumed':
      if (next.recoveryGate?.planAdmitted && next.recoveryGate.admittedPlan) {
        next.lastAdmittedPlan = next.recoveryGate.admittedPlan
        next.recoveryGate = { ...next.recoveryGate, planAdmitted: false, permitConsumed: true }
      }
      break
    case 'recovery_proven_no_effect':
      if (next.recoveryGate?.permitConsumed && next.recoveryGate.satisfied &&
          next.lastAdmittedPlan?.exactFingerprint === event.fingerprint &&
          (next.recoveryGate.noEffectReplans ?? 0) < 1) {
        const { admittedPlan: _consumedPlan, ...gate } = next.recoveryGate
        next.recoveryGate = {
          ...gate,
          permitConsumed: false,
          noEffectReplans: 1,
        }
      }
      break
    case 'localization_import_evidence':
      // Import/AST relationships are hints. Only actual typed read deliveries
      // enter the evidence map through add_evidence above.
      break
    case 'localization_begin':
    case 'localization_update':
      next.localization = structuredClone(event.localization)
      break
    case 'verifier':
      next.lastVerifier = {
        identity: event.identity,
        exitCode: event.exitCode,
        summary: event.summary,
        fresh: true,
      }
      delete next.localization
      if (greenVerifierClearsRecoveryGate(event.exitCode, event.summary)) {
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
      if (state.recoveryGate?.binding && event.binding && state.recoveryGate.failureSignature === event.failureSignature &&
          sameRecoveryBinding(state.recoveryGate.binding, event.binding)) {
        next.recoveryGate = { ...state.recoveryGate, requiredEvidence: event.requiredEvidence }
        break
      }
      next.recoveryGate = {
        failureSignature: event.failureSignature,
        ...(event.binding ? { binding: event.binding } : {}),
        requiredEvidence: event.requiredEvidence,
        ...(event.mutationFingerprint ? { mutationFingerprint: event.mutationFingerprint } : {}),
        ...(event.failingTargets && event.failingTargets.length > 0
          ? { failingTargets: [...event.failingTargets] }
          : {}),
        observedKeys: [],
        readRecords: [],
        hypothesisAtFailure: event.hypothesisAtFailure ?? next.currentHypothesis,
        strategyAtFailure: next.currentHypothesis,
        satisfied: false,
        strategyChanged: false,
        planAdmitted: false,
        permitConsumed: false,
      }
      next.nextExperiment = event.requiredEvidence
      break
    case 'recovery_strategy':
      if (event.evidence) next.evidence = pushAll(next.evidence, event.evidence)
      next.nextExperiment = event.strategy
      break
  }
  return next
}

/**
 * Suggest the next investigation after accepted evidence. Repair authority is
 * separate and requires an admitted plan tied to the actual edit.
 */
export function recordControllerRecoveryStrategy(
  state: WorkingState,
  input: { target: string; evidence: string },
): WorkingState {
  if (!state.recoveryGate?.satisfied) return state
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
    `  last_verifier: ${state.lastVerifier ? yamlScalar(
      `${state.lastVerifier.identity} exit=${state.lastVerifier.exitCode} fresh=${state.lastVerifier.fresh} ${state.lastVerifier.summary}`,
    ) : 'none'}`,
    ...(state.lastVerifier ? [`  last_verifier_identity: ${yamlIdentity(state.lastVerifier.identity)}`] : []),
    ...(state.lastVerifier?.exitCode === 0 ? ['  acceptance_review: A green verifier covers its executed cases, not every requirement. Compare the implemented behavior with the user request and available project contract; check uncovered requirements with permitted tools, and report unverified requirements as partial. Do not substitute passing incidental tests for the requested outcome.'] : []),
    `  failure_surface: ${state.failureSurface ? state.failureSurface.kind : 'none'}`,
    `  failure_causality: ${state.failureSurface?.causality ?? 'unknown'}`,
    `  baseline_failure_signature: ${state.baselineFailureSignature ? yamlIdentity(state.baselineFailureSignature) : 'none'}`,
    `  repair_diagnosis: ${state.repairDiagnosis ? state.repairDiagnosis.kind : 'none'}`,
    `  open_questions: ${yamlList(state.openQuestions, 4)}`,
    `  invalidated_assumptions: ${yamlList(state.invalidatedAssumptions, 4)}`,
    `  next_experiment: ${yamlScalar(state.nextExperiment)}`,
  ]
  if (state.recoveryGate) {
    const records = state.recoveryGate.readRecords ?? []
    const observationIds = records.map(record => record.id)
    lines.push(
      `  recovery_gate: ${state.recoveryGate.satisfied ? 'evidence_satisfied' : 'evidence_required'}`,
      `  recovery_failure: ${yamlIdentity(state.recoveryGate.failureSignature)}`,
      `  recovery_revision: ${yamlIdentity(state.recoveryGate.binding?.workspaceRevision ?? '')}`,
      `  recovery_criterion_id: ${yamlIdentity(state.lastVerifier?.identity ?? '')}`,
      `  recovery_evidence: ${yamlScalar(state.recoveryGate.requiredEvidence)}`,
      `  recovery_observation_keys: ${yamlList(observationIds.slice(-8), 8)}`,
      `  recovery_read_records: ${JSON.stringify(records.slice(-8).map(record => ({ id: record.id, target: record.target, window: record.window })))}`,
      '  recovery_read_guidance: References name delivered windows, not permission or full-file verification. Older records can be re-published by rereading their concrete target/window.',
      `  recovery_plan: ${state.recoveryGate.planAdmitted ? 'admitted' : 'required'}`,
    )
    if (observationIds.length === 0) lines.push('  recovery_guidance: No admissible observation IDs exist yet; reread the failing assertion and relevant source after the failed verifier. Never invent observation IDs.')
  }
  if (state.localization) {
    lines.push(
      `  localization_phase: ${state.localization.phase}`,
      `  localization_calls: ${state.localization.calls}`,
      `  localization_rounds: ${state.localization.rounds}`,
      `  localization_candidates: ${yamlList(state.localization.candidates.map((candidate) => candidate.path), 4)}`,
      `  localization_test_hints: ${yamlList(state.localization.testHints, 4)}`,
      `  localization_import_candidates: ${yamlList((state.localization.importCandidates ?? []).map(candidate => `${candidate.path}:${candidate.relation}`), 4)}`,
      '  localization_guidance: Diagnostic and import candidates rank useful inspections; they do not restrict authorized source reads. Follow relevant implementation dependencies and use delivered read handles for each existing edit target. Inspect additional ranges when needed; then propose a concrete repair and rerun the verifier.',
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

/** Restore a controller snapshot without promoting legacy permits to authority. */
export function restoreWorkingStateSnapshot(value: unknown): WorkingState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = structuredClone(value) as Partial<WorkingState>
  // Older snapshots may contain v1 failure/read records without an explicit
  // session and execution-context binding. Keep their diagnostic state, but
  // discard those obsolete records rather than restoring edit/replay authority.
  const legacyCandidate = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false
    const candidate = (item as { candidate?: unknown }).candidate
    return !!candidate && typeof candidate === 'object' &&
      (candidate as { schemaVersion?: unknown }).schemaVersion === 1 &&
      typeof (candidate as { taskId?: unknown }).taskId === 'string' &&
      typeof (candidate as { contractHash?: unknown }).contractHash === 'string' &&
      typeof (candidate as { repositoryIdentity?: unknown }).repositoryIdentity === 'string' &&
      typeof (candidate as { workspaceRevision?: unknown }).workspaceRevision === 'string' &&
      !('sessionId' in candidate) && !('executionContextHash' in candidate)
  }
  if (raw.failedVerifierHistory !== undefined) {
    if (!Array.isArray(raw.failedVerifierHistory) || raw.failedVerifierHistory.length > 64) return null
    raw.failedVerifierHistory = raw.failedVerifierHistory.filter(item => !legacyCandidate(item))
    if (!raw.failedVerifierHistory.every(validFailedVerifierExecution)) return null
  }
  if (raw.failedVerifierHistoryOverflow !== undefined && raw.failedVerifierHistoryOverflow !== true) return null
  if (raw.settledFailedVerifier !== undefined) {
    if (legacyCandidate(raw.settledFailedVerifier)) delete raw.settledFailedVerifier
    else if (!validFailedVerifierExecution(raw.settledFailedVerifier)) return null
  }
  const candidate = raw
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === 'string')
  if (typeof candidate.goal !== 'string' || typeof candidate.currentHypothesis !== 'string' ||
      typeof candidate.nextExperiment !== 'string' ||
      !strings(candidate.evidence) || !strings(candidate.filesOfInterest) ||
      !strings(candidate.openQuestions) || !strings(candidate.invalidatedAssumptions) ||
      !strings(candidate.consumedRecoveryEvidence) ||
      typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision)) return null
  const restored = structuredClone(candidate) as WorkingState
  if (restored.recoveryGate?.binding && !sameRecoveryBinding(restored.recoveryGate.binding, restored.recoveryGate.binding)) {
    const gate = { ...restored.recoveryGate }
    delete gate.binding
    delete gate.admittedPlan
    delete restored.localization
    restored.recoveryGate = {
      ...gate,
      readRecords: [],
      observedKeys: [],
      satisfied: false,
      strategyChanged: false,
      planAdmitted: false,
    }
  }
  const gate = restored.recoveryGate
  if (restored.localization) {
    const loc = restored.localization
    if (!['LOCALIZE_FAILURE', 'localized', 'exhausted'].includes(loc.phase) ||
        !Number.isSafeInteger(loc.calls) || loc.calls < 0 ||
        !Number.isSafeInteger(loc.rounds) || loc.rounds < 0 ||
        !strings(loc.inspected) || !strings(loc.testHints) || loc.testHints.length > 4 ||
        !Array.isArray(loc.candidates) || loc.candidates.length > 8 ||
        loc.candidates.some((item) => !item || typeof item.path !== 'string' || typeof item.relation !== 'string') ||
        (loc.importCandidates !== undefined && (!Array.isArray(loc.importCandidates) || loc.importCandidates.length > 4 ||
          loc.importCandidates.some(item => !item || !['import_call', 'file_read'].includes(item.source) || typeof item.path !== 'string' ||
            typeof item.relation !== 'string' || typeof item.fromTestPath !== 'string'))) ||
        !loc.binding || !sameRecoveryBinding(loc.binding, loc.binding) ||
        typeof loc.binding.workspaceRevision !== 'string' || !loc.binding.workspaceRevision ||
        loc.failureSignature !== gate?.failureSignature ||
        (loc.phase === 'localized' && (!loc.acceptedPath || !loc.observationDigest ||
          !loc.candidates.some((item) => item.path === loc.acceptedPath)))) return null
  }
  if (gate) {
    if (typeof gate.failureSignature !== 'string' || typeof gate.requiredEvidence !== 'string' ||
        !strings(gate.observedKeys ?? []) || !strings(gate.failingTargets ?? []) ||
        (gate.noEffectReplans !== undefined && gate.noEffectReplans !== 0 && gate.noEffectReplans !== 1)) return null
    const binding = gate.binding
    const validBinding = binding && sameRecoveryBinding(binding, binding)
    const records = gate.readRecords ?? []
    if (!Array.isArray(records) || records.length > 64 || records.some(record =>
        !record || !record.binding || !validBinding || !sameRecoveryBinding(binding!, record.binding) ||
        record.failureSignature !== gate.failureSignature || !record.key ||
        recoveryEvidenceKey(record, gate.failureSignature) !== record.key ||
        recoveryReadObservationId(record.key) !== record.id)) return null
    restored.recoveryGate = {
      ...gate,
      readRecords: records,
      observedKeys: records.map(record => record.key),
      satisfied: validBinding === true && gate.satisfied === true && records.length > 0,
      strategyChanged: false,
      planAdmitted: false,
      permitConsumed: gate.permitConsumed === true,
    }
  }
  return restored
}

export function sameRecoveryBinding(a: RecoveryCandidateBinding, b: RecoveryCandidateBinding): boolean {
  return [a, b].every(value => value && value.schemaVersion === 2 &&
    ['taskId', 'contractHash', 'sessionId', 'repositoryIdentity', 'workspaceRevision', 'executionContextHash'].every(key =>
      typeof value[key as keyof RecoveryCandidateBinding] === 'string' && String(value[key as keyof RecoveryCandidateBinding]).length > 0)) &&
    a.taskId === b.taskId && a.contractHash === b.contractHash && a.sessionId === b.sessionId &&
    a.repositoryIdentity === b.repositoryIdentity && a.workspaceRevision === b.workspaceRevision &&
    a.executionContextHash === b.executionContextHash
}

/**
 * Identity of an observation for recovery-gate dedup. Scoping by failure
 * signature lets a genuinely new failure re-use an inspection while rejecting
 * repeated reads of the same target for the same failure.
 */
export function recoveryEvidenceKey(provenance: RecoveryEvidenceProvenance, failureSignature: string): string {
  if (!provenance || typeof provenance.target !== 'string' ||
      typeof provenance.tool !== 'string' || typeof provenance.observationDigest !== 'string' ||
      typeof failureSignature !== 'string' || !failureSignature) return ''
  const binding = provenance.binding
  const target = normalizeTarget(provenance.target)
  if (!binding || !sameRecoveryBinding(binding, binding) || !target || target !== provenance.target || !provenance.observationDigest ||
      !['read_file', 'read_range'].includes(provenance.tool) || !isReadDeliveryWindow(provenance.window)) return ''
  const w = provenance.window
  return JSON.stringify([
    3, failureSignature, binding.taskId, binding.contractHash, binding.sessionId,
    binding.repositoryIdentity, binding.workspaceRevision, binding.executionContextHash, provenance.tool,
    target, provenance.observationDigest, w.startLine, w.endLine, w.totalLines, w.completeFile, w.byteTruncated,
  ])
}

/** Expose a retained host record together with its exact delivered coverage. */
export function formatRecoveryReadReference(state: WorkingState, provenance: RecoveryEvidenceProvenance): string {
  const gate = state.recoveryGate
  if (!gate) return ''
  const key = recoveryEvidenceKey(provenance, gate.failureSignature)
  const record = gate.readRecords?.find(item => item.key === key)
  return record ? `### recovery_read_reference\n${JSON.stringify({ id: record.id, target: record.target, window: record.window })}` : ''
}

/** Stable model handle; input proposals are never truncated into handles. */
export function recoveryReadObservationId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
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

/** Encode protocol identities without the prose display bound. */
function yamlIdentity(value: string): string {
  return JSON.stringify(value)
}

function yamlList(values: string[], max: number): string {
  if (values.length === 0) return '[]'
  return `[${values.slice(0, max).map((v) => yamlScalar(v)).join(', ')}]`
}
