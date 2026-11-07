import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatEngine } from '../../agent/chatEngine.js'
import { handleWorkflow } from './workflow.js'
import type { ReplContext } from '../context.js'

test('workflow stop reaches its engine and retains the interface until settlement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workflow-stop-'))
  const definition = join(root, 'workflow.json')
  writeFileSync(definition, JSON.stringify({ id: 'fixture', nodes: [{ id: 'A', task: 'inspect' }] }))
  let started!: () => void; let release!: () => void; let cancelled = 0
  const active = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  t.mock.method(ChatEngine.prototype, 'submitMessage', async () => {
    started(); await pending
    return { status: 'cancelled', answer: '', usage: undefined, conversation: [] } as never
  })
  t.mock.method(ChatEngine.prototype, 'cancel', () => { cancelled++ })
  const ctx = { state: { model: 'deepseek-v4-flash-openrouter' }, isRunning: false,
    rl: { pause() {}, resume() {} }, resolveCurrentTarget: () => ({ targetRoot: root }) } as unknown as ReplContext
  const running = handleWorkflow(ctx, [definition])
  try {
    await active
    assert.equal(typeof ctx.cancelActiveRun, 'function')
    ctx.cancelActiveRun?.()
    assert.equal(cancelled, 1)
    assert.equal(ctx.isRunning, true)
  } finally { release(); await running; rmSync(root, { recursive: true, force: true }) }
  assert.equal(ctx.isRunning, false)
  assert.equal(ctx.cancelActiveRun, undefined)
})

test('workflow does not replace an active run owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workflow-busy-'))
  const definition = join(root, 'workflow.json')
  writeFileSync(definition, JSON.stringify({ id: 'fixture', nodes: [{ id: 'A', task: 'inspect' }] }))
  let calls = 0
  t.mock.method(ChatEngine.prototype, 'submitMessage', async () => { calls++; return { status: 'cancelled', answer: '', usage: undefined, conversation: [] } as never })
  const cancel = () => {}
  const ctx = { state: { model: 'deepseek-v4-flash-openrouter' }, isRunning: true, cancelActiveRun: cancel,
    rl: { pause() {}, resume() {} }, resolveCurrentTarget: () => ({ targetRoot: root }) } as unknown as ReplContext
  try {
    await handleWorkflow(ctx, [definition])
    assert.equal(calls, 0); assert.equal(ctx.isRunning, true); assert.equal(ctx.cancelActiveRun, cancel)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
