import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionEventLog, flushSessionEventLogStrict, recordTurnEnded, recordUserSubmitted } from '../../agent/sessionEvents.js'
import { createThreadEventLog, persistThreadEventLog, startTurn } from '../../agent/threadEventLog.js'
import { globalCostTracker } from '../../services/costTracker.js'
import type { ReplContext } from '../context.js'
import { handleCost } from './config.js'
import { handleStatus, handleWhyStopped } from './info.js'

test('status shows running product identity and configured route', () => {
  const prior = console.log; const output: string[] = []
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(' ')) }
  try {
    handleStatus({ state: { mode: 'chat', router: 'v9', model: 'glm-5.3-flash' }, verboseMode: false } as never, [])
    const text = output.join('\n')
    assert.match(text, /Babel/); assert.match(text, /revision unknown/i)
    assert.match(text, /Package/); assert.match(text, /Entry/); assert.match(text, /openrouter/i)
  } finally { console.log = prior }
})

test('/why-stopped selects the current conversation and supports an explicit saved run', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-stopped-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previousRuns = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = root
  t.after(() => {
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRuns
  })
  const messages: string[] = []
  t.mock.method(console, 'log', (message: string) => messages.push(message))

  const currentRun = join(root, 'chat-sessions', 'current')
  const otherRun = join(root, 'another run')
  mkdirSync(currentRun, { recursive: true })
  mkdirSync(otherRun)
  writeFileSync(join(otherRun, 'terminal_status_summary.json'), JSON.stringify({ terminal_outcome: 'VERIFIED_COMPLETE' }))

  const sessionLog = createSessionEventLog('current')
  recordUserSubmitted(sessionLog, { turn_id: 'prior', task: 'Earlier task', projectRoot: root })
  recordTurnEnded(sessionLog, { turn_id: 'prior', outcome: 'VERIFIED_COMPLETE', status: 'completed' })
  const threadLog = createThreadEventLog('current')
  const turnId = startTurn(threadLog, {
    task: 'Current task', model: 'fixture', provider: 'fixture', projectRoot: root, policyPreset: 'workspace_write',
  })
  recordUserSubmitted(sessionLog, { turn_id: turnId, task: 'Current task', projectRoot: root })
  await persistThreadEventLog(currentRun, threadLog)
  flushSessionEventLogStrict(currentRun, sessionLog)
  const ctx = { turns: [], lastRunDir: otherRun, chatEngine: { getEngineRunId: () => 'current' } } as unknown as ReplContext

  handleWhyStopped(ctx, ['latest'])
  assert.match(messages.join('\n'), /Conversation run: current[\s\S]*Outcome: INTERRUPTED/)
  assert.doesNotMatch(messages.join('\n'), /VERIFIED_COMPLETE|another run/)

  messages.length = 0
  recordTurnEnded(sessionLog, {
    turn_id: turnId, outcome: 'BLOCKED_POLICY', status: 'blocked',
    reason: { code: 'permission_denied', cause_class: 'harness' },
  })
  flushSessionEventLogStrict(currentRun, sessionLog)
  handleWhyStopped(ctx, [])
  assert.match(messages.join('\n'), /BLOCKED_POLICY[\s\S]*permission_denied/)

  messages.length = 0
  handleWhyStopped(ctx, [otherRun])
  assert.match(messages.join('\n'), /Selected run: another run[\s\S]*Outcome: VERIFIED_COMPLETE/)

  messages.length = 0
  ctx.chatEngine = undefined
  handleWhyStopped(ctx, [])
  assert.match(messages.join('\n'), /No recorded run in this conversation/)
  assert.doesNotMatch(messages.join('\n'), /VERIFIED_COMPLETE/)
})

test('/cost shows unresolved charges and labels the accounting scope', (t) => {
  const messages: string[] = []
  t.mock.method(console, 'log', (message: string) => messages.push(message))
  t.mock.method(globalCostTracker, 'getSessionSummary', () => ({
    totalCostUSD: 0, knownCostUSD: 0, completeCostUSD: null, costComplete: false, unknownChargeCount: 8,
    totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
    modelBreakdown: { 'provider/test': { costUSD: 0, inputTokens: 0, outputTokens: 0, unknownChargeCount: 8 } },
  }))

  handleCost({} as ReplContext, [])
  const text = messages.join('\n')
  assert.match(text, /all conversations tracked in this session/)
  assert.match(text, /\$0\.000000 known subtotal \+ 8 unresolved charge\(s\); final cost unknown/)
  assert.doesNotMatch(text, /Total USD/)
})
