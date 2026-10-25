import { realpathSync } from 'node:fs'
import { sha256Canonical } from '../acceptance/canonical.js'
import { verifyFilesystemPathList } from './filesystemPathListVerifier.js'
import type { LiveSessionFilesystemPathListAdmissionV1 } from '../agent/liveSessionFilesystemPathListAdmission.js'
import type { AcceptanceRequirementV1, TaskContractV1 } from '../agent/taskContract.js'
import { HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID } from '../agent/pathListHostDeclaredClarification.js'
import { buildAgentEndpointV1 } from '../agent/agentEndpoint.js'
import type { EvidenceGraph, EvidenceNode } from '../evidence/evidenceGraph.js'
import type { TrustedExecutionAuthorityV1 } from './trustedExecutionSupervisor.js'
import type { FilesystemPathListVerifierResultV1 } from './filesystemPathListVerifier.js'

export const NATIVE_PATH_LIST_COMPLETION_ENDPOINT_ID = HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID

export function isHostPathListAcceptanceRequirement(
  requirement: AcceptanceRequirementV1,
): boolean {
  return requirement.verification.verifier_id === HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID
}

export function contractUsesNativePathListCompletion(
  contract: TaskContractV1,
): boolean {
  const required = contract.acceptance.filter(item => item.required)
  return (
    required.length > 0 &&
    required.every(item => isHostPathListAcceptanceRequirement(item))
  )
}

function nativePathListVerifierEndpoint() {
  return buildAgentEndpointV1({
    endpoint_id: NATIVE_PATH_LIST_COMPLETION_ENDPOINT_ID,
    identity: NATIVE_PATH_LIST_COMPLETION_ENDPOINT_ID,
    harness: 'babel-chat',
    model: 'governed',
    provider: 'babel',
    capabilities: ['inspect_repository'],
    location: 'local',
    execution_domain: 'host-process',
  })
}

export function ensureNativePathListVerifierAssignment(input: {
  supervisor: TrustedExecutionAuthorityV1
  runId: string
  contract: TaskContractV1
}): void {
  const endpoint = nativePathListVerifierEndpoint()
  if (input.supervisor.read.get(input.runId, endpoint.endpoint_id)) return
  input.supervisor.assign({
    run_id: input.runId,
    task_id: input.contract.task_id,
    contract_hash: input.contract.contract_hash,
    role: 'verifier',
    endpoint,
  })
}

function verificationSpecHash(requirement: AcceptanceRequirementV1): string {
  return sha256Canonical(requirement.verification)
}

function resultDigest(result: FilesystemPathListVerifierResultV1): string {
  return sha256Canonical({
    status: result.status,
    declaration_hash: result.declaration_hash,
    checks: result.checks,
    inventory_missing_paths: result.inventory_missing_paths,
    inventory_extra_paths: result.inventory_extra_paths,
    preserved_drift_paths: result.preserved_drift_paths,
  })
}

export function buildHostPathListPolicyEvidenceNode(input: {
  requirement: AcceptanceRequirementV1
  contract: TaskContractV1
  runId: string
  repository: string
  candidateSha: string
  result: FilesystemPathListVerifierResultV1
}): EvidenceNode {
  return {
    id: `criterion:${input.requirement.id}:native-path-list`,
    type: 'policy_result',
    data: {
      verifier_id: input.requirement.verification.verifier_id,
      verifier_spec_hash: verificationSpecHash(input.requirement),
      target: input.requirement.verification.target,
      status: 'passed',
      passed: true,
      result_digest: resultDigest(input.result),
      inventory_evidence_mode: input.result.inventory_evidence_mode,
    },
    parents: [],
    binding: {
      run_id: input.runId,
      task_id: input.contract.task_id,
      contract_hash: input.contract.contract_hash,
      repository: input.repository,
      base_sha: input.contract.base_sha,
      candidate_sha: input.candidateSha,
      requirement_id: input.requirement.id,
    },
    producer_role: 'verifier',
    producer_identity: {
      kind: 'agent_endpoint',
      endpoint_id: NATIVE_PATH_LIST_COMPLETION_ENDPOINT_ID,
      role: 'verifier',
      execution_domain: 'host-process',
    },
  }
}

export function runOwnedHostPathListVerification(input: {
  projectRoot: string
  contract: TaskContractV1
  admission: LiveSessionFilesystemPathListAdmissionV1
  candidateSha: string | null
}): { ok: true; result: FilesystemPathListVerifierResultV1; candidateSha: string } | { ok: false; code: string } {
  if (!input.admission.declaration.acceptance_clarification) {
    return { ok: false, code: 'PATH_LIST_CLARIFICATION_ABSENT' }
  }
  const binding = input.admission.declaration.acceptance_clarification
  const row = input.contract.acceptance.find(
    item => item.id === binding.target_criterion_id,
  )
  if (!row || !isHostPathListAcceptanceRequirement(row)) {
    return { ok: false, code: 'PATH_LIST_CRITERION_UNBOUND' }
  }
  if (!input.candidateSha) {
    return { ok: false, code: 'PATH_LIST_MUTATION_LINEAGE_MISSING' }
  }
  const root = realpathSync.native(input.projectRoot)
  const result = verifyFilesystemPathList(
    root,
    input.admission.declaration,
    input.admission.preserved_baseline,
  )
  if (result.status !== 'passed') {
    return { ok: false, code: `PATH_LIST_VERIFY_${result.status}` }
  }
  return { ok: true, result, candidateSha: input.candidateSha }
}

export function publishOwnedHostPathListEvidence(input: {
  graph: EvidenceGraph
  supervisor: TrustedExecutionAuthorityV1
  contract: TaskContractV1
  runId: string
  projectRoot: string
  admission: LiveSessionFilesystemPathListAdmissionV1
  candidateSha: string
  result: FilesystemPathListVerifierResultV1
}): void {
  const requirement = input.contract.acceptance.find(item =>
    isHostPathListAcceptanceRequirement(item),
  )
  if (!requirement) return
  const repository = realpathSync.native(input.projectRoot)
  ensureNativePathListVerifierAssignment({
    supervisor: input.supervisor,
    runId: input.runId,
    contract: input.contract,
  })
  const node = buildHostPathListPolicyEvidenceNode({
    requirement,
    contract: input.contract,
    runId: input.runId,
    repository,
    candidateSha: input.candidateSha,
    result: input.result,
  })
  if (input.graph.getNode(node.id)) return
  input.graph.addNode(node)
}
