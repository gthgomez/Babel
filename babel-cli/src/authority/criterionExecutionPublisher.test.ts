import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { inferTaskAcceptance } from '../agent/taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { bindChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import {
  createCriterionCompletionServiceV1,
  evaluateCriterionCompletionV1,
} from './criterionCompletion.js'

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-publish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'parser.ts'), 'export const v = 1;\n')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }),
  )
  const task = 'Investigate why parser_test fails and fix it.'
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: task,
    acceptance: inferTaskAcceptance(task).criteria,
  }))
  const owner = { contract, runId: 'publish-run', projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const receipt = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 0,
    summary: 'ok',
    mutationPaths: ['parser.ts'],
  })
  assert.ok(receipt)
  return { root, owner, service, receipt, request: service.currentRequest()! }
}

test('governed chat execution publishes private criterion evidence at current revision', async t => {
  const { root, service, receipt, request } = await fixture(t)
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

test('non-compliant proof refresh does not publish criterion evidence', async t => {
  const { root, service, receipt, request } = await fixture(t)
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
  const { request } = await fixture(t)
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('stale or mismatched revision cannot populate the private graph', async t => {
  const { root, service, receipt, request } = await fixture(t)
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
  const { root, owner, service, request } = await fixture(t)
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

test('failed verifier execution cannot publish passing criterion evidence', async t => {
  const { root, service, request } = await fixture(t)
  const failed = await bindChatVerifierReceipt({
    projectRoot: root,
    command: 'npm test',
    exit_code: 1,
    summary: 'failed',
    mutationPaths: ['parser.ts'],
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
