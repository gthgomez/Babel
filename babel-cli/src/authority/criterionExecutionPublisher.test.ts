import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { inferTaskAcceptance } from '../agent/taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import {
  bindChatVerifierReceipt,
  resolveGovernedCriterionCandidateRevisionSha,
} from '../evidence/chatRevisionBinding.js'
import {
  createCriterionCompletionServiceV1,
  evaluateCriterionCompletionV1,
} from './criterionCompletion.js'

const NPM_VERIFIER_ID = 'verifier:npm'
const NPM_ARGV = ['test']

function npmTestRequirement(id: string, description: string) {
  return {
    id,
    description,
    type: 'unit_test' as const,
    required: true,
    verification_strategy: 'Run npm test on the fixture.',
    verification: {
      kind: 'unit_test',
      verifier_id: NPM_VERIFIER_ID,
      executable_id: 'npm',
      argv: NPM_ARGV,
      command_hash: sha256Canonical({ executable_id: 'npm', argv: NPM_ARGV }),
    },
  }
}

const GOVERNED_EXECUTION = {
  working_directory: '.',
  environment_policy: 'host-process',
} as const

async function npmTestReceipt(root: string, mutationPaths: string[]) {
  return bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 0,
    summary: 'ok',
    mutationPaths,
    structured: {
      verifierId: NPM_VERIFIER_ID,
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['test'],
    },
    execution: GOVERNED_EXECUTION,
  })
}

async function fixtureWithAcceptance(
  t: TestContext,
  acceptance: ReturnType<typeof buildTaskContractV1>['acceptance'],
) {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-publish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'parser.ts'), 'export const v = 1;\n')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }),
  )
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: 'Fix the fixture and run npm test.',
    acceptance,
  }))
  const owner = { contract, runId: 'publish-run', projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const receipt = await npmTestReceipt(root, ['parser.ts'])
  assert.ok(receipt)
  return { root, service, receipt, request: service.currentRequest()! }
}

test('governed chat execution publishes criterion evidence only for dispatched frozen checks', async t => {
  const { root, service, receipt, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.status, 'VERIFIED')
})

test('unresolved inferred acceptance stays fail-closed despite a green npm test receipt', async t => {
  const task = 'Investigate why parser_test fails and fix it.'
  const meaning = inferTaskAcceptance(task)
  assert.equal(meaning.unresolved, true)
  const { root, service, receipt, request } = await fixtureWithAcceptance(t, meaning.criteria)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('an unrelated green verifier cannot manufacture criterion evidence', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const lint = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm run lint',
    exit_code: 0,
    summary: 'ok',
    mutationPaths: ['parser.ts'],
    structured: {
      verifierId: 'verifier:npm',
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['run', 'lint'],
    },
  })
  assert.ok(lint)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt: lint,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('two distinct governed verifiers can satisfy separate required criteria', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
    {
      id: 'acceptance:build',
      description: 'npm run build passes',
      type: 'build' as const,
      required: true,
      verification_strategy: 'Run npm run build.',
      verification: {
        kind: 'build',
        verifier_id: 'verifier:npm',
        executable_id: 'npm',
        argv: ['run', 'build'],
        command_hash: sha256Canonical({ executable_id: 'npm', argv: ['run', 'build'] }),
        working_directory: '.',
        environment_policy: 'host-process',
      },
    },
  ])
  const testReceipt = await npmTestReceipt(root, ['parser.ts'])
  const buildReceipt = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm run build',
    exit_code: 0,
    summary: 'ok',
    mutationPaths: ['parser.ts'],
    structured: {
      verifierId: 'verifier:npm',
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['run', 'build'],
    },
    execution: GOVERNED_EXECUTION,
  })
  assert.ok(testReceipt && buildReceipt)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [testReceipt, buildReceipt],
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, true)
})

test('multiple required criteria require every frozen check to have executed', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
    {
      id: 'acceptance:build',
      description: 'npm run build passes',
      type: 'build' as const,
      required: true,
      verification_strategy: 'Run npm run build.',
      verification: {
        kind: 'build',
        verifier_id: 'verifier:npm',
        executable_id: 'npm',
        argv: ['run', 'build'],
        command_hash: sha256Canonical({ executable_id: 'npm', argv: ['run', 'build'] }),
      },
    },
  ])
  const receipt = await npmTestReceipt(root, ['parser.ts'])
  assert.ok(receipt)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('non-compliant proof refresh does not publish criterion evidence', async t => {
  const { root, service, receipt, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidateSha = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: false },
    receipt,
    candidate_sha: candidateSha,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('missing governed refresh leaves criterion evidence unverified', async t => {
  const { request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('stale or mismatched revision cannot populate the private graph', async t => {
  const { root, service, receipt, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: 'f'.repeat(64),
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
  writeFileSync(join(root, 'parser.ts'), 'export const v = 2;\n')
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('publisher binds receipt revision when candidate matches verifier closure scope', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  writeFileSync(join(root, 'extra.mjs'), 'export const x = 1;\n')
  const mutationOnly = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  const closureRevision = RevisionManager.computeRevisionSync(root, ['extra.mjs', 'parser.ts']).compositeTreeHash
  const receipt = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 0,
    summary: 'ok',
    mutationPaths: ['extra.mjs', 'parser.ts'],
    structured: {
      verifierId: NPM_VERIFIER_ID,
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['test'],
    },
  })
  assert.ok(receipt)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: mutationOnly,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: closureRevision,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, true)
})

test('post-verification workspace drift fails recheck even with a prior green receipt hash', async t => {
  const { root, service, receipt, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const atVerify = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  assert.equal(resolveGovernedCriterionCandidateRevisionSha(root, receipt), atVerify)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: atVerify,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, true)
  writeFileSync(join(root, 'parser.ts'), 'export const v = 99;\n')
  assert.equal(resolveGovernedCriterionCandidateRevisionSha(root, receipt), null)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: atVerify,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('wrong working directory metadata cannot satisfy a frozen cwd-bound criterion', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    {
      ...npmTestRequirement('acceptance:npm', 'npm test passes'),
      verification: {
        ...npmTestRequirement('acceptance:npm', 'npm test passes').verification,
        working_directory: 'subdir',
        environment_policy: 'host-process',
      },
    },
  ])
  mkdirSync(join(root, 'subdir'), { recursive: true })
  const receipt = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 0,
    summary: 'ok',
    mutationPaths: ['parser.ts'],
    structured: {
      verifierId: NPM_VERIFIER_ID,
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['test'],
    },
    execution: { working_directory: '.', environment_policy: 'host-process' },
  })
  assert.ok(receipt)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('failed verifier execution cannot publish passing criterion evidence', async t => {
  const { root, service, request } = await fixtureWithAcceptance(t, [
    npmTestRequirement('acceptance:npm', 'npm test passes'),
  ])
  const failed = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 1,
    summary: 'failed',
    mutationPaths: ['parser.ts'],
    structured: {
      verifierId: NPM_VERIFIER_ID,
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['test'],
    },
  })
  assert.ok(failed)
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const candidate = RevisionManager.computeRevisionSync(root, ['parser.ts']).compositeTreeHash
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt: failed,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})
