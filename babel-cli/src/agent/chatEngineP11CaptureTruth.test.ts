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

function fixture(t: TestContext, committed = true, runInside = false) {
  const root = mkdtempSync(join(tmpdir(), 'babel-p11-capture-truth-'))
  const projectRoot = join(root, 'project')
  const runDir = join(runInside ? projectRoot : root, 'run')
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
  const toolCallLog: Array<ChatEngineP11Host['toolCallLog'][number]> = []
  const host = {
    _cancelled: false, _turnIndex: 0, activeAdmissionClaim: null,
    activeSubmissionGeneration: 1, admissionEpoch: 'fixture-epoch', admissionLease: null,
    engineRunDir: runDir, engineRunId: 'capture-truth-fixture', executionProfile: 'safe_repo',
    lastVerifierReceipt: null, options: { projectRoot, task: 'Inspect the fixture source.' },
    p11InstallBlock: null, p11ObservationCaptureIssues: [], p11ObservationRefs: [], parity,
    taskAllowance: { taskOwnerId: 'fixture-task', grant: { turnCap: 10 }, consumed: { turns: 0 } },
    taskClass: 'Chat', toolCallLog, workingState: createWorkingState('Inspect the fixture source.'),
    isSubmissionCurrent: (generation: number) => generation === 1,
    shouldUseTextTools: () => false,
    buildP11Sources: (override: Parameters<ChatEngineP11Host['buildP11Sources']>[0]) => authority.buildP11Sources(override),
  } as unknown as ChatEngineP11Host
  const authority = new ChatEngineP11Authority(host)
  assert.ok(authority.admitCurrentSubmission(1, 'Inspect the fixture source.'))
  return { projectRoot, authority, host, parity, toolCallLog }
}

function observe(authority: ChatEngineP11Authority): void {
  authority.captureP11Observation(
    { type: 'read_file', path: 'source.ts' },
    { index: 0, observation: 'Fixture source inspection completed.' },
    { index: 0, idempotencyKey: 'fixture-read', ownerGeneration: 1 },
  )
}

test('successful admitted source reads may quote credential-denial diagnostics', async t => {
  const { authority, host, parity, toolCallLog } = fixture(t)
  toolCallLog.push({ tool: 'read_file', index: 0, exit_code: 0 })
  authority.captureP11Observation(
    { type: 'read_file', path: 'source.ts' },
    { index: 0, observation: '// credential store: [AUTONOMY_DENIED:CLASS_D]', admittedProjectRead: true },
    { index: 0, idempotencyKey: 'source-diagnostic', ownerGeneration: 1 },
  )
  assert.equal(host.p11ObservationRefs.length, 1)
  assert.deepEqual(host.p11ObservationCaptureIssues, [])
  assert.equal(await authority.installP11ContextCheckpoint(route), true)
  assert.ok(parity.contextCheckpoint)
})

test('a prior successful read cannot approve a later credential denial', t => {
  const { authority, host, toolCallLog } = fixture(t)
  toolCallLog.push({ tool: 'read_file', index: 0, exit_code: 0 })
  authority.captureP11Observation(
    { type: 'read_file', path: '.env' },
    { index: 0, observation: '[AUTONOMY_DENIED:CLASS_D] credential store' },
    { index: 0, idempotencyKey: 'denied-read', ownerGeneration: 1 },
  )
  assert.equal(host.p11ObservationRefs.length, 0)
  assert.equal(host.p11ObservationCaptureIssues.length, 1)
})

