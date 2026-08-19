/**
 * Thin ChatEngine bindings so coding-loop logic does not grow chatEngine.ts.
 */

import { classifyFailureSurface } from './failureSurface.js'
import { compileObservation } from './observationCompiler.js'
import {
  applyWorkingStateEvent,
  type WorkingState,
} from './workingState.js'
import { rememberReadInjection, selectReadWindow } from './readWindow.js'
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
      surface: classifyFailureSurface({ observation: compiled }),
    })
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
): void {
  const window = selectReadWindow(stdout, { kind: 'full' })
  if (window.truncated) {
    rememberReadInjection(
      cache,
      `${pathKey}::${window.startLine}-${window.endLine}`,
      fileHash,
    )
    return
  }
  rememberReadInjection(cache, `${pathKey}::full`, fileHash)
}
