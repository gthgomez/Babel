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
  assertPathListSessionBinding,
  pathListAdmissionProvenanceRecord,
  TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX,
  type LiveSessionFilesystemPathListAdmissionV1,
} from '../agent/liveSessionFilesystemPathListAdmission.js'
import { applyHostDeclaredPathListClarification } from '../agent/pathListHostDeclaredClarification.js'
import { inferTaskAcceptance } from '../agent/taskAcceptanceMeaning.js'
import { buildTaskContractV1, freezeTaskContract } from '../agent/taskContract.js'
import { LiveSessionAuthorityError } from '../agent/liveSessionAuthorityError.js'
import {
  evaluateCompletionGateForEngine,
  evaluateExecuteCompletionHonesty,
} from '../agent/completionGatePolicy.js'
import {
  createCriterionCompletionServiceV1,
  type CriterionCompletionOwnerV1,
} from './criterionCompletion.js'
import {
  requireNativePathListCertificationProvenance,
  runOwnedHostPathListVerification,
} from './criterionNativePathListEvidence.js'
import { HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID } from '../agent/pathListHostDeclaredClarification.js'
import {
  LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
} from '../agent/liveSessionFilesystemPathListAdmission.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

function admissionFixture(
  userRequest: string,
): LiveSessionFilesystemPathListAdmissionV1 {
  return {
    schema_version: 1,
    kind: LIVE_SESSION_FILESYSTEM_PATH_LIST_ADMISSION_KIND,
    user_request_digest: 'abc',
    project_root_real: '/tmp/fixture',
    admission_record_digest: 'digest',
    declaration: {
      schema_version: 1,
      kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
      declaration_id: 'decl-1',
      user_request: userRequest,
      user_request_digest: 'abc',
      target_document: 'meta/tree-index.md',
      format_profile: 'markdown_bullet_paths',
      inventory_scope: { roots: ['apps'] },
      coverage: { mode: 'complete_scoped_inventory' },
      preserved_input_selectors: [],
      limits: { max_document_bytes: 32_000, max_entries: 128 },
    },
    preserved_baseline: {
      schema_version: 1,
      kind: 'filesystem_source_baseline_v1',
      declaration_hash: 'hash',
      project_root_real: '/tmp/fixture',
      captured_at: '2026-01-01T00:00:00.000Z',
      preserved: {},
      inventory_snapshot: [],
    },
  }
}

function pathListOwnerFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-path-list-neg-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
    runId: 'path-list-run',
    projectRoot: root,
    filesystemPathListAdmission: admission,
    hasGovernedMutationLineage: () => true,
    candidateRevisionSha: () => candidateSha,
  }
  const service = createCriterionCompletionServiceV1(() => owner)
  return { root, owner, service, frozen, admission, candidateSha, projectRootReal }
}

function establishOwnedHandle(service: ReturnType<typeof createCriterionCompletionServiceV1>) {
  service.refreshNativePathListEvidence()
  const handle = service.pathListVerificationRequest()
  assert.ok(handle)
  return handle
}

function evaluateOwnerErrors(
  service: ReturnType<typeof createCriterionCompletionServiceV1>,
  handle: NonNullable<ReturnType<typeof service.pathListVerificationRequest>>,
) {
  const result = service.evaluateOwnedPathListVerification(handle)
  assert.equal(result.verified, false)
  return result.errors
}

test('negative: stale path-list verification handle is rejected after authority reset', () => {
  const service = createCriterionCompletionServiceV1(() => ({
    contract: undefined,
    runId: 'run',
    projectRoot: null,
  }))
  const forged = Object.freeze({
    schema_version: 1 as const,
    kind: 'path-list-verification:v1' as const,
  })
  assert.deepEqual(service.evaluateOwnedPathListVerification(forged).errors, [
    'PATH_LIST_REQUEST_UNTRUSTED',
  ])
})

test('negative: direct provenance guard rejects contract without admission provenance digest', () => {
  const admission = admissionFixture('List paths for the current task.')
  const contract = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: 'List paths for the current task.',
      acceptance_criteria: ['path list'],
      acceptance: [
        {
          id: 'paths',
          description: 'path list',
          type: 'policy',
          required: true,
          verification_strategy: 'native path list',
          verification: {
            kind: 'policy',
            verifier_id: HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
            target: 'target-hash',
          },
        },
      ],
    }),
  )
  assert.throws(
    () => requireNativePathListCertificationProvenance(contract, admission),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError &&
      error.code === 'PATH_LIST_ADMISSION_PROVENANCE_MISMATCH',
  )
})

