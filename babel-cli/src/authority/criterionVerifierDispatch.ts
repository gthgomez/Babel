import { canonicalJson, sha256Canonical } from '../acceptance/canonical.js'
import type { AcceptanceRequirementV1, VerificationSpecV1 } from '../agent/taskContract.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import type { RevisionBoundReceipt } from '../evidence/revisionBoundReceipt.js'
import { satisfiesVerifierRequirement } from '../services/verifierIdentity.js'

/** Meaning capture marked unresolved — no command can satisfy it. */
export function isUnresolvedAcceptanceRequirement(
  requirement: AcceptanceRequirementV1,
): boolean {
  return (
    requirement.verification.verifier_id.startsWith('meaning:') &&
    requirement.verification_strategy.includes('unresolved')
  )
}

function receiptVerifierId(receipt: BoundChatVerifierReceipt): string | undefined {
  return receipt.verifier_id ?? receipt.verifierId
}

function governedExecutionMetadataMatches(
  receipt: BoundChatVerifierReceipt,
  required: VerificationSpecV1,
): boolean {
  for (const field of ['working_directory', 'environment_policy', 'target'] as const) {
    if (required[field] === undefined) continue
    const actual = receipt[field]
    if (actual === undefined || actual !== required[field]) return false
  }
  return true
}

function frozenExecutableArgv(required: VerificationSpecV1): string[] | null {
  if (!required.argv || required.argv.length === 0) return null
  return required.executable_id
    ? [required.executable_id, ...required.argv]
    : [...required.argv]
}

/**
 * Whether governed chat execution actually ran the frozen check for this criterion.
 * Fail-closed: inferred/unresolved meaning IDs never bind; argv and verifier_id must match.
 */
export function chatReceiptDispatchesToRequirement(
  receipt: BoundChatVerifierReceipt,
  requirement: AcceptanceRequirementV1,
): boolean {
  if (receipt.exit_code !== 0) return false
  if (isUnresolvedAcceptanceRequirement(requirement)) return false
  if (requirement.verification.verifier_id.startsWith('meaning:')) return false

  const required = requirement.verification
  const actualId = receiptVerifierId(receipt)
  if (!actualId || actualId !== required.verifier_id) return false

  const expectedArgv = frozenExecutableArgv(required)
  if (expectedArgv) {
    if (!receipt.argv || canonicalJson(receipt.argv) !== canonicalJson(expectedArgv)) {
      return false
    }
    if (required.command_hash) {
      const bound = sha256Canonical({
        executable_id: required.executable_id,
        argv: required.argv,
      })
      if (required.command_hash !== bound) return false
    }
    if (!governedExecutionMetadataMatches(receipt, required)) return false
    return satisfiesVerifierRequirement(expectedArgv.join(' '), receipt.command)
  }

  return false
}

/** Evidence payload for the graph — only from real receipt bytes, never requirement forgery. */
export function buildCriterionReceiptEvidenceData(
  requirement: AcceptanceRequirementV1,
  bound: RevisionBoundReceipt,
  receipt: BoundChatVerifierReceipt,
): Record<string, unknown> | null {
  if (!chatReceiptDispatchesToRequirement(receipt, requirement)) return null
  const required = requirement.verification
  const expectedArgv = frozenExecutableArgv(required)
  if (!governedExecutionMetadataMatches(receipt, required)) return null
  return {
    ...bound,
    verifier_id: required.verifier_id,
    verifier_spec_hash: sha256Canonical(required),
    ...(required.command_hash !== undefined ? { command_hash: required.command_hash } : {}),
    ...(required.executable_id !== undefined ? { executable_id: required.executable_id } : {}),
    ...(receipt.working_directory !== undefined
      ? { working_directory: receipt.working_directory }
      : required.working_directory !== undefined
        ? { working_directory: required.working_directory }
        : {}),
    ...(receipt.environment_policy !== undefined
      ? { environment_policy: receipt.environment_policy }
      : required.environment_policy !== undefined
        ? { environment_policy: required.environment_policy }
        : {}),
    ...(receipt.target !== undefined
      ? { target: receipt.target }
      : required.target !== undefined
        ? { target: required.target }
        : {}),
    ...(required.argv ? { argv: [...required.argv] } : {}),
  }
}
