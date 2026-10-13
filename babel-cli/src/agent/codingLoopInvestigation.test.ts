import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, mock } from 'node:test'
import { getEventListeners } from 'node:events'

// Fixture-only configuration; no provider requests or credential-store access.
const scratch = mkdtempSync(join(tmpdir(), 'babel-loop-audit-'))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BABEL_') || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key]
}
process.env.BABEL_CONFIG_DIR = join(scratch, 'config')
process.env.BABEL_STATE_DIR = join(scratch, 'state')
process.env.BABEL_CACHE_DIR = join(scratch, 'cache')
process.env.BABEL_CHRONICLE_BACKEND = 'json'
process.env.BABEL_CHRONICLE_JSON_PATH = join(scratch, 'chronicle.json')
process.env.BABEL_DRY_RUN = 'false'
globalThis.fetch = async () => { throw new Error('Offline audit forbids network requests') }
const { runMutationAgentLoop } = await import('./lanes/runMutationAgentLoop.js')
const { runChatEngineCompaction } = await import('./compactionCommit.js')
const { createThreadEventLog, startTurn, recordUserMessage, recordAssistantMessage } = await import('./threadEventLog.js')
const { createSessionEventLog } = await import('./sessionEvents.js')
const { executeTool, getExecutorToolRegistrySnapshot } = await import('../localTools.js')
const { resetSessionCache, TOOL_RESULT_CACHE_MUTATING_TOOLS } = await import('../tools/toolResultCache.js')
const { readRuntimeMode } = await import('../config/runtimeMode.js')
const { handleMemoryQuery } = await import('../tools/chronicleMemory.js')
const { executeActionWithPolicy } = await import('./toolExecutor.js')
const { WorkspaceTransactionManager } = await import('../services/workspaceTransactions.js')
const finish: import('./actions.js').AgentAction = { type: 'finish', summary: 'done', verification: [] }

function fixture(name: string) {
  const root = mkdtempSync(join(scratch, name + '-'))
  mkdirSync(join(root, 'src'))
  const runDir = join(root, '.babel', 'runs')
  const toolContext = { projectRoot: root, babelRoot: root, runId: name, agentId: name, runDir }
  return { root, input: { projectRoot: root, toolContext, agentId: name, task: 'offline fixture', writeScope: ['src'], runDir, maxRounds: 2 } }
}
function executorFor(handler: (action: import('./actions.js').AgentAction, context: import('../localTools.js').ToolContext) => import('../sandbox.js').ToolResult) {
  return {
    mapAction: () => [],
    execute: async (action: import('./actions.js').AgentAction, context: import('../localTools.js').ToolContext) => ({ action, terminal: false, results: [await handler(action, context)] }),
  }
}
const ok = { exit_code: 0, stdout: 'fixture executed', stderr: '' }

async function compact(task: string, manager = false) {
  const threadLog = createThreadEventLog()
  const sessionLog = createSessionEventLog()
  const turnId = startTurn(threadLog, { task, model: 'test-model', provider: 'deepseek', projectRoot: scratch, policyPreset: 'chat' })
  const conversation: import('./chatCompaction.js').ChatMessage[] = [{ role: 'system', content: 'policy' }]
  for (let i = 0; i < 8; i++) {
    const content = `history-${i} ${'x'.repeat(3000)}`
    recordUserMessage(threadLog, turnId, content)
    recordAssistantMessage(threadLog, turnId, content)
    conversation.push({ role: 'user', content }, { role: 'assistant', content })
  }
  recordUserMessage(threadLog, turnId, 'keep tail')
  conversation.push({ role: 'user', content: 'keep tail' })
  const host = {
    conversation, options: { task, model: 'test-model' }, compactionProviderId: 'deepinfra',
    limits: { maxEstimatedTokens: 128000 }, abortSignal: new AbortController().signal,
    writeCount: 0, turnIndex: 2, toolCallLog: [], progress: { receipts: [], consecutiveNoProgress: 0 },
    threadLog, sessionLog, turnId, shouldUseTextTools: () => false,
    compactHeuristic: () => { host.conversation = [conversation[0]!, { role: 'user', content: 'keep tail' }] },
    checkpoint: async () => undefined, reserveTokens: 0, textToolsReserve: 0, forceCompaction: true,
    resolveModel: () => 'test-model', shouldCompactByTokens: () => true,
    estimateTokens: (messages: import('./chatCompaction.js').ChatMessage[]) => messages.reduce((sum, m) => sum + m.content.length, 0),
  }
  if (!manager) return runChatEngineCompaction(host)
  return runChatEngineCompaction({ ...host, ...(manager ? {
    compactionManager: {
      compactWithResult: async () => ({
        messages: [conversation[0]!, { role: 'user' as const, content: 'keep tail' }],
        changed: true, strategy: 'heuristic' as const, status: 'applied' as const, strategyErrors: [],
        tokensBefore: 12000, tokensAfter: 20,
      }),
    },
  } : {}) })
}

