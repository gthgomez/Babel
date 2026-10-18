import { realpathSync } from 'node:fs'
import { buildAgentEndpointV1 } from '../agent/agentEndpoint.js'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { TaskContractV1 } from '../agent/taskContract.js'
import {
  toRevisionBoundReceipt,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js'
import { RevisionManager } from '../evidence/revisionBoundReceipt.js'
import {
  EvidenceGraph,
  type EvidenceNode,
} from '../evidence/evidenceGraph.js'
import type { TrustedExecutionAuthorityV1 } from './trustedExecutionSupervisor.js'

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

function verificationSpecHash(requirement: TaskContractV1['acceptance'][number]): string {
  return sha256Canonical(requirement.verification)
}

function buildCriterionReceiptNode(input: {
  requirement: TaskContractV1['acceptance'][number]
  bound: ReturnType<typeof toRevisionBoundReceipt>
  repository: string
  runId: string
  contract: TaskContractV1
  candidateSha: string
}): EvidenceNode | null {
  if (!input.bound) return null
  const data: Record<string, unknown> = {
    ...input.bound,
    verifier_id: input.requirement.verification.verifier_id,
    verifier_spec_hash: verificationSpecHash(input.requirement),
    ...(input.requirement.verification.command_hash !== undefined
      ? { command_hash: input.requirement.verification.command_hash }
      : {}),
  }
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
  const bound = toRevisionBoundReceipt(input.receipt)
  if (!bound || bound.exitCode !== 0 || bound.stale === true) return null
  const repository = realpathSync.native(input.projectRoot)
  const revisionSha = bound.boundRevision.compositeTreeHash
  if (!revisionSha || input.candidateSha !== revisionSha) return null
  const stale = RevisionManager.isReceiptStaleSync(bound, repository)
  if (stale.stale) return null
  ensureGovernedVerifierAssignment({
    supervisor: input.supervisor,
    runId: input.runId,
    contract: input.contract,
  })
  for (const requirement of input.contract.acceptance.filter(item => item.required)) {
    const node = buildCriterionReceiptNode({
      requirement,
      bound,
      repository,
      runId: input.runId,
      contract: input.contract,
      candidateSha: revisionSha,
    })
    if (node) input.graph.addNode(node)
  }
  return revisionSha
}
