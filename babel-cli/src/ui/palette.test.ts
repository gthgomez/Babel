import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandPalette } from './palette.js'

test('scoped selection filters only supplied options and selects the exact ID', () => {
  const palette = new CommandPalette({ rl: { write() { throw new Error('must not inject command') } } } as never, [
    { command: 'account-a', description: 'OpenRouter', group: 'Connections' },
    { command: 'account-b', description: 'CommandCode', group: 'Connections' },
  ]) as unknown as { handleKeyEvent(event: unknown): void; resolve: () => void; choice: string | null; flatFiltered: Array<{ command: string }> }
  palette.resolve = () => {}
  ;(palette as unknown as { renderToScreen(): void }).renderToScreen = () => {}
  for (const ch of 'commandcode') palette.handleKeyEvent({ name: ch, sequence: ch, ctrl: false, meta: false })
  assert.deepEqual(palette.flatFiltered.map(item => item.command), ['account-b'])
  palette.handleKeyEvent({ name: 'enter', sequence: '\r', ctrl: false, meta: false })
  assert.equal(palette.choice, 'account-b')
})

test('scoped palette navigates and cancels without injecting a command', () => {
  const palette = new CommandPalette({ rl: { write() { throw new Error('must not inject') } } } as never, [
    { command: 'vendor/one', description: '', group: 'Models' },
    { command: 'vendor/two', description: '', group: 'Models' },
  ]) as unknown as { handleKeyEvent(event: unknown): void; renderToScreen(): void; resolve: () => void; choice: string | null; selectedIdx: number }
  let settled = false
  palette.resolve = () => { settled = true }; palette.renderToScreen = () => {}
  palette.handleKeyEvent({ name: 'down', sequence: '', ctrl: false, meta: false })
  assert.equal(palette.selectedIdx, 1)
  palette.handleKeyEvent({ name: 'escape', sequence: '\x1b', ctrl: false, meta: false })
  assert.equal(settled, true); assert.equal(palette.choice, null)
})

test('palette cleans up if terminal setup fails', async () => {
  const palette = new CommandPalette({} as never, [{ command: 'a', description: '', group: 'Connections' }]) as unknown as { run(): Promise<void>; onMount(): void; onUnmount(): void }
  let cleaned = false
  palette.onMount = () => { throw new Error('synthetic terminal failure') }
  palette.onUnmount = () => { cleaned = true }
  await assert.rejects(palette.run(), /synthetic terminal failure/)
  assert.equal(cleaned, true)
})
