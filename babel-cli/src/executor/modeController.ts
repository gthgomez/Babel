import type { TerminalOutcome } from '../schemas/agentContracts.js'
import { classifyToolEffect, modePolicyFor, type BabelMode, type CanonicalExecutorEvent } from './contracts.js'

export interface TurnInput {
  turnId?: string
  message: string
}

export interface RecoveredSession {
  descriptor: import('./contracts.js').SessionDescriptor
  events: readonly CanonicalExecutorEvent[]
}

/** Mode-controller boundary: orchestration may vary, executor authority may not. */
export interface ModeController {
  readonly mode: BabelMode
  submit(input: TurnInput): AsyncIterable<CanonicalExecutorEvent>
  cancel(turnId: string): Promise<void>
  resume(session: RecoveredSession): Promise<void>
}

/** Plan mode is denied before a tool reaches a mutating executor. */
export function assertEffectAllowed(mode: BabelMode, toolName: string): void {
  if (modePolicyFor(mode).mutationPolicy !== 'read_only') return
  if (classifyToolEffect(toolName) !== 'read_only') {
    throw new Error(`Plan mode denied non-read-only effect: ${toolName}`)
  }
}

/** Only the shared executor may produce executor terminals. */
export function assertTerminalAllowed(mode: BabelMode, outcome: TerminalOutcome | 'PLAN_COMPLETE'): void {
  if (mode === 'plan' && outcome !== 'PLAN_COMPLETE') {
    throw new Error(`Plan mode cannot emit executor terminal: ${outcome}`)
  }
  if (mode !== 'plan' && outcome === 'PLAN_COMPLETE') {
    throw new Error(`Executor mode cannot emit plan terminal: ${outcome}`)
  }
}
