import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplContext } from '../context.js'
import { handleModel } from './config.js'

test('legacy model explanation stays in the hosted shell and retains linear output', () => {
  const notices: string[] = []
  const raw: string[] = []
  const original = console.log
  const ctx = { state: { mode: 'chat' }, shellRuntime: { appendNotice: (text: string) => notices.push(text) } } as unknown as ReplContext
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
  try {
    handleModel(ctx, ['why'])
    assert.equal(raw.length, 0)
    assert.ok(notices.length > 0)
    delete ctx.shellRuntime
    handleModel(ctx, ['why'])
    assert.ok(raw.length > 0)
  } finally { console.log = original }
})
