import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { validateTaskContractV1ForCompletion, type TaskContractV1 } from '../agent/taskContract.js'
import { EvidenceGraph, evaluateCompletionGateV1, type CompletionEvaluationV1 } from '../evidence/evidenceGraph.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import type { LiveSessionFilesystemPathListAdmissionV1 } from '../agent/liveSessionFilesystemPathListAdmission.js'
import { publishCriterionEvidenceFromChatExecution } from './criterionExecutionPublisher.js'
import {
  contractUsesNativePathListCompletion,
  ensureNativePathListVerifierAssignment,
  publishOwnedHostPathListEvidence,
  runOwnedHostPathListVerification,
} from './criterionNativePathListEvidence.js'
import { createTrustedExecutionSupervisorV1, type TrustedExecutionAuthorityV1 } from './trustedExecutionSupervisor.js'
import type { EvidenceNode } from '../evidence/evidenceGraph.js'

/** An opaque read capability; a serialized or caller-made copy has no authority. */
export interface CriterionCompletionContextV1 {
  readonly schema_version: 1
  readonly kind: 'criterion-completion:v1'
}
export interface CriterionCompletionOwnerV1 {
  contract: TaskContractV1 | undefined
  runId: string
  projectRoot: string | null
  filesystemPathListAdmission?: LiveSessionFilesystemPathListAdmissionV1
  candidateRevisionSha?: () => string | null
  hasGovernedMutationLineage?: () => boolean
}

/** Opaque owner request; only the issuing service context may evaluate it. */
export interface PathListVerificationRequestV1 {
  readonly schema_version: 1
  readonly kind: 'path-list-verification:v1'
}

export interface PathListVerificationEvaluationV1 {
  verified: boolean
  errors: string[]
}
export interface CriterionCompletionRequestV1 {
  context: CriterionCompletionContextV1
  contract: TaskContractV1
  run_id: string
  project_root: string
}
export interface CriterionPrivateEvidenceRefreshV1 {
  proof: { compliant: boolean }
  receipt?: BoundChatVerifierReceipt | null
  receipts?: readonly BoundChatVerifierReceipt[] | null
  candidate_sha: string | null
  has_mutation: boolean
}

export interface CriterionCompletionServiceV1 {
  readonly context: CriterionCompletionContextV1
  currentRequest(): CriterionCompletionRequestV1 | undefined
  /** Chat-only: populate the private graph from governed execution before kernel evaluate. */
  refreshPrivateEvidence(input: CriterionPrivateEvidenceRefreshV1): void
  /** Capture native path-list verification from canonical admission + governed mutation lineage. */
  refreshNativePathListEvidence(): void
  pathListVerificationRequest(): PathListVerificationRequestV1 | undefined
  evaluateOwnedPathListVerification(
    request: PathListVerificationRequestV1 | undefined,
  ): PathListVerificationEvaluationV1
  nativePathListProofCompliant(): boolean
}
interface PathListVerificationState {
  verified: boolean
  candidateSha: string
  errors: string[]
}
interface CompletionAuthority {
  readOwner: () => CriterionCompletionOwnerV1
  epoch?: string
  graph: EvidenceGraph
  supervisor: TrustedExecutionAuthorityV1
  candidateSha?: string | undefined
  pathListRequest?: PathListVerificationRequestV1
  pathListState?: PathListVerificationState
}
const contexts = new WeakMap<object, CompletionAuthority>()
const pathListVerificationBindings = new WeakMap<
  PathListVerificationRequestV1,
  { serviceContext: CriterionCompletionContextV1; epoch: string }
>()

function computeOwnerAuthorityEpoch(owner: CriterionCompletionOwnerV1): string | undefined {
  try {
    if (!owner.contract?.frozen || !owner.projectRoot || !isAbsolute(owner.projectRoot)) {
      return undefined
    }
    const root = realpathSync.native(owner.projectRoot)
    const physicalRoot = statSync(root)
    if (!physicalRoot.isDirectory()) return undefined
    return sha256Canonical({
      contract: owner.contract.contract_hash,
      run: owner.runId,
      root,
      device: physicalRoot.dev,
      inode: physicalRoot.ino,
    })
  } catch {
    return undefined
  }
}

