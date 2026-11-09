/**
 * Witness completion: governed executor → verifier receipt → criterion graph → kernel.
 * Fixture scaffolding may use direct fs; product mutations and witness runs use policy dispatch.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import {
  createCriterionCompletionServiceV1,
  evaluateCriterionCompletionV1,
} from '../authority/criterionCompletion.js'
import { captureChatVerifierReceipt, captureAndRecordVerifierReceipt, captureCompletionWorkspaceRevisionHash, prepareKernelVerifierInput, resolveVerifierCacheIdentity, verifierEnvironmentKey } from './chatEngineVerifierAdapter.js'
import { chatVerifierOwner, chatVerifierRequirements } from './chatVerifierContext.js'
import { createSessionEventLog } from './sessionEvents.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  resolveGovernedCriterionCandidateRevisionSha,
} from '../evidence/chatRevisionBinding.js'
import type { ToolContext } from '../localTools.js'
import {
  computeVerifierDependencyHashes,
  hasVerifierDependencyTamper,
} from './verifierIntegrity.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { buildVerifierReceiptV2, evaluateVerifierPromotion } from './verifierKernel.js'
import { createToolExecutor, executeActionWithPolicy } from './toolExecutor.js'

const DUAL_WITNESS_TASK = [
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
    projectRoot,
  }
}

function witnessBoundContract() {
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(DUAL_WITNESS_TASK),
    trustedVerifierCommands: ['npm run test:alpha', 'npm run test:beta'],
    defaultWorkingDirectory: '.',
  })
  assert.equal(bound.criteria.length, 2, 'the witness fixture contains only its two explicit requirements')
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
      verifier_requirements: ['npm run test:alpha', 'npm run test:beta'],
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

/** Portable npm run spawn (avoids EINVAL from direct npm.cmd on Windows). */
function npmRunHostInvocation(script: string): { executable: string; args: string[] } {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && existsSync(npmExecPath)) {
    return { executable: process.execPath, args: [npmExecPath, 'run', script] }
  }
  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundledNpmCli)) {
    return { executable: process.execPath, args: [bundledNpmCli, 'run', script] }
  }
  return { executable: 'npm', args: ['run', script] }
}

function witnessExecutionEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BABEL_PROJECT_ROOT: root }
  // The witness is an independent native run, not a child of the test harness.
  delete env.NODE_TEST_CONTEXT
  return env
}

