import { PreparedRequestAdmissionError } from '../runners/preparedProviderRequest.js'
import type { ChatEngineStreamingLoopHost, ChatEvent } from './chatEngineContracts.js'

type RecoveryHost = Pick<ChatEngineStreamingLoopHost,
  'recoverPreparedRequestAdmission' | 'isSubmissionCurrent' |
  'emitCancelledIfOperatorAbort' | 'streamFailed'>

/** A local capacity refusal is neither a provider fault nor a tool-protocol retry. */
export async function* recoverStreamingRequestAdmission(
  host: RecoveryHost,
  error: unknown,
  generation: number,
  onStop: () => void,
): AsyncGenerator<ChatEvent, 'recovered' | 'stopped' | 'unhandled', undefined> {
  const info = await host.recoverPreparedRequestAdmission(error, generation)
  if (!host.isSubmissionCurrent(generation)) { onStop(); return 'stopped' }
  if (info) {
    yield { type: 'context_compacted', ...info }
    return 'recovered'
  }
  if (!(error instanceof PreparedRequestAdmissionError) || error.request.admission !== 'over_limit') return 'unhandled'
  const cancelled = host.emitCancelledIfOperatorAbort(error)
  onStop()
  if (cancelled) { yield cancelled; return 'stopped' }
  const request = error.request
  yield host.streamFailed(
    `The complete request still exceeds its ${request.context_limit_tokens}-token context window after bounded recovery ` +
      `(estimated input ${request.accounting.estimated_input_tokens}, output reserve ${request.accounting.reserved_completion_tokens}). ` +
      'Reduce optional context or output reserve before retrying.',
    { code: 'context_preparation_failed', cause_class: 'harness', detail: 'prepared_request_over_limit' },
  )
  return 'stopped'
}
