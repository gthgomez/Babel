import type { TerminalReason } from './chatTerminalReason.js'

/** A local context prerequisite refusal, never a provider error or retry grant. */
export class ContextPreparationError extends Error {
  readonly reason: TerminalReason

  constructor(projectRoot: string, detail: string, refusal: string, runDir?: string) {
    super(`Could not prepare context: ${refusal}. Project: ${projectRoot}. The required repository context could not be prepared or durably installed, so repository-grounded work is refused and this turn cannot be dispatched. Unavailable repository coverage alone does not refuse — continuation installs and dispatches — but a missing operational authority or a failed durable install fails closed. Inspect the run evidence before retrying.${runDir ? ` Evidence: ${runDir}` : ''}`)
    this.name = 'ContextPreparationError'
    this.reason = { code: 'context_preparation_failed', cause_class: 'harness', detail }
  }
}
