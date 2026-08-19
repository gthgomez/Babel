/**
 * One intervention decision per turn, fed only by real producer signals
 * (failure surface, hypothesis change, verifier, new evidence).
 */

import type { ProgressInterventionLevel, ProgressSignal } from '../progressController.js'
import { isRepeatedSameError, type FailureSurface } from './failureSurface.js'
import type { WorkingState } from './workingState.js'

export interface ProgressDecisionInput {
  state: WorkingState
  previousSurface?: FailureSurface
  localizedNewPath?: boolean
  newEvidence?: boolean
  hypothesisChanged?: boolean
  verifierAttempted?: boolean
  verifierAdvanced?: boolean
  reducedFailingTests?: boolean
  changedRecovery?: boolean
  noProgressStreak?: number
}

export interface ProgressDecision {
  signals: ProgressSignal[]
  level: ProgressInterventionLevel
  message?: string
}

/**
 * Single intervention decision after producers have run.
 */
export function decideProgressIntervention(input: ProgressDecisionInput): ProgressDecision {
  const signals: ProgressSignal[] = []
  if (input.localizedNewPath) signals.push('new_localization')
  if (input.hypothesisChanged) signals.push('changed_hypothesis')
  if (input.newEvidence) signals.push('new_reproducer')
  if (input.verifierAttempted) signals.push('verifier_attempted')
  if (input.verifierAdvanced) signals.push('verifier_advanced')
  if (input.reducedFailingTests) signals.push('reduced_failing_tests')
  if (input.changedRecovery) signals.push('changed_recovery_approach')
  if (
    input.state.failureSurface &&
    input.previousSurface &&
    input.state.failureSurface.errorSignature !== input.previousSurface.errorSignature
  ) {
    signals.push('new_error_signature')
  }

  const productive = signals.length > 0
  const repeated =
    input.state.failureSurface !== undefined &&
    isRepeatedSameError(input.previousSurface, input.state.failureSurface) &&
    !input.newEvidence &&
    !input.hypothesisChanged

  if (repeated) {
    signals.push('repeated_identical_action')
    return {
      signals,
      level: 'nudge',
      message:
        'Same error signature with no new evidence. Update the hypothesis or gather targeted repository evidence before mutating again.',
    }
  }

  const streak = input.noProgressStreak ?? 0
  if (!productive && streak >= 3) {
    return {
      signals,
      level: 'last_chance_repair',
      message: 'No progress across several turns. Change strategy or declare BLOCKED with missing evidence.',
    }
  }
  if (!productive && streak >= 1) {
    return {
      signals,
      level: 'nudge',
      message: 'No new evidence, hypothesis, or verifier movement this turn.',
    }
  }
  return { signals, level: 'none' }
}
