import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep, win32 } from 'node:path'
import test, { type TestContext } from 'node:test'
import { canonicalizeContained } from '../bridge/workspaceBound.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { evaluateChatVerifierReceiptCurrencySync } from '../evidence/chatRevisionBinding.js'
import { selectCompletionProof } from './completionGatePolicy.js'
import { createSessionEventLog, flushSessionEventLogStrict, parseSessionEventLog, recordToolProposed, recordToolStarted, recordToolTerminal } from './sessionEvents.js'
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'
import {
  captureChatVerifierReceipt, captureCompletionWorkspaceRevisionHash, captureAndRecordVerifierReceipt,
  prepareKernelVerifierInput, shouldReuseCachedVerifierReceipt,
  resolveVerifierCacheIdentity, verifierEnvironmentKey,
} from './chatEngineVerifierAdapter.js'
import { chatVerifierOwner, chatVerifierRequirements } from './chatVerifierContext.js'

const command = 'node --test --test-reporter=tap test/native.test.mjs'

function directoryAlias(target: string, alias: string): void {
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
}

function fixture(t: TestContext) {
  const inheritedTestContext = process.env['NODE_TEST_CONTEXT']
  delete process.env['NODE_TEST_CONTEXT']
  t.after(() => {
    if (inheritedTestContext === undefined) delete process.env['NODE_TEST_CONTEXT']
    else process.env['NODE_TEST_CONTEXT'] = inheritedTestContext
  })
  const base = fs.mkdtempSync(join(tmpdir(), 'babel-verifier-alias-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'physical')
  const alias = join(base, 'linked')
  fs.mkdirSync(join(root, 'test'), { recursive: true })
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  fs.writeFileSync(join(root, 'source.mjs'), 'export const value = 4\n')
  fs.writeFileSync(join(root, 'test/native.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../source.mjs'; test('actual native alias control', () => { assert.equal(value, 4); assert.equal(process.env.BABEL_PROJECT_ROOT, ${JSON.stringify(resolve(alias))}); });\n`)
  directoryAlias(root, alias)
  const env: NodeJS.ProcessEnv = { ...process.env, BABEL_PROJECT_ROOT: resolve(alias) }
  delete env['NODE_TEST_CONTEXT']
  const session = createSessionEventLog('alias-session')
  const dispatch = { turn_id: 'alias-turn', tool_call_id: 'alias-native-test', tool_name: 'test_run' }
  recordToolProposed(session, dispatch)
  recordToolStarted(session, dispatch)
  const actual = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/native.test.mjs'], {
    cwd: alias, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  })
  recordToolTerminal(session, { ...dispatch, exit_code: actual.status ?? 1, content: actual.stdout })
  assert.equal(actual.error, undefined)
  assert.equal(actual.signal, null)
  assert.equal(actual.status, 0, actual.stderr)
  assert.match(actual.stdout, /# tests 1\b/)
  assert.match(actual.stdout, /# fail 0\b/)
  const owner = chatVerifierOwner({ projectRoot: alias, sessionId: 'alias-session', taskId: 'alias-task', contractHash: 'alias-contract' })!
  const context = { workspaceRoot: owner.workspaceRoot, taskId: owner.taskId, contractHash: owner.contractHash,
    workingDirectory: canonicalizeContained(root),
    environmentFingerprint: verifierEnvironmentKey({ ...process.env, BABEL_PROJECT_ROOT: resolve(alias) }),
    targetSelectors: analyzeVerifierIdentity(command)!.targetSelectors }
  const capture = (projectRoot: string, mutationPaths: string[]) => captureChatVerifierReceipt({
    projectRoot, command, exitCode: actual.status!, summary: 'Actual native test passed', stdout: actual.stdout,
    stderr: actual.stderr, mutationPaths, executionContext: context,
  })
  return { base, root, alias, owner, capture, actual, session, environmentFingerprint: verifierEnvironmentKey(env) }
}

for (const direction of ['alias-root', 'physical-root'] as const) {
  test(`native receipt and live currency bind physical identity through ${direction}`, async t => {
    const f = fixture(t)
    const root = direction === 'alias-root' ? f.alias : f.root
    const mutation = join(direction === 'alias-root' ? f.root : f.alias, 'source.mjs')
    const receipt = await f.capture(root, [mutation])
    assert.ok(receipt, 'a settled native pass in the same physical project must bind')
    assert.equal(receipt.tests_total, 1)
    assert.equal(receipt.tests_failed, 0)
    assert.equal(receipt.executionContext?.workspaceRoot, f.owner.workspaceRoot)
    assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, [mutation], receipt), receipt.boundRevision!.compositeTreeHash)
  })
}

test('cache identity freezes physical cwd without erasing the actual raw-root environment', t => {
  const f = fixture(t)
  const aliasIdentity = resolveVerifierCacheIdentity({ projectRoot: f.alias, command })
  const physicalIdentity = resolveVerifierCacheIdentity({ projectRoot: f.root, command })
  assert.equal(aliasIdentity.cwd, physicalIdentity.cwd)
  assert.equal(aliasIdentity.cwd, canonicalizeContained(f.root))
  assert.notEqual(aliasIdentity.envKey, physicalIdentity.envKey)
  assert.notEqual(aliasIdentity.key, physicalIdentity.key, 'raw root aliases remain distinct actual execution environments')
})

test('live currency accepts alias and physical absolute paths for a receipt captured with relative mutations', async t => {
  const f = fixture(t)
  const receipt = await f.capture(f.alias, ['source.mjs'])
  assert.ok(receipt)
  for (const root of [f.root, f.alias]) {
    for (const path of [join(f.root, 'source.mjs'), join(f.alias, 'source.mjs')]) {
      assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: root }, [path], receipt), receipt.boundRevision!.compositeTreeHash)
    }
  }
})

test('requirements preserve the actual governed root environment while canonicalizing cwd and owner', t => {
  const f = fixture(t)
  const identity = resolveVerifierCacheIdentity({ projectRoot: f.alias, command })
  const expectedEnv = f.environmentFingerprint
  assert.equal(identity.envKey, expectedEnv)
  assert.notEqual(expectedEnv, verifierEnvironmentKey({ ...process.env, BABEL_PROJECT_ROOT: resolve(f.root) }))
  const originalOwner = structuredClone(f.owner)
  const [required] = chatVerifierRequirements(f.owner, [command], 'Run the targeted native test', f.alias)
  assert.ok(required)
  assert.equal(required.executionContext.environmentFingerprint, expectedEnv)
  assert.equal(required.executionContext.workingDirectory, canonicalizeContained(f.root))
  assert.equal(required.executionContext.workspaceRoot, f.owner.workspaceRoot)
  assert.deepEqual(f.owner, originalOwner)
  assert.deepEqual(chatVerifierRequirements(f.owner, [command], 'Run tests', f.base), [])
})

test('recorded native execution through an alias covers independently frozen host requirements', async t => {
  const f = fixture(t)
  const required = chatVerifierRequirements(f.owner, [command], 'Run the targeted native test', f.alias)
  assert.equal(required.length, 1)
  const expectedEnv = f.environmentFingerprint
  const session = f.session
  const ledger: BoundChatVerifierReceipt[] = []
  const receipt = await captureAndRecordVerifierReceipt({
    projectRoot: f.alias, command, exitCode: f.actual.status!, summary: 'Actual native test passed',
    stdout: f.actual.stdout, stderr: f.actual.stderr, mutationPaths: [join(f.root, 'source.mjs')],
    sessionEvents: session, turnId: 'alias-turn', toolCallId: 'alias-native-test',
    ledger, cache: new Map(), writeCount: 1, verifierOwner: f.owner,
  })
  assert.ok(receipt)
  assert.equal(receipt.working_directory, '.')
  assert.equal(receipt.executionContext?.workingDirectory, canonicalizeContained(f.root))
  assert.equal(receipt.executionContext?.workspaceRoot, f.owner.workspaceRoot)
  assert.equal(receipt.executionContext?.environmentFingerprint, expectedEnv)
  const recorded = session.events.find(event => event.kind === 'verifier_attempt')!
  assert.ok(recorded)
  assert.deepEqual(receipt.order, { sessionId: session.session_id, seq: recorded.seq })
  const flushed = flushSessionEventLogStrict(join(f.base, 'run-events'), session)
  assert.equal(flushed.wrote, 4)
  const persisted = parseSessionEventLog(fs.readFileSync(flushed.path, 'utf8'))
  const persistedAttempt = persisted.events.find(event => event.kind === 'verifier_attempt')
  assert.ok(persistedAttempt)
  assert.equal(persistedAttempt.seq, receipt.order!.seq)
  const live = captureCompletionWorkspaceRevisionHash({ projectRoot: f.alias }, [join(f.root, 'source.mjs')], receipt)
  assert.ok(live)
  const prepared = prepareKernelVerifierInput(receipt, ledger)
  assert.deepEqual(prepared.verifierEvidenceErrors, [])
  const selected = selectCompletionProof({
    requiredVerifiers: required, owner: f.owner, currentRevisionHash: live,
    receipts: prepared.executedVerifierLedger ?? [],
  })
  assert.deepEqual(selected.evidenceErrors, [])
  assert.deepEqual(selected.missingRequirements, [])
  assert.equal(selected.selectedCoveringReceipts.length, 1)
  assert.equal(selected.selectedCoveringReceipts[0]?.receiptId, receipt.receiptId)
})

test('a switched root alias cannot recertify another physical project or retain a cached cwd', async t => {
  const f = fixture(t)
  const receipt = await f.capture(f.alias, ['source.mjs'])
  assert.ok(receipt)
  const before = resolveVerifierCacheIdentity({ projectRoot: f.alias, command })
  const other = join(f.base, 'other')
  fs.cpSync(f.root, other, { recursive: true })
  fs.unlinkSync(f.alias)
  directoryAlias(other, f.alias)
  const after = resolveVerifierCacheIdentity({ projectRoot: f.alias, command })
  assert.notEqual(after.cwd, before.cwd)
  assert.notEqual(after.key, before.key)
  assert.equal(after.envKey, before.envKey, 'same raw root spelling does not hide changed physical cwd')
  assert.deepEqual(chatVerifierRequirements(f.owner, [command], 'Run tests', f.alias), [])
  const forbiddenReads: string[] = []
  const nativeFs = (fs as unknown as { default: typeof fs }).default
  const isOther = (value: unknown): boolean => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false
    try {
      const candidate = canonicalizeContained(value instanceof URL ? value.pathname : String(value))
      const rel = relative(canonicalizeContained(other), candidate)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:|^\//.test(rel))
    } catch { return false }
  }
  for (const method of ['openSync', 'readFileSync'] as const) {
    const original = nativeFs[method]
    t.mock.method(nativeFs, method, ((value: unknown, ...args: unknown[]) => {
      if (isOther(value)) { forbiddenReads.push(String(value)); throw new Error('Unexpected external project content read') }
      return (original as (...values: unknown[]) => unknown)(value, ...args)
    }) as typeof original)
  }
  syncBuiltinESMExports()
  try {
    assert.equal(await f.capture(f.alias, ['source.mjs']), null)
    assert.equal(captureCompletionWorkspaceRevisionHash({ projectRoot: f.alias }, ['source.mjs'], receipt), undefined)
    assert.equal(evaluateChatVerifierReceiptCurrencySync(f.alias, receipt)?.stale, true)
    assert.equal(shouldReuseCachedVerifierReceipt(f.alias, receipt), false)
    assert.deepEqual(forbiddenReads, [], 'root mismatch must fail before verifier-input content access')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test('external sibling prefixes and directory escapes, including absent leaves, cannot bind receipts', async t => {
  const f = fixture(t)
  const sibling = `${f.root}-sibling`
  fs.mkdirSync(sibling)
  fs.writeFileSync(join(sibling, 'source.mjs'), 'outside\n')
  directoryAlias(sibling, join(f.root, 'escape'))
  fs.writeFileSync(join(sibling, 'deleted.mjs'), 'deleted outside\n')
  fs.unlinkSync(join(sibling, 'deleted.mjs'))
  for (const path of [join(sibling, 'source.mjs'), join(f.root, 'escape/source.mjs'),
    join(f.root, 'escape/missing.mjs'), join(f.root, 'escape/deleted.mjs')]) {
    assert.equal(await f.capture(f.alias, [path]), null, path)
  }
})

test('physical credential destinations are not admitted through an innocent directory alias', async t => {
  const f = fixture(t)
  const credentials = join(f.root, '.aws')
  fs.mkdirSync(credentials)
  fs.writeFileSync(join(credentials, 'credentials'), 'synthetic-private-input\n')
  directoryAlias(credentials, join(f.root, 'ordinary'))
  assert.equal(await f.capture(f.alias, [join(f.root, 'ordinary/credentials')]), null)
})

test('POSIX case distinctions and Windows cross-drive paths never turn siblings into contained inputs', async t => {
  const f = fixture(t)
  if (process.platform !== 'win32') {
    const caseSibling = join(f.base, 'PHYSICAL')
    fs.mkdirSync(caseSibling)
    fs.writeFileSync(join(caseSibling, 'source.mjs'), 'different case-sensitive directory\n')
    assert.equal(await f.capture(f.alias, [join(caseSibling, 'source.mjs')]), null)
  }
  const currentDrive = win32.parse(f.root).root.slice(0, 1).toUpperCase()
  const otherDrive = currentDrive === 'Z' ? 'Y' : 'Z'
  const outside = `${otherDrive}:\\outside\\source.mjs`
  assert.equal(await f.capture(f.alias, [outside]), null)
})