test('control: plain task compacts successfully', async () => {
  assert.equal((await compact('repair parser'))?.changed, true)
})
test('F1: task containing quotes and newline should still compact', async () => {
  assert.equal((await compact('Repair "parser"\nPreserve behavior'))?.changed, true)
})
test('F1: both compaction paths retain quotes, tabs and Windows paths', async () => {
  for (const manager of [false, true]) {
    assert.equal((await compact('Repair "parser"\tD:\\source\\file.ts\nKeep behavior', manager))?.changed, true)
  }
})
test('F2: failed write must not manufacture changed-file evidence', async () => {
  const { root, input } = fixture('failed-write')
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => [{ type: 'write_file', path: 'src/new.txt', content: 'never written' }, finish],
    executor: executorFor(() => ({ exit_code: 1, stdout: '', stderr: 'fixture disk failure' })),
  })
  assert.equal(existsSync(join(root, 'src/new.txt')), false)
  assert.equal(result.changedFiles.length, 0, `reported ${result.attribution} with ${result.changedFiles.length} nonexistent file`)
})
test('F3: WorktreeSafetyController refusal must prevent protected write', async () => {
  const { root, input } = fixture('protected-write')
  mkdirSync(join(root, 'dist'))
  const target = join(root, 'dist/result.txt')
  writeFileSync(target, 'original')
  await runMutationAgentLoop({ ...input, writeScope: ['dist'],
    actionResolver: async () => [{ type: 'write_file', path: 'dist/result.txt', content: 'overwritten' }, finish],
    executor: executorFor(action => { writeFileSync(target, action.type === 'write_file' ? action.content : ''); return ok }),
  })
  assert.equal(readFileSync(target, 'utf8'), 'original')
})
test('F4: finish before trailing actions must terminate the outer loop', async () => {
  const { input } = fixture('finish-position')
  let turns = 0
  const result = await runMutationAgentLoop({ ...input, actionResolver: async () => {
    turns++
    return [finish, { type: 'read_file', path: 'src/a.txt' }]
  } })
  assert.equal(result.success, true)
  assert.equal(turns, 1)
})
test('F5: local timeout must apply while resolver is pending', async () => {
  const { input } = fixture('timeout')
  const result = await runMutationAgentLoop({ ...input, timeoutMs: 10,
    actionResolver: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return [finish] },
  })
  assert.equal(result.attribution, 'child_timeout')
})
test('F6: entering plan mode twice around exit must really enter plan', async () => {
  resetSessionCache()
  const { input } = fixture('mode-cache')
  for (const tool of ['enter_plan_mode', 'exit_plan_mode', 'enter_plan_mode'] as const) {
    const result = await executeTool({ tool }, input.toolContext)
    assert.equal(result.exit_code, 0)
  }
  assert.equal(readRuntimeMode(), 'plan')
})
test('F6b: memory mutation must invalidate reads and never replay a stale write result', async () => {
  resetSessionCache()
  process.env.BABEL_LIVE = 'true'
  const { input } = fixture('memory-cache')
  const ctx = input.toolContext
  for (const value of ['first', 'second', 'first']) {
    const result = await executeTool({ tool: 'memory_store', key: 'audit', value }, ctx)
    assert.equal(result.exit_code, 0)
  }
  const actual = await handleMemoryQuery({ tool: 'memory_query', key: 'audit' }, ctx.projectRoot)
  delete process.env.BABEL_LIVE
  assert.ok(actual.stdout.includes('first'), `actual value: ${actual.stdout}`)
})
test('F7: apply_patch effects remain covered when unowned child rollback is refused', async () => {
  const { root, input } = fixture('patch-rollback')
  const target = join(root, 'src/a.txt')
  writeFileSync(target, 'before\n')
  let turns = 0
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => {
      if (++turns > 1) throw new Error('fixture provider failure')
      return [{ type: 'apply_patch', patch: '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-before\n+after\n' }]
    },
    executor: executorFor(() => { writeFileSync(target, 'after\n'); return ok }),
  })
  assert.equal(result.success, false)
  assert.equal(result.changedFiles.length, 1, result.error ?? result.attribution)
  const rollback = await result.rollback()
  assert.equal(rollback.status, 'rollback_failed')
  assert.equal(readFileSync(target, 'utf8'), 'after\n')
  assert.deepEqual(rollback.failed_files.map(file => file.path), ['src/a.txt'])
})
test('F8: explicit read_only preset must deny child writes', async () => {
  const { root, input } = fixture('readonly-preset')
  const target = join(root, 'src/a.txt')
  const result = await runMutationAgentLoop({ ...input, preset: 'read_only',
    actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'written' }, finish],
    executor: executorFor(() => { writeFileSync(target, 'written'); return ok }),
  })
  assert.equal(existsSync(target), false, `preset ignored: ${result.attribution}`)
})
test('F9: child verifier dispatch must receive isolation capability', async () => {
  const { input } = fixture('child-verifier')
  let dispatched = false
  const result = await runMutationAgentLoop({ ...input, executionEnvelope: { isolationAvailable: true },
    actionResolver: async () => [{ type: 'test_run', command: 'npm test' }, finish],
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(dispatched, true, result.error ?? 'no error')
})
test('control: shared executor accepts a verifier with supplied isolation evidence', async () => {
  const { input } = fixture('verifier-control')
  let dispatched = false
  const result = await executeActionWithPolicy({ type: 'test_run', command: 'npm test' }, 'workspace_write', input.toolContext, {
    isolationAvailable: true,
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(result.policyBlocked, false)
  assert.equal(dispatched, true)
})
test('F6: compatibility cache inventory covers registered mutators', () => {
  const missing = getExecutorToolRegistrySnapshot().filter((t: { mutating: boolean; name: string }) => t.mutating && !TOOL_RESULT_CACHE_MUTATING_TOOLS.has(t.name)).map((t: { name: string }) => t.name)
  assert.deepEqual(missing, [])
})

test('F3: dirty tracked targets are refused before executor dispatch', async () => {
  const { root, input } = fixture('dirty-target')
  const target = join(root, 'src/a.txt')
  writeFileSync(target, 'tracked\n')
  for (const args of [
    ['init', '-q'], ['add', 'src/a.txt'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(git.status, 0, git.stderr)
  }
  writeFileSync(target, 'owner edits\n')
  let dispatched = false
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'overwritten' }, finish],
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(dispatched, false)
  assert.equal(result.attribution, 'child_policy_block')
  assert.equal(readFileSync(target, 'utf8'), 'owner edits\n')
})

test('F3/F8: deterministic mock honors safety and permission refusals', async () => {
  for (const preset of ['read_only', 'ask_before_mutation', 'workspace_write'] as const) {
    const { root, input } = fixture('mock-refusal-' + preset)
    mkdirSync(join(root, 'dist'))
    let dispatchedWrite = false
    const result = await runMutationAgentLoop({ ...input, preset, useDeterministicMock: true,
      writeScope: preset === 'workspace_write' ? ['dist'] : ['src'],
      executor: executorFor(action => {
        if (action.type === 'write_file') dispatchedWrite = true
        return ok
      }),
    })
    assert.equal(dispatchedWrite, false)
    assert.equal(result.attribution, 'child_policy_block')
    assert.equal(result.changedFiles.length, 0)
  }
})

test('F8: ask_before_mutation cannot silently dispatch a child write', async () => {
  const { input } = fixture('ask-preset')
  let dispatched = false
  const result = await runMutationAgentLoop({ ...input, preset: 'ask_before_mutation',
    actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'written' }, finish],
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(dispatched, false)
  assert.equal(result.success, false)
})

test('F2/F7: mixed write and patch effects are retained when writer ownership is unknown', async () => {
  const { root, input } = fixture('mixed-rollback')
  writeFileSync(join(root, 'src/edit.txt'), 'before\n')
  writeFileSync(join(root, 'src/delete.txt'), 'delete\n')
  const patch = '--- a/src/edit.txt\n+++ b/src/edit.txt\n@@ -1 +1 @@\n-before\n+after\n'
    + '--- /dev/null\n+++ b/src/patch-new.txt\n@@ -0,0 +1 @@\n+new\n'
    + '--- a/src/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-delete\n'
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => [
      { type: 'write_file', path: 'src/write-new.txt', content: 'write\n' },
      { type: 'apply_patch', patch }, finish,
    ],
    executor: executorFor(action => {
      if (action.type === 'write_file') writeFileSync(join(root, action.path), action.content)
      if (action.type === 'apply_patch') {
        writeFileSync(join(root, 'src/edit.txt'), 'after\n')
        writeFileSync(join(root, 'src/patch-new.txt'), 'new\n')
        rmSync(join(root, 'src/delete.txt'))
      }
      return ok
    }),
  })
  assert.equal(result.success, true, result.error ?? '')
  assert.equal(result.changedFiles.length, 4)
  assert.equal(result.changedFiles.find(file => file.path === 'src/delete.txt')?.bytes, 0)
  const rollback = await result.rollback()
  assert.equal(rollback.status, 'rollback_failed')
  assert.equal(rollback.failed_files.length, 4)
  assert.equal(result.changedFiles.length, 4)
  assert.equal(readFileSync(join(root, 'src/edit.txt'), 'utf8'), 'after\n')
  assert.equal(existsSync(join(root, 'src/delete.txt')), false)
  assert.equal(existsSync(join(root, 'src/write-new.txt')), true)
  assert.equal(existsSync(join(root, 'src/patch-new.txt')), true)
})

test('F2: change and restoration within one child leave no net mutation evidence', async () => {
  const { root, input } = fixture('net-noop')
  writeFileSync(join(root, 'src/a.txt'), 'before')
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => [
      { type: 'write_file', path: 'src/a.txt', content: 'after' },
      { type: 'write_file', path: 'src/a.txt', content: 'before' }, finish,
    ],
    executor: executorFor(action => {
      if (action.type === 'write_file') writeFileSync(join(root, action.path), action.content)
      return ok
    }),
  })
  assert.equal(result.attribution, 'child_noop')
  assert.equal(result.changedFiles.length, 0)
})

