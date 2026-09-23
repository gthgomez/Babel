/**
 * Thin ChatEngine bindings so coding-loop logic does not grow chatEngine.ts.
 */

import { classifyFailureSurface } from './failureSurface.js'
import { compileObservation } from './observationCompiler.js'
import {
  applyWorkingStateEvent,
  type WorkingState,
  type RecoveryCandidateBinding,
} from './workingState.js'
import { rememberReadInjection, selectReadWindow } from './readWindow.js'
import { recoveryTargetIdentity } from './recoveryIdentity.js'
import { captureLocalizationCandidates, captureLocalizationTestHints, startFailureLocalization } from './failureLocalization.js'
import type { ReadInjectionCache } from './readWindow.js'

/**
 * After a verifier command, update WorkingState + last-failed flag.
 */
export function ingestVerifierResult(input: {
  state: WorkingState
  tool: string
  target: string
  exitCode: number
  stdout: string
  stderr: string
  summary: string
  knownBaselineSignature?: string
  verifierId?: string
  workspaceRevision?: string
  recoveryBinding?: RecoveryCandidateBinding
  recoveryProjectRoot?: string
}): { state: WorkingState; lastVerifierFailed: boolean } {
  let state = applyWorkingStateEvent(input.state, {
    type: 'verifier',
    identity: input.target,
    exitCode: input.exitCode,
    summary: input.summary,
  })
  if (input.exitCode !== 0) {
    const compiled = compileObservation({
      tool: input.tool,
      target: input.target,
      command: input.target,
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
    })
    state = applyWorkingStateEvent(state, {
      type: 'failure_surface',
      surface: classifyFailureSurface({
        observation: compiled,
        ...(state.failureSurface?.errorSignature !== undefined
          ? { previousSignature: state.failureSurface.errorSignature }
          : {}),
        ...(state.baselineFailureSignature !== undefined
          ? { knownBaselineSignature: state.baselineFailureSignature }
          : {}),
        ...(input.knownBaselineSignature !== undefined
          ? { knownBaselineSignature: input.knownBaselineSignature }
          : {}),
        ...(input.verifierId !== undefined ? { verifierId: input.verifierId } : {}),
        ...(input.workspaceRevision !== undefined ? { workspaceRevision: input.workspaceRevision } : {}),
      }),
    })
    if (
      state.failureSurface &&
      ['TEST_FAILURE', 'TYPECHECK_FAILURE', 'BUILD_FAILURE', 'LINT_FAILURE', 'RUNTIME_FAILURE', 'UNKNOWN_FAILURE'].includes(state.failureSurface.kind)
    ) {
      const rawTargets = [
        ...state.failureSurface.failingFiles,
        ...(state.lastMutation?.path ? [state.lastMutation.path] : []),
      ].filter((value) => value.trim().length > 0)
      const failingTargets = input.recoveryProjectRoot
        ? rawTargets.map((value) => recoveryTargetIdentity(input.recoveryProjectRoot!, value)).filter((value): value is string => value !== null)
        : rawTargets
      // A controller-observed prior edit is an implicated target. A path in
      // diagnostic output alone is only a localization candidate.
      const mutationTarget = state.lastMutation?.path && input.recoveryProjectRoot
        ? recoveryTargetIdentity(input.recoveryProjectRoot, state.lastMutation.path)
        : state.lastMutation?.path ?? null
      const trustedTargets = mutationTarget ? failingTargets : []
      state = applyWorkingStateEvent(state, {
        type: 'recovery_gate',
        failureSignature: state.failureSurface.errorSignature,
        ...(input.recoveryBinding ? { binding: input.recoveryBinding } : {}),
        requiredEvidence: 'Acquire discriminating evidence before another mutation: reread the failing assertion and inspect the relevant caller/callee boundary.',
        ...(state.lastMutation?.fingerprint ? { mutationFingerprint: state.lastMutation.fingerprint } : {}),
        ...(trustedTargets.length > 0 ? { failingTargets: trustedTargets } : {}),
        hypothesisAtFailure: state.currentHypothesis,
      })
      if (trustedTargets.length === 0 && state.failureSurface && input.recoveryBinding && input.recoveryProjectRoot) {
        state = applyWorkingStateEvent(state, {
          type: 'localization_begin',
          localization: startFailureLocalization(
            state.failureSurface.errorSignature,
            input.recoveryBinding,
            captureLocalizationCandidates({
              projectRoot: input.recoveryProjectRoot,
              stdout: input.stdout,
              stderr: input.stderr,
              tool: input.tool,
              command: input.target,
            }),
            captureLocalizationTestHints({
              stdout: input.stdout, stderr: input.stderr, tool: input.tool, command: input.target,
            }),
          ),
        })
      }
    }
  }
  return { state, lastVerifierFailed: input.exitCode !== 0 }
}

/**
 * Remember a bounded or complete full-file read using the range-aware cache.
 */
export function rememberFullReadWindow(
  cache: ReadInjectionCache,
  pathKey: string,
  fileHash: string,
  stdout: string,
  contextEpoch = 0,
): void {
  const window = selectReadWindow(stdout, { kind: 'full' })
  if (window.truncated) {
    rememberReadInjection(
      cache,
      `${pathKey}::${window.startLine}-${window.endLine}::epoch=${Math.max(0, Math.floor(contextEpoch))}`,
      fileHash,
    )
    return
  }
  rememberReadInjection(
    cache,
    `${pathKey}::full::epoch=${Math.max(0, Math.floor(contextEpoch))}`,
    fileHash,
  )
}
