import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { validateTaskContractV1ForCompletion, type TaskContractV1 } from '../agent/taskContract.js'
import { EvidenceGraph, evaluateCompletionGateV1, type CompletionEvaluationV1 } from '../evidence/evidenceGraph.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { publishCriterionEvidenceFromChatExecution } from './criterionExecutionPublisher.js'
import { createTrustedExecutionSupervisorV1, type TrustedExecutionAuthorityV1 } from './trustedExecutionSupervisor.js'

/** An opaque read capability; a serialized or caller-made copy has no authority. */
export interface CriterionCompletionContextV1 {
  readonly schema_version: 1
  readonly kind: 'criterion-completion:v1'
}
export interface CriterionCompletionOwnerV1 {
  contract: TaskContractV1 | undefined
  runId: string
  projectRoot: string | null
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
}
interface CompletionAuthority {
  readOwner: () => CriterionCompletionOwnerV1
  epoch?: string
  graph: EvidenceGraph
  supervisor: TrustedExecutionAuthorityV1
  candidateSha?: string | undefined
}
const contexts = new WeakMap<object, CompletionAuthority>()

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
          authority.graph = new EvidenceGraph()
          authority.supervisor = createTrustedExecutionSupervisorV1()
          delete authority.candidateSha
        }
        authority.graph = new EvidenceGraph()
        delete authority.candidateSha
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
      authority.graph = new EvidenceGraph()
      authority.supervisor = createTrustedExecutionSupervisorV1()
      delete authority.candidateSha
    }
    const candidateSha = authority.candidateSha ?? 'unobserved'
    return evaluateCompletionGateV1({
      contract: owner.contract, graph: authority.graph, repository: root,
      candidate_sha: candidateSha, run_id: owner.runId,
      trusted_execution: authority.supervisor.read, project_root: root,
    })
  } catch {
    return unknown('acceptance_context_unavailable')
  }
}