test('budget controls distinguish productive exhaustion, repetition, completed change and no-op', async () => {
  for (const scenario of ['productive_limit', 'stuck_limit', 'correct_finish', 'noop_finish'] as const) {
    const { root, input } = fixture(scenario)
    let round = 0
    const result = await runMutationAgentLoop({ ...input, maxRounds: 2,
      actionResolver: async () => {
        round++
        if (scenario === 'noop_finish') return [finish]
        if (scenario === 'stuck_limit') return [{ type: 'read_file', path: 'src/missing.txt' }]
        const write: import('./actions.js').AgentAction = { type: 'write_file', path: `src/round-${round}.txt`, content: `useful-${round}` }
        return scenario === 'correct_finish' ? [write, finish] : [write]
      },
      executor: executorFor(action => {
        if (action.type === 'write_file') writeFileSync(join(root, action.path), action.content)
        return ok
      }),
    })
    const expectedChanges = scenario === 'productive_limit' ? 2 : scenario === 'correct_finish' ? 1 : 0
    assert.equal(result.changedFiles.length, expectedChanges)
    for (const file of result.changedFiles) assert.match(readFileSync(join(root, file.path), 'utf8'), /^useful-/)
    if (scenario.endsWith('limit')) {
      assert.equal(result.attribution, 'child_round_exhaustion')
      assert.equal(result.success, false)
      if (expectedChanges > 0) assert.equal(result.rollbackSummary?.status, 'rollback_failed')
    } else {
      assert.equal(result.success, true)
      assert.equal(result.attribution, scenario === 'noop_finish' ? 'child_noop' : 'child_success')
    }
  }
})

