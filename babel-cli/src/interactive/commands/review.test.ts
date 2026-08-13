import assert from 'node:assert/strict'
import * as readline from 'node:readline'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { handleDiffReview } from './review.js'
test('the production /diff path isolates a real readline interface from pager input', async () => {
  const originalStdin = process.stdin
  const originalWrite = process.stdout.write.bind(process.stdout)
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (mode: boolean) => void
  }
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (mode: boolean) => {
    stdin.isRaw = mode
  }
  const output = new PassThrough()
  Object.assign(output, { isTTY: true, columns: 80, rows: 24 })
  const rl = readline.createInterface({ input: stdin, output, terminal: true })
  const draft = 'real readline draft: 你好'
  rl.write(draft)


  const ctx = {
    rl,
    resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
  }

  process.stdout.write = ((chunk: string | Uint8Array) => {
    void chunk
    return true
  }) as typeof process.stdout.write
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })

  let lineAfterPager = ''
  try {
    const pending = handleDiffReview(ctx as never)
    await new Promise<void>((resolve) => setImmediate(resolve))
    stdin.write('j')
    stdin.write('q')
    await pending
    lineAfterPager = rl.line
  } finally {
    rl.close()
    output.destroy()
    process.stdout.write = originalWrite
    Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin })
  }

  assert.equal(lineAfterPager, draft, 'pager bytes must not enter readline internal line state')
  assert.equal(stdin.read(), null, 'pager bytes must not remain buffered for readline')
  assert.equal(rl.line, draft, 'the exact prior readline draft must be restored')
})
