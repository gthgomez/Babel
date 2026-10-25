import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
  TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
  TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
} from './trustedHostFilesystemPathList.js'
import {
  admitFilesystemPathListForLiveSession,
  pathListAdmissionProvenanceRecord,
} from '../agent/liveSessionFilesystemPathListAdmission.js'
import { applyHostDeclaredPathListClarification } from '../agent/pathListHostDeclaredClarification.js'
import { inferTaskAcceptance } from '../agent/taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  createCriterionCompletionServiceV1, evaluateCriterionCompletionV1,
  type CriterionCompletionOwnerV1, type CriterionCompletionRequestV1,
} from './criterionCompletion.js'

function contract() {
  return freezeTaskContract(buildTaskContractV1({
    mode: 'chat', user_request: 'Produce the required fixture output.',
    acceptance: [{ id: 'output', description: 'The output matches the required value.',
      type: 'custom', required: true, verification_strategy: 'Independent output evidence.',
      verification: { kind: 'custom', verifier_id: 'fixture:output' } }],
  }))
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner: CriterionCompletionOwnerV1 = { contract: contract(), runId: 'fixture-run', projectRoot: root }
  const service = createCriterionCompletionServiceV1(() => owner)
  const request: CriterionCompletionRequestV1 = {
    context: service.context, contract: owner.contract!, run_id: owner.runId, project_root: root,
  }
  return { root, owner, service, request }
}

test('an owned context reports required criteria missing without trusted executions', t => {
  const { request } = fixture(t)
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.verified, false)
  assert.deepEqual(result.missing_requirements, ['output'])
  assert.deepEqual(result.satisfied_requirements, [])
})

test('a serialized context cannot retain parent-process authority', t => {
  const { request } = fixture(t)
  const result = evaluateCriterionCompletionV1({ ...request, context: JSON.parse(JSON.stringify(request.context)) })
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_context_untrusted'])
})

test('caller-made pass callbacks are never invoked by the kernel', t => {
  const { request } = fixture(t)
  let called = false
  const forged = { ...request.context, evaluate: () => { called = true; return { verified: true } } }
  const result = createExecutorKernel('chat').completion.decide({
    mode: 'chat', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], proof: { compliant: true },
    acceptance: { ...request, context: forged },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.finalOutcome, 'UNVERIFIED_PATCH')
  assert.equal(called, false)
})

test('a current owned context cannot turn coarse proof into criterion evidence', t => {
  const { request } = fixture(t)
  const result = createExecutorKernel('deep').completion.decide({
    mode: 'deep', requestedOutcome: 'VERIFIED_COMPLETE', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], proof: { compliant: true }, acceptance: request,
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'completion_downgraded:acceptance_unverified')
})

test('a replaced accepted head cannot be evaluated through its predecessor request', t => {
  const { owner, request } = fixture(t)
  owner.contract = contract()
  const result = evaluateCriterionCompletionV1(request)
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_head_mismatch'])
})

test('the service builds fresh request identity from its current owner', t => {
  const { owner, service } = fixture(t)
  owner.contract = contract()
  owner.runId = 'new-owner-run'
  const request = service.currentRequest()!
  assert.equal(request.contract, owner.contract)
  assert.equal(request.run_id, owner.runId)
  assert.equal(evaluateCriterionCompletionV1(request).verified, false)
})

test('an engine run replacement cannot reuse the prior request', t => {
  const { owner, request } = fixture(t)
  owner.runId = 'replacement-run'
  assert.deepEqual(evaluateCriterionCompletionV1(request).errors, ['acceptance_run_mismatch'])
})

test('a request cannot substitute a different physical project', t => {
  const { request } = fixture(t)
  const other = fixture(t)
  const result = evaluateCriterionCompletionV1({ ...request, project_root: other.root })
  assert.equal(result.verified, false)
  assert.deepEqual(result.errors, ['acceptance_project_mismatch'])
})

test('conversation scope cannot acquire project certification from ambient cwd', t => {
  const { owner, request } = fixture(t)
  owner.projectRoot = null
  assert.deepEqual(evaluateCriterionCompletionV1(request).errors, ['acceptance_project_unavailable'])
})

test('unavailable owner errors do not leak their payload', t => {
  const { request } = fixture(t)
  const service = createCriterionCompletionServiceV1(() => { throw new Error('fixture-private-error') })
  assert.deepEqual(evaluateCriterionCompletionV1({ ...request, context: service.context }).errors,
    ['acceptance_context_unavailable'])
})

test('Plan and nonverified terminals do not consult criterion authority', t => {
  const { request } = fixture(t)
  let reads = 0
  const service = createCriterionCompletionServiceV1(() => { reads++; throw new Error('must not evaluate') })
  const acceptance = { ...request, context: service.context }
  const plan = createExecutorKernel('plan').completion.decide({
    mode: 'plan', requestedOutcome: 'PLAN_COMPLETE', hasWrite: false,
    verificationPolicy: 'strict', toolCallLog: [], acceptance,
  })
  const unverified = createExecutorKernel('chat').completion.decide({
    mode: 'chat', requestedOutcome: 'UNVERIFIED_PATCH', hasWrite: true,
    verificationPolicy: 'none', toolCallLog: [], acceptance,
  })
  assert.equal(plan.finalOutcome, 'PLAN_COMPLETE')
  assert.equal(plan.allowed, true)
  assert.equal(unverified.finalOutcome, 'UNVERIFIED_PATCH')
  assert.equal(reads, 0)
})

