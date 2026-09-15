/**
 * Native stream → ChatTurn mapping. Token-limit termination stays explicit.
 */

import type { ChatToolAction, ChatTurn } from './chatToolDefinitions.js';

/** Provider stopped because the output token budget was exhausted. */
export class ProviderOutputTruncatedError extends Error {
  readonly finishReason = 'length';
  constructor(
    message = '[deepInfraApi] Output truncated by token limit (finish_reason: length)',
  ) {
    super(message);
    this.name = 'ProviderOutputTruncatedError';
  }
}

/**
 * Build the native ChatTurn from a completed provider stream.
 * A length finish reason is never a normal completion proposal.
 */
export function nativeTurnFromStream(input: {
  answerText: string;
  actions: ChatToolAction[];
  finishReason?: string | undefined;
}): ChatTurn {
  if (input.finishReason === 'length') {
    throw new ProviderOutputTruncatedError();
  }
  return input.actions.length > 0
    ? { type: 'tool_calls', actions: input.actions }
    : { type: 'completion', answer: input.answerText || 'OK' };
}
