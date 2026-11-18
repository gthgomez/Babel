/**
 * W01 round-2 controls: a relevance-bound witness must be able to certify a
 * correct patch without spawning a process, a documentation goal must be
 * mechanically checked rather than blocking forever, and a public-surface
 * preservation clause must veto an API-breaking candidate.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { createCriterionCompletionServiceV1 } from '../authority/criterionCompletion.js'
import { noChangeFinalRevisionScope } from './chatNoChangeFinalRevision.js'
import { createExecutorKernel } from '../executor/kernel.js'
import { captureChatVerifierReceipt, prepareKernelVerifierInput } from './chatEngineVerifierAdapter.js'
import { resolveGovernedCriterionCandidateRevisionSha } from '../evidence/chatRevisionBinding.js'
import { chatVerifierOwner, chatVerifierRequirements } from './chatVerifierContext.js'
import type { ExecutorVerifierReceipt } from '../executor/contracts.js'
import {
  ADVISORY_DOC_STRATEGY,
  advisoryDocsViolations,
  hasAdvisoryDocsGoal,
} from './advisoryDocsGoal.js'
import {
  computePublicApiSurface,
  hasPublicApiPreservationClause,
  publicApiPreservationViolation,
} from './publicApiPreservation.js'

const GOAL = 'Fix parser.js so parseSum(2, 3) returns 5.'
const DOC_GOAL = 'Update README.md so the example shows parseSum usage.'
const VERIFIER = 'node --test --test-force-exit --experimental-test-isolation=none test/parser.test.mjs'
const TEST_SOURCE = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { parseSum } from "../src/parser.js";',
  'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
  '',
].join('\n')
const TAP = [
  'TAP version 13',
  'ok 1 - parseSum',
  '# tests 1',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '',
].join('\n')

function fixture(task: string, options: { readme?: string; publicClause?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'babel-w01-round2-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'round2', private: true, type: 'module' }))
  writeFileSync(join(root, 'src', 'parser.js'),
    'export function parseSum(a, b) { return a + b; }\nexport function parseMinus(a, b) { return a - b; }\n')
  writeFileSync(join(root, 'test', 'parser.test.mjs'), TEST_SOURCE)
  if (options.readme !== undefined) writeFileSync(join(root, 'README.md'), options.readme)
  for (const args of [
    ['init', '--quiet'], ['config', 'core.autocrlf', 'false'],
    ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'fixture'],
    ['add', '-A'], ['commit', '--quiet', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: root,
    projectTestCommands: [VERIFIER],
    verifierRequirements: [VERIFIER],
  }).taskContract
  return { root, contract }
}

test('P2-3 positive: a relevance-bound witness certifies VERIFIED_COMPLETE', async t => {
  const { root, contract } = fixture(GOAL)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const goal = contract.acceptance.find(item => item.description === GOAL)!
  assert.equal(goal.verification.verifier_id, 'verifier:node')
  const sessionId = 'round2-positive'
  const owner = chatVerifierOwner({
    projectRoot: root,
    sessionId,
    taskId: contract.task_id,
    contractHash: contract.contract_hash,
  })
  assert.ok(owner)
  const requiredVerifiers = chatVerifierRequirements(owner, [VERIFIER], contract.user_request, root)
  assert.equal(requiredVerifiers.length, 1)
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root,
    command: VERIFIER,
    exitCode: 0,
    summary: 'parseSum passed',
    stdout: TAP,
    mutationPaths: ['src/parser.js'],
    executionContext: requiredVerifiers[0]!.executionContext,
    execution: { working_directory: '.', environment_policy: 'host-process' },
  })
  assert.ok(receipt)
  receipt.order = { sessionId, seq: 1 }
  const candidate = resolveGovernedCriterionCandidateRevisionSha(root, receipt)
  assert.ok(candidate)
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId: 'round2-positive', projectRoot: root }))
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [receipt],
    candidate_sha: candidate,
    has_mutation: true,
  })
  assert.ok(receipt)
  const prepared = prepareKernelVerifierInput(receipt, [receipt])
  const kernelReceipt = prepared.executedVerifierLedger?.[0] as ExecutorVerifierReceipt | undefined
  assert.ok(kernelReceipt)
  const decision = createExecutorKernel('chat').completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'none',
    toolCallLog: [],
    proof: { compliant: true },
    acceptance: service.currentRequest(),
    requiredVerifierCommands: [VERIFIER],
    requiredVerifiers,
    verifierOwner: owner,
    lastVerifierReceipt: prepared.lastVerifierReceipt ?? kernelReceipt,
    executedVerifierLedger: prepared.executedVerifierLedger ?? [kernelReceipt],
    verifierEvidenceErrors: prepared.verifierEvidenceErrors,
    currentReceiptRevisionHashes: kernelReceipt.receiptId ? { [kernelReceipt.receiptId]: candidate } : {},
    currentWorkspaceRevisionHash: candidate,
  })
  assert.equal(decision.allowed, true, JSON.stringify(decision))
  assert.equal(decision.finalOutcome, 'VERIFIED_COMPLETE', JSON.stringify(decision))
})

test('P1-3: a documentation goal is advisory but mechanically checked', t => {
  const { root, contract } = fixture([GOAL, DOC_GOAL, 'Requirements:', `- \`${VERIFIER}\` must pass.`].join('\n'), {
    readme: '# Parser\n\nUsage: parseSum adds two numbers.\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const docs = contract.acceptance.find(item => item.description === DOC_GOAL)!
  assert.equal(docs.required, false, 'non-executable docs goal must not block every other obligation')
  assert.equal(hasAdvisoryDocsGoal(contract.acceptance), true)
  assert.deepEqual(advisoryDocsViolations({ acceptance: contract.acceptance, projectRoot: root }), [],
    'the written README satisfies the recorded goal')

  writeFileSync(join(root, 'README.md'), '# Parser\n\nNo usage yet.\n')
  assert.equal(advisoryDocsViolations({ acceptance: contract.acceptance, projectRoot: root }).length, 1,
    'a README without the requested behavior is still a violation')
  rmSync(join(root, 'README.md'))
  assert.equal(advisoryDocsViolations({ acceptance: contract.acceptance, projectRoot: root }).length, 1,
    'a missing documentation target is still a violation')
})

test('P1-2: a public-surface rename is a preservation violation', t => {
  const task = [GOAL, 'Do not change public APIs.', 'Requirements:', `- \`${VERIFIER}\` must pass.`].join('\n')
  const { root, contract } = fixture(task)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(hasPublicApiPreservationClause(task), true)
  const frozen = publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root })
  assert.equal(frozen, null, 'an unchanged surface satisfies the constraint')
  const before = computePublicApiSurface(root)!
  assert.ok(before.files['src/parser.js']!.includes('name:parseMinus'))
  writeFileSync(join(root, 'src', 'parser.js'),
    'export function parseSum(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }\n')
  assert.match(
    publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root }) ?? '',
    /public API surface changed/,
  )
})

test('P1-2 control: no freeze is recorded without the preservation clause', t => {
  const { root, contract } = fixture(GOAL)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(hasPublicApiPreservationClause(GOAL), false)
  assert.equal(publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root }), null)
  writeFileSync(join(root, 'src', 'parser.js'),
    'export function parseSum(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }\n')
  assert.equal(publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root }), null)
})

test('P1-3 positive: multi-goal task with a written docs obligation certifies', async t => {
  const task = [GOAL, DOC_GOAL, 'Requirements:', `- \`${VERIFIER}\` must pass.`].join('\n')
  const { root, contract } = fixture(task, { readme: '# Parser\n\nUsage: parseSum adds two numbers.\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const docs = contract.acceptance.find(item => item.description === DOC_GOAL)
  assert.equal(docs?.required, false)
  assert.deepEqual(advisoryDocsViolations({ acceptance: contract.acceptance, projectRoot: root }), [])

  const sessionId = 'round2-multigoal'
  const owner = chatVerifierOwner({
    projectRoot: root,
    sessionId,
    taskId: contract.task_id,
    contractHash: contract.contract_hash,
  })
  assert.ok(owner)
  const requiredVerifiers = chatVerifierRequirements(owner, [VERIFIER], contract.user_request, root)
  const receipt = await captureChatVerifierReceipt({
    projectRoot: root,
    command: VERIFIER,
    exitCode: 0,
    summary: 'parseSum passed',
    stdout: TAP,
    mutationPaths: ['src/parser.js', 'README.md'],
    executionContext: requiredVerifiers[0]!.executionContext,
    execution: { working_directory: '.', environment_policy: 'host-process' },
  })
  assert.ok(receipt)
  receipt.order = { sessionId, seq: 1 }
  const candidate = resolveGovernedCriterionCandidateRevisionSha(root, receipt)
  assert.ok(candidate)
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId: sessionId, projectRoot: root }))
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    receipts: [receipt],
    candidate_sha: candidate,
    has_mutation: true,
  })
  const prepared = prepareKernelVerifierInput(receipt, [receipt])
  const kernelReceipt = prepared.executedVerifierLedger?.[0] as ExecutorVerifierReceipt | undefined
  assert.ok(kernelReceipt)
  const decision = createExecutorKernel('chat').completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'none',
    toolCallLog: [],
    proof: { compliant: true },
    acceptance: service.currentRequest(),
    requiredVerifierCommands: [VERIFIER],
    requiredVerifiers,
    verifierOwner: owner,
    lastVerifierReceipt: prepared.lastVerifierReceipt ?? kernelReceipt,
    executedVerifierLedger: prepared.executedVerifierLedger ?? [kernelReceipt],
    verifierEvidenceErrors: prepared.verifierEvidenceErrors,
    currentReceiptRevisionHashes: kernelReceipt.receiptId ? { [kernelReceipt.receiptId]: candidate } : {},
    currentWorkspaceRevisionHash: candidate,
  })
  assert.equal(decision.allowed, true, JSON.stringify(decision))
  assert.equal(decision.finalOutcome, 'VERIFIED_COMPLETE', JSON.stringify(decision))
})

test('P1-2: the same constraint without a Requirements section is not unsatisfiable prose', t => {
  const task = [GOAL, 'Do not change public APIs.'].join('\n')
  const { root, contract } = fixture(task)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const constraint = contract.acceptance.find(item => /Do not change public APIs/.test(item.description))
  assert.ok(constraint, 'the constraint stays recorded')
  assert.equal(constraint.required, false, 'it is enforced by the frozen surface, not by prose')
  assert.equal(publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root }), null)
})

test('P1 sequencing: ambient NO_CHANGE opts out of final-revision proof explicitly', () => {
  const ambient = noChangeFinalRevisionScope({ ambientReadOnly: true })
  assert.equal(ambient.finalRevisionRequired, false)
  const project = noChangeFinalRevisionScope({ ambientReadOnly: false })
  assert.equal('finalRevisionRequired' in project, false,
    'project-scoped no-change keeps the witness requirement')

  const decision = createExecutorKernel('chat').completion.decide({
    mode: 'chat',
    requestedOutcome: 'NO_CHANGE_REQUIRED',
    hasWrite: false,
    verificationPolicy: 'required',
    toolCallLog: [{ tool: 'read_file', target: 'src/parser.js', exit_code: 0 }],
    ...ambient,
  })
  assert.equal(decision.allowed, true, JSON.stringify(decision))
  assert.equal(decision.finalOutcome, 'NO_CHANGE_REQUIRED', JSON.stringify(decision))
})

test('P2 containment: an outside documentation path is never admitted or read', t => {
  const task = [GOAL, 'Update ../outside.md so the example shows parseSum usage.'].join('\n')
  const { root, contract } = fixture(task)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outside = contract.acceptance.find(item => /outside\.md/.test(item.description))
  assert.ok(outside)
  assert.equal(outside.required, true, 'an escaping target stays a required (non-advisory) obligation')

  const crafted = {
    ...outside,
    required: false,
    verification_strategy: ADVISORY_DOC_STRATEGY,
  }
  let reads = 0
  const violations = advisoryDocsViolations({
    acceptance: [crafted],
    projectRoot: root,
    readFile: () => { reads += 1; return 'parseSum' },
  })
  assert.match(violations.join('\n'), /escapes the project root/)
  assert.equal(reads, 0, 'an outside path is rejected before any read')
})