test('same-epoch refreshPrivateEvidence clears native path-list verification handles', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-path-list-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const USER_REQUEST =
    'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' }).status, 0)
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'meta'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'entry.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n', 'utf8')
  writeFileSync(join(root, 'meta', 'tree-index.md'), '- apps/web/entry.mjs\n', 'utf8')

  const meaning = inferTaskAcceptance(USER_REQUEST)
  const unresolved = meaning.sources.filter(source => source.status === 'unresolved')[0]!
  const binding = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: unresolved.criterion_id,
    task_request_digest: sha256Canonical(USER_REQUEST),
    meaning_input_digest: unresolved.input_digest,
  }
  const declaration = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request: USER_REQUEST,
    user_request_digest: sha256Canonical(USER_REQUEST),
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths' as const,
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' as const },
    preserved_input_selectors: ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
    acceptance_clarification: binding,
  }
  const clarified = applyHostDeclaredPathListClarification({ meaning, declaration })
  const projectRootReal = realpathSync.native(root)
  const admission = admitFilesystemPathListForLiveSession(
    projectRootReal,
    USER_REQUEST,
    declaration,
  )
  const frozen = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: USER_REQUEST,
      acceptance: clarified.criteria,
      acceptance_criteria: clarified.criteria.map(row => row.description),
      provenance: [
        ...clarified.provenance,
        pathListAdmissionProvenanceRecord(admission.admission_record_digest),
      ],
    }),
  )
  const candidateSha = 'f'.repeat(64)
  let lineage = true
  const owner: CriterionCompletionOwnerV1 = {
    contract: frozen,
    runId: 'path-list-run',
    projectRoot: root,
    filesystemPathListAdmission: admission,
    hasGovernedMutationLineage: () => lineage,
    candidateRevisionSha: () => candidateSha,
  }
  const service = createCriterionCompletionServiceV1(() => owner)
  service.refreshNativePathListEvidence()
  assert.equal(service.nativePathListProofCompliant(), true)
  const handle = service.pathListVerificationRequest()
  assert.ok(handle)
  service.refreshPrivateEvidence({
    proof: { compliant: true },
    candidate_sha: candidateSha,
    has_mutation: true,
  })
  assert.equal(service.pathListVerificationRequest(), undefined)
  assert.equal(service.evaluateOwnedPathListVerification(handle).verified, false)
  lineage = false
  assert.equal(service.nativePathListProofCompliant(), false)
})

test('owner run replacement revokes prior path-list handle without refresh', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-criterion-path-list-epoch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const USER_REQUEST =
    'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' }).status, 0)
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'meta'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'entry.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n', 'utf8')
  writeFileSync(join(root, 'meta', 'tree-index.md'), '- apps/web/entry.mjs\n', 'utf8')

  const meaning = inferTaskAcceptance(USER_REQUEST)
  const unresolved = meaning.sources.filter(source => source.status === 'unresolved')[0]!
  const binding = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: unresolved.criterion_id,
    task_request_digest: sha256Canonical(USER_REQUEST),
    meaning_input_digest: unresolved.input_digest,
  }
  const declaration = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request: USER_REQUEST,
    user_request_digest: sha256Canonical(USER_REQUEST),
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths' as const,
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' as const },
    preserved_input_selectors: ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
    acceptance_clarification: binding,
  }
  const clarified = applyHostDeclaredPathListClarification({ meaning, declaration })
  const projectRootReal = realpathSync.native(root)
  const admission = admitFilesystemPathListForLiveSession(
    projectRootReal,
    USER_REQUEST,
    declaration,
  )
  const frozen = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: USER_REQUEST,
      acceptance: clarified.criteria,
      acceptance_criteria: clarified.criteria.map(row => row.description),
      provenance: [
        ...clarified.provenance,
        pathListAdmissionProvenanceRecord(admission.admission_record_digest),
      ],
    }),
  )
  const candidateSha = 'f'.repeat(64)
  const owner: CriterionCompletionOwnerV1 = {
    contract: frozen,
    runId: 'path-list-run-a',
    projectRoot: root,
    filesystemPathListAdmission: admission,
    hasGovernedMutationLineage: () => true,
    candidateRevisionSha: () => candidateSha,
  }
  const service = createCriterionCompletionServiceV1(() => owner)
  service.refreshNativePathListEvidence()
  const handle = service.pathListVerificationRequest()
  assert.ok(handle)
  owner.runId = 'path-list-run-b'
  assert.deepEqual(service.evaluateOwnedPathListVerification(handle).errors, [
    'PATH_LIST_REQUEST_UNTRUSTED',
  ])
})