test('negative: runOwnedHostPathListVerification rejects missing admission provenance', t => {
  const { frozen, admission, candidateSha, projectRootReal } = pathListOwnerFixture(t)
  const contractWithoutProvenance = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: USER_REQUEST,
      acceptance: frozen.acceptance,
      acceptance_criteria: frozen.acceptance_criteria,
      provenance: frozen.provenance.records.filter(
        record =>
          record.kind !== 'user_goal' &&
          record.kind !== 'derived_acceptance' &&
          !record.ref.startsWith(TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX),
      ),
    }),
  )
  const owned = runOwnedHostPathListVerification({
    projectRoot: projectRootReal,
    contract: contractWithoutProvenance,
    admission,
    candidateSha,
  })
  assert.equal(owned.ok, false)
  if (owned.ok) assert.fail('expected provenance rejection')
  assert.equal(owned.code, 'PATH_LIST_ADMISSION_PROVENANCE_MISMATCH')
})

test('negative: path-list session binding rejects stale admission task text', () => {
  const admission = admissionFixture('stale task text')
  const contract = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: 'current task text',
      acceptance_criteria: ['current task text'],
    }),
  )
  assert.throws(
    () =>
      assertPathListSessionBinding({
        projectRoot: admission.project_root_real,
        task: contract.user_request,
        contract,
        admission,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError &&
      error.code === 'PATH_LIST_REQUEST_MISMATCH',
  )
})

test('negative: completion owner rejects document inventory drift at unchanged git head', t => {
  const { root, service } = pathListOwnerFixture(t)
  const handle = establishOwnedHandle(service)
  writeFileSync(join(root, 'meta', 'tree-index.md'), '- apps/web/phantom.mjs\n', 'utf8')
  assert.deepEqual(evaluateOwnerErrors(service, handle), ['PATH_LIST_VERIFY_failed'])
})

test('negative: completion owner rejects scoped untracked inventory at unchanged git head', t => {
  const { root, service } = pathListOwnerFixture(t)
  const handle = establishOwnedHandle(service)
  writeFileSync(join(root, 'apps', 'web', 'untracked.mjs'), 'export {}\n', 'utf8')
  assert.deepEqual(evaluateOwnerErrors(service, handle), ['PATH_LIST_VERIFY_failed'])
})

test('negative: completion owner rejects candidate revision change during verify', t => {
  const { owner, service, candidateSha } = pathListOwnerFixture(t)
  const handle = establishOwnedHandle(service)
  let reads = 0
  owner.candidateRevisionSha = () => {
    reads += 1
    return reads === 1 ? candidateSha : 'e'.repeat(64)
  }
  assert.deepEqual(evaluateOwnerErrors(service, handle), ['PATH_LIST_MUTATION_DURING_VERIFY'])
})

test('negative: completion owner rejects missing governed mutation lineage', t => {
  const { owner, service, candidateSha } = pathListOwnerFixture(t)
  owner.hasGovernedMutationLineage = () => false
  assert.equal(service.nativePathListProofCompliant(), false)
  owner.hasGovernedMutationLineage = () => true
  const handle = establishOwnedHandle(service)
  owner.hasGovernedMutationLineage = () => false
  owner.candidateRevisionSha = () => candidateSha
  assert.deepEqual(evaluateOwnerErrors(service, handle), ['PATH_LIST_MUTATION_LINEAGE_MISSING'])
})

test('negative: completion owner rejects admission without host clarification binding', t => {
  const { frozen, admission, candidateSha, projectRootReal, owner, service } = pathListOwnerFixture(t)
  const { acceptance_clarification: _omit, ...declarationWithoutClarification } =
    admission.declaration
  const admissionNoClarification = {
    ...admission,
    declaration: declarationWithoutClarification,
  }
  const owned = runOwnedHostPathListVerification({
    projectRoot: projectRootReal,
    contract: frozen,
    admission: admissionNoClarification,
    candidateSha,
  })
  assert.equal(owned.ok, false)
  if (owned.ok) assert.fail('expected clarification rejection')
  assert.equal(owned.code, 'PATH_LIST_CLARIFICATION_ABSENT')
  const handle = establishOwnedHandle(service)
  owner.filesystemPathListAdmission = admissionNoClarification
  assert.deepEqual(evaluateOwnerErrors(service, handle), ['PATH_LIST_CLARIFICATION_ABSENT'])
})