test('F5: local deadline cancels a resolver that never settles', async () => {
  const { input } = fixture('never-resolves')
  let childSignal: AbortSignal | undefined
  const started = Date.now()
  const result = await runMutationAgentLoop({ ...input, timeoutMs: 20,
    actionResolver: async (_prompt, signal) => { childSignal = signal; return new Promise(() => {}) },
  })
  assert.equal(result.attribution, 'child_timeout')
  assert.equal(childSignal?.aborted, true)
  assert.ok(Date.now() - started < 1000)
})

test('F5: pending tool receives local cancellation and settles before return', async () => {
  const { input } = fixture('tool-timeout')
  let settled = false
  const result = await runMutationAgentLoop({ ...input, timeoutMs: 80,
    actionResolver: async () => [{ type: 'read_file', path: 'src/a.txt' }, finish],
    executor: {
      mapAction: () => [],
      execute: async (action, context) => {
        await new Promise<void>(resolve => {
          if (context.signal?.aborted) resolve()
          else context.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        settled = true
        return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'aborted' }] }
      },
    },
  })
  assert.equal(settled, true)
  assert.equal(result.attribution, 'child_timeout')
})

test('F9: missing isolation evidence continues to deny repository-controlled verification', async () => {
  const { input } = fixture('verifier-no-evidence')
  let dispatched = false
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => [{ type: 'test_run', command: 'npm test' }, finish],
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(dispatched, false)
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /DENY_CAPABILITY_CONSTRAINT/)
})

