/**
 * Turn-completion invariants for the conversational coding loop.
 *
 * Continuation requires positive evidence that more model work is needed
 * (a tool/action request this iteration, or unresolved honesty work after
 * mutations). A plain assistant completion is a finished turn — including
 * greetings, clarifications, refusals, and execute-intent replies that
 * chose not to use tools.
 *
 * "No tool call" must not mean "continue autonomously."
 */

export type TextOnlyTurnDecision =
  | { kind: 'complete'; reason: 'text_only_no_progress' }
  | { kind: 'evaluate_further'; reason: 'has_writes' | 'had_tools' };

export const NO_PROGRESS_STOP_THRESHOLD = 2;

export function decideTextOnlyTurnCompletion(input: {
  hadToolCallsThisIteration: boolean;
  hasAnyWrites: boolean;
}): TextOnlyTurnDecision {
  if (input.hadToolCallsThisIteration) {
    return { kind: 'evaluate_further', reason: 'had_tools' };
  }
  if (input.hasAnyWrites) {
    return { kind: 'evaluate_further', reason: 'has_writes' };
  }
  return { kind: 'complete', reason: 'text_only_no_progress' };
}

/**
 * After streaming deltas, the engine must not re-yield the full assembled
 * answer as another answer_chunk. Return only the unsent suffix, or null
 * when the TUI already has the complete text.
 */
export function remainingAnswerChunk(alreadyStreamed: string, finalAnswer: string): string | null {
  if (!finalAnswer) return null;
  if (!alreadyStreamed) return finalAnswer;
  if (finalAnswer === alreadyStreamed) return null;
  if (finalAnswer.startsWith(alreadyStreamed)) {
    const suffix = finalAnswer.slice(alreadyStreamed.length);
    return suffix.length > 0 ? suffix : null;
  }
  // Provider replaced rather than appended — replaying the whole answer
  // duplicates committed TTY cells. Drop the replay.
  return null;
}

export function isRepeatedNoProgressLoop(input: {
  consecutiveTextOnlyIterations: number;
  consecutiveIdenticalAnswers?: number;
  threshold?: number;
}): boolean {
  const t = input.threshold ?? NO_PROGRESS_STOP_THRESHOLD;
  if (input.consecutiveTextOnlyIterations >= t) return true;
  if ((input.consecutiveIdenticalAnswers ?? 0) >= t) return true;
  return false;
}

export function buildNoProgressStopMessage(iterations: number): string {
  const n = Math.max(1, iterations);
  return `Agent made no observable progress across ${n} iterations.`;
}
