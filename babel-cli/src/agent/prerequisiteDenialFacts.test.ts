/**
 * Unit witnesses for isolation prerequisite facts (not full ChatEngine transport proof).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindIsolationPrerequisiteScope,
  isolationPrerequisiteRevisionKey,
  shellBlockedByIsolation,
} from './capabilityRecoveryScope.js'
import { evaluateExecuteCompletionHonesty } from './completionGatePolicy.js'
import { ProgressController } from './progressController.js'
import { satisfiesVerifierRequirement } from '../services/verifierIdentity.js'

const NPM_TEST = 'npm test'
const UNRELATED = 'node -e "void 0"'

function isolationHost(over: {
  taskOwnerId?: string
  hostFallbackAllowed?: boolean
  engineRunId?: string
} = {}) {
  const progressController = new ProgressController()
  const hostFallbackAllowed = over.hostFallbackAllowed ?? false
  return {
    progressController,
    engineRunId: over.engineRunId ?? 'run-p2-fact',
    executionProfile: 'safe_repo',
    taskAllowance: { taskOwnerId: over.taskOwnerId ?? 'owner-fact-1' },
    options: { projectRoot: '/tmp/p2-fact-proj', model: 'opencode-go/deepseek-v4.1-flash' },
    isolationBrokerFlags: () => ({
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed,
      dirtyTree: false,
    }),
  }
}

test('bindIsolationPrerequisiteScope ties taskId to durable taskOwnerId', () => {
  const host = isolationHost({ taskOwnerId: 'owner-abc' })
  const scope = bindIsolationPrerequisiteScope(host)
  assert.equal(scope.taskId, 'owner-abc')
  assert.equal(scope.prerequisiteKey, 'isolation_unavailable:shell')
  assert.equal(scope.revisionKey, '1:0:0')
})

test('isolationPrerequisiteRevisionKey re-arms only when host fallback flips', () => {
  const blocked = { isolationRequired: true, isolationAvailable: false, hostFallbackAllowed: false, dirtyTree: false }
  const open = { ...blocked, hostFallbackAllowed: true }
  assert.equal(isolationPrerequisiteRevisionKey(blocked), '1:0:0')
  assert.equal(isolationPrerequisiteRevisionKey(open), '1:0:1')
  assert.notEqual(isolationPrerequisiteRevisionKey(blocked), isolationPrerequisiteRevisionKey(open))
})

test('shellBlockedByIsolation matches safe_repo broker gate', () => {
  assert.equal(
    shellBlockedByIsolation({
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: false,
      dirtyTree: true,
    }),
    true,
  )
  assert.equal(
    shellBlockedByIsolation({
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: true,
      dirtyTree: false,
    }),
    false,
  )
})

test('prerequisite denial probe: one broker evaluation per revision (reservation not second denial)', () => {
  const pc = new ProgressController()
  pc.setTrustedEnvironmentIdentity('env-fact')
  const scope = {
    prerequisiteKey: 'isolation_unavailable:shell',
    taskId: 'owner-fact-1',
    environmentIdentity: 'env-fact',
    revisionKey: '1:0:0',
  }
  assert.equal(pc.admitPrerequisiteDenialProbe(scope), true)
  assert.equal(pc.admitPrerequisiteDenialProbe(scope), false)
  assert.equal(pc.hasConsumedPrerequisiteDenialProbe(scope), true)
})

test('unrelated blocked shell receipt does not satisfy explicit npm test required verifier', () => {
  const unrelatedBlocked = {
    command: UNRELATED,
    exit_code: 1,
    summary: 'blocked',
    authority: false,
    error: 'blocked',
  }
  assert.equal(satisfiesVerifierRequirement(NPM_TEST, unrelatedBlocked.command ?? ''), false)
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    lastVerifierReceipt: unrelatedBlocked,
    executedVerifierLedger: [unrelatedBlocked],
    verifierEvidenceErrors: [],
    requiredVerifierCommands: [NPM_TEST],
    toolCallLog: [],
  })
  assert.equal(honesty.allow, false)
  assert.equal(honesty.reason, 'verifier_missing')
})

test('empty required verifier list keeps conservative missing-verifier honesty', () => {
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    lastVerifierReceipt: null,
    executedVerifierLedger: [],
    verifierEvidenceErrors: [],
    requiredVerifierCommands: [],
    toolCallLog: [],
  })
  assert.equal(honesty.allow, false)
})
