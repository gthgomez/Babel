import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EvidenceGraph,
  evaluateCompletionGateV1,
  type EvidenceNode,
} from './evidenceGraph.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID } from '../agent/pathListHostDeclaredClarification.js'
import { sha256Canonical } from '../acceptance/canonical.js'
import { createTrustedExecutionSupervisorV1 } from '../authority/trustedExecutionSupervisor.js'
import { buildAgentEndpointV1 } from '../agent/agentEndpoint.js'

const RUN_ID = 'run:exit-code-fixture'

function lintContract() {
  const verification = {
    kind: 'lint' as const,
    verifier_id: 'fixture:lint',
    command_hash: sha256Canonical('npm run lint'),
  }
  return freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      task_id: 'task-lint',
      user_request: 'lint',
      acceptance: [
        {
          id: 'lint',
          description: 'lint',
          type: 'lint',
          required: true,
          verification_strategy: 'lint',
          verification,
        },
      ],
    }),
  )
}

function trustedFor(contract: ReturnType<typeof lintContract>) {
  const supervisor = createTrustedExecutionSupervisorV1()
  const endpoint = buildAgentEndpointV1({
    endpoint_id: 'fixture:lint',
    identity: 'fixture:lint',
    harness: 'babel-chat',
    model: 'governed',
    provider: 'babel',
    capabilities: ['inspect_repository'],
    location: 'local',
    execution_domain: 'host-process',
  })
  supervisor.assign({
    run_id: RUN_ID,
    task_id: contract.task_id,
    contract_hash: contract.contract_hash,
    role: 'verifier',
    endpoint,
  })
  return supervisor.read
}

function lintCommandNode(
  contract: ReturnType<typeof lintContract>,
  data: Record<string, unknown>,
): EvidenceNode {
  const verification = contract.acceptance[0]!.verification
  return {
    id: 'criterion:lint:command',
    type: 'command_result',
    data: {
      status: 'passed',
      passed: true,
      verifier_kind: 'lint',
      verifier_id: verification.verifier_id,
      verifier_spec_hash: sha256Canonical(verification),
      command_hash: verification.command_hash,
      ...data,
    },
    parents: [],
    binding: {
      run_id: RUN_ID,
      task_id: contract.task_id,
      contract_hash: contract.contract_hash,
      repository: '/repo',
      base_sha: null,
      candidate_sha: 'candidate',
      requirement_id: 'lint',
    },
    producer_role: 'verifier',
    producer_identity: {
      kind: 'agent_endpoint',
      endpoint_id: 'fixture:lint',
      role: 'verifier',
      execution_domain: 'host-process',
    },
  }
}

test('certifying command_result rejects missing exit_code', () => {
  const contract = lintContract()
  const graph = new EvidenceGraph()
  graph.addNode(lintCommandNode(contract, {}))
  const evaluation = evaluateCompletionGateV1({
    graph,
    contract,
    run_id: RUN_ID,
    project_root: '/repo',
    candidate_sha: 'candidate',
    repository: '/repo',
    trusted_execution: trustedFor(contract),
  })
  assert.equal(evaluation.verified, false)
  assert.match(evaluation.errors.join(' '), /exit_code/)
})

test('admitted native path-list policy_result may omit exit_code', () => {
  const verification = {
    kind: 'policy' as const,
    verifier_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
    target: 'target-hash',
  }
  const contract = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      task_id: 'task-paths',
      user_request: 'paths',
      acceptance: [
        {
          id: 'paths',
          description: 'paths',
          type: 'policy',
          required: true,
          verification_strategy: 'native path list',
          verification,
        },
      ],
    }),
  )
  const supervisor = createTrustedExecutionSupervisorV1()
  const endpoint = buildAgentEndpointV1({
    endpoint_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
    identity: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
    harness: 'babel-chat',
    model: 'governed',
    provider: 'babel',
    capabilities: ['inspect_repository'],
    location: 'local',
    execution_domain: 'host-process',
  })
  supervisor.assign({
    run_id: RUN_ID,
    task_id: contract.task_id,
    contract_hash: contract.contract_hash,
    role: 'verifier',
    endpoint,
  })
  const graph = new EvidenceGraph()
  graph.addNode({
    id: 'criterion:paths:native-path-list',
    type: 'policy_result',
    data: {
      verifier_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
      verifier_spec_hash: sha256Canonical(verification),
      target: 'target-hash',
      status: 'passed',
      passed: true,
      result_digest: 'digest',
      inventory_evidence_mode: 'git_head',
    },
    parents: [],
    binding: {
      run_id: RUN_ID,
      task_id: contract.task_id,
      contract_hash: contract.contract_hash,
      repository: '/repo',
      base_sha: null,
      candidate_sha: 'candidate',
      requirement_id: 'paths',
    },
    producer_role: 'verifier',
    producer_identity: {
      kind: 'agent_endpoint',
      endpoint_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
      role: 'verifier',
      execution_domain: 'host-process',
    },
  })
  const evaluation = evaluateCompletionGateV1({
    graph,
    contract,
    run_id: RUN_ID,
    project_root: '/repo',
    candidate_sha: 'candidate',
    repository: '/repo',
    trusted_execution: supervisor.read,
  })
  assert.equal(evaluation.verified, true)
  assert.deepEqual(evaluation.satisfied_requirements, ['paths'])
})