/** Revoke path-list handles when owner run/contract/root epoch changes. */
function reconcileCompletionAuthorityEpoch(authority: CompletionAuthority): void {
  const next = computeOwnerAuthorityEpoch(authority.readOwner())
  if (authority.epoch === next) return
  if (next === undefined) delete authority.epoch
  else authority.epoch = next
  clearNativePathListAuthorityState(authority)
}

function snapshotNativePathListNodes(graph: EvidenceGraph): EvidenceNode[] {
  return [...graph.getNodesMap().values()].filter(node =>
    node.id.endsWith(':native-path-list'),
  )
}

function stripNativePathListEvidenceNodes(graph: EvidenceGraph): void {
  for (const id of graph.getNodesMap().keys()) {
    if (id.endsWith(':native-path-list')) graph.removeNode(id)
  }
}

function resyncNativePathListVerifierTrust(authority: CompletionAuthority): void {
  if (snapshotNativePathListNodes(authority.graph).length === 0) return
  try {
    const owner = authority.readOwner()
    if (!owner.contract?.frozen) return
    ensureNativePathListVerifierAssignment({
      supervisor: authority.supervisor,
      runId: owner.runId,
      contract: owner.contract,
    })
  } catch { /* fail closed */ }
}

function clearNativePathListAuthorityState(authority: CompletionAuthority): void {
  stripNativePathListEvidenceNodes(authority.graph)
  if (authority.pathListRequest) {
    pathListVerificationBindings.delete(authority.pathListRequest)
  }
  delete authority.pathListRequest
  delete authority.pathListState
}

function resetCompletionAuthorityWorkspace(authority: CompletionAuthority): void {
  authority.graph = new EvidenceGraph()
  authority.supervisor = createTrustedExecutionSupervisorV1()
  delete authority.candidateSha
  clearNativePathListAuthorityState(authority)
}

function refreshNativePathListEvidenceOnAuthority(
  authority: CompletionAuthority,
  serviceContext: CriterionCompletionContextV1,
): void {
  try {
    reconcileCompletionAuthorityEpoch(authority)
    const owner = authority.readOwner()
    if (!owner.contract?.frozen || !owner.projectRoot || !owner.filesystemPathListAdmission) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_ADMISSION_MISSING'] }
      return
    }
    if (!contractUsesNativePathListCompletion(owner.contract)) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_CONTRACT_UNSUPPORTED'] }
      return
    }
    if (owner.hasGovernedMutationLineage && !owner.hasGovernedMutationLineage()) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_MUTATION_LINEAGE_MISSING'] }
      return
    }
    const revisionBefore = owner.candidateRevisionSha?.() ?? null
    if (!revisionBefore) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_MUTATION_LINEAGE_MISSING'] }
      return
    }
    const verified = runOwnedHostPathListVerification({
      projectRoot: owner.projectRoot,
      contract: owner.contract,
      admission: owner.filesystemPathListAdmission,
      candidateSha: revisionBefore,
    })
    const revisionAfter = owner.candidateRevisionSha?.() ?? null
    if (!verified.ok) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: [verified.code] }
      return
    }
    if (revisionAfter !== revisionBefore) {
      clearNativePathListAuthorityState(authority)
      authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_MUTATION_DURING_VERIFY'] }
      return
    }
    publishOwnedHostPathListEvidence({
      graph: authority.graph,
      supervisor: authority.supervisor,
      contract: owner.contract,
      runId: owner.runId,
      projectRoot: owner.projectRoot,
      admission: owner.filesystemPathListAdmission,
      candidateSha: verified.candidateSha,
      result: verified.result,
    })
    authority.candidateSha = verified.candidateSha
    authority.pathListState = { verified: true, candidateSha: verified.candidateSha, errors: [] }
    if (!authority.pathListRequest) {
      authority.pathListRequest = Object.freeze({
        schema_version: 1,
        kind: 'path-list-verification:v1',
      })
      pathListVerificationBindings.set(authority.pathListRequest, {
        serviceContext,
        epoch: authority.epoch ?? '',
      })
    }
  } catch {
    clearNativePathListAuthorityState(authority)
    authority.pathListState = { verified: false, candidateSha: '', errors: ['PATH_LIST_REFRESH_FAILED'] }
  }
}

