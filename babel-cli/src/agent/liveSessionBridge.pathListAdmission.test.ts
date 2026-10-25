import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
  TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
  TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
} from '../authority/trustedHostFilesystemPathList.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'
import {
  TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_REF_PREFIX,
  formatHostDeclaredPathListClarificationDescription,
} from './pathListHostDeclaredClarification.js'
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

/** Scripted offline provider route; pairs with benchmark env (no network). */
const SCRIPTED_OBJECTIVE_ADMISSION_ROUTE = {
  model: 'fixture-model',
  provider: 'ollama',
}

function enableScriptedObjectiveAdmissionEnv(): () => void {
  const prior = {
    BABEL_BENCHMARK_MODE: process.env['BABEL_BENCHMARK_MODE'],
    BABEL_BENCHMARK_AUTO_APPROVE: process.env['BABEL_BENCHMARK_AUTO_APPROVE'],
    BABEL_EXECUTION_PROFILE: process.env['BABEL_EXECUTION_PROFILE'],
    BABEL_DIFF_CRITIC: process.env['BABEL_DIFF_CRITIC'],
  }
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_DIFF_CRITIC'] = '0'
  return () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

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
  acceptanceClarification?: Record<string, unknown>
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
    ...(overrides.acceptanceClarification
      ? { acceptance_clarification: overrides.acceptanceClarification }
      : {}),
  }
}

