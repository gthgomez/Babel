import assert from 'node:assert/strict'
import test from 'node:test'

import type { KeyEvent } from '../keyInput.js'
import { BabelRepl } from '../../interactive/BabelRepl.js'
import { ShellNavigator, type ShellNavigationRow } from './shellNavigation.js'
import { ShellRuntimeBinding } from './shellRuntimeBinding.js'
import { ShellSources } from './shellSources.js'
import { ShellInspectorStore } from './shellInspector.js'
import { planShellLayout } from './shellLayout.js'
import { createShellCommandOperations, type ShellCommandOperations } from './shellOperations.js'
import type { ReplContext } from '../../interactive/context.js'

function key(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false, sequence: name }
}

function sessionRow(id: string): ShellNavigationRow {
  return { id, label: id, command: { kind: 'session.resume', id } }
}

/**
 * Handler-boundary test: drive the actual BabelRepl.dispatchShellKey path with a
 * real ShellRuntimeBinding so the move-vs-resume invariant is exercised against
 * the handler, not asserted in isolation.
 */
function createHandlerSubject() {
  const repl = Object.create(BabelRepl.prototype) as unknown as Record<string, unknown>
  const runtime = new ShellRuntimeBinding({ threadId: 'thread-original' })
  runtime.hydrateTurns([], 'thread-original')
  const navigator = new ShellNavigator()
  navigator.setRows('sessions', [sessionRow('s1'), sessionRow('s2')])

  const resumed: string[] = []
  const operations: ShellCommandOperations = {
    resumeSession: async (id: string) => {
      resumed.push(id)
      runtime.hydrateTurns([], id)
      return { ok: true }
    },
    newSession: () => ({ ok: true }),
    setTarget: () => {},
    toggleDirectory: () => {},
    setMode: () => {},
    setModel: () => {},
    runAction: async () => {},
    toggleInspector: () => {},
  }

  repl['shellRuntime'] = runtime
  repl['shellNavigator'] = navigator
  repl['shellInputState'] = { focus: 'sessions', leftDrawerOpen: true, rightDrawerOpen: true }
  repl['shellInspector'] = new ShellInspectorStore()
  repl['shellSources'] = new ShellSources(
    async () => [],
    () => [],
  )
  repl['shellCommandOperations'] = operations
  repl['targetOverrideRoot'] = null
  repl['cachedTargetRoot'] = null
  repl['shellHost'] = undefined
  repl['state'] = { mode: 'chat' }
  repl['resolveCurrentTarget'] = () => ({
    targetRoot: '/tmp/target',
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: '/tmp/target',
  })
  repl['withExclusiveTerminal'] = async (
    _reason: string,
    work: () => Promise<unknown>,
  ) => work()

  const dispatch = (
    repl['dispatchShellKey'] as (
      event: KeyEvent,
      host: undefined,
      adapter: { processKey: (event: KeyEvent) => void },
      layout: ReturnType<typeof planShellLayout>,
    ) => void
  ).bind(repl)

  return { repl, runtime, navigator, resumed, dispatch }
}

test('BabelRepl handler: cursoring does not touch the active thread; Enter rebinds only on resume', async () => {
  const { runtime, navigator, resumed, dispatch } = createHandlerSubject()
  const adapter = { processKey: () => {} }
  const layout = planShellLayout({ cols: 160, rows: 40 })

  dispatch(key('down'), undefined, adapter, layout)
  assert.equal(runtime.getSnapshot().threadId, 'thread-original')
  assert.deepEqual(navigator.getSelection(), { surface: 'sessions', index: 1 })

  dispatch(key('enter'), undefined, adapter, layout)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(resumed, ['s2'])
  assert.equal(runtime.getSnapshot().threadId, 's2')
})

test('BabelRepl handler: active New conversation preserves cancellation and shows recovery', async () => {
  const { repl, runtime, navigator, dispatch } = createHandlerSubject()
  let closed = 0
  let cancelled = 0
  const engine = { closeAdmissionStore: () => { closed++ }, abortTurn: () => { cancelled++ } }
  repl['chatEngine'] = engine
  repl['isRunning'] = true
  repl['shellCommandOperations'] = createShellCommandOperations(repl as unknown as ReplContext, {
    invalidate: () => {}, onSessionChanged: () => { throw new Error('Active session must remain bound') },
  })
  navigator.setRows('sessions', [{ id: 'new', label: 'New conversation', command: { kind: 'session.new' } }])
  const messages: string[] = []
  const log = console.log
  console.log = message => { messages.push(String(message)) }
  try {
    dispatch(key('enter'), undefined, { processKey: () => {} }, planShellLayout({ cols: 160, rows: 40 }))
    await new Promise(resolve => setImmediate(resolve))
  } finally { console.log = log }
  assert.equal(repl['chatEngine'], engine)
  assert.equal(runtime.getSnapshot().threadId, 'thread-original')
  assert.equal(closed, 0)
  assert.equal(repl['cachedTargetRoot'], null)
  assert.match(messages.join('\n'), /wait.*cancel/i)
  ;(repl['chatEngine'] as typeof engine).abortTurn()
  assert.equal(cancelled, 1)
})
