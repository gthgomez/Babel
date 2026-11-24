import assert from 'node:assert/strict'
import test from 'node:test'
import { handleCommand } from '../commands.js'
import type { ReplContext } from '../context.js'
import { INTERACTIVE_COMMAND_COMPLETIONS } from '../types.js'
import { capturesShellCommandOutput } from '../../ui/shell/shellCommandOutput.js'

test('/pwd reports the exact target and invocation directory without a provider or indexing', async t => {
  const targetRoot = 'C:\\fixture project\\target'
  const cwd = 'C:\\fixture project\\invoked'
  let indexCalls = 0
  const ctx = {
    state: { readinessState: 'setup_required' },
    resolveCurrentTarget: () => ({ targetRoot, cwd, workspaceRoot: null, project: null, source: 'cwd' }),
    scheduleIndexWarmup: () => { indexCalls += 1 },
  } as unknown as ReplContext
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider request') })
  const lines: string[] = []
  const oldLog = console.log
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try { await handleCommand(ctx, '/pwd') } finally { console.log = oldLog }
  assert.ok(lines.join('\n').includes(JSON.stringify(targetRoot)))
  assert.ok(lines.join('\n').includes(JSON.stringify(cwd)))
  assert.equal(indexCalls, 0)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(capturesShellCommandOutput('pwd'), false)
  assert.ok(INTERACTIVE_COMMAND_COMPLETIONS.includes('/pwd'))
})

test('/pwd presents its paths through the hosted shell', async () => {
  const notices: string[] = []; const raw: string[] = []; const oldLog = console.log
  const targetRoot = 'C:\\fixture project\\target'; const cwd = 'C:\\fixture project\\invoked'
  const ctx = { state: { readinessState: 'setup_required' }, resolveCurrentTarget: () => ({ targetRoot, cwd }),
    shellRuntime: { appendNotice: (text: string) => notices.push(text) } } as unknown as ReplContext
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
  try { await handleCommand(ctx, '/pwd') } finally { console.log = oldLog }
  assert.equal(raw.length, 0)
  assert.ok(notices.join('\n').includes(JSON.stringify(targetRoot)))
  assert.ok(notices.join('\n').includes(JSON.stringify(cwd)))
})
