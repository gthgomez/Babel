import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import { TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND } from '../authority/trustedHostFilesystemPathList.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { ChatEngine } from './chatEngine.js'
import { TRUSTED_HOST_PATH_LIST_ADMISSION_REF } from './liveSessionFilesystemPathListAdmission.js'
import {
  LiveSessionAuthorityError,
  TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME,
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
} from './liveSessionBridge.js'
import { refreshEngineInstructionManifest } from './chatEngineLiveSession.js'
import type { ParityRuntime } from './chatEngineParityBridge.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

function declarationPayload(overrides: { userRequest?: string } = {}) {
  const user_request = overrides.userRequest ?? USER_REQUEST
  return {
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request,
    user_request_digest: sha256Canonical(user_request),
    target_document: 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths',
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' },
    preserved_input_selectors: ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
  }
}

function seedRepo(root: string) {
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'entry.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n', 'utf8')
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('ChatEngine constructor rejects declaration when projectRoot is null', () => {
  const runId = `path-list-null-root-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  let caught: unknown
  try {
    new ChatEngine({
      runId,
      task: USER_REQUEST,
      projectRoot: null,
      trustedHostFilesystemPathListDeclaration: declarationPayload(),
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof LiveSessionAuthorityError)
  assert.equal(caught.code, 'PATH_LIST_DECLARATION_REQUIRES_PROJECT_ROOT')
  assert.equal(existsSync(runDir), false)
  assert.equal(existsSync(join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)), false)
})

test('ChatEngine constructor rejects task drift and leaves no path-list admission artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-drift-'))
  const runId = `path-list-engine-drift-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  try {
    seedRepo(root)
    let caught: unknown
    try {
      new ChatEngine({
        runId,
        task: USER_REQUEST + ' ',
        projectRoot: root,
        trustedHostFilesystemPathListDeclaration: declarationPayload(),
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof LiveSessionAuthorityError)
    assert.equal(caught.code, 'PATH_LIST_REQUEST_MISMATCH')
    assert.equal(existsSync(join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)), false)
    const contractPath = join(runDir, 'task-contract.json')
    if (existsSync(contractPath)) {
      const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
        provenance?: { records?: Array<{ ref?: string }> }
      }
      assert.equal(
        contract.provenance?.records?.some(record => record.ref === TRUSTED_HOST_PATH_LIST_ADMISSION_REF),
        false,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  }
})

test('ChatEngine without declaration keeps prior authority shape', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-plain-'))
  const runId = `path-list-engine-plain-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
  })
  const contract = engine.getTaskContract()
  assert.ok(contract)
  assert.equal(
    contract.provenance.records.some(record => record.ref === TRUSTED_HOST_PATH_LIST_ADMISSION_REF),
    false,
  )
  assert.equal(existsSync(join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)), false)
})

test('ChatEngine constructor admits declaration when task and root bind', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-admit-'))
  const runId = `path-list-engine-admit-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  assert.ok(engine.getTaskContract()?.provenance.records.some(
    record => record.ref === TRUSTED_HOST_PATH_LIST_ADMISSION_REF,
  ))
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
})

test('rejects task drift against declaration user_request', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-drift-'))
  try {
    seedRepo(root)
    assert.throws(
      () =>
        resolveLiveSessionAuthority({
          mode: 'chat',
          projectRoot: root,
          task: USER_REQUEST + ' ',
          trustedHostFilesystemPathListDeclaration: declarationPayload(),
        }),
      (error: unknown) =>
        error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_REQUEST_MISMATCH',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captures preserved baseline before mutation and keeps it on reload', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-base-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  assert.ok(authority.filesystemPathListAdmission)
  assert.equal(
    authority.filesystemPathListAdmission.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
  persistLiveSessionAuthority(runDir, authority)
  writeFileSync(notesPath, '# mutated after admission\n', 'utf8')
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
})

test('refresh does not recapture preserved baseline after disk mutation', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  const beforeHash =
    authority.filesystemPathListAdmission!.preserved_baseline.preserved['docs/notes.md']?.content_sha256
  persistLiveSessionAuthority(runDir, authority)
  writeFileSync(notesPath, '# mutated before refresh\n', 'utf8')
  const parity = { liveAuthority: authority } as ParityRuntime
  refreshEngineInstructionManifest({
    parity,
    options: {
      projectRoot: root,
      task: USER_REQUEST,
      trustedHostFilesystemPathListDeclaration: declarationPayload(),
    },
    taskClass: 'unknown',
    executionProfile: 'chat',
    engineRunDir: runDir,
  })
  assert.equal(
    parity.liveAuthority?.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']
      ?.content_sha256,
    beforeHash,
  )
})

test('rejects conflicting declaration on refresh when admission already exists', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-conflict-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-conflict-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  persistLiveSessionAuthority(runDir, authority)
  const parity = { liveAuthority: authority } as ParityRuntime
  assert.throws(
    () =>
      refreshEngineInstructionManifest({
        parity,
        options: {
          projectRoot: root,
          task: USER_REQUEST,
          trustedHostFilesystemPathListDeclaration: declarationPayload({ userRequest: USER_REQUEST + 'x' }),
        },
        taskClass: 'unknown',
        executionProfile: 'chat',
        engineRunDir: runDir,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_DECLARATION_CONFLICT',
  )
})

test('strict load fails closed on tampered admission record', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-tamper-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-tamper-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  persistLiveSessionAuthority(runDir, authority)
  const admissionPath = join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)
  const raw = JSON.parse(readFileSync(admissionPath, 'utf8')) as Record<string, unknown>
  raw.admission_record_digest = '0'.repeat(64)
  writeFileSync(admissionPath, JSON.stringify(raw, null, 2), 'utf8')
  assert.throws(
    () => loadLiveSessionAuthorityStrict(runDir),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_ADMISSION_INVALID',
  )
})

test('strict load fails when admission file missing but contract binds one', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-missing-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-missing-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: declarationPayload(),
  })
  persistLiveSessionAuthority(runDir, authority)
  rmSync(join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME))
  assert.throws(
    () => loadLiveSessionAuthorityStrict(runDir),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_ADMISSION_MISSING',
  )
})

test('declaration does not change inferred acceptance criteria', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-accept-'))
  try {
    seedRepo(root)
    const without = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: USER_REQUEST,
    })
    const withDecl = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: USER_REQUEST,
      trustedHostFilesystemPathListDeclaration: declarationPayload(),
    })
    assert.deepEqual(withDecl.taskContract.acceptance, without.taskContract.acceptance)
    assert.deepEqual(withDecl.taskContract.verifier_requirements, without.taskContract.verifier_requirements)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
