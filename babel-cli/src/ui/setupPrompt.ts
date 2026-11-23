/** A single, exclusive terminal reader for setup. Masked input never reaches readline history. */
import { installKeyHandler } from './keyInput.js'

export type SetupQuestion = (prompt: string, masked?: boolean) => Promise<string | null>

export class SetupCancelled extends Error {}

const unframedSettleMs = 60

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
  let framed = false
  let quiet = false
  let settling: { answer: string | null; extra: boolean; timer?: ReturnType<typeof setTimeout> } | undefined
  const stopSettling = (): void => {
    clearTimeout(settling?.timer)
    settling = undefined
  }
  const cancel = (): void => {
    if (stop.signal.aborted) return
    const error = new SetupCancelled()
    stop.abort(error)
    stopSettling()
    pending?.reject(error)
    pending = undefined
    value = ''
  }
  const finish = (answer: string | null): void => {
    const resolve = pending?.resolve
    pending = undefined
    value = ''
    write('\n')
    resolve?.(answer)
  }
  const waitForPasteTail = (): void => {
    const current = settling!
    clearTimeout(current.timer)
    current.timer = setTimeout(() => {
      settling = undefined
      if (current.extra && current.answer !== null) {
        value = ''
        invalid = false
        framed = false
        write(`\nPaste a single line, then press Enter separately.\n${pending?.prompt ?? ''}`)
      } else finish(current.answer)
    }, unframedSettleMs)
  }
  const cleanup = installKeyHandler(input, event => {
    if (event.ctrl && (event.name === 'c' || event.name === 'd')) {
      if (pending) write('\n')
      cancel()
      return
    }
    if (!pending) return // Do not carry input from one prompt into the next.
    if (settling) {
      settling.extra = true
      waitForPasteTail()
      return
    }
    if (event.name === 'enter' && invalid) {
      value = ''
      invalid = false
      framed = false
      write(`\nUse a single line (up to 4096 characters).\n${pending.prompt}`)
      return
    }
    if (event.name === 'escape' || event.name === 'enter') {
      const answer = event.name === 'escape' ? null : value
      if (pending.masked && (!framed || answer === null)) {
        // Without terminal framing an Enter may be a newline inside a paste.
        // Quarantine queued bytes, and never echo an arbitrarily delayed tail
        // in later setup prompts. Prompts and visible choices still render.
        quiet = true
        settling = { answer, extra: false }
        waitForPasteTail()
      } else finish(answer)
    } else if (event.name === 'backspace') {
      if (value && !pending.masked && !quiet) write('\b \b')
      value = value.slice(0, -1)
    } else if (event.ctrl && event.name === 'u') {
      if (!pending.masked && !quiet) write('\b \b'.repeat(value.length))
      value = ''
      invalid = false
      framed = false
    } else if (!event.ctrl && !event.meta && (event.name === 'paste' || event.sequence.length === 1)) {
      const text = event.sequence
      if (!/^[\x20-\x7e]+$/.test(text) || value.length + text.length > 4096) {
        invalid = true
        return
      }
      framed = event.bracketedPaste === true && value === ''
      value += text
      if (!pending.masked && !quiet) write(text)
    }
  }, undefined, write)
  input.once('end', cancel).once('close', cancel).once('error', cancel)
  if (input.readableEnded || input.destroyed) cancel()
  return {
    question: (prompt, masked = false) => new Promise((resolve, reject) => {
      stop.signal.throwIfAborted()
      value = ''
      invalid = false
      framed = false
      pending = { prompt, resolve, reject, masked }
      write(prompt)
    }),
    signal: stop.signal,
    close: () => {
      input.off('end', cancel).off('close', cancel).off('error', cancel)
      cleanup()
      input.pause() // Standalone setup has no other stdin owner to keep alive.
      cancel()
    },
  }
}