/** Compose per-engine authority without accepting a graph or producer assertions. */
export function createCriterionCompletionServiceV1(
  readOwner: () => CriterionCompletionOwnerV1,
): CriterionCompletionServiceV1 {
  const context: CriterionCompletionContextV1 = Object.freeze({ schema_version: 1, kind: 'criterion-completion:v1' })
  contexts.set(context, { readOwner, graph: new EvidenceGraph(), supervisor: createTrustedExecutionSupervisorV1() })
  return Object.freeze({
    context,
    currentRequest(): CriterionCompletionRequestV1 | undefined {
      try {
        const owner = readOwner()
        return owner.contract && owner.projectRoot
          ? Object.freeze({ context, contract: owner.contract, run_id: owner.runId, project_root: owner.projectRoot })
          : undefined
      } catch { return undefined }
    },
    refreshPrivateEvidence(input: CriterionPrivateEvidenceRefreshV1): void {
      if (!input.proof.compliant) return
      const authority = contexts.get(context)
      if (!authority) return
      try {
        const owner = authority.readOwner()
        if (!owner.contract || !owner.projectRoot || !owner.contract.frozen) return
        const root = realpathSync.native(owner.projectRoot)
        const physicalRoot = statSync(root)
        const epoch = sha256Canonical({ contract: owner.contract.contract_hash, run: owner.runId,
          root, device: physicalRoot.dev, inode: physicalRoot.ino })
        if (authority.epoch !== epoch) {
          authority.epoch = epoch
          resetCompletionAuthorityWorkspace(authority)
        } else {
          authority.graph = new EvidenceGraph()
          delete authority.candidateSha
          clearNativePathListAuthorityState(authority)
        }
        const published = publishCriterionEvidenceFromChatExecution({
          graph: authority.graph,
          supervisor: authority.supervisor,
          contract: owner.contract,
          runId: owner.runId,
          projectRoot: root,
          candidateSha: input.candidate_sha,
          proof: input.proof,
          ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
          ...(input.receipts !== undefined ? { receipts: input.receipts } : {}),
          hasMutation: input.has_mutation,
        })
        if (published) authority.candidateSha = published
      } catch { /* fail closed: leave graph empty */ }
    },
    refreshNativePathListEvidence(): void {
      const authority = contexts.get(context)
      if (!authority) return
      refreshNativePathListEvidenceOnAuthority(authority, context)
    },
    pathListVerificationRequest(): PathListVerificationRequestV1 | undefined {
      return contexts.get(context)?.pathListRequest
    },
    evaluateOwnedPathListVerification(
      request: PathListVerificationRequestV1 | undefined,
    ): PathListVerificationEvaluationV1 {
      if (!request) return { verified: false, errors: ['PATH_LIST_REQUEST_MISSING'] }
      const authority = contexts.get(context)
      if (!authority) {
        return { verified: false, errors: ['PATH_LIST_REQUEST_UNTRUSTED'] }
      }
      reconcileCompletionAuthorityEpoch(authority)
      const binding = pathListVerificationBindings.get(request)
      if (
        !binding ||
        binding.serviceContext !== context ||
        !authority.epoch ||
        binding.epoch !== authority.epoch ||
        request !== authority.pathListRequest
      ) {
        return { verified: false, errors: ['PATH_LIST_REQUEST_UNTRUSTED'] }
      }
      refreshNativePathListEvidenceOnAuthority(authority, context)
      return {
        verified: authority.pathListState?.verified === true,
        errors: authority.pathListState?.errors ?? ['PATH_LIST_STATE_MISSING'],
      }
    },
    nativePathListProofCompliant(): boolean {
      const authority = contexts.get(context)
      if (!authority) return false
      refreshNativePathListEvidenceOnAuthority(authority, context)
      return authority.pathListState?.verified === true
    },
  })
}

