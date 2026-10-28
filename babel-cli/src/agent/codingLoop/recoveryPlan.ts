import { createHash } from 'node:crypto'
import { z } from 'zod'
import { extractPatchRawTargets } from '../../authority/patchTargets.js'
import { operationFingerprint } from '../sessionEvents.js'
import { recoveryTargetIdentity } from './recoveryIdentity.js'
import {
  applyWorkingStateEvent,
  sameRecoveryBinding,
  targetMatchesGate,
  type RecoveryCandidateBinding,
  type WorkingState,
} from './workingState.js'

export const RecoveryPlanProposalSchema = z.object({
  schemaVersion: z.literal(1),
  failureSignature: z.string().min(1).describe('Copy working_state.recovery_failure exactly.'),
  workspaceRevision: z.string().min(1).describe('Copy working_state.recovery_revision exactly.'),
  hypothesisClass: z.enum(['logic', 'data_flow', 'interface', 'test_expectation', 'configuration']),
  targetIdentities: z.array(z.string().min(1)).min(1).max(4).describe('Exact repository-relative file paths changed by this edit, without :symbol suffixes. Every path must be a current failing target.'),
  actionFamily: z.enum(['write_file', 'str_replace', 'apply_patch']).describe('Must equal the concrete edit tool used by this call.'),
  criterionId: z.string().min(1).describe('Copy the exact verifier command/identity from working_state.recovery_criterion_id (also last_verifier_identity). Do not use the test name, assertion label, or failure parser name.'),
  supportingObservationIds: z.array(z.string().length(16)).min(1).max(8).describe('Copy only exact 16-character IDs from working_state.recovery_observation_keys. Never use evidence prose, paths or invented IDs. If no admissible IDs exist, obtain fresh recovery evidence before proposing an edit.'),
})

export type RecoveryPlanProposalV1 = z.infer<typeof RecoveryPlanProposalSchema>

export interface AdmittedRecoveryPlanV1 extends RecoveryPlanProposalV1 {
  binding: RecoveryCandidateBinding
  editFingerprint: string
  exactFingerprint: string
  intentDigest: string
}

export interface ActualRecoveryEdit {
  actionFamily: RecoveryPlanProposalV1['actionFamily']
  targetIdentities: string[]
  editFingerprint: string
  exactFingerprint: string
}

export type RecoveryEditAction =
  | { type: 'write_file'; path: string; content: string }
  | { type: 'str_replace'; file_path: string; old_str: string; new_str: string }
  | { type: 'apply_patch'; patch: string }

/** Fingerprint the concrete edit, excluding model-supplied plan prose. */
export function actualRecoveryEdit(action: RecoveryEditAction, root: string): ActualRecoveryEdit | null {
  const rawTargets = action.type === 'write_file' ? [action.path]
    : action.type === 'str_replace' ? [action.file_path]
      : extractPatchRawTargets(action.patch)
  const targets = rawTargets.map((target) => recoveryTargetIdentity(root, target))
  if (targets.length === 0 || targets.some((target) => target === null)) return null
  const targetIdentities = [...new Set(targets as string[])].sort()
  // V2 hashes the literal payload. CRLF and LF produce different file bytes for
  // writes and replacements, so a V1 normalized fingerprint cannot veto V2.
  const payload = action.type === 'write_file' ? action.content
    : action.type === 'str_replace' ? [action.old_str, action.new_str]
      : action.patch
  return {
    actionFamily: action.type,
    targetIdentities,
    editFingerprint: `v2:${createHash('sha256').update(JSON.stringify([action.type, targetIdentities, payload])).digest('hex')}`,
    exactFingerprint: operationFingerprint(action.type, action.type === 'write_file'
      ? { type: action.type, path: action.path, content: action.content }
      : action.type === 'str_replace'
        ? { type: action.type, file_path: action.file_path, old_str: action.old_str, new_str: action.new_str }
        : { type: action.type, patch: action.patch }),
  }
}

export function recoveryObservationId(observationKey: string): string {
  return createHash('sha256').update(observationKey).digest('hex').slice(0, 16)
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length &&
    new Set(a).size === a.length && new Set(b).size === b.length &&
    [...a].sort().every((target, index) => target === [...b].sort()[index])
}