test('F9: an isolation envelope preserves the parent plan ceiling', async () => {
  const { input } = fixture('parent-plan-ceiling')
  let dispatched = false
  const result = await runMutationAgentLoop({ ...input,
    executionEnvelope: { isolationAvailable: true, mode: 'plan' },
    actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'written' }, finish],
    executor: executorFor(() => { dispatched = true; return ok }),
  })
  assert.equal(dispatched, false)
  assert.equal(result.success, false)
})

test('F2: unreadable final postimages stay indeterminate', async () => {
  const { root, input } = fixture('unknown-postimage')
  const target = join(root, 'src/a.txt')
  let turns = 0
  const result = await runMutationAgentLoop({ ...input,
    actionResolver: async () => {
      if (++turns === 1) return [{ type: 'write_file', path: 'src/a.txt', content: 'written' }]
      rmSync(target)
      mkdirSync(target)
      return [finish]
    },
    executor: executorFor(action => {
      if (action.type === 'write_file') writeFileSync(target, action.content)
      return ok
    }),
  })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /indeterminate/)
  assert.equal(result.changedFiles.length, 0)
  assert.deepEqual(result.indeterminatePaths, ['src/a.txt'])
})

test('F5: the earlier local or inherited deadline determines attribution', async () => {
  for (const localFirst of [false, true]) {
    const { input } = fixture('deadline-precedence')
    const result = await runMutationAgentLoop({ ...input,
      timeoutMs: localFirst ? 20 : 1000,
      inheritedAllowance: {
        costBaselineUsd: 0, remainingCostUsd: null, maxRounds: 2,
        deadlineAtMs: Date.now() + (localFirst ? 1000 : 20),
      },
      actionResolver: async () => new Promise(() => {}),
    })
    assert.equal(result.attribution, localFirst ? 'child_timeout' : 'child_wall_exhaustion')
  }
})

test('F7: deterministic mock retains returned changes after unowned rollback refusal', async () => {
  const { root, input } = fixture('mock-rollback')
  const result = await runMutationAgentLoop({ ...input, useDeterministicMock: true,
    executor: executorFor(action => {
      if (action.type === 'write_file') writeFileSync(join(root, action.path), action.content)
      return ok
    }),
  })
  assert.equal(result.changedFiles.length, 1)
  assert.equal((await result.rollback()).status, 'rollback_failed')
  assert.equal(result.changedFiles.length, 1)
  assert.equal(existsSync(join(root, 'src/result.txt')), true)
})

test('review: safety rescans distinguish confirmed child edits from external edits', async () => {
  for (const external of [false, true]) {
    const { root, input } = fixture('rescan-ownership')
    const target = join(root, 'src/a.txt')
    writeFileSync(target, 'original')
    for (const args of [['init', '-q'], ['add', 'src/a.txt'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(git.status, 0, git.stderr)
    }
    let now = Date.now()
    const clock = mock.method(Date, 'now', () => now)
    let turns = 0
    try {
      const result = await runMutationAgentLoop({ ...input,
        actionResolver: async () => {
          if (++turns === 1) return [{ type: 'write_file', path: 'src/a.txt', content: 'child first' }]
          now += 6001
          if (external) writeFileSync(target, 'owner edits')
          return [{ type: 'write_file', path: 'src/a.txt', content: 'child second' }, finish]
        },
        executor: executorFor(action => {
          if (action.type === 'write_file') writeFileSync(target, action.content)
          return ok
        }),
      })
      assert.equal(result.success, !external, result.error ?? '')
      assert.equal(readFileSync(target, 'utf8'), external ? 'owner edits' : 'child second')
      const rollback = await result.rollback()
      assert.equal(rollback.status, external ? 'rollback_skipped_user_dirty_target' : 'rollback_failed')
      assert.equal(readFileSync(target, 'utf8'), external ? 'owner edits' : 'child second')
    } finally {
      clock.mock.restore()
    }
  }
})

test('review: failed writes reconcile partial rollback without inventing success', async () => {
  const undo = mock.method(WorkspaceTransactionManager, 'undoLastMutationBatch', async () => {
    throw new Error('fixture transaction rollback unavailable')
  })
  try {
    for (const safetyFails of [false, true]) {
      const { root, input } = fixture('failed-rollback')
      if (safetyFails) process.env.BABEL_SIMULATE_ROLLBACK_FAILURE_FOR = 'src/a.txt'
      else delete process.env.BABEL_SIMULATE_ROLLBACK_FAILURE_FOR
      const target = join(root, 'src/a.txt')
      const result = await runMutationAgentLoop({ ...input,
        actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'partial' }, finish],
        executor: executorFor(() => {
          writeFileSync(target, 'partial')
          return { exit_code: 1, stdout: '', stderr: 'fixture partial write' }
        }),
      })
      assert.equal(result.success, false)
      assert.equal(result.changedFiles.length, 0)
      assert.equal(existsSync(target), true)
      assert.deepEqual(result.indeterminatePaths ?? [], ['src/a.txt'])
    }
  } finally {
    undo.mock.restore()
    delete process.env.BABEL_SIMULATE_ROLLBACK_FAILURE_FOR
  }
})

