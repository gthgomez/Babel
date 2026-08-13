import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { handleDiffReview } from './review.js'

test('the /diff command uses the interactive pager and consumes q before restoring the draft', async () => {
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

  let leakedToComposer = ''
  const draft = 'preserve this draft byte-for-byte: 你好\nsecond line'
  let currentDraft = draft
  const composerListener = (chunk: Buffer) => {
    leakedToComposer += chunk.toString('utf8')
  }
  stdin.on('data', composerListener)

  const rl = {
    pause: () => stdin.off('data', composerListener),
    resume: () => stdin.on('data', composerListener),
    getInputText: () => currentDraft,
    setInputText: (text: string) => {
      currentDraft = text
    },
  }
  const ctx = {
    rl,
    resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
  }

  process.stdout.write = ((chunk: string | Uint8Array) => {
    void chunk
    return true
  }) as typeof process.stdout.write
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })

  try {
    const pending = handleDiffReview(ctx as never)
    await new Promise<void>((resolve) => setImmediate(resolve))
    stdin.write('q')
    await pending
  } finally {
    process.stdout.write = originalWrite
    Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin })
  }

  assert.equal(leakedToComposer, '')
  assert.equal(currentDraft, draft)
})