test('negative: runOwnedHostPathListVerification rejects wrong verification target spec', t => {
  const { frozen, admission, candidateSha, projectRootReal } = pathListOwnerFixture(t)
  const tampered = freezeTaskContract(
    buildTaskContractV1({
      mode: 'chat',
      user_request: frozen.user_request,
      acceptance: frozen.acceptance.map(row =>
        row.verification.verifier_id === HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID
          ? {
              ...row,
              verification: {
                ...row.verification,
                target: 'forged-target-digest',
              },
            }
          : row,
      ),
      acceptance_criteria: frozen.acceptance_criteria,
      provenance: frozen.provenance.records.filter(
        record => record.kind !== 'user_goal' && record.kind !== 'derived_acceptance',
      ),
    }),
  )
  const owned = runOwnedHostPathListVerification({
    projectRoot: projectRootReal,
    contract: tampered,
    admission,
    candidateSha,
  })
  assert.equal(owned.ok, false)
  if (owned.ok) assert.fail('expected target mismatch rejection')
  assert.equal(owned.code, 'PATH_LIST_VERIFICATION_TARGET_MISMATCH')
})

test('negative: runOwnedHostPathListVerification rejects physical root mismatched to admission', t => {
  const { frozen, admission, candidateSha, projectRootReal } = pathListOwnerFixture(t)
  const otherRoot = mkdtempSync(join(tmpdir(), 'babel-path-list-other-root-'))
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
  const owned = runOwnedHostPathListVerification({
    projectRoot: otherRoot,
    contract: frozen,
    admission,
    candidateSha,
  })
  assert.equal(owned.ok, false)
  if (owned.ok) assert.fail('expected root mismatch rejection')
  assert.equal(owned.code, 'PATH_LIST_SESSION_ROOT_MISMATCH')
})

test('negative: completion owner rejects replaced physical project root via epoch rebinding', t => {
  const { owner, service } = pathListOwnerFixture(t)
  const handle = establishOwnedHandle(service)
  const otherRoot = mkdtempSync(join(tmpdir(), 'babel-path-list-other-root-'))
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
  owner.projectRoot = otherRoot
  assert.deepEqual(service.evaluateOwnedPathListVerification(handle).errors, [
    'PATH_LIST_REQUEST_UNTRUSTED',
  ])
})

test('negative: mixed independent shell matrix — strict gate rejects native-only satisfaction', () => {
  const gate = evaluateCompletionGateForEngine({
    turnType: 'completion',
    taskIntent: 'execute',
    task: USER_REQUEST,
    taskClass: 'general_swe',
    toolCallLog: [{
      tool: 'str_replace',
      target: 'meta/tree-index.md',
      effect_status: 'confirmed_change',
    }],
    lastVerifierReceipt: null,
    requiredVerifierCommands: ['npm test'],
    nativePathListCompletionSatisfied: true,
  })
  assert.equal(gate, 'reject')

  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'strict',
    lastVerifierReceipt: null,
    toolCallLog: [],
    requiredVerifierCommands: ['npm test'],
    nativePathListCompletionSatisfied: true,
  })
  assert.equal(honesty.allow, false)
  assert.equal(honesty.reason, 'verifier_missing')
})

test('negative: mixed independent shell matrix — required policy allows native-only satisfaction', () => {
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: 'required',
    lastVerifierReceipt: null,
    toolCallLog: [],
    requiredVerifierCommands: [],
    nativePathListCompletionSatisfied: true,
  })
  assert.equal(honesty.allow, true)

  const gate = evaluateCompletionGateForEngine({
    turnType: 'completion',
    taskIntent: 'execute',
    task: USER_REQUEST,
    taskClass: 'general_swe',
    toolCallLog: [{
      tool: 'str_replace',
      target: 'meta/tree-index.md',
      effect_status: 'confirmed_change',
    }],
    lastVerifierReceipt: null,
    requiredVerifierCommands: [],
    nativePathListCompletionSatisfied: true,
  })
  assert.equal(gate, 'allow')
})