/** Model fields are proposals; only this controller check admits the actual edit. */
export function admitRecoveryPlan(
  state: WorkingState,
  proposed: unknown,
  actual: ActualRecoveryEdit,
  current: RecoveryCandidateBinding | null,
): { admitted: boolean; state: WorkingState; reason?: string } {
  const gate = state.recoveryGate
  const parsed = RecoveryPlanProposalSchema.safeParse(proposed)
  if (!gate?.satisfied || gate.permitConsumed || gate.planAdmitted || !gate.binding || !current ||
      !sameRecoveryBinding(gate.binding, current) || !parsed.success) {
    return { admitted: false, state, reason: 'unbound_or_missing_plan' }
  }
  const plan = parsed.data
  if (plan.criterionId !== state.lastVerifier?.identity) {
    return { admitted: false, state, reason: 'criterion_identity_mismatch' }
  }
  if (plan.failureSignature !== gate.failureSignature) return { admitted: false, state, reason: 'failure_signature_mismatch' }
  if (plan.workspaceRevision !== gate.binding.workspaceRevision) return { admitted: false, state, reason: 'workspace_revision_mismatch' }
  if (plan.actionFamily !== actual.actionFamily) return { admitted: false, state, reason: 'action_family_mismatch' }
  if (!sameTargets(plan.targetIdentities, actual.targetIdentities)) return { admitted: false, state, reason: 'target_identity_mismatch' }
  if (plan.targetIdentities.some((target) => !targetMatchesGate(target, gate.failingTargets))) {
    return { admitted: false, state, reason: 'target_outside_failure_scope' }
  }
  const known = new Set((gate.observedKeys ?? []).map(recoveryObservationId))
  if (plan.supportingObservationIds.some((id) => !known.has(id)) ||
      new Set(plan.supportingObservationIds).size !== plan.supportingObservationIds.length) {
    return { admitted: false, state, reason: 'unsupported_observation' }
  }
  if (!actual.editFingerprint || !actual.exactFingerprint ||
      actual.editFingerprint === state.lastMutation?.canonicalFingerprint ||
      actual.exactFingerprint === gate.mutationFingerprint) {
    return { admitted: false, state, reason: 'repeated_failed_edit' }
  }
  const intentDigest = createHash('sha256').update(JSON.stringify([
    plan.hypothesisClass, [...plan.targetIdentities].sort(), plan.actionFamily, plan.criterionId,
  ])).digest('hex')
  if (state.lastAdmittedPlan?.editFingerprint === actual.editFingerprint) {
    return { admitted: false, state, reason: 'repeated_plan_or_edit' }
  }
  const admittedPlan: AdmittedRecoveryPlanV1 = {
    ...plan, binding: current,
    editFingerprint: actual.editFingerprint,
    exactFingerprint: actual.exactFingerprint,
    intentDigest,
  }
  return {
    admitted: true,
    state: applyWorkingStateEvent(state, { type: 'recovery_plan_admitted', plan: admittedPlan }),
  }
}

/** Controller facts explain a rejected proposal without changing its authority. */
export function formatRecoveryPlanRejection(state: WorkingState, reason?: string, actual?: ActualRecoveryEdit | null): string {
  if (state.recoveryGate?.permitConsumed || state.recoveryGate?.planAdmitted) return 'The one-use recovery plan is consumed. Rerun the verifier before proposing another repair.'
  if (reason === 'criterion_identity_mismatch') {
    const expected = state.lastVerifier?.identity
    if (!expected) return 'criterion_identity_mismatch: no authoritative verifier identity is available; rerun the verifier before proposing a repair.'
    return `criterion_identity_mismatch criterion_id_expected=${JSON.stringify(expected)}. Copy that exact verifier command into repair_plan.criterionId, not the test label. Changing edit tools or delegating cannot bypass this gate.`
  }
  if (reason === 'target_identity_mismatch' && actual) return `target_identity_mismatch target_identities_expected=${JSON.stringify(actual.targetIdentities)}. Copy the exact repository-relative file paths into repair_plan.targetIdentities, without :symbol suffixes. This does not admit a path outside the failing scope.`
  if (reason === 'failure_signature_mismatch') return 'failure_signature_mismatch: copy recovery_failure exactly into repair_plan.failureSignature.'
  if (reason === 'workspace_revision_mismatch') return 'workspace_revision_mismatch: copy recovery_revision exactly into repair_plan.workspaceRevision.'
  if (reason === 'action_family_mismatch') return `action_family_mismatch: repair_plan.actionFamily must equal the actual edit tool ${actual?.actionFamily ?? '(write_file, str_replace or apply_patch)'}.`
  if (reason === 'target_outside_failure_scope') return 'target_outside_failure_scope: repair only a target corroborated by the current failing assertion and fresh source read. Rerun the verifier before investigating another failure.'
  if (reason === 'unsupported_observation') return 'unsupported_observation: copy only the exact current recovery_observation_keys into supportingObservationIds, without duplicates or invented IDs.'
  if (reason === 'repeated_failed_edit' || reason === 'repeated_plan_or_edit') return `${reason}: repeating the same edit or changing hypothesis text does not establish a different repair.`
  return 'Submit a concrete write_file, str_replace or apply_patch with a scoped repair_plan supported by current observation IDs and the actual edit. Copy recovery_criterion_id exactly; shell commands and delegation cannot bypass this gate.'
}