test('read provenance cannot cross tool, invocation index, failure, or owner boundaries', t => {
  const { authority, host, toolCallLog } = fixture(t)
  toolCallLog.push({ tool: 'read_file', index: 0, exit_code: 1 })
  const observation = '[AUTONOMY_DENIED:CLASS_D] credential store'
  authority.captureP11Observation({ type: 'read_file', path: 'source.ts' },
    { index: 0, observation, admittedProjectRead: true },
    { index: 0, idempotencyKey: 'failed-read', ownerGeneration: 1 })
  authority.captureP11Observation({ type: 'read_file', path: 'source.ts' },
    { index: 1, observation, admittedProjectRead: true },
    { index: 2, idempotencyKey: 'wrong-index', ownerGeneration: 1 })
  authority.captureP11Observation({ type: 'run_command', command: 'fixture' },
    { index: 3, observation, admittedProjectRead: true },
    { index: 3, idempotencyKey: 'wrong-tool', ownerGeneration: 1 })
  assert.equal(host.p11ObservationCaptureIssues.length, 3)
  authority.captureP11Observation({ type: 'read_file', path: 'source.ts' },
    { index: 0, observation, admittedProjectRead: true },
    { index: 0, idempotencyKey: 'stale-owner', ownerGeneration: 0 })
  assert.equal(host.p11ObservationCaptureIssues.length, 3)
  assert.equal(host.p11ObservationRefs.length, 0)
})

test('physical recovery proof stays separate from a conversation checkpoint', async t => {
  const { projectRoot, authority, host, parity } = fixture(t)
  const physical = RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository', git_binding: 'optional' })
  assert.ok(physical.gitCommitHash)
  const sources = authority.buildP11Sources(route)
  assert.ok(sources)
  assert.equal(sources.workspace, null, 'conversation preparation does not claim repository coverage')
  assert.ok(authority.currentRecoveryBinding())
  observe(authority)
  assert.equal(host.p11ObservationRefs.length, 1)
  assert.equal(host.p11ObservationRefs[0]!.snapshot_ref, undefined)
  assert.equal(host.p11ObservationRefs[0]!.coverage_ref, undefined)
  assert.equal(await authority.installP11ContextCheckpoint(route), true, host.p11InstallBlock?.code)
  assert.ok(parity.contextCheckpoint)
  assert.equal(parity.contextCheckpoint.schema_version, 2)
  assert.equal(parity.contextCheckpoint.population.workspace_revision_current, false)
  const owner = authority.currentP11Owner()
  assert.ok(owner)
  assert.equal(validateContextCheckpoint(parity.contextCheckpoint, {
    expectedThreadId: parity.eventLog.thread_id, currentOwner: owner, requireInstalledLineage: true,
    authorizedObservationIds: [...parity.authorizedObservationIds!],
    lineageEvidence: { threadEvents: parity.eventLog.events, sessionEvents: parity.sessionEvents.events },
  }).status, 'valid')
})

for (const failure of ['oversized input', 'credential metadata', 'unreadable input'] as const) {
  test(`${failure}: conversation continues while physical recovery proof stays unavailable`, async t => {
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
      const denied = fs.realpathSync.native(join(projectRoot, 'source.ts'))
      const access = fs.accessSync
      const mocked = t.mock.method(fs, 'accessSync', (path: fs.PathLike, mode?: number) => {
        if (fs.realpathSync.native(String(path)) === denied) {
          throw Object.assign(new Error('fixture denied input access'), { code: 'EACCES' })
        }
        access(path, mode)
      })
      syncBuiltinESMExports()
      t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
    }
    assert.equal(RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository', git_binding: 'optional' }).gitCommitHash, null)
    const sources = authority.buildP11Sources(route)
    assert.ok(sources)
    assert.equal(sources.workspace, null, 'failed capture must not be labelled complete/current')
    assert.equal(authority.currentRecoveryBinding() === null, true, 'failed capture must not grant a recovery binding')
    observe(authority)
    assert.equal(host.p11ObservationRefs.length, 1)
    assert.equal(host.p11ObservationRefs[0]!.snapshot_ref, undefined, 'unavailable capture cannot supply a snapshot ref')
    assert.equal(host.p11ObservationRefs[0]!.coverage_ref, undefined, 'unavailable capture cannot supply a coverage ref')
    assert.equal(authority.prepareP11ContextCheckpointCandidate(route)?.status, 'prepared')
    assert.equal(await authority.installP11ContextCheckpoint(route), true)
    assert.equal(host.p11InstallBlock, null)
    assert.notEqual(parity.contextCheckpoint, previous)
    assert.equal(parity.contextCheckpoint?.schema_version, 2)
    assert.equal(parity.contextCheckpoint?.workspace, null)
    assert.equal(parity.contextCheckpoint?.population.workspace_revision_current, false)
    assert.deepEqual(parity.contextCheckpoint?.budget, previous.budget, 'conversation continuation cannot renew the allowance')
    assert.notEqual(createHash('sha256').update(readFileSync(checkpointPath)).digest('hex'), persistedHash, 'the updated observation manifest is durable')
  })
}

