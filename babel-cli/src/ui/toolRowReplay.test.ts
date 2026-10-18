import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationalRenderer } from './conversationalRenderer.js'
import { createVirtualCellGrid } from './observe/virtualCellGrid.js'
import { OutputBuffer } from './outputBuffer.js'
import { resetTerminalProbe } from './terminalProbe.js'

/** Join wrapped grid rows for assertions without losing tokens split across lines. */
function normalizedReplayText(rows: string[]): string {
  return rows.join(' ').replace(/\s+/g, ' ').trim()
}

for (const width of [40, 80, 100, 160]) {
  test(`tool cells keep long starts, short summaries and errors separate at ${width} columns`, () => {
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
    const write = process.stdout.write
    Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true })
    OutputBuffer.resetInstance(); resetTerminalProbe()
    let bytes = ''
    process.stdout.write = ((chunk: unknown) => { bytes += String(chunk); return true }) as typeof write
    const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false })
    try {
      renderer.start()
      const a = renderer.onToolCallStart('read_file', 'products/current-app/src/components/LongComponentName.tsx')
      const b = renderer.onToolCallStart('read_range', 'products/current-app/src/界面.tsx')
      renderer.onToolCallComplete(a, '5 lines', undefined, 0)
      renderer.onToolCallComplete(b, 'invalid range', 'start_line out of range', 1)
      renderer.onSummary(); renderer.stop()
      const grid = createVirtualCellGrid(width, 80)
      grid.apply(bytes)
      const rows = grid.snapshot().lines.map(line => line.trim()).filter(Boolean)
      const summary = rows.findIndex(row => /Read 1 file/.test(row))
      assert.ok(summary >= 0, rows.join('\n'))
      assert.match(rows[summary]!, /Read 1 file$/)
      assert.doesNotMatch(rows.join('\n'), /\[Esc\] cancel|\[Ctrl\+C\] stop/)
      assert.match(normalizedReplayText(rows), /start_line out of range/)
    } finally {
      renderer.stop(); process.stdout.write = write
      if (columns) Object.defineProperty(process.stdout, 'columns', columns)
      else Reflect.deleteProperty(process.stdout, 'columns')
      OutputBuffer.resetInstance(); resetTerminalProbe()
    }
  })
}

test('redirected tools retain failed state and contain no terminal controls', () => {
  const write = process.stdout.write
  let bytes = ''
  process.stdout.write = ((chunk: unknown) => { bytes += String(chunk); return true }) as typeof write
  const renderer = new ConversationalRenderer({ isTTY: false, ownsInput: false })
  try {
    renderer.start()
    const a = renderer.onToolCallStart('read_range', 'source.ts')
    renderer.onToolCallComplete(a, 'error', 'start_line out of range', 1)
    renderer.onSummary(); renderer.stop()
    assert.match(bytes, /fail(?:ed|ure).*start_line out of range/i)
    assert.doesNotMatch(bytes, /\x1b|\r/)
  } finally { renderer.stop(); process.stdout.write = write }
})


test('single short summary never inherits the previous filename cells', () => {
  const write = process.stdout.write
  let bytes = ''
  process.stdout.write = ((chunk: unknown) => { bytes += String(chunk); return true }) as typeof write
  const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false })
  try {
    renderer.start()
    const id = renderer.onToolCallStart('read_file', 'products/current-app/src/components/LongComponentName.tsx')
    renderer.onToolCallComplete(id, '5 lines', undefined, 0)
    renderer.onSummary(); renderer.stop()
    const grid = createVirtualCellGrid(100, 30); grid.apply(bytes)
    assert.match(grid.snapshot().lines.find(line => line.includes('Read 1 file'))!.trim(), /Read 1 file$/)
  } finally { renderer.stop(); process.stdout.write = write }
})
