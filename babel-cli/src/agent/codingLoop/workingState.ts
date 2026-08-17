/**
 * Compact, invalidatable WorkingState injected each turn. Compaction must
 * preserve this block; stale failures are not authoritative after new evidence.
 */

import type { ChatMessage } from '../chatToolDefinitions.js'
import type { FailureSurface, RepairDiagnosis, RepairDiagnosisKind } from './failureSurface.js'

export const WORKING_STATE_NAME = 'working_state'
export const WORKING_STATE_MARKER = '<!-- BABEL_WORKING_STATE -->'

export interface WorkingState {
  goal: string
  currentHypothesis: string
  evidence: string[]
  filesOfInterest: string[]
  lastMutation?: { path: string; at: number; fingerprint?: string }
  lastVerifier?: { identity: string; exitCode: number; summary: string; fresh: boolean }
  failureSurface?: FailureSurface
  repairDiagnosis?: RepairDiagnosis
  openQuestions: string[]
  invalidatedAssumptions: string[]
  nextExperiment: string
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
    revision: 0,
  }
}

export type WorkingStateEvent =
  | { type: 'set_goal'; goal: string }
  | { type: 'set_hypothesis'; hypothesis: string; evidence?: string[] }
  | { type: 'add_evidence'; evidence: string; file?: string }
  | { type: 'mutation'; path: string; fingerprint?: string }
  | { type: 'verifier'; identity: string; exitCode: number; summary: string }
  | { type: 'failure_surface'; surface: FailureSurface }
  | { type: 'diagnosis'; diagnosis: RepairDiagnosis }
  | { type: 'invalidate'; assumption: string }
  | { type: 'next_experiment'; experiment: string }

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
    case 'add_evidence':
      next.evidence = pushUnique(next.evidence, event.evidence)
      if (event.file) next.filesOfInterest = pushUnique(next.filesOfInterest, event.file)
      if (next.lastVerifier && !next.lastVerifier.fresh) {
        next.lastVerifier = { ...next.lastVerifier, fresh: false }
      }
      break
    case 'mutation':
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
    case 'verifier':
      next.lastVerifier = {
        identity: event.identity,
        exitCode: event.exitCode,
        summary: event.summary,
        fresh: true,
      }
      if (event.exitCode === 0) {
        delete next.failureSurface
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
  }
  return next
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
    `  repair_diagnosis: ${state.repairDiagnosis ? state.repairDiagnosis.kind : 'none'}`,
    `  open_questions: ${yamlList(state.openQuestions, 4)}`,
    `  invalidated_assumptions: ${yamlList(state.invalidatedAssumptions, 4)}`,
    `  next_experiment: ${yamlScalar(state.nextExperiment)}`,
  ]
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
  const msg: ChatMessage = { role: 'system', name: WORKING_STATE_NAME, content }
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

function pushUnique(list: string[], value: string): string[] {
  if (!value || list.includes(value)) return list
  return [...list, value].slice(-16)
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
