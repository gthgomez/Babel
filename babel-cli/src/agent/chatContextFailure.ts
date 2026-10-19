import type { TerminalReason } from './chatTerminalReason.js'

/** A local context prerequisite refusal, never a provider error or retry grant. */
export class ContextPreparationError extends Error {
  readonly reason: TerminalReason

  constructor(projectRoot: string, detail: string, refusal: string, runDir?: string) {
    super(`Could not prepare context: ${refusal}. Project: ${projectRoot}. The required repository context could not be prepared or durably installed, so repository-grounded work is refused; conversation continuation remains available. Inspect the run evidence before retrying.${runDir ? ` Evidence: ${runDir}` : ''}`)
    this.name = 'ContextPreparationError'
    this.reason = { code: 'context_preparation_failed', cause_class: 'harness', detail }
  }
}