function hostClarificationBindingForTask(task: string = USER_REQUEST) {
  const meaning = inferTaskAcceptance(task)
  const unresolved = meaning.sources.filter(source => source.status === 'unresolved')
  assert.equal(unresolved.length, 1)
  const source = unresolved[0]!
  return {
    schema_version: 1,
    kind: TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_KIND,
    clarification_mode: HOST_DECLARED_ACCEPTANCE_CLARIFICATION_MODE,
    target_criterion_id: source.criterion_id,
    task_request_digest: sha256Canonical(task),
    meaning_input_digest: source.input_digest,
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

test('refresh retains admitted baseline after preserved input deleted on disk', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-del-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-del-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const decl = declarationPayload()
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  persistLiveSessionAuthority(runDir, authority)
  rmSync(notesPath)
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

test('refresh retains admitted baseline after preserved input changed on disk', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-drift-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-admit-refresh-drift-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const decl = declarationPayload()
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  persistLiveSessionAuthority(runDir, authority)
  writeFileSync(notesPath, '# mutated on disk after admission\n', 'utf8')
  assert.notEqual(fileSha256(notesPath), beforeHash)
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

test('same-mode ChatEngine resume retains baseline when preserved input deleted on disk', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-engine-resume-'))
  const runId = `path-list-engine-resume-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const decl = declarationPayload()
  new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  rmSync(notesPath)
  new ChatEngine({
    runId,
    resumeExisting: true,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
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

test('objective admission via admitUserSubmission does not recapture path-list baseline', t => {
  const restoreEnv = enableScriptedObjectiveAdmissionEnv()
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-submit-once-'))
  const runId = `path-list-admit-submit-once-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const beforeHash = fileSha256(join(root, 'docs', 'notes.md'))
  const admitted = engine.admitUserSubmission(
    { userInput: USER_REQUEST },
    SCRIPTED_OBJECTIVE_ADMISSION_ROUTE,
  )
  assert.equal(admitted.status, 'committed')
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
})

test('Continue objective admission retains baseline after preserved input deleted', t => {
  const restoreEnv = enableScriptedObjectiveAdmissionEnv()
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-continue-'))
  const runId = `path-list-admit-continue-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const notesPath = join(root, 'docs', 'notes.md')
  const beforeHash = fileSha256(notesPath)
  const decl = declarationPayload()
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const first = engine.admitUserSubmission(
    { userInput: USER_REQUEST },
    SCRIPTED_OBJECTIVE_ADMISSION_ROUTE,
  )
  assert.equal(first.status, 'committed')
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  rmSync(notesPath)
  const continued = engine.admitUserSubmission(
    {
      userInput: USER_REQUEST,
      continueTask: true,
    },
    SCRIPTED_OBJECTIVE_ADMISSION_ROUTE,
  )
  assert.equal(continued.status, 'committed')
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.filesystemPathListAdmission?.preserved_baseline.preserved['docs/notes.md']?.content_sha256,
    beforeHash,
  )
})

test('objective admission rejects a new task while path-list declaration remains on engine options', t => {
  const restoreEnv = enableScriptedObjectiveAdmissionEnv()
  const root = mkdtempSync(join(tmpdir(), 'path-list-admit-new-objective-'))
  const runId = `path-list-admit-new-objective-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const decl = declarationPayload()
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(
    engine.admitUserSubmission(
      { userInput: USER_REQUEST },
      SCRIPTED_OBJECTIVE_ADMISSION_ROUTE,
    ).status,
    'committed',
  )
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  assert.throws(
    () =>
      engine.admitUserSubmission(
        { userInput: 'Enumerate every package entrypoint under apps/' },
        SCRIPTED_OBJECTIVE_ADMISSION_ROUTE,
      ),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError &&
      error.code === 'PATH_LIST_REQUEST_MISMATCH',
  )
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(reloaded.filesystemPathListAdmission?.declaration.user_request, USER_REQUEST)
})

test('declaration without host clarification does not change inferred acceptance criteria', () => {
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

test('host-declared clarification binds at resolve and persists through admission', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-clarify-admit-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-clarify-admit-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const binding = hostClarificationBindingForTask()
  const decl = declarationPayload({ acceptanceClarification: binding })
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  persistLiveSessionAuthority(runDir, authority)
  const row = authority.taskContract.acceptance.find(c => c.id === binding.target_criterion_id)
  assert.ok(row)
  assert.equal(row!.description, formatHostDeclaredPathListClarificationDescription(authority.filesystemPathListAdmission!.declaration))
  assert.ok(
    authority.taskContract.provenance.records.some(record =>
      record.ref.startsWith(TRUSTED_HOST_ACCEPTANCE_CLARIFICATION_REF_PREFIX),
    ),
  )
  assert.ok(
    authority.instructionManifest.fragments.some(
      fragment => fragment.rule_id === 'host:acceptance-clarification',
    ),
  )
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.taskContract.acceptance.find(c => c.id === binding.target_criterion_id)?.description,
    row!.description,
  )
})

test('host clarification survives objective admission without recapture', t => {
  const restoreEnv = enableScriptedObjectiveAdmissionEnv()
  const root = mkdtempSync(join(tmpdir(), 'path-list-clarify-obj-admit-'))
  const runId = `path-list-clarify-obj-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  resetPathListBaselineCaptureCountForTests()
  seedRepo(root)
  const binding = hostClarificationBindingForTask()
  const engine = new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: declarationPayload({
      acceptanceClarification: binding,
    }),
  })
  const described = engine.getTaskContract()!.acceptance.find(c => c.id === binding.target_criterion_id)!.description
  engine.admitUserSubmission({ userInput: USER_REQUEST }, SCRIPTED_OBJECTIVE_ADMISSION_ROUTE)
  const reloaded = loadLiveSessionAuthorityStrict(runDir)
  assert.equal(
    reloaded.taskContract.acceptance.find(c => c.id === binding.target_criterion_id)?.description,
    described,
  )
  assert.equal(pathListBaselineCaptureCountForTests(), 1)
})

test('refresh rejects host clarification drift on declaration hash', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-clarify-refresh-'))
  const runDir = mkdtempSync(join(tmpdir(), 'path-list-clarify-refresh-run-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const binding = hostClarificationBindingForTask()
  const decl = declarationPayload({ acceptanceClarification: binding })
  const authority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot: root,
    task: USER_REQUEST,
    trustedHostFilesystemPathListDeclaration: decl,
  })
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
  const drifted = {
    ...decl,
    acceptance_clarification: {
      ...binding,
      target_criterion_id: 'acceptance:deadbeefdeadbeefdeadbeefdeadbeef',
    },
  }
  assert.throws(
    () =>
      refreshEngineInstructionManifest({
        parity,
        options: {
          projectRoot: root,
          task: USER_REQUEST,
          trustedHostFilesystemPathListDeclaration: drifted,
        },
        taskClass: 'unknown',
        executionProfile: 'chat',
        engineRunDir: runDir,
      }),
    (error: unknown) =>
      error instanceof LiveSessionAuthorityError && error.code === 'PATH_LIST_DECLARATION_CONFLICT',
  )
})

test('resume retains host-declared clarification binding', t => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-clarify-resume-'))
  const runId = `path-list-clarify-resume-${randomUUID()}`
  const runDir = chatSessionDir(runId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })
  seedRepo(root)
  const binding = hostClarificationBindingForTask()
  const decl = declarationPayload({ acceptanceClarification: binding })
  new ChatEngine({
    runId,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  const described = loadLiveSessionAuthorityStrict(runDir).taskContract.acceptance.find(
    c => c.id === binding.target_criterion_id,
  )!.description
  new ChatEngine({
    runId,
    resumeExisting: true,
    task: USER_REQUEST,
    projectRoot: root,
    trustedHostFilesystemPathListDeclaration: decl,
  })
  assert.equal(
    loadLiveSessionAuthorityStrict(runDir).taskContract.acceptance.find(
      c => c.id === binding.target_criterion_id,
    )?.description,
    described,
  )
})

test('invalid host clarification rejects before path-list capture', () => {
  const root = mkdtempSync(join(tmpdir(), 'path-list-clarify-invalid-'))
  try {
    seedRepo(root)
    resetPathListBaselineCaptureCountForTests()
    const binding = hostClarificationBindingForTask()
    binding.meaning_input_digest = '0'.repeat(64)
    assert.throws(
      () =>
        resolveLiveSessionAuthority({
          mode: 'chat',
          projectRoot: root,
          task: USER_REQUEST,
          trustedHostFilesystemPathListDeclaration: declarationPayload({
            acceptanceClarification: binding,
          }),
        }),
      (error: unknown) =>
        error instanceof LiveSessionAuthorityError &&
        error.code === 'PATH_LIST_CLARIFICATION_MEANING_DIGEST_MISMATCH',
    )
    assert.equal(pathListBaselineCaptureCountForTests(), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
