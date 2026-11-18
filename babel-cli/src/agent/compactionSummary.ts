/**
 * Deterministic compaction summary for dropped conversation turns.
 *
 * Scope: this helper is used by the inline ChatEngine heuristic compaction
 * (`compactHeuristicConversation`). The strategy fallback in chatCompaction
 * (`HeuristicTruncationStrategy`) does not call it and still drops the oldest
 * rows without a summary; its durable capsule retains the original task.
 *
 * A dropped user turn carries task constraints and must never be reduced to a
 * fixed excerpt or silently discarded. Tool first lines are secondary.
 */

import type { ChatMessage } from './chatToolDefinitions.js';

export interface DroppedTurnSummaryOptions {
  /**
   * Upper bound for the returned summary. When user constraints do not fit,
   * the summary keeps an explicit head+tail marker instead of dropping them.
   */
  maxChars?: number;
}

/**
 * Per-user-turn retention budget for the compaction summary.
 *
 * Keep the full turn while it fits, and use an explicit head+tail window
 * (never a silent cut) for pathological turns.
 */
const COMPACTED_USER_TURN_LIMIT = 12_000;
const COMPACTED_USER_TURN_HEAD = 9_000;
const COMPACTED_TOOL_FACT_LIMIT = 24;
const MIN_COMPACTED_BODY = 96;

/** Preserve a whole user constraint turn, or both ends with a visible marker. */
function formatCompactedUserTurn(content: string): string {
  const normalized = content;
  if (normalized.length <= COMPACTED_USER_TURN_LIMIT) return normalized;
  const head = normalized.slice(0, COMPACTED_USER_TURN_HEAD);
  const tail = normalized.slice(normalized.length - (COMPACTED_USER_TURN_LIMIT - COMPACTED_USER_TURN_HEAD));
  const omitted = normalized.length - head.length - tail.length;
  return `${head}\n…[truncated ${omitted} chars from the middle of this user turn; both ends are retained]…\n${tail}`;
}

/**
 * Head+tail representation of the dropped user constraints. The marker is
 * always emitted when text is omitted, so a caller can never mistake a reduced
 * summary for the complete user request.
 */
function compactUserConstraints(userText: string, bodyBudget: number): string {
  const available = Math.max(MIN_COMPACTED_BODY, bodyBudget);
  const markerReserve = 140;
  const headTailBudget = Math.max(24, available - markerReserve);
  const headLength = Math.ceil(headTailBudget * 0.65);
  const tailLength = Math.max(0, headTailBudget - headLength);
  const head = userText.slice(0, headLength);
  const tail = tailLength > 0 ? userText.slice(-tailLength) : '';
  const omitted = Math.max(0, userText.length - head.length - tail.length);
  const marker = `…[compaction budget retained ${head.length + tail.length} of ${userText.length} chars of dropped user constraints; ${omitted} chars omitted; head and tail are shown]…`;
  return tail.length > 0 ? `${head}\n${marker}\n${tail}` : `${head}\n${marker}`;
}

/**
 * Lightweight text summary of dropped conversation turns (no LLM).
 *
 * Every dropped user turn is represented. Tool first lines are bounded helpers
 * and are removed first when `maxChars` is tight; user constraints are reduced
 * only with an explicit head+tail marker, never to nothing.
 */
export function summarizeDroppedTurns(
  dropped: ChatMessage[],
  options: DroppedTurnSummaryOptions = {},
): string {
  const userFacts: string[] = [];
  const toolCandidates: string[] = [];
  for (const m of dropped) {
    if (m.role === 'tool' && m.content) {
      const firstLine = m.content.split('\n')[0]?.trim();
      if (firstLine && firstLine.length > 10 && firstLine.length < 200 && toolCandidates.length < COMPACTED_TOOL_FACT_LIMIT) {
        toolCandidates.push(`- ${firstLine}`);
      }
    } else if (m.role === 'user' && m.content) {
      userFacts.push(`- ${formatCompactedUserTurn(m.content)}`);
    }
  }

  if (userFacts.length === 0) {
    const body = toolCandidates.join('\n');
    const unit = body.length > 0
      ? `[Compacted ${dropped.length} messages. Key context:\n${body}]`
      : `[${dropped.length} earlier messages compacted for length]`;
    if (options.maxChars === undefined || unit.length <= options.maxChars) return unit;
    return `[${dropped.length} earlier messages compacted for length; tool detail omitted by compaction budget]`;
  }

  const prefix = `[Compacted ${dropped.length} messages. User constraints and key context:\n`;
  const suffix = ']';
  const userText = userFacts.join('\n');
  const budget = options.maxChars;

  if (budget === undefined) {
    // No explicit bound: keep all user constraints and add tool facts only when
    // they do not make the summary larger than the text it replaces.
    const droppedChars = dropped.reduce((sum, message) => sum + message.content.length, 0);
    let toolBudget = Math.max(0, droppedChars - userText.length - 200);
    const selectedTools: string[] = [];
    for (const candidate of toolCandidates) {
      if (candidate.length + 1 > toolBudget) continue;
      selectedTools.push(candidate);
      toolBudget -= candidate.length + 1;
    }
    return `${prefix}${[userText, ...selectedTools].join('\n')}${suffix}`;
  }

  const bodyBudget = Math.max(0, budget - prefix.length - suffix.length);
  if (userText.length <= bodyBudget) {
    let remaining = bodyBudget - userText.length;
    const selectedTools: string[] = [];
    for (const candidate of toolCandidates) {
      if (candidate.length + 1 > remaining) continue;
      selectedTools.push(candidate);
      remaining -= candidate.length + 1;
    }
    return `${prefix}${[userText, ...selectedTools].join('\n')}${suffix}`;
  }

  return `${prefix}${compactUserConstraints(userText, bodyBudget)}${suffix}`;
}
