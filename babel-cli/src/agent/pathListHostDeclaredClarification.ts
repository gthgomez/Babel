import { sha256Canonical } from '../acceptance/canonical.js'
import {
  declarationContentHash,
  type TrustedHostAcceptanceClarificationBindingV1,
  type TrustedHostFilesystemPathListDeclarationV1,
} from '../authority/trustedHostFilesystemPathList.js'
import type { AcceptanceRequirementV1 } from './taskContract.js'
import {
  ACCEPTANCE_MEANING_REF,
  type AcceptanceMeaningSource,
  type TaskAcceptanceMeaning,
} from './taskAcceptanceMeaning.js'
import { LiveSessionAuthorityError } from './liveSessionAuthorityError.js'

export const TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_REF_PREFIX =
  'trusted-host-acceptance-clarification:v1#'

export const HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID =
  'verifier:trusted-host-filesystem-path-list:v1'

export const HOST_ACCEPTANCE_CLARIFICATION_DERIVED_REF =
  'task-acceptance-path-list-clarification:v1:host_declared'

function isUnresolvedCriterion(criterion: AcceptanceRequirementV1): boolean {
  return (
    criterion.verification.verifier_id.startsWith('meaning:') &&
    criterion.verification_strategy.includes('unresolved')
  )
}

function meaningProvenanceRef(source: AcceptanceMeaningSource): string {
  return `${ACCEPTANCE_MEANING_REF}:${source.status}:${source.input_digest}:${source.start}:${source.end}:${source.criterion_id}`
}

function clarificationReject(code: string, message: string): never {
  throw new LiveSessionAuthorityError(code, message)
}

export function clarificationBindingDigest(
  binding: TrustedHostAcceptanceClarificationBindingV1,
): string {
  return sha256Canonical(binding)
}

export function pathListClarificationProvenanceRecord(
  binding: TrustedHostAcceptanceClarificationBindingV1,
): { kind: 'repository_policy'; ref: string } {
  const digest = clarificationBindingDigest(binding)
  return {
    kind: 'repository_policy',
    ref: `${TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_REF_PREFIX}${digest}`,
  }
}

/** Visible task-context summary; not completion evidence. */
export function buildHostClarificationManifestRule(
  binding: TrustedHostAcceptanceClarificationBindingV1,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): {
  rule_id: string
  source: string
  content: string
  precedence: 'verifier'
  selection_reason: string
  policy_class: 'mechanical'
} {
  return {
    rule_id: 'host:acceptance-clarification',
    source: 'trusted-host-path-list-admission',
    content: [
      'Host-declared acceptance clarification (not inferred natural-language understanding).',
      `clarification_mode=${binding.clarification_mode}`,
      `target_criterion_id=${binding.target_criterion_id}`,
      `declaration_id=${declaration.declaration_id}`,
      `declaration_content_hash=${declarationContentHash(declaration)}`,
    ].join(' '),
    precedence: 'verifier',
    selection_reason: 'host_declared_path_list_clarification',
    policy_class: 'mechanical',
  }
}

export function formatHostDeclaredPathListClarificationDescription(
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): string {
  const roots = declaration.inventory_scope.roots.join(', ')
  const preserved = declaration.preserved_input_selectors.join(', ')
  return [
    'Host-declared acceptance clarification for scoped filesystem path-list inventory.',
    `Target document: ${declaration.target_document} (${declaration.format_profile}).`,
    `Inventory scope roots: ${roots}. Coverage: ${declaration.coverage.mode}.`,
    `Preserved input selectors (baseline-bound, not expected listing): ${preserved}.`,
    `Document limits: max_document_bytes=${declaration.limits.max_document_bytes}, max_entries=${declaration.limits.max_entries}.`,
  ].join(' ')
}

export function frozenPathListVerificationSpecForBinding(
  declaration: TrustedHostFilesystemPathListDeclarationV1,
): AcceptanceRequirementV1['verification'] {
  return {
    kind: 'custom',
    verifier_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
    target: declarationContentHash(declaration),
  }
}