function createRealNpmRunExecutor(root: string) {
  return createToolExecutor({
    executeTool: async (request) => {
      assert.equal(request.tool, 'test_run')
      const command = request.command ?? ''
      assert.match(command, /^npm run test:(alpha|beta)$/)
      const script = command.slice('npm run '.length)
      const { executable, args } = npmRunHostInvocation(script)
      const child = spawnSync(executable, args, {
        cwd: root,
        encoding: 'utf8',
        env: witnessExecutionEnvironment(root),
        timeout: 30_000,
        windowsHide: true,
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

async function governedMutateSrcFix(root: string, runId: string, mutationPath = 'src/fix.ts', content = 'export const v = 2;\n') {
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
  recording?: Pick<Parameters<typeof captureAndRecordVerifierReceipt>[0], 'sessionEvents' | 'ledger' | 'cache' | 'verifierOwner'>,
) {
  const command = `npm run ${script}`
  const cacheIdentity = resolveVerifierCacheIdentity({ projectRoot: root, command, envKey: verifierEnvironmentKey(witnessExecutionEnvironment(root)) })
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
  const capture = {
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
  }
  const receipt = recording
    ? await captureAndRecordVerifierReceipt({
      ...capture,
      ...recording,
      cacheIdentity,
      turnId: runId,
      writeCount: 1,
      executionBackend: 'host-process',
    })
    : await captureChatVerifierReceipt(capture)
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
  const contract = input.service.currentRequest()!.contract
  const sessionEvents = createSessionEventLog(input.runId)
  const verifierOwner = chatVerifierOwner({ projectRoot: input.root, sessionId: sessionEvents.session_id,
    taskId: contract.task_id, contractHash: contract.contract_hash })!
  const requiredVerifierCommands = [...contract.verifier_requirements]
  const requiredVerifiers = chatVerifierRequirements(verifierOwner, requiredVerifierCommands, contract.user_request, input.root).map(requirement => ({
    ...requirement, executionContext: { ...requirement.executionContext,
      environmentFingerprint: verifierEnvironmentKey(witnessExecutionEnvironment(input.root)) },
  }))
  const recording: Pick<Parameters<typeof captureAndRecordVerifierReceipt>[0], 'sessionEvents' | 'ledger' | 'cache' | 'verifierOwner'> = {
    sessionEvents, verifierOwner, ledger: [], cache: new Map(),
  }
  const receipts = []
  for (const script of input.scripts) {
    const run = await runDesignatedWitnessViaPolicy(
      input.root,
      input.runId,
      script,
      input.mutationPath,
      recording,
    )
    assert.ok(run.receipt, JSON.stringify({ script, exit: run.exitCode }))
    assert.ok((run.receipt.tests_total ?? 0) > 0, JSON.stringify({ exit: run.exitCode, total: run.receipt.tests_total, skipped: run.receipt.tests_skipped }))
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
  const currentReceiptRevisionHashes: Record<string, string> = {}
  for (const receipt of receipts) {
    const current = captureCompletionWorkspaceRevisionHash({ projectRoot: input.root }, [input.mutationPath], receipt)
    assert.ok(current && receipt.receiptId)
    currentReceiptRevisionHashes[receipt.receiptId] = current
  }
  return { receipts, candidate, kernelEvidence: {
    ...prepareKernelVerifierInput(receipts.at(-1)!, recording.ledger),
    verifierOwner, requiredVerifierCommands, requiredVerifiers, currentReceiptRevisionHashes,
    currentWorkspaceRevisionHash: currentReceiptRevisionHashes[receipts.at(-1)!.receiptId!]!,
  } }
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

test('executor → receipt → inferred semantic criterion: two green npm cases remain supporting evidence, not a binding', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-semantic-acceptance-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'semantic-acceptance-fixture',
    type: 'module',
    scripts: { test: 'node --test test/normalize.test.mjs' },
  }))
  writeFileSync(join(root, 'src', 'normalize.js'),
    'export function normalize(value) { return value.replaceAll(",", ""); }\n')
  writeFileSync(join(root, 'test', 'normalize.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { normalize } from "../src/normalize.js";',
    'test("normalizes decimal grouping", () => assert.equal(normalize("1,234.50"), "1234.50"));',
    'test("preserves fractional scale", () => assert.equal(normalize("12,000.00"), "12000.00"));',
  ].join('\n') + '\n')

  const task = 'Normalize decimal separators and preserve the original scale.'
  const meaning = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(task), trustedVerifierCommands: ['npm test'], defaultWorkingDirectory: '.',
  })
  assert.equal(meaning.sources[0]?.status, 'inferred')
  assert.ok(meaning.criteria[0]?.verification.verifier_id.startsWith('meaning:'))
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', user_request: task, acceptance: meaning.criteria,
    verifier_requirements: ['npm test'],
  }))
  const runId = 'semantic-two-green-cases'
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId, projectRoot: root }))
  const request = service.currentRequest()!
  const mutationPath = await governedMutateSrcFix(root, runId)
  const npmExecPath = process.env.npm_execpath
  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const executable = npmExecPath && existsSync(npmExecPath) ? process.execPath
    : existsSync(bundledNpmCli) ? process.execPath : 'npm'
  const args = npmExecPath && existsSync(npmExecPath) ? [npmExecPath, 'test']
    : existsSync(bundledNpmCli) ? [bundledNpmCli, 'test'] : ['test']
  const execution = await executeActionWithPolicy(
    { type: 'test_run', command: 'npm test' }, 'workspace_write', policyCtx(runId, root), {
      executor: createToolExecutor({
        executeTool: async request => {
          assert.equal(request.tool, 'test_run')
          const child = spawnSync(executable, args, {
            cwd: root, encoding: 'utf8', env: witnessExecutionEnvironment(root),
            timeout: 30_000, windowsHide: true,
          })
          assert.ifError(child.error)
          return { exit_code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
        },
      }),
      mode: 'chat', lease: null, hostFallbackAllowed: true, isolationAvailable: true,
    },
  )
  assert.equal(execution.policyBlocked, false, JSON.stringify(execution))
  const stdout = execution.results[0]?.stdout ?? ''
  const exitCode = execution.results[0]?.exit_code ?? 1
  assert.equal(exitCode, 0, stdout)
  assert.match(stdout, /pass 2/)
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root, command: 'npm test', exitCode, summary: '2/2 tests passed', stdout,
    stderr: execution.results[0]?.stderr ?? '', mutationPaths: [mutationPath],
    execution: { working_directory: '.', environment_policy: 'host-process' },
  })
  assert.ok(receipt)
  assert.equal(receipt.tests_total, 2)
  const candidate = candidateShaFromReceipt(root, receipt)
  service.refreshPrivateEvidence({
    proof: { compliant: true }, receipts: [receipt], candidate_sha: candidate, has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
  assert.deepEqual(result.missing_requirements, [meaning.criteria[0]!.id])
  assert.equal(result.satisfied_requirements.length, 0)
})

