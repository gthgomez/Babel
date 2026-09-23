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
  failureSignature: z.string().min(1),
  workspaceRevision: z.string().min(1),
  hypothesisClass: z.enum(['logic', 'data_flow', 'interface', 'test_expectation', 'configuration']),
  targetIdentities: z.array(z.string().min(1)).min(1).max(4),
  actionFamily: z.enum(['write_file', 'str_replace', 'apply_patch']),
  criterionId: z.string().min(1),
  supportingObservationIds: z.array(z.string().length(16)).min(1).max(8),
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
  if (plan.failureSignature !== gate.failureSignature ||
      plan.workspaceRevision !== gate.binding.workspaceRevision ||
      plan.criterionId !== state.lastVerifier?.identity ||
      plan.actionFamily !== actual.actionFamily ||
      !sameTargets(plan.targetIdentities, actual.targetIdentities) ||
      plan.targetIdentities.some((target) => !targetMatchesGate(target, gate.failingTargets))) {
    return { admitted: false, state, reason: 'plan_does_not_match_candidate_or_edit' }
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
