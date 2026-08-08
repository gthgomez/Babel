import { FrameScheduler } from './frameScheduler.js'

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

/** Clear the thinking HUD and stop its scheduler before the next renderer state. */
export function leaveThinking(input: LeaveThinkingInput): LeaveThinkingResult {
  const nextState: 'streaming' | 'failed' = input.reason === 'end' ? 'failed' : 'streaming'
  if (input.state !== 'thinking') {
    return { state: input.state, overlayLines: input.overlayLines, unregisterTick: null }
  }

  input.transition(nextState)
  if (input.isTTY) {
    input.write('\r\x1b[K')
    for (let i = 0; i < input.overlayLines; i++) input.write('\n\x1b[K')
    if (input.overlayLines > 0) input.write(`\x1b[${input.overlayLines}A`)
  }

  FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false)
  input.unregisterTick?.()
  return { state: nextState, overlayLines: 0, unregisterTick: null }
}
