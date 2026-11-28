import type { ChatEngineStreamingLoopHost, ChatEvent } from './chatEngine.js'
import { chatActionTarget, chatActionToolName, type ChatToolAction } from './chatToolDefinitions.js'

type DecisionRequest = Extract<ChatToolAction, { type: 'request_user_decision' }>

export function findDecisionRequest(actions: readonly ChatToolAction[]): DecisionRequest | undefined {
  return actions.find((action): action is DecisionRequest => action.type === 'request_user_decision')
}

/** Match a complete choice from the structured controller record. */
export function matchesDecisionChoice(options: readonly string[], reply: string): boolean {
  const choice = reply.trim()
  const exact = options.filter(option => option === choice).length
  return exact > 0 ? exact === 1 : options.filter(option => option.toLowerCase() === choice.toLowerCase()).length === 1
}

/** Do not carry the old authority when the decision text introduces a limit. */
export function decisionHasExecutionLimits(text: string, kind: 'choice' | 'context'): boolean {
  const denial = /\b(?:do\s+not|don['’]t|must\s+not|never|without|read[ -]?only|dry[ -]?run|no\s+(?:edits?|writes?|changes?|file\s+changes|commands?|tests?|execution|output)|skip\s+(?:(?:all|the)\s+)?tests?)\b/i
  const inspection = /\b(?:inspect|read|review|audit|explain|describe|summarize|observe|show|report)\b(?:[ \t]+[\w'-]+){0,4}[ \t]+only\b|\b(?:only|just|merely)\s+(?:inspect|read|review|audit|explain|describe|summarize|observe|show|report)\b/i
  const restrictedClause = /(?:^|[.!?,:;()\n–—-]|\b(?:or|rather|then|and|to)\s+)\s*(?:please\s+)?(?:inspect|read|review|audit|explain|describe|summarize|observe|show|report|stop|abort|cancel)\b/i
  const opaqueChoice = /^(?:(?:please\s+)?(?:(?:use|choose|select|take)\s+|go\s+with\s+)?(?:the\s+)?(?:option|choice|alternative|plan)\s+)?[^ ]+$/i
  const choiceText = text.match(/[\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*/gu)?.join(' ')
  return denial.test(text) || inspection.test(text) || restrictedClause.test(text.trim()) ||
    (kind === 'choice' && (!choiceText || opaqueChoice.test(choiceText)))
}

/** Convert a structured decision action batch into a blocked terminal payload. */
export function buildDecisionRequestDeferral(input: {
  request: DecisionRequest
  actions: readonly ChatToolAction[]
  callIds: readonly string[]
  turn: number
}): { answer: string; outcomes: Array<{ entry: ChatEngineStreamingLoopHost['toolCallLog'][number]; event: ChatEvent }> } {
  const { request, actions, callIds, turn } = input
  const answer = [
    `I need your decision before proceeding: ${request.question}`,
    '',
    'Options:',
    ...request.options.map(option => `- ${option}`),
    '',
    `Why it matters: ${request.impact}`,
    'No actions in this turn were started. Earlier changes, if any, remain unverified.',
  ].join('\n')
  const outcomes = actions.map((action, index) => {
    const toolCallId = callIds[index] ?? `decision_${turn}_${index}`
    const tool = chatActionToolName(action)
    const target = chatActionTarget(action)
    const isDecision = action.type === 'request_user_decision'
    const entry: ChatEngineStreamingLoopHost['toolCallLog'][number] = {
      toolCallId, tool, target, index,
      error: isDecision ? 'decision_requested' : 'decision_required',
      exit_code: isDecision ? 0 : 1,
      effect_status: 'not_applicable',
      detail: isDecision
        ? 'Controller paused for the requested user decision.'
        : 'Co-emitted action was not dispatched because a user decision is required.',
    }
    const event: ChatEvent = isDecision
      ? { type: 'tool_complete', toolCallId, tool, target,
          detail: 'Waiting for the user decision; no action was dispatched.', effect_status: 'not_applicable' }
      : { type: 'tool_failed', toolCallId, tool, target,
          error: 'decision_required', detail: 'Not dispatched; the turn is paused for a user decision.',
          exitCode: 1, effect_status: 'not_applicable' }
    return { entry, event }
  })
  return { answer, outcomes }
}

/** Emit only outcomes owned by the current submission, checking after every yield. */
export function* streamDecisionRequestOutcomes(input: {
  outcomes: ReturnType<typeof buildDecisionRequestDeferral>['outcomes']
  isSubmissionCurrent: () => boolean
  recordCall: (entry: ChatEngineStreamingLoopHost['toolCallLog'][number]) => void
}): Generator<ChatEvent> {
  for (const outcome of input.outcomes) {
    if (!input.isSubmissionCurrent()) return
    input.recordCall(outcome.entry)
    yield outcome.event
    if (!input.isSubmissionCurrent()) return
  }
}