test('review: first cancellation cause survives delayed tool settlement', async () => {
  for (const parentFirst of [false, true]) {
    const { input } = fixture('delayed-settlement')
    const parent = new AbortController()
    let now = Date.now()
    const clock = mock.method(Date, 'now', () => now)
    try {
      const result = await runMutationAgentLoop({ ...input,
        abortSignal: parent.signal, timeoutMs: 40,
        inheritedAllowance: { costBaselineUsd: 0, remainingCostUsd: null, maxRounds: 2, deadlineAtMs: now + 100 },
        actionResolver: async () => [{ type: 'read_file', path: 'src/a.txt' }, finish],
        executor: {
          mapAction: () => [],
          execute: async action => {
            if (parentFirst) setTimeout(() => parent.abort(), 5)
            await new Promise(resolve => setTimeout(resolve, 130))
            now += 200
            return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'aborted' }] }
          },
        },
      })
      assert.equal(result.attribution, parentFirst ? 'child_cancellation' : 'child_timeout')
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
    } finally {
      clock.mock.restore()
    }
  }
})

test('review: rollback preserves external edits without another mutation snapshot', async () => {
  for (const failure of [false, true]) {
    const { root, input } = fixture('rollback-external-owner')
    const target = join(root, 'src/a.txt')
    writeFileSync(target, 'original')
    let turns = 0
    const result = await runMutationAgentLoop({ ...input,
      actionResolver: async () => {
        if (++turns === 1) return [{ type: 'write_file', path: 'src/a.txt', content: 'child' }]
        writeFileSync(target, 'owner edits')
        if (failure) throw new Error('fixture provider failure')
        return [finish]
      },
      executor: executorFor(action => {
        if (action.type === 'write_file') writeFileSync(target, action.content)
        return ok
      }),
    })
    await result.rollback()
    assert.equal(readFileSync(target, 'utf8'), 'owner edits')
    assert.equal(result.changedFiles.length, 0)
    assert.deepEqual(result.indeterminatePaths, ['src/a.txt'])
  }
})

test('review: unknown partial-write bytes are preserved when ownership cannot be established', async () => {
  const { root, input } = fixture('partial-unknown-owner')
  const target = join(root, 'src/a.txt')
  writeFileSync(target, 'original')
  const undo = mock.method(WorkspaceTransactionManager, 'undoLastMutationBatch', async () => {
    throw new Error('fixture transaction rollback unavailable')
  })
  try {
    const result = await runMutationAgentLoop({ ...input,
      actionResolver: async () => [{ type: 'write_file', path: 'src/a.txt', content: 'requested' }, finish],
      executor: executorFor(() => {
        writeFileSync(target, 'unbound bytes')
        return { exit_code: 1, stdout: '', stderr: 'fixture partial failure' }
      }),
    })
    assert.equal(result.success, false)
    assert.equal(readFileSync(target, 'utf8'), 'unbound bytes')
    assert.deepEqual(result.indeterminatePaths, ['src/a.txt'])
    assert.equal(result.rollbackSummary?.status, 'rollback_skipped_user_dirty_target')
  } finally {
    undo.mock.restore()
  }
})
