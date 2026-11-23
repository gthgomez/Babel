/** A single, exclusive terminal reader for setup. Masked input never reaches readline history. */
import { installKeyHandler } from './keyInput.js'

export type SetupQuestion = (prompt: string, masked?: boolean) => Promise<string | null>

export class SetupCancelled extends Error {}

/** Escape goes back; Ctrl+C, Ctrl+D and EOF close the wizard without closing Babel. */
export function openSetupPrompt(write: (text: string) => void, input: NodeJS.ReadStream = process.stdin): {
  question: SetupQuestion
  signal: AbortSignal
  close: () => void
} {
  const stop = new AbortController()
  let pending: { prompt: string; resolve: (value: string | null) => void; reject: (error: Error) => void; masked: boolean } | undefined
  let value = ''
  let invalid = false
  const cancel = (): void => {
    if (stop.signal.aborted) return
    const error = new SetupCancelled()
    stop.abort(error)
    pending?.reject(error)
    pending = undefined
    value = ''
  }
  const cleanup = installKeyHandler(input, event => {
    if (event.ctrl && (event.name === 'c' || event.name === 'd')) {
      if (pending) write('\n')
      cancel()
      return
    }
    if (!pending) return // Do not carry input from one prompt into the next.
    if (event.name === 'enter' && invalid) {
      value = ''
      invalid = false
      write(`\nUse a single line (up to 4096 characters).\n${pending.prompt}`)
      return
    }
    if (event.name === 'escape' || event.name === 'enter') {
      const answer = event.name === 'escape' ? null : value
      const { resolve } = pending
      pending = undefined
      value = ''
      write('\n')
      resolve(answer)
    } else if (event.name === 'backspace') {
      if (value && !pending.masked) write('\b \b')
      value = value.slice(0, -1)
    } else if (event.ctrl && event.name === 'u') {
      if (!pending.masked) write('\b \b'.repeat(value.length))
      value = ''
      invalid = false
    } else if (!event.ctrl && !event.meta && (event.name === 'paste' || event.sequence.length === 1)) {
      const text = event.sequence
      if (!/^[\x20-\x7e]+$/.test(text) || value.length + text.length > 4096) {
        invalid = true
        return
      }
      value += text
      if (!pending.masked) write(text)
    }
  })
  input.once('end', cancel).once('close', cancel).once('error', cancel)
  if (input.readableEnded || input.destroyed) cancel()
  return {
    question: (prompt, masked = false) => new Promise((resolve, reject) => {
      stop.signal.throwIfAborted()
      value = ''
      invalid = false
      pending = { prompt, resolve, reject, masked }
      write(prompt)
    }),
    signal: stop.signal,
    close: () => {
      input.off('end', cancel).off('close', cancel).off('error', cancel)
      cleanup()
      cancel()
    },
  }
}
