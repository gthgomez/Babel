import { realpathSync } from 'node:fs'
import { buildAgentEndpointV1 } from '../agent/agentEndpoint.js'
import type { TaskContractV1 } from '../agent/taskContract.js'
import {
  resolveGovernedCriterionCandidateRevisionSha,
  toRevisionBoundReceipt,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js'
import {
  EvidenceGraph,
  type EvidenceNode,
} from '../evidence/evidenceGraph.js'
import type { TrustedExecutionAuthorityV1 } from './trustedExecutionSupervisor.js'
import {
  buildCriterionReceiptEvidenceData,
  chatReceiptDispatchesToRequirement,
} from './criterionVerifierDispatch.js'

export const CHAT_CRITERION_VERIFIER_ENDPOINT_ID = 'verifier:chat-governed'

function chatCriterionVerifierEndpoint() {
  return buildAgentEndpointV1({
    endpoint_id: CHAT_CRITERION_VERIFIER_ENDPOINT_ID,
    identity: CHAT_CRITERION_VERIFIER_ENDPOINT_ID,
    harness: 'babel-chat',
    model: 'governed',
    provider: 'babel',
    capabilities: [
      'run_tests',
      'run_build',
      'run_lint',
      'run_typecheck',
      'run_local_command',
      'inspect_repository',
    ],
    location: 'local',
    execution_domain: 'isolated-verifier',
  })
}

function ensureGovernedVerifierAssignment(input: {
  supervisor: TrustedExecutionAuthorityV1
  runId: string
  contract: TaskContractV1
}): void {
  const endpoint = chatCriterionVerifierEndpoint()
  if (input.supervisor.read.get(input.runId, endpoint.endpoint_id)) return
  input.supervisor.assign({
    run_id: input.runId,
    task_id: input.contract.task_id,
    contract_hash: input.contract.contract_hash,
    role: 'verifier',
    endpoint,
  })
}

function buildCriterionReceiptNode(input: {
  requirement: TaskContractV1['acceptance'][number]
  bound: ReturnType<typeof toRevisionBoundReceipt>
  receipt: BoundChatVerifierReceipt
  repository: string
  runId: string
  contract: TaskContractV1
  candidateSha: string
}): EvidenceNode | null {
  if (!input.bound) return null
  const data = buildCriterionReceiptEvidenceData(
    input.requirement,
    input.bound,
    input.receipt,
  )
  if (!data) return null
  return {
    id: `criterion:${input.requirement.id}`,
    type: 'verifier_receipt',
    data,
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
      endpoint_id: CHAT_CRITERION_VERIFIER_ENDPOINT_ID,
      role: 'verifier',
      execution_domain: 'isolated-verifier',
    },
  }
}

/** Publish governed Chat execution into the private criterion evidence graph. */
export function publishCriterionEvidenceFromChatExecution(input: {
  graph: EvidenceGraph
  supervisor: TrustedExecutionAuthorityV1
  contract: TaskContractV1
  runId: string
  projectRoot: string
  candidateSha: string | null
  proof: { compliant: boolean }
  receipt: BoundChatVerifierReceipt | null
  hasMutation: boolean
}): string | null {
  if (
    !input.proof.compliant ||
    !input.hasMutation ||
    !input.candidateSha ||
    !input.receipt ||
    input.receipt.exit_code !== 0
  ) {
    return null
  }
  const repository = realpathSync.native(input.projectRoot)
  const revisionSha = resolveGovernedCriterionCandidateRevisionSha(
    repository,
    input.receipt,
  )
  if (!revisionSha || input.candidateSha !== revisionSha) return null
  const bound = toRevisionBoundReceipt(input.receipt)
  if (!bound || bound.exitCode !== 0 || bound.stale === true) return null

  const required = input.contract.acceptance.filter(item => item.required)
  if (required.length === 0) return null

  const nodes: EvidenceNode[] = []
  for (const requirement of required) {
    if (!chatReceiptDispatchesToRequirement(input.receipt, requirement)) return null
    const node = buildCriterionReceiptNode({
      requirement,
      bound,
      receipt: input.receipt,
      repository,
      runId: input.runId,
      contract: input.contract,
      candidateSha: revisionSha,
    })
    if (!node) return null
    nodes.push(node)
  }

  ensureGovernedVerifierAssignment({
    supervisor: input.supervisor,
    runId: input.runId,
    contract: input.contract,
  })
  for (const node of nodes) input.graph.addNode(node)
  return revisionSha
}
