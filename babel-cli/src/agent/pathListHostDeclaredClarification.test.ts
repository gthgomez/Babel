import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
  TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
  TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
  type TrustedHostFilesystemPathListDeclarationV1,
} from '../authority/trustedHostFilesystemPathList.js'
import { inferTaskAcceptance, ACCEPTANCE_MEANING_REF } from './taskAcceptanceMeaning.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { LiveSessionAuthorityError } from './liveSessionBridge.js'
import {
  applyHostDeclaredPathListClarification,
  formatHostDeclaredPathListClarificationDescription,
  HOST_ACCEPTANCE_CLARIFICATION_DERIVED_REF,
  HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID,
} from './pathListHostDeclaredClarification.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

function baseDeclaration(
  acceptance_clarification?: TrustedHostFilesystemPathListDeclarationV1['acceptance_clarification'],
): TrustedHostFilesystemPathListDeclarationV1 {
  return {
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: 'decl-fixture',
    user_request: USER_REQUEST,
    user_request_digest: sha256Canonical(USER_REQUEST),
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths',
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' },
    preserved_input_selectors: ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
    ...(acceptance_clarification ? { acceptance_clarification } : {}),
  }
}

function bindingForTask(task: string = USER_REQUEST) {
  const meaning = inferTaskAcceptance(task)
  const unresolved = meaning.sources.filter(source => source.status === 'unresolved')
  assert.equal(unresolved.length, 1)
  const source = unresolved[0]!
  return {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: source.criterion_id,
    task_request_digest: sha256Canonical(task),
    meaning_input_digest: source.input_digest,
  }
}

function expectReject(
  fn: () => void,
  code: string,
  meaningBefore: ReturnType<typeof inferTaskAcceptance>,
) {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof LiveSessionAuthorityError)
  assert.equal(caught.code, code)
  const after = structuredClone(meaningBefore)
  assert.deepEqual(after, meaningBefore)
}

test('R12 absent clarification leaves meaning unchanged', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const declaration = baseDeclaration()
  const result = applyHostDeclaredPathListClarification({ meaning, declaration })
  assert.deepEqual(result, meaning)
})

test('G01 valid binding clarifies sole unresolved row in place', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = bindingForTask()
  const declaration = baseDeclaration(binding)
  const result = applyHostDeclaredPathListClarification({ meaning, declaration })
  const row = result.criteria.find(criterion => criterion.id === binding.target_criterion_id)
  assert.ok(row)
  assert.equal(row!.description, formatHostDeclaredPathListClarificationDescription(declaration))
  assert.equal(row!.verification.verifier_id, HOST_PATH_LIST_ACCEPTANCE_VERIFIER_ID)
  assert.equal(result.unresolved, false)
})

test('G02 historical unresolved provenance is retained', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = bindingForTask()
  const declaration = baseDeclaration(binding)
  const result = applyHostDeclaredPathListClarification({ meaning, declaration })
  assert.ok(
    result.provenance.some(ref => ref.ref.includes(`${ACCEPTANCE_MEANING_REF}:unresolved:`)),
  )
  assert.ok(result.provenance.some(ref => ref.ref.startsWith(HOST_ACCEPTANCE_CLARIFICATION_DERIVED_REF)))
})

test('G03 single current source for target criterion', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = bindingForTask()
  const result = applyHostDeclaredPathListClarification({
    meaning,
    declaration: baseDeclaration(binding),
  })
  const forTarget = result.sources.filter(source => source.criterion_id === binding.target_criterion_id)
  assert.equal(forTarget.length, 1)
  assert.equal(forTarget[0]!.status, 'explicit')
})

test('R02 unknown criterion id rejects without mutation', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = { ...bindingForTask(), target_criterion_id: 'acceptance:ffffffffffffffffffffffffffffffff' }
  expectReject(
    () => applyHostDeclaredPathListClarification({ meaning, declaration: baseDeclaration(binding) }),
    'PATH_LIST_CLARIFICATION_CRITERION_UNKNOWN',
    meaning,
  )
})

test('R07 meaning digest mismatch rejects', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = { ...bindingForTask(), meaning_input_digest: '0'.repeat(64) }
  expectReject(
    () => applyHostDeclaredPathListClarification({ meaning, declaration: baseDeclaration(binding) }),
    'PATH_LIST_CLARIFICATION_MEANING_DIGEST_MISMATCH',
    meaning,
  )
})

