import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { bindChatVerifierReceipt, toExecutorVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { RevisionManager } from '../evidence/revisionBoundReceipt.js'
import { createCriterionCompletionServiceV1, evaluateCriterionCompletionV1 } from '../authority/criterionCompletion.js'
import { createExecutorKernel } from './kernel.js'
import type { ExecutorVerifierReceipt } from './contracts.js'

for (const rootForm of ['direct', 'alias'] as const)
test(`owned criterion acceptance rejects weaker red, stale or wrong-context proof (${rootForm})`, async () => {
  const base = mkdtempSync(join(tmpdir(), 'babel-kernel-proof-'))
  const physical = join(base, 'project')
  mkdirSync(physical)
  const root = rootForm === 'alias' ? join(base, 'linked') : physical
  try {
    if (rootForm === 'alias') symlinkSync(physical, root, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(root, 'value.cjs'), 'module.exports = 1\n')
    writeFileSync(join(root, 'value.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('value', () => assert.equal(require('./value.cjs'), 1));\n")
    const env = { ...process.env }; delete env['NODE_TEST_CONTEXT']
    const executed = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(executed.status, 0)
    assert.match(executed.stdout, /# pass 1/)
    const contract = freezeTaskContract(buildTaskContractV1({ mode: 'chat', user_request: 'Fix and run node --test.', acceptance: [{
      id: 'node', description: 'node tests pass', type: 'unit_test', required: true, verification_strategy: 'Run node --test.',
      verification: { kind: 'unit_test', verifier_id: 'verifier:node', executable_id: 'node', argv: ['--test'], command_hash: sha256Canonical({ executable_id: 'node', argv: ['--test'] }) },
    }] }))
    const service = createCriterionCompletionServiceV1(() => ({ contract, runId: 'run', projectRoot: root }))
    // Freeze host ownership from the physical project, not its invocation spelling.
    // The raw root remains the actual spawn/service input (including junctions).
    const verifierOwner = { workspaceRoot: realpathSync.native(root), taskId: contract.task_id,
      contractHash: contract.contract_hash, sessionId: 'session' }
    const executionContext = { workspaceRoot: verifierOwner.workspaceRoot, taskId: verifierOwner.taskId, contractHash: verifierOwner.contractHash,
      workingDirectory: verifierOwner.workspaceRoot, environmentFingerprint: 'frozen-env', targetSelectors: [] }
    const green = await bindChatVerifierReceipt({ projectRoot: root, command: 'node --test', exit_code: 0, summary: executed.stdout, mutationPaths: ['value.cjs'],
      structured: { verifierId: 'verifier:node', authoritySource: 'built_in_runner', executable: 'node', args: ['--test'] }, executionContext })
    green.tests_total = 1; green.tests_skipped = 0; green.tests_failed = 0
    green.order = { sessionId: 'session', seq: 1 }
    const candidate = RevisionManager.computeRevisionSync(root, ['value.cjs']).compositeTreeHash
    service.refreshPrivateEvidence({ proof: { compliant: true }, receipt: green, candidate_sha: candidate, has_mutation: true })
    const acceptance = service.currentRequest()
    assert.equal(evaluateCriterionCompletionV1(acceptance).verified, true, 'negative controls use real owned criterion acceptance')
    const adapted = toExecutorVerifierReceipt(green)
    assert.equal(adapted.ok, true)
    if (!adapted.ok) return
    const kernel = createExecutorKernel('chat')
    const decide = (receipts: ExecutorVerifierReceipt[], currentWorkspaceRevisionHash = candidate) => kernel.completion.decide({
      mode: 'chat', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true, verificationPolicy: 'required', toolCallLog: [],
      requiredVerifierCommands: ['node --test'], requiredVerifiers: [{ command: 'node --test', executionContext, requiredScope: 'full_suite', greenRequired: true }],
      verifierOwner,
      executedVerifierLedger: receipts, currentWorkspaceRevisionHash, proof: { compliant: true }, acceptance,
    })
    assert.equal(decide([adapted.receipt]).finalOutcome, 'VERIFIED_COMPLETE')
    for (const receipts of [
      [{ ...adapted.receipt, exitCode: 1 }], [{ ...adapted.receipt, stale: true }],
      [{ ...adapted.receipt, executionContext: { ...executionContext, workingDirectory: join(root, 'other') } }],
      [{ ...adapted.receipt, executionContext: { ...executionContext, environmentFingerprint: 'unrelated-env' } }],
      [{ ...adapted.receipt, order: { sessionId: 'session', seq: 0 }, summary: 'VERIFIER_DEF_TAMPERED', stale: true }, adapted.receipt],
    ]) {
      const decision = decide(receipts)
      assert.equal(decision.allowed, false)
      assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH')
    }
    assert.equal(decide([adapted.receipt], 'wrong-current-revision').finalOutcome, 'UNVERIFIED_PATCH')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
