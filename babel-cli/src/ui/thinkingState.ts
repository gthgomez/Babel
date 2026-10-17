import { FrameScheduler } from './frameScheduler.js'
import { canUseCursorRewrite } from './cursorRewritePolicy.js'
import { stripAnsi, truncate, visibleLength } from './theme.js'

export type ThinkingExitReason = 'stream' | 'tool' | 'end'

export interface LeaveThinkingInput {
  state: string
  reason: ThinkingExitReason
  isTTY: boolean
  overlayLines: number
  write: (text: string) => boolean
  transition: (state: 'streaming' | 'failed') => void
  unregisterTick: (() => void) | null
}

export interface LeaveThinkingResult {
  state: string
  overlayLines: number
  unregisterTick: null
}

export interface ThinkingHudComposeInput {
  indicatorLine: string
  overlayLines: readonly string[]
  columns: number
  previousOverlayLines: number
}

export interface ThinkingHudComposeResult {
  output: string
  showingOverlayLines: number
}

/**
 * Compose the thinking HUD write.
 *
 * Capable terminals keep a multi-line overlay and cursor-up to the thinking
 * row. ConPTY append-only mode collapses everything onto one ephemeral line
 * so CUU cannot accumulate blank rows.
 */
export function composeThinkingHud(input: ThinkingHudComposeInput): ThinkingHudComposeResult {
  const width = Math.max(8, input.columns - 1)
  const fit = (line: string): string => {
    if (visibleLength(line) <= width) return line
    const hint = ' · Ctrl+C cancel'
    if (line.includes('Ctrl+C cancel') && width >= 28) {
      return truncate(line.replace(/\s*·?\s*Ctrl\+C cancel\)?/, ''), width - hint.length) + hint
    }
    return truncate(line, width)
  }
  if (!canUseCursorRewrite()) {
    const compact = input.overlayLines
      .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ')
    const combined = compact ? `${input.indicatorLine}  ${compact}` : input.indicatorLine
    const fitted = fit(combined)
    return { output: `\r\x1b[K${fitted}`, showingOverlayLines: 0 }
  }

  let output = `\r\x1b[K${fit(input.indicatorLine)}`
  if (input.overlayLines.length > 0) {
    for (const line of input.overlayLines) {
      const fitted = truncate(stripAnsi(line), Math.max(1, input.columns - 2))
      output += `\n${fitted}\x1b[K`
    }
    output += `\x1b[${input.overlayLines.length}A`
    return { output, showingOverlayLines: input.overlayLines.length }
  }
  if (input.previousOverlayLines > 0) {
    for (let i = 0; i < input.previousOverlayLines; i++) {
      output += '\n\x1b[K'
    }
    output += `\x1b[${input.previousOverlayLines}A`
  }
  return { output, showingOverlayLines: 0 }
}

/** Clear the thinking HUD and stop its scheduler before the next renderer state. */
export function leaveThinking(input: LeaveThinkingInput): LeaveThinkingResult {
  const nextState: 'streaming' | 'failed' = input.reason === 'end' ? 'failed' : 'streaming'
  if (input.state !== 'thinking') {
    return { state: input.state, overlayLines: input.overlayLines, unregisterTick: null }
  }

  input.transition(nextState)
  if (input.isTTY) {
    input.write('\r\x1b[K')
    if (canUseCursorRewrite() && input.overlayLines > 0) {
      for (let i = 0; i < input.overlayLines; i++) input.write('\n\x1b[K')
      input.write(`\x1b[${input.overlayLines}A`)
    }
  }

  FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false)
  input.unregisterTick?.()
  return { state: nextState, overlayLines: 0, unregisterTick: null }
}