function assertBindingPreconditions(
  meaning: TaskAcceptanceMeaning,
  declaration: TrustedHostFilesystemPathListDeclarationV1,
  binding: TrustedHostAcceptanceClarificationBindingV1,
): { target: AcceptanceRequirementV1; source: AcceptanceMeaningSource } {
  if (binding.task_request_digest !== declaration.user_request_digest) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_TASK_DIGEST_MISMATCH',
      'Path-list clarification task_request_digest does not match declaration',
    )
  }
  const explicitSources = meaning.sources.filter(source => source.status === 'explicit')
  if (explicitSources.length > 0) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_EXPLICIT_OBLIGATIONS_PRESENT',
      'Path-list clarification cannot apply when explicit acceptance obligations are present',
    )
  }
  const shellBound = meaning.criteria.some(
    criterion => !criterion.verification.verifier_id.startsWith('meaning:'),
  )
  if (shellBound) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_EXPLICIT_OBLIGATIONS_PRESENT',
      'Path-list clarification cannot apply when executable acceptance bindings are present',
    )
  }
  const unresolvedSources = meaning.sources.filter(source => source.status === 'unresolved')
  if (unresolvedSources.length !== 1) {
    clarificationReject(
      unresolvedSources.length > 1
        ? 'PATH_LIST_CLARIFICATION_MULTIPLE_UNRESOLVED'
        : 'PATH_LIST_CLARIFICATION_TARGET_NOT_UNRESOLVED',
      'Path-list clarification requires exactly one unresolved acceptance obligation',
    )
  }
  const target = meaning.criteria.find(
    criterion => criterion.id === binding.target_criterion_id,
  )
  if (!target) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_CRITERION_UNKNOWN',
      'Path-list clarification target_criterion_id is not present in acceptance',
    )
  }
  if (!isUnresolvedCriterion(target)) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_TARGET_NOT_UNRESOLVED',
      'Path-list clarification target is not the sole unresolved acceptance row',
    )
  }
  const source = meaning.sources.find(
    item => item.criterion_id === binding.target_criterion_id,
  )
  if (!source || source.status !== 'unresolved') {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_TARGET_NOT_UNRESOLVED',
      'Path-list clarification target source is not unresolved',
    )
  }
  if (source.input_digest !== binding.meaning_input_digest) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_MEANING_DIGEST_MISMATCH',
      'Path-list clarification meaning_input_digest does not match target source',
    )
  }
  const expectedRef = meaningProvenanceRef(source)
  if (
    binding.meaning_provenance_ref !== undefined &&
    binding.meaning_provenance_ref !== expectedRef
  ) {
    clarificationReject(
      'PATH_LIST_CLARIFICATION_PROVENANCE_MISMATCH',
      'Path-list clarification meaning_provenance_ref does not match target source',
    )
  }
  return { target, source }
}

/**
 * Apply host-declared clarification to the sole unresolved row when binding is present.
 * No-op when `acceptance_clarification` is absent. Invalid binding throws without mutating.
 */
export function applyHostDeclaredPathListClarification(input: {
  meaning: TaskAcceptanceMeaning
  declaration: TrustedHostFilesystemPathListDeclarationV1
}): TaskAcceptanceMeaning {
  const binding = input.declaration.acceptance_clarification
  if (!binding) return input.meaning

  const { target, source } = assertBindingPreconditions(
    input.meaning,
    input.declaration,
    binding,
  )
  const snapshot = structuredClone(input.meaning)

  const description = formatHostDeclaredPathListClarificationDescription(input.declaration)
  const verification = frozenPathListVerificationSpecForBinding(input.declaration)
  const criteria = snapshot.criteria.map(criterion =>
    criterion.id === target.id
      ? {
          ...criterion,
          description,
          type: 'policy' as const,
          verification,
          verification_strategy:
            'Host-declared scoped path-list inventory obligation; future verification uses trusted host read-only inventory checks bound to the admitted declaration (not natural-language inference).',
        }
      : criterion,
  )
  const sources = snapshot.sources.map(item =>
    item.criterion_id === source.criterion_id
      ? { ...item, status: 'explicit' as const }
      : item,
  )
  const clarificationProvenance = {
    kind: 'derived_acceptance' as const,
    ref: `${HOST_ACCEPTANCE_CLARIFICATION_DERIVED_REF}:${clarificationBindingDigest(binding)}`,
  }
  const unresolved = sources.some(item => item.status === 'unresolved')
  return {
    ...snapshot,
    criteria,
    sources,
    unresolved,
    provenance: [...snapshot.provenance, clarificationProvenance],
  }
}