test('exact behavioral goal plus unrelated green npm test cannot certify a wrong parser patch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-goal-preservation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'goal-preservation-fixture', type: 'module',
    scripts: { test: 'node --test test/unrelated.test.mjs' },
  }))
  writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return 0; }\n')
  writeFileSync(join(root, 'test', 'unrelated.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("unrelated fixture still works", () => assert.equal(2 + 2, 4));',
  ].join('\n') + '\n')

  const task = 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.'
  const authority = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: root,
    projectTestCommands: ['npm test'], verifierRequirements: ['npm test'],
  })
  const contract = authority.taskContract
  const goal = contract.acceptance.find(item => item.description === 'Fix parser.js so parseSum(2, 3) returns 5.')
  const testCriterion = contract.acceptance.find(item => item.description === '`npm test` must pass.')
  assert.ok(goal, 'admission keeps the requested behavior as a required criterion')
  assert.ok(testCriterion, 'admission keeps the test requirement as its own criterion')
  assert.ok(goal.verification.verifier_id.startsWith('meaning:'), 'unrelated test success is not pre-bound as proof of behavior')
  assert.deepEqual(testCriterion.verification.argv, ['test'], 'the exact positive npm test criterion remains executable-bound')

  const runId = 'goal-preservation-wrong-patch'
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId, projectRoot: root }))
  const request = service.currentRequest()!
  const sessionEvents = createSessionEventLog(runId)
  const verifierOwner = chatVerifierOwner({ projectRoot: root, sessionId: sessionEvents.session_id,
    taskId: contract.task_id, contractHash: contract.contract_hash })!
  const recording = { sessionEvents, ledger: [] as NonNullable<Parameters<typeof captureAndRecordVerifierReceipt>[0]['ledger']>,
    cache: new Map(), verifierOwner }
  const mutationPath = 'src/parser.js'
  await governedMutateSrcFix(root, runId, mutationPath,
    'export function parseSum(a, b) { return a - b; }\n')
  const observed = await import(`${pathToFileURL(join(root, mutationPath)).href}?trial=${Date.now()}`) as { parseSum(a: number, b: number): number }
  assert.equal(observed.parseSum(2, 3), -1, 'the intentionally wrong subtraction patch misses the user goal')

  const npmExecPath = process.env.npm_execpath
  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const executable = npmExecPath && existsSync(npmExecPath) ? process.execPath
    : existsSync(bundledNpmCli) ? process.execPath : 'npm'
  const args = npmExecPath && existsSync(npmExecPath) ? [npmExecPath, 'test']
    : existsSync(bundledNpmCli) ? [bundledNpmCli, 'test'] : ['test']
  const execution = await executeActionWithPolicy(
    { type: 'test_run', command: 'npm test' }, 'workspace_write', policyCtx(runId, root), {
      executor: createToolExecutor({
        executeTool: async request => {
          assert.equal(request.tool, 'test_run')
          const child = spawnSync(executable, args, {
            cwd: root, encoding: 'utf8', env: witnessExecutionEnvironment(root),
            timeout: 30_000, windowsHide: true,
          })
          assert.ifError(child.error)
          return { exit_code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
        },
      }),
      mode: 'chat', lease: null, hostFallbackAllowed: true, isolationAvailable: true,
    },
  )
  assert.equal(execution.policyBlocked, false, JSON.stringify(execution))
  const stdout = execution.results[0]?.stdout ?? ''
  const exitCode = execution.results[0]?.exit_code ?? 1
  assert.equal(exitCode, 0, stdout)
  assert.match(stdout, /pass 1/, 'the unrelated npm test is genuinely green')
  const capture = {
    projectRoot: root, command: 'npm test', exitCode, summary: '1/1 unrelated test passed', stdout,
    stderr: execution.results[0]?.stderr ?? '', mutationPaths: [mutationPath],
    execution: { working_directory: '.', environment_policy: 'host-process' },
  }
  const cacheIdentity = resolveVerifierCacheIdentity({ projectRoot: root, command: 'npm test',
    envKey: verifierEnvironmentKey(witnessExecutionEnvironment(root)) })
  const receipt = await captureAndRecordVerifierReceipt({
    ...capture, ...recording, cacheIdentity, turnId: runId, writeCount: 1, executionBackend: 'host-process',
  })
  assert.ok(receipt)
  const candidate = candidateShaFromReceipt(root, receipt)
  service.refreshPrivateEvidence({ proof: { compliant: true }, receipts: [receipt], candidate_sha: candidate, has_mutation: true })

  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.equal(result.status, 'UNVERIFIED')
  assert.ok(result.missing_requirements.includes(goal.id), 'green npm evidence cannot satisfy the behavioral goal')

  const requiredVerifierCommands = ['npm test']
  const requiredVerifiers = chatVerifierRequirements(verifierOwner, requiredVerifierCommands, task, root).map(requirement => ({
    ...requirement,
    executionContext: { ...requirement.executionContext,
      environmentFingerprint: verifierEnvironmentKey(witnessExecutionEnvironment(root)) },
  }))
  const currentRevision = captureCompletionWorkspaceRevisionHash({ projectRoot: root }, [mutationPath], receipt)
  assert.ok(currentRevision && receipt.receiptId)
  const kernel = createExecutorKernel('chat')
  const decision = kernel.completion.decide({
    mode: 'chat', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true,
    verificationPolicy: 'strict', ...prepareKernelVerifierInput(receipt, recording.ledger),
    verifierOwner, requiredVerifierCommands, requiredVerifiers,
    currentReceiptRevisionHashes: { [receipt.receiptId]: currentRevision },
    currentWorkspaceRevisionHash: currentRevision,
    toolCallLog: [{ tool: 'write_file', target: mutationPath }, { tool: 'test_run', target: 'npm test' }],
    proof: { compliant: true }, acceptance: request,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH')
  assert.notEqual(decision.finalOutcome, 'VERIFIED_COMPLETE', decision.reason)
})

test('a task-authored exact verifier link admits only the matching behavioral evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-linked-criterion-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test files'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'linked-criterion-fixture', type: 'module' }))
  writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return 0; }\n')
  writeFileSync(join(root, 'test files', 'parser.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { parseSum } from "../src/parser.js";',
    'test("parseSum returns the required value", () => assert.equal(parseSum(2, 3), 5));',
  ].join('\n') + '\n')

  const command = 'node --test "test files/parser.test.mjs"'
  const behavior = 'Fix parser.js so parseSum(2, 3) returns 5'
  const task = [
    `${behavior}.`,
    'Requirements:',
    `- ${behavior}; verified by: \`${command}\` must pass.`,
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: root,
    projectTestCommands: [command], verifierRequirements: [command],
  }).taskContract
  const linked = contract.acceptance.filter(item =>
    item.description.startsWith(behavior),
  )
  assert.equal(linked.length, 2)
  assert.ok(linked.every(item => item.verification.verifier_id === 'verifier:node'))
  assert.ok(linked.every(item => JSON.stringify(item.verification.argv) === JSON.stringify(['--test', 'test files/parser.test.mjs'])))
  assert.ok(linked.every(item => item.verification.command_hash))

  const runId = 'criterion-explicit-verifier-link'
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId, projectRoot: root }))
  const request = service.currentRequest()!
  const mutationPath = 'src/parser.js'
  await governedMutateSrcFix(root, runId, mutationPath,
    'export function parseSum(a, b) { return a + b; }\n')
  const sessionEvents = createSessionEventLog(runId)
  const verifierOwner = chatVerifierOwner({ projectRoot: root, sessionId: sessionEvents.session_id,
    taskId: contract.task_id, contractHash: contract.contract_hash })!
  const env = witnessExecutionEnvironment(root)
  const policy = await executeActionWithPolicy(
    { type: 'test_run', command }, 'workspace_write', policyCtx(runId, root), {
      executor: createToolExecutor({
        executeTool: async request => {
          assert.equal(request.tool, 'test_run')
          const child = spawnSync(process.execPath, ['--test', 'test files/parser.test.mjs'], {
            cwd: root, encoding: 'utf8', env, timeout: 30_000, windowsHide: true,
          })
          assert.ifError(child.error)
          return { exit_code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
        },
      }),
      mode: 'chat', lease: null, hostFallbackAllowed: true, isolationAvailable: true,
    },
  )
  assert.equal(policy.policyBlocked, false, JSON.stringify(policy))
  const stdout = policy.results[0]?.stdout ?? ''
  const exitCode = policy.results[0]?.exit_code ?? 1
  assert.equal(exitCode, 0, stdout)
  assert.match(stdout, /pass 1/)
  const cacheIdentity = resolveVerifierCacheIdentity({
    projectRoot: root, command, envKey: verifierEnvironmentKey(env),
  })
  const receipt = await captureAndRecordVerifierReceipt({
    projectRoot: root, command, exitCode, summary: '1/1 parser behavior test passed', stdout,
    stderr: policy.results[0]?.stderr ?? '', mutationPaths: [mutationPath],
    sessionEvents, turnId: runId, ledger: [], cache: new Map(), writeCount: 1,
    cacheIdentity, verifierOwner, executionBackend: 'host-process',
  })
  assert.ok(receipt)
  assert.equal(receipt.tests_total, 1)
  const candidate = candidateShaFromReceipt(root, receipt)
  service.refreshPrivateEvidence({
    proof: { compliant: true }, receipts: [receipt], candidate_sha: candidate, has_mutation: true,
  })
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, true, JSON.stringify(result))
  assert.deepEqual(result.missing_requirements, [])
  assert.equal(result.satisfied_requirements.length, 2)
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
  const { kernelEvidence } = await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha', 'test:beta'],
  })
  assert.equal(evaluateCriterionCompletionV1(request).verified, true)
  const kernel = createExecutorKernel('chat')
  const decision = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'strict',
    ...kernelEvidence,
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
  const { kernelEvidence } = await publishDualWitnessEvidence({
    root,
    service,
    runId,
    mutationPath,
    scripts: ['test:alpha'],
  })
  const kernel = createExecutorKernel('chat')
  const decision = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'strict',
    ...kernelEvidence,
    toolCallLog: [{ tool: 'write_file', target: mutationPath }],
    proof: { compliant: true },
    acceptance: request,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH')
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
  assert.equal(decision.reason, 'completion_downgraded:verifier_missing')
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
