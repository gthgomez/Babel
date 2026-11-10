import { SpanStatusCode, type Span } from '@opentelemetry/api'
import type { TaskOperation } from '../config/chatTaskClass.js'
import type { ChatEvent } from './chatEngineContracts.js'
import type { ChatEngineStreamingLoopHost } from './chatEngineContracts.js'
import { endSpan } from '../telemetry/tracing.js'
import { availableChatToolNames } from './chatToolAvailability.js'
import { recordChatHarnessFeedback } from './chatHarnessFeedback.js'
import { buildTextToolProtocolRejectMessage, TEXT_TOOL_NAMES } from './textToolParser.js'

type ProtocolHost = Pick<ChatEngineStreamingLoopHost,
  'conversation' | 'engineRunDir' | 'getResolvedRequiredVerifiers' |
  'isolationBrokerFlags' | 'isSubmissionCurrent' | 'options' | 'parity' | 'streamFailed'>

export function buildScopedTextProtocolRejectMessage(
  host: ProtocolHost, operation: TaskOperation | undefined, isReadOnlyInspection: boolean, rejection?: string,
): string {
  const verifiers = isReadOnlyInspection ? host.getResolvedRequiredVerifiers() : []
  return buildTextToolProtocolRejectMessage(
    availableChatToolNames([...TEXT_TOOL_NAMES], {
      executionScope: host.options.executionScope, operation, requiredVerifiers: verifiers,
      hostFallbackAllowed: host.isolationBrokerFlags().hostFallbackAllowed,
    }), verifiers, rejection,
  )
}

/** Retry one malformed text decision request, then fail closed without dispatch. */
export async function* handleMalformedDecisionProtocol(input: {
  host: ProtocolHost
  generation: number
  turnSpan: Span | null
  alreadyRetried: boolean
  operation: TaskOperation | undefined
  isReadOnlyInspection: boolean
}): AsyncGenerator<ChatEvent, 'retry' | 'stopped', undefined> {
  const { host, generation, turnSpan, alreadyRetried, operation, isReadOnlyInspection } = input
  if (!host.isSubmissionCurrent(generation)) {
    endSpan(turnSpan, SpanStatusCode.ERROR)
    return 'stopped'
  }
  if (alreadyRetried) {
    endSpan(turnSpan, SpanStatusCode.ERROR)
    yield host.streamFailed('Malformed decision request; no actions from that response were dispatched.', {
      code: 'native_tool_protocol_invalid', cause_class: 'model', detail: 'malformed_decision_request',
    })
    return 'stopped'
  }
  const protocolAnswer = 'Malformed decision request; no actions from that response were dispatched.'
  host.conversation.push({ role: 'assistant', content: protocolAnswer })
  recordChatHarnessFeedback(host, buildScopedTextProtocolRejectMessage(
    host, operation, isReadOnlyInspection,
    '`request_user_decision` needs a question, impact, and 2–6 concrete options. No action from the malformed response was dispatched. Reissue a valid decision request if the choice still blocks the task.',
  ))
  endSpan(turnSpan, SpanStatusCode.OK)
  yield { type: 'thought', text: '[Text tool protocol: malformed decision request]' }
  return host.isSubmissionCurrent(generation) ? 'retry' : 'stopped'
}
