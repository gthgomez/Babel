import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAction } from './actions.js'
import type { ToolContext } from '../localTools.js'
import type { ToolExecutor } from './toolExecutor.js'
import type { ExecutionContext } from './executionContext.js'
import {
  isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture,
  removeSyntheticProviderFixture, summarizeSyntheticProviderOutput,
} from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('mutation admission runs without ambient credentials or inference', async t => {
    const fixture = prepareSyntheticProviderFixture()
    t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, [
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>((resolveChild, reject) => {
      child.once('error', reject)
      child.once('close', value => resolveChild(value ?? 1))
    })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code))
    if (code !== 0) {
      // Numeric case identities aid CI diagnosis without exporting child errors,
      // filesystem paths, provider objects, or synthetic credential canaries.
      t.diagnostic(JSON.stringify({ failedCases: [...output.matchAll(/^not ok (\d+) - /gm)]
        .map(match => Number(match[1])) }))
      // Export only the finite rollback category, never its underlying error.
      t.diagnostic(JSON.stringify({ rollbackFailureCategories:
        [...new Set([...output.matchAll(/BABEL_PATCH_ROLLBACK_(timeout|refused|identity|other)\b/g)]
          .map(match => match[1]))],
        failureSourceLines: [...new Set([...output.matchAll(/chatMutationAdmissionParity\.test\.ts:(\d+):\d+/g)]
          .map(match => Number(match[1])))].slice(0, 16) }))
    }
    assert.equal(code, 0)
  })
} else {
  const { ChatEngine } = await import('./chatEngine.js')
  const { runWithExecutionContext } = await import('./executionContext.js')
  const { executeActionWithPolicy } = await import('./toolExecutor.js')
  const { governedStrReplace, governedApplyPatch } = await import('./governedMutations.js')
  const { resolveIsolationBrokerFlags } = await import('./chatEngineIsolationFlags.js')
  const { decodeTaskGitOutput, decodeTaskGitRootOutput } = await import('./taskMutationOwnership.js')

  test('Git path decoding distinguishes malformed bytes from a valid replacement character', () => {
    assert.equal(decodeTaskGitOutput(Buffer.from('?? \uFFFD.txt\0')), '?? \uFFFD.txt\0')
    assert.equal(decodeTaskGitOutput(Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0])), null)
  })

  test('Git root decoding preserves pathname whitespace and embedded newlines', () => {
    assert.equal(decodeTaskGitRootOutput(Buffer.from('/tmp/repo \t\n')), '/tmp/repo \t')
    assert.equal(decodeTaskGitRootOutput(Buffer.from('/tmp/repo\nname \n')), '/tmp/repo\nname ')
    assert.equal(decodeTaskGitRootOutput(Buffer.from('/tmp/repo\n')), '/tmp/repo')
    assert.equal(decodeTaskGitRootOutput(Buffer.from('/tmp/repo\n\n')), '/tmp/repo\n')
    assert.equal(decodeTaskGitRootOutput(Buffer.from('D:/repo \r\n')), process.platform === 'win32' ? 'D:/repo ' : 'D:/repo \r')
  })

  test('POSIX repository roots ending in whitespace preserve consecutive writes', async t => {
    if (process.platform === 'win32') { t.skip('POSIX whitespace-suffixed root identity'); return }
    const f = fixture(t, false, false, 'repository ')
    assert.equal((await f.write('one\n')).policyBlocked, false)
    assert.equal((await f.replace('one', 'two')).policyBlocked, false)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'two\n')
  })

  test('invalid POSIX filename bytes cannot impersonate a task-owned Unicode filename', async t => {
    if (process.platform === 'win32') { t.skip('Windows filenames cannot carry raw invalid UTF-8 bytes'); return }
    const f = fixture(t)
    assert.equal((await f.writePath('\uFFFD.txt', 'owned\n')).policyBlocked, false)
    writeFileSync(Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0xff]), Buffer.from('.txt')]), 'external\n')
    assert.equal((await f.write('overwrite\n')).policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'before\n')
  })

  test('Windows short repository aliases preserve consecutive owned edits', async t => {
    if (process.platform !== 'win32') { t.skip('Windows 8.3 path identity'); return }
    const f = fixture(t, false, false, undefined, true)
    if (f.root === f.repository) { t.skip('8.3 aliases are disabled on this fixture volume'); return }
    assert.equal((await f.write('one\n')).policyBlocked, false)
    assert.equal((await f.replace('one', 'two')).policyBlocked, false)
    assert.equal((await f.patch('two', 'three')).policyBlocked, false)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'three\n')
  })

  function fixture(t: TestContext, subdirectory = false, selectedAlias = false, repositoryName?: string, shortAlias = false) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'babel-owned-edits-'))
    const repository = repositoryName ? join(temporaryRoot, repositoryName) : temporaryRoot
    if (repositoryName) mkdirSync(repository)
    const physicalRoot = subdirectory ? join(repository, 'package') : repository
    if (subdirectory) mkdirSync(physicalRoot)
    const shortResult = shortAlias
      ? spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${physicalRoot}") do @echo %~sI`], {
          encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
        })
      : null
    if (shortResult) assert.equal(shortResult.status, 0)
    const root = shortResult ? shortResult.stdout.trim()
      : selectedAlias ? `${repository}-selected` : physicalRoot
    if (selectedAlias) symlinkSync(physicalRoot, root, process.platform === 'win32' ? 'junction' : 'dir')
    t.after(() => {
      if (selectedAlias) rmSync(root, { recursive: true, force: true })
      rmSync(temporaryRoot, { recursive: true, force: true })
    })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, windowsHide: true })
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(root, 'notes.txt'), 'before\n')
    writeFileSync(join(root, 'other.txt'), 'other\n')
    if (subdirectory) writeFileSync(join(repository, 'sibling.txt'), 'sibling\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/main.ts'), 'export const value = 1\n')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    const owner = {
      options: { projectRoot: root }, engineRunId: `owned-${root}`,
      parity: { eventLog: { thread_id: root }, turnId: 'turn' },
      taskAllowance: { taskOwnerId: root }, taskMutationOwnership: null,
    }
    const contextFactory = (ChatEngine.prototype as unknown as {
      buildBaseExecutionContext(this: typeof owner): ExecutionContext
    }).buildBaseExecutionContext
    const scope = () => contextFactory.call(owner)
    const context: ToolContext = {
      agentId: 'fixture', runId: owner.engineRunId, babelRoot: root, projectRoot: root,
    }
    let failPath: string | null = null
    const executor = {
      mapAction: () => [],
      async execute(action: AgentAction) {
        assert.equal(action.type, 'write_file')
        if (action.type !== 'write_file') throw new Error('unexpected fixture action')
        if (action.path === failPath) {
          return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'fixture write failure' }] }
        }
        writeFileSync(resolve(root, action.path), action.content)
        return { action, terminal: false, results: [{ exit_code: 0, stdout: '', stderr: '' }] }
      },
    } as ToolExecutor
    const writePath = (path: string, content: string, extra: { onDispatchAuthorized?: () => { allowed: boolean } } = {}) => runWithExecutionContext(scope(), () => executeActionWithPolicy(
      { type: 'write_file', path, content }, 'workspace_write', context,
      { executor, ...resolveIsolationBrokerFlags(root), ...extra },
    ))
    const write = (content: string, extra: { onDispatchAuthorized?: () => { allowed: boolean } } = {}) => writePath('notes.txt', content, extra)
    const replace = (oldStr: string, newStr: string) => runWithExecutionContext(scope(), () => governedStrReplace(
      { file_path: 'notes.txt', old_str: oldStr, new_str: newStr }, { projectRoot: root, context, executor },
    ))
    const patch = (oldStr: string, newStr: string) => runWithExecutionContext(scope(), () => governedApplyPatch(
      { patch: `--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-${oldStr}\n+${newStr}\n` },
      { projectRoot: root, context, executor },
    ))
    return {
      root, repository, git, write, writePath, replace, patch, context, executor,
      ownership: () => scope().mutationOwnership,
      deleteNotes: () => runWithExecutionContext(scope(), () => executeActionWithPolicy(
        { type: 'apply_patch', patch: '--- a/notes.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n' },
        'workspace_write', context, { ...resolveIsolationBrokerFlags(root), executor: {
          mapAction: () => [],
          async execute(action) {
            unlinkSync(join(root, 'notes.txt'))
            return { action, terminal: false, results: [{ exit_code: 0, stdout: '', stderr: '' }] }
          },
        } },
      )),
      closeOwner: () => (ChatEngine.prototype as unknown as {
        closeAdmissionStore(this: unknown): void
      }).closeAdmissionStore.call({ engineRunId: owner.engineRunId,
        taskMutationOwnership: scope().mutationOwnership, activeAdmissionClaim: null, parity: {} }),
      failOther: () => { failPath = 'other.txt' },
      patchBoth: () => runWithExecutionContext(scope(), () => governedApplyPatch(
        { patch: '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-one\n+two\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-other\n+changed\n' },
        { projectRoot: root, context, executor },
      )),
    }
  }

  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  // Filesystem tools remain project-sandboxed without starting Docker.
  process.env['BABEL_DOCKER_DISABLE'] = 'true'

  test('second task-owned write is admitted', async t => {
    const f = fixture(t)
    const first = await f.write('first\n')
    assert.equal(first.results[0]?.exit_code, 0, first.results[0]?.stderr)
    assert.equal(first.policyBlocked, false)
    assert.equal(first.mutationReceipt?.status, 'committed')
    assert.equal(f.ownership()?.snapshot([join(f.root, 'notes.txt')]).size, 1,
      JSON.stringify({ root: f.ownership()?.root, receipt: first.mutationReceipt }))
    assert.equal(f.ownership()?.classifyChanges().taskOwnedPaths.length, 1,
      JSON.stringify(f.ownership()?.classifyChanges()))
    const second = await f.write('second\n')
    assert.equal(second.policyBlocked, false, second.results[0]?.stderr)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'second\n')
  })

  test('new file creation and task-owned deletion retain exact path identities', async t => {
    const f = fixture(t)
    assert.equal((await f.writePath('created.txt', '')).results[0]?.exit_code, 0)
    assert.equal((await f.writePath('created.txt', 'created\n')).results[0]?.exit_code, 0)
    assert.equal((await f.deleteNotes()).results[0]?.exit_code, 0)
    assert.equal((await f.write('recreated\n')).results[0]?.exit_code, 0)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'recreated\n')
  })

  test('an explicitly selected repository junction preserves consecutive owned writes', async t => {
    const f = fixture(t, false, true)
    assert.equal((await f.write('one\n')).policyBlocked, false)
    assert.equal((await f.write('two\n')).policyBlocked, false)
    assert.equal((await f.replace('two', 'three')).policyBlocked, false)
    assert.equal(readFileSync(join(f.repository, 'notes.txt'), 'utf8'), 'three\n')
  })

  test('retargeting the selected repository junction does not transfer ownership', async t => {
    const f = fixture(t, false, true)
    assert.equal((await f.write('owned\n')).policyBlocked, false)
    const external = fixture(t)
    rmSync(f.root, { recursive: true, force: true })
    symlinkSync(external.root, f.root, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await f.write('overwrite\n')).policyBlocked, true)
    assert.equal(readFileSync(join(external.root, 'notes.txt'), 'utf8'), 'before\n')
  })

  test('fresh task isolation retires old ownership while explicit continuation preserves it', async t => {
    const f = fixture(t)
    const engine = new ChatEngine({ task: 'Edit notes.txt', projectRoot: f.root, model: 'glm-5.3-flash' })
    t.after(() => engine.closeAdmissionStore())
    const scope = () => (engine as unknown as { buildBaseExecutionContext(): ExecutionContext }).buildBaseExecutionContext()
    const previous = scope().mutationOwnership
    const first = await runWithExecutionContext(scope(), () => executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'owned\n' }, 'workspace_write', f.context,
      { executor: f.executor, ...resolveIsolationBrokerFlags(f.root) },
    ))
    assert.equal(first.results[0]?.exit_code, 0)
    engine.applyUserSubmission({ userInput: 'Start an independent task' })
    assert.equal(previous?.isCurrent, false)
    const current = scope().mutationOwnership
    assert.notEqual(current, previous)
    assert.equal(runWithExecutionContext(scope(), () => resolveIsolationBrokerFlags(f.root).dirtyTree), true)
    engine.applyUserSubmission({ userInput: 'Continue the independent task', continueTask: true })
    assert.equal(scope().mutationOwnership, current)
  })

  test('direct, replacement, and patch edits share admission across a productive sequence', async t => {
    const f = fixture(t)
    assert.equal((await f.write('one\n')).policyBlocked, false)
    assert.equal((await f.replace('one', 'two')).policyBlocked, false)
    assert.equal((await f.patch('two', 'three')).policyBlocked, false)
    const last = await f.write('four\n')
    assert.equal(last.policyBlocked, false, last.results[0]?.stderr)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'four\n')
  })

  for (const gesture of ['continue', 'also update the second note']) {
    test(`objective continuation preserves owned edits: ${gesture}`, async t => {
      const f = fixture(t)
      const engine = new ChatEngine({ task: 'Edit notes.txt', projectRoot: f.root, model: 'glm-5.3-flash' })
      t.after(() => engine.closeAdmissionStore())
      const submit = (userInput: string) => {
        const prepared = engine.prepareUserSubmission({ userInput })
        const allowance = engine.prepareSubmissionAllowance(prepared, 'fixture-task')
        engine.applyPreparedUserSubmission(prepared, { allowance })
        return prepared
      }
      submit('Edit notes.txt')
      const scope = () => (engine as unknown as { buildBaseExecutionContext(): ExecutionContext }).buildBaseExecutionContext()
      const write = (content: string) => runWithExecutionContext(scope(), () => executeActionWithPolicy(
        { type: 'write_file', path: 'notes.txt', content }, 'workspace_write', f.context,
        { executor: f.executor, ...resolveIsolationBrokerFlags(f.root) },
      ))
      assert.equal((await write('owned\n')).results[0]?.exit_code, 0)
      const owner = scope().mutationOwnership
      const next = submit(gesture)
      assert.equal(next.objectiveDisposition, 'preserve')
      assert.equal(next.runtime.continuedTask, false)
      assert.equal(scope().mutationOwnership, owner)
      assert.equal((await write('continued\n')).policyBlocked, false)
      assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'continued\n')
    })
  }

  test('external permission changes do not inherit task-owned content admission', async t => {
    const f = fixture(t, false, false, undefined, process.platform === 'win32')
    assert.equal((await f.write('owned\n')).policyBlocked, false)
    const path = join(f.root, 'notes.txt')
    const before = statSync(path).mode
    // Windows supports the read-only bit; POSIX also reports executable drift.
    chmodSync(path, process.platform === 'win32' ? 0o444 : (before & 0o777) ^ 0o111)
    try {
      assert.notEqual(statSync(path).mode, before)
      assert.deepEqual(f.ownership()?.classifyChanges().unexpectedPaths.map(value =>
        relative(realpathSync.native(path), realpathSync.native(value))), [''])
      assert.equal((await f.write('overwrite\n')).policyBlocked, true)
      assert.equal(readFileSync(path, 'utf8'), 'owned\n')
    } finally { chmodSync(path, before) }
  })

  for (const tool of ['write', 'replace', 'patch'] as const) {
    test(`${tool} preserves pre-existing dirty bytes`, async t => {
      const f = fixture(t)
      writeFileSync(join(f.root, 'notes.txt'), 'user\n')
      const result = tool === 'write' ? await f.write('agent\n')
        : tool === 'replace' ? await f.replace('user', 'agent') : await f.patch('user', 'agent')
      assert.equal(result.policyBlocked, true)
      assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'user\n')
    })
  }

  test('external same-path edits are not task-owned', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).policyBlocked, false)
    writeFileSync(join(f.root, 'notes.txt'), 'external\n')
    const result = await f.write('overwrite\n')
    assert.equal(result.policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'external\n')
  })

  test('unexpected staged or unrelated changes remain protected', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).policyBlocked, false)
    f.git('add', 'notes.txt')
    assert.equal((await f.write('overwrite\n')).policyBlocked, true)
    writeFileSync(join(f.root, 'other.txt'), 'external\n')
    assert.equal((await f.replace('owned', 'overwrite')).policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'owned\n')
  })

  test('an external change during authorization is preserved before dispatch', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).results[0]?.exit_code, 0)
    const result = await f.write('overwrite\n', { onDispatchAuthorized: () => {
      writeFileSync(join(f.root, 'notes.txt'), 'external\n')
      return { allowed: true }
    } })
    assert.equal(result.policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'external\n')
  })

  test('retired task context cannot dispatch another write', async t => {
    const f = fixture(t)
    f.ownership()?.retire()
    const result = await f.write('stale\n')
    assert.equal(result.policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'before\n')
  })

  test('closing the engine retires task mutation ownership', async t => {
    const f = fixture(t)
    const ownership = f.ownership()
    assert.equal(ownership?.isCurrent, true)
    f.closeOwner()
    assert.equal(ownership?.isCurrent, false)
  })

  test('partial patch failure restores earlier ownership without claiming residual bytes', async t => {
    const f = fixture(t)
    assert.equal((await f.write('one\n')).results[0]?.exit_code, 0)
    f.failOther()
    const result = await f.patchBoth()
    assert.equal(result.exit_code, 1)
    const category = result.observation.includes('Windows handle acquisition timed out') ? 'timeout'
      : result.observation.includes('Windows handles refused') ? 'refused'
      : result.observation.includes('PARENT_IDENTITY') ? 'identity' : 'other'
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'one\n', `BABEL_PATCH_ROLLBACK_${category}`)
    assert.equal((await f.write('continued\n')).results[0]?.exit_code, 0)
  })

  test('explicit strict clean-tree override remains strict', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).results[0]?.exit_code, 0)
    process.env['BABEL_REQUIRE_CLEAN_TREE'] = '1'
    try { assert.equal((await f.replace('owned', 'denied')).policyBlocked, true) }
    finally { delete process.env['BABEL_REQUIRE_CLEAN_TREE'] }
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'owned\n')
  })

  test('an unrelated compensation-named directory still blocks mutation admission', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).results[0]?.exit_code, 0)
    const unrelated = join(f.root, '.babel-compensation-external')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'captured'), 'external\n')
    assert.equal((await f.write('denied\n')).policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'owned\n')
    assert.equal(readFileSync(join(unrelated, 'captured'), 'utf8'), 'external\n')
  })

  test('a newly hard-linked owned target is not admitted as an ordinary file', async t => {
    const f = fixture(t)
    assert.equal((await f.write('owned\n')).results[0]?.exit_code, 0)
    const alias = `${f.root}-alias`
    linkSync(join(f.root, 'notes.txt'), alias)
    t.after(() => rmSync(alias, { force: true }))
    assert.equal((await f.replace('owned', 'overwrite')).policyBlocked, true)
    assert.equal(readFileSync(alias, 'utf8'), 'owned\n')
  })

  test('dirty siblings outside a selected package remain protected', async t => {
    const f = fixture(t, true)
    writeFileSync(join(f.repository, 'sibling.txt'), 'external\n')
    assert.equal((await f.write('overwrite\n')).policyBlocked, true)
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'before\n')
  })

  test('different invalid UTF-8 bytes cannot impersonate a task post-image', async t => {
    const f = fixture(t)
    assert.equal((await f.write('\uFFFD')).results[0]?.exit_code, 0)
    writeFileSync(join(f.root, 'notes.txt'), Buffer.from([0xff]))
    assert.equal((await f.write('overwrite')).policyBlocked, true)
    assert.deepEqual(readFileSync(join(f.root, 'notes.txt')), Buffer.from([0xff]))
  })

  test('ChatEngine mutation children get their own worktree ownership', async t => {
    const f = fixture(t)
    const engine = new ChatEngine({
      task: 'Write a scoped result', projectRoot: f.root, model: 'glm-5.3-flash',
      testChildLaneOverrides: {
        useDeterministicMock: true,
        executor: {
          mapAction: () => [],
          async execute(action, context) {
            if (action.type === 'write_file') {
              assert.ok(context.projectRoot)
              writeFileSync(resolve(context.projectRoot, action.path), action.content)
            }
            return { action, terminal: false, results: [{ exit_code: 0, stdout: '', stderr: '' }] }
          },
        },
      },
    })
    t.after(() => engine.closeAdmissionStore())
    const internal = engine as unknown as {
      executeOneAction: (action: unknown, context: ToolContext, callbacks: unknown, meta: unknown) => Promise<{ observation: string }>
      toolCallLog: Array<{ tool: string; exit_code?: number; error?: string }>
    }
    await internal.executeOneAction(
      { type: 'sub_agent', task: 'Write src/result.txt', mutation: true, write_scope: ['src'], max_rounds: 3 },
      { agentId: 'parent', runId: 'parent', babelRoot: f.root, projectRoot: f.root },
      {}, { index: 0, idempotencyKey: 'child-owned-worktree' },
    )
    const child = internal.toolCallLog.find(entry => entry.tool === 'sub_agent')
    assert.ok(child)
    assert.equal(child.exit_code, 0, child.error)
    assert.equal(readFileSync(join(f.root, 'src/main.ts'), 'utf8'), 'export const value = 1\n')
  })

  test('the native provider loop can dispatch two successive writes', async t => {
    const f = fixture(t)
    const priorFetch = globalThis.fetch
    const priorLive = process.env['BABEL_LIVE']
    const priorHeadless = process.env['BABEL_HEADLESS']
    process.env['BABEL_LIVE'] = '1'
    process.env['BABEL_HEADLESS'] = '1'
    t.after(() => {
      globalThis.fetch = priorFetch
      if (priorLive === undefined) delete process.env['BABEL_LIVE']; else process.env['BABEL_LIVE'] = priorLive
      if (priorHeadless === undefined) delete process.env['BABEL_HEADLESS']; else process.env['BABEL_HEADLESS'] = priorHeadless
    })
    let calls = 0
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls++
      if (calls > 4) throw new Error('fixture request limit exceeded')
      const delta = calls <= 2 ? {
        tool_calls: [{ index: 0, id: `write-${calls}`, type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: calls === 1 ? 'one\n' : 'two\n' }),
        } }],
      } : { content: 'The requested updates were attempted.' }
      return new Response(`data: ${JSON.stringify({ model: body.model,
        choices: [{ delta, finish_reason: calls <= 2 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const engine = new ChatEngine({ task: 'Update notes.txt twice', projectRoot: f.root,
      model: 'glm-5.3-flash', maxTurns: 4 })
    t.after(() => engine.closeAdmissionStore())
    for await (const _event of engine.submitMessageStream('Change notes.txt to one, then to two.', 'execute')) {
      if (readFileSync(join(f.root, 'notes.txt'), 'utf8') === 'two\n') break
    }
    assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'two\n')
  })
}