function unknown(code: string, contract?: TaskContractV1): CompletionEvaluationV1 {
  return {
    status: 'UNKNOWN', verified: false, satisfied_requirements: [],
    missing_requirements: Array.isArray(contract?.acceptance)
      ? contract.acceptance.filter(item => item.required).map(item => item.id) : [],
    errors: [code],
  }
}

function unverified(code: string, contract?: TaskContractV1): CompletionEvaluationV1 {
  const required = Array.isArray(contract?.acceptance)
    ? contract.acceptance.filter(item => item.required).map(item => item.id)
    : []
  return {
    status: 'UNVERIFIED',
    verified: false,
    satisfied_requirements: [],
    missing_requirements: required,
    errors: [code],
  }
}

function resolveCriterionEvaluationCandidateSha(input: {
  contract: TaskContractV1
  repository: string
  authority: CompletionAuthority
}): string | null {
  const bound =
    input.authority.pathListState?.candidateSha ??
    input.authority.candidateSha ??
    null
  if (bound && /^[0-9a-f]{64}$/i.test(bound)) return bound.toLowerCase()
  if (contractUsesNativePathListCompletion(input.contract)) return null
  return sha256Canonical({
    repository: input.repository,
    mode: 'criterion_evaluation_without_mutation_closure',
    contract_hash: input.contract.contract_hash,
  })
}

/** Resolve the owned context and delegate criterion truth to the existing V1 oracle. */
export function evaluateCriterionCompletionV1(
  request?: CriterionCompletionRequestV1,
): CompletionEvaluationV1 {
  try {
    if (!request || typeof request.context !== 'object' || request.context === null)
      return unknown('acceptance_context_missing')
    const authority = contexts.get(request.context)
    if (!authority) return unknown('acceptance_context_untrusted')
    const owner = authority.readOwner()
    if (!request.contract || validateTaskContractV1ForCompletion(request.contract).length ||
      !request.contract.frozen || !owner.contract || !owner.contract.frozen ||
      validateTaskContractV1ForCompletion(owner.contract).length)
      return unknown('acceptance_contract_invalid')
    if (sha256Canonical(owner.contract) !== sha256Canonical(request.contract))
      return unknown('acceptance_head_mismatch', request.contract)
    if (!request.run_id || owner.runId !== request.run_id)
      return unknown('acceptance_run_mismatch', request.contract)
    if (!owner.projectRoot || !isAbsolute(owner.projectRoot) ||
      !request.project_root || !isAbsolute(request.project_root))
      return unknown('acceptance_project_unavailable', request.contract)
    const root = realpathSync.native(owner.projectRoot)
    const requestedRoot = realpathSync.native(request.project_root)
    const physicalRoot = statSync(root)
    if ((process.platform === 'win32' ? root.toLowerCase() !== requestedRoot.toLowerCase() : root !== requestedRoot) ||
      !physicalRoot.isDirectory())
      return unknown('acceptance_project_mismatch', request.contract)
    const epoch = sha256Canonical({ contract: request.contract.contract_hash, run: owner.runId,
      root, device: physicalRoot.dev, inode: physicalRoot.ino })
    if (authority.epoch !== epoch) {
      authority.epoch = epoch
      resetCompletionAuthorityWorkspace(authority)
    }
    resyncNativePathListVerifierTrust(authority)
    if (contractUsesNativePathListCompletion(owner.contract)) {
      refreshNativePathListEvidenceOnAuthority(authority, request.context)
    }
    const candidateSha = resolveCriterionEvaluationCandidateSha({
      contract: owner.contract,
      repository: root,
      authority,
    })
    if (!candidateSha) {
      return unverified('acceptance_candidate_revision_missing', owner.contract)
    }
    return evaluateCompletionGateV1({
      contract: owner.contract, graph: authority.graph, repository: root,
      candidate_sha: candidateSha, run_id: owner.runId,
      trusted_execution: authority.supervisor.read, project_root: root,
    })
  } catch {
    return unknown('acceptance_context_unavailable')
  }
}
