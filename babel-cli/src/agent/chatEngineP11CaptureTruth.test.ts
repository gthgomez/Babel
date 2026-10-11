import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { ChatEngineP11Authority, type ChatEngineP11Host } from './chatEngineP11Authority.js'
import { createParityRuntime, parityOnUserTurn } from './chatEngineParityBridge.js'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { createWorkingState } from './codingLoop/workingState.js'
import { RevisionManager } from '../evidence/revisionBoundReceipt.js'
import { openAdmissionStore } from '../runtime/admission.js'
import { validateContextCheckpoint } from '../runtime/contextCheckpoints.js'

const route = { compiled_request_identity: 'fixture-request', tool_profile: 'native-tools', model_route: 'fixture:model' }

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
}

function fixture(t: TestContext, committed = true) {
  const root = mkdtempSync(join(tmpdir(), 'babel-p11-capture-truth-'))
  const projectRoot = join(root, 'project')
  const runDir = join(root, 'run')
  mkdirSync(projectRoot)
  mkdirSync(runDir)
  writeFileSync(join(projectRoot, 'source.ts'), 'export const value = 1\n')
  git(projectRoot, ['init', '-q'])
  git(projectRoot, ['add', 'source.ts'])
  if (committed) git(projectRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
  const opened = openAdmissionStore({ authorizedRoot: root, runDir })
  assert.equal(opened.ok, true)
  if (!opened.ok) throw new Error('fixture admission store unavailable')
  t.after(() => { opened.store.close(); rmSync(root, { recursive: true, force: true }) })
  const parity = createParityRuntime('capture-truth-fixture')
  parity.admissionStore = opened.store
  parity.liveAuthority = resolveLiveSessionAuthority({ mode: 'chat', projectRoot, task: 'Inspect the fixture source.' })
  parityOnUserTurn(parity, {
    task: 'Inspect the fixture source.', model: 'fixture-model', provider: 'fixture', projectRoot, policyPreset: 'workspace_write',
  })
  const host = {
    _cancelled: false, _turnIndex: 0, activeAdmissionClaim: null,
    activeSubmissionGeneration: 1, admissionEpoch: 'fixture-epoch', admissionLease: null,
    engineRunDir: runDir, engineRunId: 'capture-truth-fixture', executionProfile: 'safe_repo',
    lastVerifierReceipt: null, options: { projectRoot, task: 'Inspect the fixture source.' },
    p11InstallBlock: null, p11ObservationCaptureIssues: [], p11ObservationRefs: [], parity,
    taskAllowance: { taskOwnerId: 'fixture-task', grant: { turnCap: 10 }, consumed: { turns: 0 } },
    taskClass: 'Chat', toolCallLog: [], workingState: createWorkingState('Inspect the fixture source.'),
    isSubmissionCurrent: (generation: number) => generation === 1,
    shouldUseTextTools: () => false,
    buildP11Sources: (override: Parameters<ChatEngineP11Host['buildP11Sources']>[0]) => authority.buildP11Sources(override),
  } as unknown as ChatEngineP11Host
  const authority = new ChatEngineP11Authority(host)
  assert.ok(authority.admitCurrentSubmission(1, 'Inspect the fixture source.'))
  return { projectRoot, authority, host, parity }
}

function observe(authority: ChatEngineP11Authority): void {
  authority.captureP11Observation(
    { type: 'read_file', path: 'source.ts' },
    { index: 0, observation: 'Fixture source inspection completed.' },
    { index: 0, idempotencyKey: 'fixture-read', ownerGeneration: 1 },
  )
}

test('successful physical Git capture installs a valid current checkpoint and recovery binding', async t => {
  const { projectRoot, authority, host, parity } = fixture(t)
  const physical = RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository', git_binding: 'optional' })
  assert.ok(physical.gitCommitHash)
  const sources = authority.buildP11Sources(route)
  assert.ok(sources?.workspace)
  assert.equal(sources.workspace.capture_complete, true)
  assert.equal(sources.workspace.capture_provenance, 'current_capture')
  assert.equal(sources.workspace.current_snapshot_revision, physical.compositeTreeHash)
  assert.ok(authority.currentRecoveryBinding())
  observe(authority)
  assert.equal(host.p11ObservationRefs.length, 1)
  assert.equal(host.p11ObservationRefs[0]!.snapshot_ref, physical.compositeTreeHash)
  assert.equal(await authority.installP11ContextCheckpoint(route), true, host.p11InstallBlock?.code)
  assert.ok(parity.contextCheckpoint)
  const owner = authority.currentP11Owner()
  assert.ok(owner)
  assert.equal(validateContextCheckpoint(parity.contextCheckpoint, {
    expectedThreadId: parity.eventLog.thread_id, currentOwner: owner, requireInstalledLineage: true,
    authorizedObservationIds: [...parity.authorizedObservationIds!],
    lineageEvidence: { threadEvents: parity.eventLog.events, sessionEvents: parity.sessionEvents.events },
  }).status, 'valid')
})

for (const failure of ['oversized input', 'credential metadata', 'unreadable input'] as const) {
  test(`${failure}: unavailable physical capture cannot replace installed checkpoint or bind recovery`, async t => {
    const { projectRoot, authority, host, parity } = fixture(t)
    assert.equal(await authority.installP11ContextCheckpoint(route), true)
    const previous = parity.contextCheckpoint
    assert.ok(previous)
    const checkpointPath = join(host.engineRunDir, 'context-checkpoint.json')
    const persistedHash = createHash('sha256').update(readFileSync(checkpointPath)).digest('hex')
    if (failure === 'oversized input') {
      const target = join(projectRoot, 'large.bin')
      writeFileSync(target, '')
      truncateSync(target, 1_000_001)
    } else if (failure === 'credential metadata') {
      // Presence alone must reject capture; no credential content is created or read.
      writeFileSync(join(projectRoot, '.env'), '')
    } else {
      const denied = join(projectRoot, 'source.ts')
      const access = fs.accessSync
      const mocked = t.mock.method(fs, 'accessSync', (path: fs.PathLike, mode?: number) => {
        if (String(path) === denied) throw Object.assign(new Error('fixture denied input access'), { code: 'EACCES' })
        access(path, mode)
      })
      syncBuiltinESMExports()
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
    }
    assert.equal(RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository', git_binding: 'optional' }).gitCommitHash, null)
    assert.equal(authority.buildP11Sources(route) === null, true, 'failed capture must not be labelled complete/current')
    assert.equal(authority.currentRecoveryBinding() === null, true, 'failed capture must not grant a recovery binding')
    observe(authority)
    assert.equal(host.p11ObservationRefs.length, 1)
    assert.equal(host.p11ObservationRefs[0]!.snapshot_ref, undefined, 'unavailable capture cannot supply a snapshot ref')
    assert.equal(host.p11ObservationRefs[0]!.coverage_ref, undefined, 'unavailable capture cannot supply a coverage ref')
    assert.equal(authority.prepareP11ContextCheckpointCandidate(route) === null, true)
    assert.equal(await authority.installP11ContextCheckpoint(route), false)
    assert.equal(host.p11InstallBlock?.code, 'sources_unavailable')
    assert.equal(host.p11InstallBlock?.details.includes('workspace_revision'), true)
    assert.equal(parity.contextCheckpoint, previous, 'failed capture preserves installed authority')
    assert.equal(createHash('sha256').update(readFileSync(checkpointPath)).digest('hex'), persistedHash, 'failed capture preserves durable authority')
  })
}

test('unborn Git HEAD cannot become complete workspace authority', async t => {
  const { authority, host } = fixture(t, false)
  assert.equal(authority.buildP11Sources(route) === null, true)
  assert.equal(authority.currentRecoveryBinding() === null, true)
  assert.equal(await authority.installP11ContextCheckpoint(route), false)
  assert.equal(host.p11InstallBlock?.code, 'sources_unavailable')
})

test('non-Git workspace cannot become complete workspace authority', async t => {
  const { projectRoot, authority, host } = fixture(t)
  rmSync(join(projectRoot, '.git'), { recursive: true, force: true })
  assert.equal(authority.buildP11Sources(route) === null, true)
  assert.equal(authority.currentRecoveryBinding() === null, true)
  assert.equal(await authority.installP11ContextCheckpoint(route), false)
  assert.equal(host.p11InstallBlock?.code, 'sources_unavailable')
})
