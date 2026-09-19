import assert from 'node:assert/strict'
import test from 'node:test'

import type { KeyEvent } from '../keyInput.js'
import { BabelRepl } from '../../interactive/BabelRepl.js'
import { ShellNavigator, type ShellNavigationRow } from './shellNavigation.js'
import { ShellRuntimeBinding } from './shellRuntimeBinding.js'
import { ShellSources } from './shellSources.js'
import { ShellInspectorStore } from './shellInspector.js'
import { planShellLayout } from './shellLayout.js'
import type { ShellCommandOperations } from './shellOperations.js'

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
    newSession: () => {},
    setTarget: () => {},
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
