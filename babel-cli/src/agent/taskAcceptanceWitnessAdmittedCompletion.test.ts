/**
 * Witness completion: governed executor → verifier receipt → criterion graph → kernel.
 * Fixture scaffolding may use direct fs; product mutations and witness runs use policy dispatch.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  createCriterionCompletionServiceV1,
  evaluateCriterionCompletionV1,
} from '../authority/criterionCompletion.js'
import { captureChatVerifierReceipt } from './chatEngineVerifierAdapter.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  resolveGovernedCriterionCandidateRevisionSha,
  toExecutorVerifierReceipt,
} from '../evidence/chatRevisionBinding.js'
import type { ToolContext } from '../localTools.js'
import {
  computeVerifierDependencyHashes,
  hasVerifierDependencyTamper,
} from './verifierIntegrity.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import { buildVerifierReceiptV2, evaluateVerifierPromotion } from './verifierKernel.js'
import { createToolExecutor, executeActionWithPolicy } from './toolExecutor.js'

const DUAL_WITNESS_TASK = [
  'Preserve alpha. Tests are already present. Run both tests using: npm run test:alpha.',
  'Preserve beta. Tests are already present. Run both tests using: npm run test:beta.',
  'Acceptance criteria:',
  '- `npm run test:alpha` must pass.',
  '- `npm run test:beta` must pass.',
].join('\n')

const WITNESS_NPM_SCRIPT = (name: 'test:alpha' | 'test:beta') =>
  `node --test --test-reporter=tap test/${name === 'test:alpha' ? 'alpha' : 'beta'}.test.mjs`

function policyCtx(runId: string, projectRoot: string): ToolContext {
  return {
    agentId: 'witness-admitted',
    runId,
    babelRoot: projectRoot,
    requestId: runId,
    projectRoot,
    cwd: projectRoot,
    readOnly: false,
  }
}

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

function writeDualWitnessTree(root: string, betaExitsZero = true) {
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'test:alpha': WITNESS_NPM_SCRIPT('test:alpha'),
        'test:beta': betaExitsZero
          ? WITNESS_NPM_SCRIPT('test:beta')
          : 'node -e "process.exit(1)"',
      },
    }),
  )
  writeFileSync(
    join(root, 'test', 'alpha.test.mjs'),
    'import { test } from "node:test";\ntest("alpha witness", () => {});\n',
  )
  writeFileSync(
    join(root, 'test', 'beta.test.mjs'),
    'import { test } from "node:test";\ntest("beta witness", () => {});\n',
  )
  writeFileSync(join(root, 'src', 'fix.ts'), 'export const v = 1;\n')
}

function createRealNpmRunExecutor(root: string) {
  return createToolExecutor({
    executeTool: async (request) => {
      assert.equal(request.tool, 'test_run')
      const command = request.command ?? ''
      assert.match(command, /^npm run test:(alpha|beta)$/)
      const script = command.slice('npm run '.length)
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const child = spawnSync(npmCmd, ['run', script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 30_000,
      })
      assert.ifError(child.error)
      return {
        exit_code: child.status ?? 1,
        stdout: child.stdout ?? '',
        stderr: child.stderr ?? '',
      }
    },
  })
}

async function governedMutateSrcFix(root: string, runId: string) {
  const mutationPath = 'src/fix.ts'
  const content = 'export const v = 2;\n'
  const executor = createToolExecutor({
    executeTool: async (request) => {
      assert.equal(request.tool, 'file_write')
      writeFileSync(join(root, String(request.path)), String(request.content))
      return { exit_code: 0, stdout: '', stderr: '' }
    },
  })
  const write = await executeActionWithPolicy(
    { type: 'write_file', path: mutationPath, content },
    'workspace_write',
    policyCtx(runId, root),
    { executor, mode: 'chat', lease: null, hostFallbackAllowed: true },
  )
  assert.equal(write.policyBlocked, false, JSON.stringify(write))
  return mutationPath
}

async function runDesignatedWitnessViaPolicy(
  root: string,
  runId: string,
  script: 'test:alpha' | 'test:beta',
  mutationPath: string,
) {
  const command = `npm run ${script}`
  const policy = await executeActionWithPolicy(
    { type: 'test_run', command },
    'workspace_write',
    policyCtx(runId, root),
    {
      executor: createRealNpmRunExecutor(root),
      mode: 'chat',
      lease: null,
      hostFallbackAllowed: true,
      isolationAvailable: true,
    },
  )
  assert.equal(policy.policyBlocked, false, JSON.stringify(policy))
  const exitCode = policy.results[0]?.exit_code ?? 1
  const stdout = policy.results[0]?.stdout ?? ''
  const stderr = policy.results[0]?.stderr ?? ''
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root,
    command,
    exitCode,
    summary: exitCode === 0 ? 'witness green' : 'witness red',
    stdout,
    stderr,
    mutationPaths: [mutationPath],
    execution: {
      working_directory: '.',
      environment_policy: 'host-process',
    },
  })
  return { policy, exitCode, receipt }
}

async function dualWitnessFixture(t: TestContext, betaExitsZero = true) {
  const root = mkdtempSync(join(tmpdir(), 'babel-dual-witness-completion-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeDualWitnessTree(root, betaExitsZero)
  const contract = witnessBoundContract()
  const runId = 'dual-witness-run'
  const owner = { contract, runId, projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const request = service.currentRequest()!
  return { root, service, request, contract, runId }
}

function candidateShaFromReceipt(root: string, receipt: NonNullable<Awaited<ReturnType<typeof captureChatVerifierReceipt>>>) {
  const sha = resolveGovernedCriterionCandidateRevisionSha(root, receipt)
  assert.ok(sha, 'receipt must bind a fresh governed candidate revision')
  return sha
}

async function publishDualWitnessEvidence(input: {
  root: string
  service: ReturnType<typeof createCriterionCompletionServiceV1>
  runId: string
  mutationPath: string
  scripts: Array<'test:alpha' | 'test:beta'>
}) {
  const receipts = []
  for (const script of input.scripts) {
    const run = await runDesignatedWitnessViaPolicy(
      input.root,
      input.runId,
      script,
      input.mutationPath,
    )
    assert.ok(run.receipt, JSON.stringify({ script, exit: run.exitCode }))
    receipts.push(run.receipt)
  }
  const candidate = candidateShaFromReceipt(input.root, receipts[0]!)
  for (const receipt of receipts.slice(1)) {
    assert.equal(candidateShaFromReceipt(input.root, receipt), candidate)
  }
  input.service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts,
    candidate_sha: candidate,
    has_mutation: true,
  })
  return { receipts, candidate }
}

test('executor → receipt → criterion: paired policy witness runs satisfy both frozen argv bindings', async t => {
  const { root, service, request, runId } = await dualWitnessFixture(t)
  const mutationPath = await governedMutateSrcFix(root, runId)
  await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha', 'test:beta'],
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.status, 'VERIFIED')
})

test('executor → receipt → criterion negative: one governed witness run cannot satisfy sibling criterion', async t => {
  const { root, service, request, runId } = await dualWitnessFixture(t)
  const mutationPath = await governedMutateSrcFix(root, runId)
  await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha'],
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
})

test('executor → receipt → criterion negative: failing witness exit stays unverified', async t => {
  const { root, service, request, runId } = await dualWitnessFixture(t, false)
  const mutationPath = await governedMutateSrcFix(root, runId)
  const alpha = await runDesignatedWitnessViaPolicy(root, runId, 'test:alpha', mutationPath)
  const beta = await runDesignatedWitnessViaPolicy(root, runId, 'test:beta', mutationPath)
  assert.equal(alpha.exitCode, 0)
  assert.equal(beta.exitCode, 1)
  assert.ok(alpha.receipt)
  const candidate = candidateShaFromReceipt(root, alpha.receipt)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [alpha.receipt!],
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('kernel negative: no refresh leaves VERIFIED_COMPLETE blocked', async t => {
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

test('kernel positive: paired executor receipts refresh criterion evidence for VERIFIED_COMPLETE', async t => {
  const { root, service, request, runId } = await dualWitnessFixture(t)
  const mutationPath = await governedMutateSrcFix(root, runId)
  const { receipts } = await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha', 'test:beta'],
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, true)
  const last = receipts.at(-1)!
  const adapted = toExecutorVerifierReceipt(last)
  assert.equal(adapted.ok, true, adapted.reason)
  const kernel = createExecutorKernel('chat')
  const decision = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    // Criterion graph is the authority under test; coarse honesty gate is not the subject here.
    verificationPolicy: 'none',
    lastVerifierReceipt: adapted.receipt,
    toolCallLog: [{ tool: 'write_file', target: mutationPath }],
    proof: { compliant: true },
    acceptance: request,
  })
  assert.equal(decision.finalOutcome, 'VERIFIED_COMPLETE', decision.reason)
  assert.equal(decision.allowed, true)
})

test('kernel negative: single executor witness run keeps VERIFIED_COMPLETE downgraded', async t => {
  const { root, service, request, runId } = await dualWitnessFixture(t)
  const mutationPath = await governedMutateSrcFix(root, runId)
  const { receipts } = await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha'],
  })
  const adapted = toExecutorVerifierReceipt(receipts[0]!)
  assert.equal(adapted.ok, true)
  const kernel = createExecutorKernel('chat')
  const decision = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'none',
    lastVerifierReceipt: adapted.receipt,
    toolCallLog: [{ tool: 'write_file', target: mutationPath }],
    proof: { compliant: true },
    acceptance: request,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH')
  assert.match(decision.reason, /acceptance_unverified/i)
})

test('verifier integrity: designated npm script rewrite detected from dependency hashes at promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-witness-script-tamper-'))
  try {
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': WITNESS_NPM_SCRIPT('test:alpha') } }),
    )
    writeFileSync(
      join(root, 'test', 'alpha.test.mjs'),
      'import { test } from "node:test";\ntest("alpha", () => {});\n',
    )
    const commands = ['npm run test:alpha']
    const pre = computeVerifierDependencyHashes(root, commands)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': 'node -e "process.exit(0)"' } }),
    )
    const post = computeVerifierDependencyHashes(root, commands)
    const tampered = hasVerifierDependencyTamper(pre, post)
    assert.equal(tampered, true)
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
      adversarial: { verifier_def_tampered: tampered },
    })
    assert.equal(promotion.authorize_verified_complete, false)
    assert.ok(promotion.denials.includes('tampered_verifier_def'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('freeze contract limit: path-level protected_paths do not snapshot test file bytes; R9 hash does', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-witness-content-limit-'))
  try {
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:alpha': WITNESS_NPM_SCRIPT('test:alpha') } }),
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
