import type { CompletionDecision } from '../executor/contracts.js'
import { createExecutorKernel } from '../executor/kernel.js'
import type { ToolCallLog } from '../schemas/agentContracts.js'
import type { TerminalStatus } from '../services/terminalStatus.js'
import {
  evaluateFinalRevisionWitness,
  type FinalRevisionWitnessV1,
} from '../authority/finalRevision.js'

/** Success statuses that a stale final-revision witness must be able to revoke. */
const SUCCESS_STATUSES = new Set<TerminalStatus>([
  'COMPLETE',
  'COMPLETE_NO_MODIFICATION',
  'READ_ONLY_NO_MODIFICATION',
])

export interface PipelineFinalCompletionInput {
  mode: 'chat' | 'plan' | 'deep'
  status: TerminalStatus
  projectRoot: string
  toolCallLog: readonly ToolCallLog[]
  /** Host/plan-required verifier commands; extraction stays in the pipeline. */
  requiredVerifierCommands: readonly string[]
}

export interface PipelineFinalCompletionResult {
  status: TerminalStatus
  /** Set only for Deep success claims routed through kernel authority. */
  decision: CompletionDecision | null
  finalRevision: FinalRevisionWitnessV1
  /** Visible reason when stale proof revokes a completion claim. */
  condition: string | null
}

/**
 * Deep finalization through the shared final-revision authority.
 *
 * A verified status is preserved only when the required verifier evidence still
 * covers the final tree. A late write or changed bytes revoke the claim to
 * `REQUIRED_VERIFIER_MISSING` while leaving every user file untouched. Chat and
 * Plan keep their existing terminal mapping; any stale witness still revokes a
 * success status, including `READ_ONLY_NO_MODIFICATION`.
 *
 * Explicit residual: a Deep task with local writes but no host/plan-required
 * verifier remains `COMPLETE` with an `UNVERIFIED_PATCH` decision. Babel does
 * not claim verification it cannot establish; consumers must read the decision.
 */
export function decidePipelineFinalCompletion(
  input: PipelineFinalCompletionInput,
): PipelineFinalCompletionResult {
  const finalRevision = evaluateFinalRevisionWitness({
    projectRoot: input.projectRoot,
    toolCallLog: input.toolCallLog,
    requiredVerifierCommands: input.requiredVerifierCommands,
  })
  const readOnlyStatus = input.status === 'READ_ONLY_NO_MODIFICATION' ||
    input.status === 'COMPLETE_NO_MODIFICATION'
  if (SUCCESS_STATUSES.has(input.status) && readOnlyStatus && finalRevision.status !== 'verified') {
    return {
      status: 'EXECUTOR_HALTED',
      decision: null,
      finalRevision,
      condition: finalRevision.status === 'stale'
        ? `Final-revision proof is stale: ${finalRevision.reason ?? 'bytes changed after the accepted proof'}. ` +
          `Changed after the accepted proof: ${finalRevision.stale_paths.join(', ') || '(workspace)'}. ` +
          'The inspected conclusion is no longer current; rerun the check. Worktree changes are retained.'
        : `Read-only completion is unproven: ${finalRevision.reason ?? 'no inspected bytes were re-hashed'}. ` +
          'No successful no-change result is published without a current byte witness.',
    }
  }
  if (input.mode !== 'deep' || !SUCCESS_STATUSES.has(input.status)) {
    if (SUCCESS_STATUSES.has(input.status) && finalRevision.status === 'stale') {
      return {
        status: 'EXECUTOR_HALTED',
        decision: null,
        finalRevision,
        condition: `Final-revision proof is stale: ${finalRevision.reason ?? 'bytes changed after the accepted proof'}. ` +
          `Changed after the accepted proof: ${finalRevision.stale_paths.join(', ') || '(workspace)'}. ` +
          'The inspected conclusion is no longer current; rerun the check. Worktree changes are retained.',
      }
    }
    return { status: input.status, decision: null, finalRevision, condition: null }
  }
  const verifiedClaim = input.requiredVerifierCommands.length > 0
  const decision = createExecutorKernel('deep').completion.decideFinalRevision({
    verifiedClaim,
    finalRevision,
  })
  if (!verifiedClaim && finalRevision.status !== 'stale') {
    return { status: input.status, decision, finalRevision, condition: null }
  }
  if (finalRevision.status === 'stale' && !verifiedClaim) {
    return {
      status: 'EXECUTOR_HALTED',
      decision,
      finalRevision,
      condition: `Final-revision proof is stale: ${finalRevision.reason ?? 'bytes changed after the accepted proof'}. ` +
        `Changed after the accepted proof: ${finalRevision.stale_paths.join(', ') || '(workspace)'}. ` +
        'The inspected conclusion is no longer current; rerun the check. Worktree changes are retained.',
    }
  }
  if (!verifiedClaim || decision.finalOutcome === 'VERIFIED_COMPLETE') {
    return { status: input.status, decision, finalRevision, condition: null }
  }
  const reason = finalRevision.status === 'stale'
    ? `Final-revision proof is stale: ${finalRevision.reason ?? 'bytes changed after verification'}. ` +
      `Changed after the accepted proof: ${finalRevision.stale_paths.join(', ') || '(workspace)'}. ` +
      'The worktree changes are retained; rerun the required verifier before claiming completion.'
    : `Final-revision proof is not current: ${finalRevision.reason ?? 'required verifier evidence is missing'}.`
  const redAfterGreen = finalRevision.reason?.startsWith('required_verifier_red') === true
  return {
    status: redAfterGreen ? 'REQUIRED_VERIFIER_FAILED' : 'REQUIRED_VERIFIER_MISSING',
    decision,
    finalRevision,
    condition: reason,
  }
}
