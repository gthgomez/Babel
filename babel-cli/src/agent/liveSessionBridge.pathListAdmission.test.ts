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
import {
  TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX,
  assertPathListSessionBinding,
  pathListBaselineCaptureCountForTests,
  resetPathListBaselineCaptureCountForTests,
} from './liveSessionFilesystemPathListAdmission.js'
import {
  LiveSessionAuthorityError,
  TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME,
  TASK_CONTRACT_FILENAME,
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
} from './liveSessionBridge.js'
import { refreshEngineInstructionManifest } from './chatEngineLiveSession.js'
import type { ParityRuntime } from './chatEngineParityBridge.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

function contractBindsPathListAdmission(
  contract: { provenance: { records: Array<{ ref: string }> } },
): boolean {
  return contract.provenance.records.some(record =>
    record.ref.startsWith(TRUSTED_HOST_PATH_LIST_ADMISSION_REF_PREFIX),
  )
}

function declarationPayload(overrides: {
  userRequest?: string
  targetDocument?: string
  preservedSelectors?: string[]
} = {}) {
  const user_request = overrides.userRequest ?? USER_REQUEST
  return {
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request,
    user_request_digest: sha256Canonical(user_request),
    target_document: overrides.targetDocument ?? 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths',
    inventory_scope: { roots: ['apps'] },
    coverage: { mode: 'complete_scoped_inventory' },
    preserved_input_selectors: overrides.preservedSelectors ?? ['docs/notes.md'],
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

function assertNoPathListAuthorityBypass(runDir: string): void {
  assert.equal(existsSync(join(runDir, TRUSTED_HOST_PATH_LIST_ADMISSION_FILENAME)), false)
  const contractPath = join(runDir, TASK_CONTRACT_FILENAME)
  if (existsSync(contractPath)) {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
      provenance?: { records?: Array<{ ref: string }> }
    }
    assert.equal(contractBindsPathListAdmission(contract as { provenance: { records: Array<{ ref: string }> } }), false)
  }
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

test('ChatEngine constructor rejects declaration when conversation scope normalizes project root away', () => {
  const runId = `path-list-conversation-scope-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  let caught: unknown
  try {
    new ChatEngine({
      runId,
      task: USER_REQUEST,
      projectRoot: null,
      executionScope: { kind: 'conversation' },
      trustedHostFilesystemPathListDeclaration: declarationPayload(),
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof LiveSessionAuthorityError)
  assert.equal(caught.code, 'PATH_LIST_DECLARATION_REQUIRES_PROJECT_ROOT')
  assert.equal(existsSync(runDir), false)
  assertNoPathListAuthorityBypass(runDir)
})

test('ChatEngine constructor rejects conflicting conversation scope before path-list authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-conv-conflict-'))
  const runId = `path-list-conv-conflict-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  try {
    seedRepo(root)
    let caught: unknown
    try {
      new ChatEngine({
        runId,
        task: USER_REQUEST,
        projectRoot: root,
        executionScope: { kind: 'conversation' },
        trustedHostFilesystemPathListDeclaration: declarationPayload(),
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof LiveSessionAuthorityError)
    assert.equal(caught.code, 'PATH_LIST_DECLARATION_REQUIRES_PROJECT_ROOT')
    assert.equal(existsSync(runDir), false)
    assertNoPathListAuthorityBypass(runDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ChatEngine constructor rejects invalid declaration before durable path-list authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-invalid-decl-'))
  const runId = `path-list-invalid-decl-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  let caught: unknown
  try {
    new ChatEngine({
      runId,
      task: USER_REQUEST,
      projectRoot: root,
      trustedHostFilesystemPathListDeclaration: { not_a_declaration: true },
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof LiveSessionAuthorityError)
  assert.equal(caught.code, 'PATH_LIST_DECLARATION_INVALID')
  assert.equal(existsSync(runDir), false)
  assertNoPathListAuthorityBypass(runDir)
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
        contractBindsPathListAdmission(contract as { provenance: { records: Array<{ ref: string }> } }),
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
    contractBindsPathListAdmission(contract),
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
  assert.ok(contractBindsPathListAdmission(engine.getTaskContract()!))
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

test('refresh does not perform a second baseline capture when admission exists', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const beforeHash =
    authority.filesystemPathListAdmission!.preserved_baseline.preserved['docs/notes.md']?.content_sha256
  persistLiveSessionAuthority(runDir, authority)
  const parity = { liveAuthority: authority } as ParityRuntime
  refreshEngineInstructionManifest({
    parity,
    options: {
      projectRoot: root,
      task: USER_REQUEST,
      trustedHostFilesystemPathListDeclaration: decl,
    },
    taskClass: 'unknown',
    executionProfile: 'chat',
    engineRunDir: runDir,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  assert.equal(
    parity.liveAuthority?.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']
      ?.content_sha256,
    beforeHash,
  )
})

test('refresh rejects deleted preserved input instead of retaining stale baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-del-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-del-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const decl = declarationPayload()
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  persistLiveSessionAuthority(runDir, authority)
  rmSync(notesPath)
  const parity = { liveAuthority: authority } as ParityRuntime
  assert.throws(
    () =>
      refreshEngineInstructionManifest({
        parity,
        options: {
          projectRoot: root,
          task: USER_REQUEST,
          trustedHostFilesystemPathListDeclaration: decl,
        },
        taskClass: 'unknown',
        executionProfile: 'chat',
        engineRunDir: runDir,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_PRESERVED_INPUT_MISSING',
  )
})

test('refresh rejects preserved input drift without recapturing baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-drift-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-drift-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  persistLiveSessionAuthority(runDir, authority)
  writeFileSync(join(root, 'docs', 'notes.md'), '# mutated\n', 'utf8')
  const parity = { liveAuthority: authority } as ParityRuntime
  assert.throws(
    () =>
      refreshEngineInstructionManifest({
        parity,
        options: {
          projectRoot: root,
          task: USER_REQUEST,
          trustedHostFilesystemPathListDeclaration: decl,
        },
        taskClass: 'unknown',
        executionProfile: 'chat',
        engineRunDir: runDir,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_PRESERVED_INPUT_DRIFT',
  )
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
})

test('rejects conflicting declaration identity on refresh when selectors differ', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-conflict-sel-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-conflict-sel-run-'))
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
          trustedHostFilesystemPathListDeclaration: declarationPayload({
            targetDocument: 'docs/notes.md',
          }),
        },
        taskClass: 'unknown',
        executionProfile: 'chat',
        engineRunDir: runDir,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_DECLARATION_CONFLICT',
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

test('admission record deep-freezes nested declaration limits and preserved entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-freeze-'))
  try {
    seedRepo(root)
    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: USER_REQUEST,
      trustedHostFilesystemPathListDeclaration: declarationPayload(),
    })
    const admission = authority.filesystemPathListAdmission!
    assert.throws(() => {
      (admission.declaration.limits as { max_entries: number }).max_entries = 999
    }, /Cannot assign to read only property/)
    assert.throws(() => {
      admission.preserved_baseline.preserved['docs/notes.md']!.content_sha256 = '0'.repeat(64)
    }, /Cannot assign to read only property/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-mode ChatEngine resume validates declaration without recapturing baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-resume-'))
  const runId = `path-list-engine-resume-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  rmSync(join(root, 'docs', 'notes.md'))
  assert.throws(
    () =>
  new ChatEngine({
    runId,
    resumeExisting: true,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_PRESERVED_INPUT_MISSING',
  )
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
})

test('rejects cross-root binding with same user prompt and valid sidecar', t => {
  const rootA = mkdtempSync(join(tmpdir(), 'path-list-root-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'path-list-root-b-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-cross-run-'))
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(rootA)
  seedRepo(rootB)
  const decl = declarationPayload()
  const authorityA = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: rootA,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  persistLiveSessionAuthority(runDir, authorityA)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.ok(reloaded.filesystemPathListAdmission)
  assert.throws(
    () =>
      assertPathListSessionBinding({
        projectRoot: rootB,
        task: USER_REQUEST,
        contract: reloaded.taskContract,
        admission: reloaded.filesystemPathListAdmission!,
        incomingDeclaration: decl,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_SESSION_ROOT_MISMATCH',
  )
})

test('same-mode ChatEngine resume on matching root does not recapture baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-resume-ok-'))
  const runId = `path-list-engine-resume-ok-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  new ChatEngine({
    runId,
    resumeExisting: true,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
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