test('R03 target must be unresolved row', () => {
  const task = 'Must refresh the path index listing under apps/.'
  const meaning = inferTaskAcceptance(task)
  assert.equal(meaning.sources.some(source => source.status === 'inferred'), true)
  const inferred = meaning.sources.find(source => source.status === 'inferred')!
  const binding = {
    ...bindingForTask(USER_REQUEST),
    target_criterion_id: inferred.criterion_id,
    task_request_digest: sha256Canonical(USER_REQUEST),
    meaning_input_digest: inferred.input_digest,
  }
  expectReject(
    () =>
      applyHostDeclaredPathListClarification({
        meaning,
        declaration: { ...baseDeclaration(), user_request: USER_REQUEST, user_request_digest: sha256Canonical(USER_REQUEST), acceptance_clarification: binding },
      }),
    'PATH_LIST_CLARIFICATION_TARGET_NOT_UNRESOLVED',
    meaning,
  )
})

test('R06 explicit bullet obligations reject clarification', () => {
  const task = '- Must update meta/tree-index.md.\n' + USER_REQUEST
  const meaning = inferTaskAcceptance(task)
  const binding = bindingForTask(USER_REQUEST)
  const declaration = {
    ...baseDeclaration(binding),
    user_request: task,
    user_request_digest: sha256Canonical(task),
    acceptance_clarification: {
      ...binding,
      task_request_digest: sha256Canonical(task),
    },
  }
  expectReject(
    () => applyHostDeclaredPathListClarification({ meaning, declaration }),
    'PATH_LIST_CLARIFICATION_EXPLICIT_OBLIGATIONS_PRESENT',
    meaning,
  )
})

test('R05 multiple unresolved rows reject clarification', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const second = {
    criterion_id: 'acceptance:second-unresolved-fixture',
    status: 'unresolved' as const,
    input_digest: sha256Canonical('other'),
    start: 0,
    end: 1,
  }
  meaning.sources.push(second)
  meaning.criteria.push({
    id: second.criterion_id,
    description: 'Clarify the observable acceptance requirements for this request.',
    type: 'custom',
    required: true,
    verification: { kind: 'custom', verifier_id: 'meaning:fixture:abcd' },
    verification_strategy: 'Acceptance meaning is unresolved; a finished response or successful command cannot satisfy this requirement.',
  })
  meaning.unresolved = true
  const binding = bindingForTask()
  expectReject(
    () => applyHostDeclaredPathListClarification({ meaning, declaration: baseDeclaration(binding) }),
    'PATH_LIST_CLARIFICATION_MULTIPLE_UNRESOLVED',
    meaning,
  )
})

test('R08 provenance ref mismatch rejects', () => {
  const meaning = inferTaskAcceptance(USER_REQUEST)
  const binding = {
    ...bindingForTask(),
    meaning_provenance_ref: `${ACCEPTANCE_MEANING_REF}:explicit:deadbeef`,
  }
  expectReject(
    () => applyHostDeclaredPathListClarification({ meaning, declaration: baseDeclaration(binding) }),
    'PATH_LIST_CLARIFICATION_PROVENANCE_MISMATCH',
    meaning,
  )
})

test('executable binding present rejects clarification', () => {
  const task = 'Must run npm test.'
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(task),
    trustedVerifierCommands: ['npm test'],
    defaultWorkingDirectory: '.',
  })
  if (!bound.criteria.some(c => !c.verification.verifier_id.startsWith('meaning:'))) return
  const binding = {
    schema_version: 1 as const,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: bound.criteria[0]!.id,
    task_request_digest: sha256Canonical(task),
    meaning_input_digest: bound.sources[0]!.input_digest,
  }
  expectReject(
    () =>
      applyHostDeclaredPathListClarification({
        meaning: bound,
        declaration: {
          ...baseDeclaration(binding),
          user_request: task,
          user_request_digest: sha256Canonical(task),
        },
      }),
    'PATH_LIST_CLARIFICATION_EXPLICIT_OBLIGATIONS_PRESENT',
    bound,
  )
})
