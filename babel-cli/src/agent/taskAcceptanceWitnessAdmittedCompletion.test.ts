/**
 * Admitted execution/completion matrix for dual designated regression witnesses.
 * Exercises criterion evidence publication and kernel completion — not derivation-only.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { bindChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import {
  createCriterionCompletionServiceV1,
  evaluateCriterionCompletionV1,
} from '../authority/criterionCompletion.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  computeVerifierDependencyHashes,
  hasVerifierDependencyTamper,
} from './verifierIntegrity.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import { buildVerifierReceiptV2, evaluateVerifierPromotion } from './verifierKernel.js'

const GOVERNED_EXECUTION = {
  working_directory: '.',
  environment_policy: 'host-process',
} as const

const DUAL_WITNESS_TASK = [
  'Preserve alpha. Tests are already present. Run both tests using: npm run test:alpha.',
  'Preserve beta. Tests are already present. Run both tests using: npm run test:beta.',
  'Acceptance criteria:',
  '- `npm run test:alpha` must pass.',
  '- `npm run test:beta` must pass.',
].join('\n')

function witnessBoundContract() {
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(DUAL_WITNESS_TASK),
    trustedVerifierCommands: ['npm run test:alpha', 'npm run test:beta'],
    defaultWorkingDirectory: '.',
  })
  const alpha = bound.criteria.find(item => item.description.includes('alpha'))!
  const beta = bound.criteria.find(item => item.description.includes('beta'))!
  assert.ok(alpha && beta)
  assert.deepEqual(alpha.verification.argv, ['run', 'test:alpha'])
  assert.deepEqual(beta.verification.argv, ['run', 'test:beta'])
  assert.ok(alpha.verification.command_hash)
  assert.ok(beta.verification.command_hash)
  assert.notEqual(alpha.verification.command_hash, beta.verification.command_hash)
  return freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: DUAL_WITNESS_TASK,
      acceptance: bound.criteria,
    }),
  )
}

async function npmRunReceipt(root: string, script: string, mutationPaths: string[]) {
  return bindChatVerifierReceipt({
    projectRoot: root,
    command: `npm run ${script}`,
    exit_code: 0,
    summary: 'ok',
    mutationPaths,
    structured: {
      verifierId: 'verifier:npm',
      authoritySource: 'built_in_runner',
      executable: 'npm',
      args: ['run', script],
    },
    execution: GOVERNED_EXECUTION,
  })
}

async function dualWitnessFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-dual-witness-completion-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'test:alpha': 'node test/alpha.test.mjs',
        'test:beta': 'node test/beta.test.mjs',
      },
    }),
  )
  writeFileSync(join(root, 'test', 'alpha.test.mjs'), 'export {}\n')
  writeFileSync(join(root, 'test', 'beta.test.mjs'), 'export {}\n')
  writeFileSync(join(root, 'src', 'fix.ts'), 'export const v = 1;\n')
  const contract = witnessBoundContract()
  const owner = { contract, runId: 'dual-witness-run', projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const request = service.currentRequest()!
  return { root, service, request, contract }
}

async function candidateSha(root: string, paths: string[]) {
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  return RevisionManager.computeRevisionSync(root, paths).compositeTreeHash
}

test('admitted completion: both witness criteria require matching frozen-argv evidence', async t => {
  const { root, service, request } = await dualWitnessFixture(t)
  const alphaReceipt = await npmRunReceipt(root, 'test:alpha', ['src/fix.ts'])
  const betaReceipt = await npmRunReceipt(root, 'test:beta', ['src/fix.ts'])
  assert.ok(alphaReceipt && betaReceipt)
  const candidate = await candidateSha(root, ['src/fix.ts'])
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [alphaReceipt, betaReceipt],
    candidate_sha: candidate,
    has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.status, 'VERIFIED')
})

test('admitted completion: single witness receipt cannot satisfy the sibling criterion', async t => {
  const { root, service, request } = await dualWitnessFixture(t)
  const alphaOnly = await npmRunReceipt(root, 'test:alpha', ['src/fix.ts'])
  assert.ok(alphaOnly)
  const candidate = await candidateSha(root, ['src/fix.ts'])
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt: alphaOnly,
    candidate_sha: candidate,
    has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('admitted completion: cross-bound argv evidence does not complete both criteria', async t => {
  const { root, service, request } = await dualWitnessFixture(t)
  // Green receipt for beta argv only — must not satisfy alpha's frozen binding.
  const betaReceipt = await npmRunReceipt(root, 'test:beta', ['src/fix.ts'])
  assert.ok(betaReceipt)
  const candidate = await candidateSha(root, ['src/fix.ts'])
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipt: betaReceipt,
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('admitted completion: missing governed refresh stays unverified', async t => {
  const { request } = await dualWitnessFixture(t)
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('admitted completion: kernel rejects VERIFIED_COMPLETE without criterion evidence', async t => {
  const { request } = await dualWitnessFixture(t)
  const kernel = createExecutorKernel('chat')
  const blocked = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'strict',
    toolCallLog: [],
    proof: { compliant: true },
    acceptance: request,
  })
  assert.equal(blocked.allowed, false)
  assert.notEqual(blocked.finalOutcome, 'VERIFIED_COMPLETE')
})

test('admitted completion: dual witness criterion oracle passes with paired frozen-argv receipts', async t => {
  const { root, service, request } = await dualWitnessFixture(t)
  const alphaReceipt = await npmRunReceipt(root, 'test:alpha', ['src/fix.ts'])
  const betaReceipt = await npmRunReceipt(root, 'test:beta', ['src/fix.ts'])
  assert.ok(alphaReceipt && betaReceipt)
  const candidate = await candidateSha(root, ['src/fix.ts'])
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [alphaReceipt, betaReceipt],
    candidate_sha: candidate,
    has_mutation: true,
  })
  const criterion = evaluateCriterionCompletionV1(request)
  assert.equal(criterion.verified, true, JSON.stringify(criterion))
  assert.equal(criterion.status, 'VERIFIED')
  assert.deepEqual(criterion.missing_requirements, [])
})

test('admitted tamper: designated npm script rewrite is rejected at verifier-integrity boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-witness-script-tamper-'))
  try {
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': 'node test/alpha.test.mjs' } }),
    )
    writeFileSync(join(root, 'test', 'alpha.test.mjs'), 'export {}\n')
    const commands = ['npm run test:alpha']
    const pre = computeVerifierDependencyHashes(root, commands)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': 'node -e "process.exit(0)"' } }),
    )
    const post = computeVerifierDependencyHashes(root, commands)
    assert.ok(hasVerifierDependencyTamper(pre, post))
    const rev = { compositeTreeHash: 'rev-current' }
    const promotion = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: commands,
      receipts: [
        buildVerifierReceiptV2({
          receipt_id: 'witness-alpha',
          verifier_id: 'verifier:npm',
          argv: ['run', 'test:alpha'],
          cwd: root,
          env_profile_hash: 'env',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          workspace_revision: rev,
          scope: 'targeted',
          command: 'npm run test:alpha',
          authoritative: true,
          freshness: 'fresh',
        }),
      ],
      current_revision_hash: rev.compositeTreeHash,
      adversarial: { verifier_def_tampered: hasVerifierDependencyTamper(pre, post) },
    })
    assert.equal(promotion.authorize_verified_complete, false)
    assert.ok(promotion.denials.includes('tampered_verifier_def'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('admitted tamper: static test file bytes change is detected only via R9 dependency hash, not freeze contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-witness-content-limit-'))
  try {
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': 'node test/alpha.test.mjs' } }),
    )
    writeFileSync(join(root, 'test', 'alpha.test.mjs'), 'export const a = 1;\n')
    const commands = ['npm run test:alpha']
    const pre = computeVerifierDependencyHashes(root, commands)
    writeFileSync(join(root, 'test', 'alpha.test.mjs'), 'export const a = 2;\n')
    const post = computeVerifierDependencyHashes(root, commands)
    assert.ok(hasVerifierDependencyTamper(pre, post), 'R9 tracks script-named file content')
    assert.ok('package.json' in pre)
    assert.equal(
      readFileSync(join(root, 'package.json'), 'utf8').includes('test:alpha'),
      true,
      'protected_paths at freeze is path-level; content hash is not part of that contract',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