test('unborn Git HEAD supports conversation without complete workspace authority', async t => {
  const { authority, host, parity } = fixture(t, false)
  assert.equal(authority.buildP11Sources(route)?.workspace, null)
  assert.equal(authority.currentRecoveryBinding() === null, true)
  assert.equal(await authority.installP11ContextCheckpoint(route), true)
  assert.equal(host.p11InstallBlock, null)
  assert.equal(parity.contextCheckpoint?.population.workspace_revision_current, false)
})

test('non-Git workspace supports conversation without complete workspace authority', async t => {
  const { projectRoot, authority, host, parity } = fixture(t)
  rmSync(join(projectRoot, '.git'), { recursive: true, force: true })
  assert.equal(authority.buildP11Sources(route)?.workspace, null)
  assert.equal(authority.currentRecoveryBinding() === null, true)
  assert.equal(await authority.installP11ContextCheckpoint(route), true)
  assert.equal(host.p11InstallBlock, null)
  assert.equal(parity.contextCheckpoint?.population.workspace_revision_current, false)
})

// Conversation ownership is independent of repository-evidence capture.
test('conversation guard permits umbrella and nested contexts without certifying physical revisions', t => {
  const { projectRoot, authority, host } = fixture(t)
  const nested = join(projectRoot, 'products', 'current-app')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'ui.ts'), 'export const ui = 1\n')
  git(nested, ['init', '-q'])
  git(nested, ['add', 'ui.ts'])
  git(nested, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'nested'])
  const large = join(projectRoot, 'unrelated.apk')
  writeFileSync(large, '')
  truncateSync(large, 1_000_001)
  assert.equal(authority.prepareCompactionGuard()(), true)
  host.options.projectRoot = nested
  const validate = authority.prepareCompactionGuard()
  assert.equal(validate(), true)
  writeFileSync(join(nested, 'ui.ts'), 'export const ui = 2\n')
  assert.equal(validate(), true, 'physical changes do not rewrite the conversation or create verification proof')
  assert.equal(authority.buildP11Sources(route)?.workspace, null)
})

test('conversation compaction guard rejects a superseded owner', t => {
  const { authority, host } = fixture(t)
  const validate = authority.prepareCompactionGuard()
  assert.equal(validate(), true)
  host.activeAdmissionClaim!.settled = true
  assert.equal(validate(), false)
})

test('runtime evidence changes physical capture without blocking conversation ownership', async t => {
  const { authority, host, projectRoot, parity } = fixture(t, true, true)
  const before = RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository' })
  writeFileSync(join(host.engineRunDir, 'usage.json'), '{"reportedCost":0.001}')
  const after = RevisionManager.computeRevisionSync(projectRoot, [], { scope_kind: 'repository' })
  assert.notEqual(before.compositeTreeHash, after.compositeTreeHash, 'runtime evidence changes the selected physical revision')
  assert.equal(authority.prepareCompactionGuard()(), true)
  assert.equal(await authority.installP11ContextCheckpoint(route), true)
  assert.equal(parity.contextCheckpoint?.workspace, null)
  assert.equal(parity.contextCheckpoint?.population.workspace_revision_current, false)
})
