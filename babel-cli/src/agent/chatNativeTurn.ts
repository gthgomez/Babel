/**
 * Native stream → ChatTurn mapping. A provider stream is only a completion
 * proposal when it carries a valid terminal disposition AND substantive output
 * (non-empty answer text or at least one tool action). Token exhaustion, empty
 * streams, blank answers and refusals/filters are distinct failures — never a
 * fabricated `OK` completion.
 */

import type { ChatToolAction, ChatTurn } from './chatToolDefinitions.js';

/** Provider stopped because the output token budget was exhausted. */
export class ProviderOutputTruncatedError extends Error {
  readonly finishReason = 'length';
  constructor(
    message = 'Output truncated by provider token limit (finish_reason: length)',
  ) {
    super(message);
    this.name = 'ProviderOutputTruncatedError';
  }
}

/**
 * The provider stream carried no usable assistant output: no answer text and no
 * tool action. An empty provider response is not evidence that the task needs
 * no change, so it must fail closed rather than complete with a placeholder.
 */
export class ProviderEmptyResponseError extends Error {
  readonly finishReason: string | undefined;
  constructor(finishReason?: string) {
    super(
      `Provider returned no usable output${finishReason ? ` (finish_reason: ${finishReason})` : ''}. ` +
        'An empty or blank response cannot certify task completion.',
    );
    this.name = 'ProviderEmptyResponseError';
    this.finishReason = finishReason;
  }
}

/**
 * The provider refused the request (safety / content filter), or ended with a
 * disposition the engine does not recognize as a normal stop. Either is an
 * honest terminal state, not an answer.
 */
export class ProviderRefusedResponseError extends Error {
  readonly finishReason: string | undefined;
  constructor(finishReason?: string) {
    super(
      `Provider refused or did not complete the response${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`,
    );
    this.name = 'ProviderRefusedResponseError';
    this.finishReason = finishReason;
  }
}

const REFUSAL_FINISH_REASONS = new Set([
  'content_filter',
  'safety',
  'refusal',
  'blocked',
  'recitation',
  'sensitive',
]);

/** A terminal disposition the engine recognizes as a normal stop. */
const STOP_FINISH_REASONS = new Set(['stop', 'end_turn', 'stop_sequence']);

function isBlankAnswer(answerText: string): boolean {
  return answerText.trim().length === 0;
}

/**
 * Build the native ChatTurn from a completed provider stream.
 *
 * Ordering is deliberate: a truncated `length` finish reason is never a normal
 * completion even when partial text exists. Refusals are reported as refusals.
 * A stream with no text and no actions is an empty response, and a stop with
 * blank text is likewise empty — neither may become a synthetic `OK` answer.
 */
export function nativeTurnFromStream(input: {
  answerText: string;
  actions: ChatToolAction[];
  finishReason?: string | undefined;
}): ChatTurn {
  if (input.finishReason === 'length') {
    throw new ProviderOutputTruncatedError();
  }
  if (input.finishReason !== undefined && REFUSAL_FINISH_REASONS.has(input.finishReason)) {
    throw new ProviderRefusedResponseError(input.finishReason);
  }
  if (input.actions.length > 0) {
    return { type: 'tool_calls', actions: input.actions };
  }
  const finishReason = input.finishReason;
  const stopped = finishReason === undefined || STOP_FINISH_REASONS.has(finishReason);
  if (isBlankAnswer(input.answerText)) {
    // No actions and no usable text is never a completion proposal. A missing
    // or unrecognized finish reason cannot certify an answer either.
    throw stopped
      ? new ProviderEmptyResponseError(finishReason)
      : new ProviderRefusedResponseError(finishReason);
  }
  return { type: 'completion', answer: input.answerText };
}
