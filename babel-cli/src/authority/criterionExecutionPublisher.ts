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
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'
import {
  buildCriterionReceiptEvidenceData,
  chatReceiptMatchesRequirement,
} from './criterionVerifierDispatch.js'

export const CHAT_CRITERION_VERIFIER_ENDPOINT_ID = 'verifier:chat-governed'
const TEST_VERIFIER_FAMILIES = new Set([
  'npm-test', 'node-test', 'pytest', 'unittest', 'doctest', 'jest', 'vitest', 'mocha',
  'go-test', 'cargo-test', 'gradle-test', 'deno-test', 'dotnet-test',
  'npx-pytest', 'npx-ava', 'npx-tap', 'npx-uvu',
])

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

function hasAdmissibleCriterionResult(
  requirement: TaskContractV1['acceptance'][number],
  receipt: BoundChatVerifierReceipt,
): boolean {
  if (receipt.exit_code !== 0 || (receipt.tests_failed ?? 0) > 0
    || (receipt.tests_failed !== undefined && !Number.isSafeInteger(receipt.tests_failed))) return false
  const isTestCriterion = requirement.type === 'unit_test'
    || requirement.type === 'integration_test'
    || requirement.type === 'e2e'
  const family = analyzeVerifierIdentity(receipt.command)?.family.toLowerCase() ?? ''
  const isTestCommand = TEST_VERIFIER_FAMILIES.has(family) || family.startsWith('npm-run-test:')
  if (typeof receipt.tests_total === 'number' || typeof receipt.tests_skipped === 'number') {
    const total = receipt.tests_total
    const skipped = receipt.tests_skipped ?? 0
    if (total === undefined || !Number.isSafeInteger(total) || total < 0
      || !Number.isSafeInteger(skipped) || skipped < 0 || skipped > total) return false
    if (total > 0 && skipped >= total) return false
  }
  if (!isTestCriterion && !isTestCommand) {
    return true
  }
  const total = receipt.tests_total
  const skipped = receipt.tests_skipped ?? 0
  return typeof total === 'number' && Number.isFinite(total) && total > 0
    && Number.isFinite(skipped) && skipped >= 0 && skipped < total
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
  allowPartialEvidence?: boolean
  receipt?: BoundChatVerifierReceipt | null
  receipts?: readonly BoundChatVerifierReceipt[] | null
  hasMutation: boolean
}): string | null {
  const ledger = [
    ...(input.receipts ?? []),
    ...(input.receipt ? [input.receipt] : []),
  ].filter((entry, index, all) => all.indexOf(entry) === index)
  if (
    (!input.proof.compliant && input.allowPartialEvidence !== true) ||
    !input.hasMutation ||
    !input.candidateSha ||
    ledger.length === 0
  ) {
    return null
  }
  const repository = realpathSync.native(input.projectRoot)
  const required = input.contract.acceptance.filter(item => item.required)
  if (required.length === 0) return null

  const dispatches: Array<{
    requirement: TaskContractV1['acceptance'][number]
    receipt: BoundChatVerifierReceipt
  }> = []
  const latestAttemptFor = (
    requirement: TaskContractV1['acceptance'][number],
  ): BoundChatVerifierReceipt | undefined => {
    const matching = ledger.filter(receipt => chatReceiptMatchesRequirement(receipt, requirement))
    if (matching.length < 2) return matching[0]
    if (matching.some(receipt => !receipt.order || !Number.isSafeInteger(receipt.order.seq) || receipt.order.seq < 0)) return undefined
    const ordered = [...matching].sort((left, right) => left.order!.seq - right.order!.seq)
    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index - 1]!.order!.seq === ordered[index]!.order!.seq &&
        JSON.stringify(ordered[index - 1]) !== JSON.stringify(ordered[index])) return undefined
    }
    return ordered.at(-1)
  }
  // Evidence is criterion-scoped: a missing verifier for one requirement must
  // not erase an independently dispatched receipt for another requirement.
  // A later red attempt supersedes an earlier green receipt for that criterion;
  // the completion evaluator still requires every required criterion before it
  // can return VERIFIED.
  for (const requirement of required) {
    const receipt = latestAttemptFor(requirement)
    if (receipt && hasAdmissibleCriterionResult(requirement, receipt)) dispatches.push({ requirement, receipt })
  }

  const nodes: EvidenceNode[] = []
  let revisionSha: string | null = null
  for (const { requirement, receipt } of dispatches) {
    const candidateRevision = resolveGovernedCriterionCandidateRevisionSha(
      repository,
      receipt,
    )
    if (!candidateRevision || input.candidateSha !== candidateRevision) continue
    const bound = toRevisionBoundReceipt(receipt)
    if (!bound || bound.exitCode !== 0 || bound.stale === true) continue
    revisionSha = candidateRevision
    const node = buildCriterionReceiptNode({
      requirement,
      bound,
      receipt,
      repository,
      runId: input.runId,
      contract: input.contract,
      candidateSha: candidateRevision,
    })
    if (!node) continue
    nodes.push(node)
  }
  if (!revisionSha || nodes.length === 0) return null

  ensureGovernedVerifierAssignment({
    supervisor: input.supervisor,
    runId: input.runId,
    contract: input.contract,
  })
  for (const node of nodes) input.graph.addNode(node)
  return revisionSha
}
