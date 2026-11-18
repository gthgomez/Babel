/**
 * Deterministic compaction summary for dropped conversation turns.
 *
 * Two compaction mechanisms need the same retention rule: the inline ChatEngine
 * heuristic and the strategy fallback in chatCompaction. A user turn carries
 * task constraints and must never be reduced to a fixed 120-character excerpt.
 */

import type { ChatMessage } from './chatToolDefinitions.js';

/**
 * Per-user-turn retention budget for the compaction summary.
 *
 * A user turn carries the task constraints; it is not interchangeable with tool
 * noise. Keep the full turn while it fits, and use an explicit head+tail window
 * (never a silent cut) for pathological turns.
 */
const COMPACTED_USER_TURN_LIMIT = 12_000;
const COMPACTED_USER_TURN_HEAD = 9_000;
const COMPACTED_TOOL_FACT_LIMIT = 24;

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
 * Lightweight text summary of dropped conversation turns (no LLM).
 *
 * Every dropped user turn is retained. Tool first lines are bounded helpers, so
 * they can never crowd out an earlier user constraint (the previous eight-fact
 * cap did exactly that).
 */
export function summarizeDroppedTurns(dropped: ChatMessage[]): string {
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
    if (toolCandidates.length === 0) {
      return `[${dropped.length} earlier messages compacted for length]`;
    }
    return `[Compacted ${dropped.length} messages. Key context:\n${toolCandidates.join('\n')}]`;
  }
  // Tool first lines are secondary: include them only with space left after the
  // user constraints, so a summary never becomes larger than the text it
  // replaces (which would break request-admission recovery).
  const droppedChars = dropped.reduce((sum, message) => sum + message.content.length, 0);
  const userText = userFacts.join('\n');
  let toolBudget = Math.max(0, droppedChars - userText.length - 200);
  const selectedTools: string[] = [];
  for (const candidate of toolCandidates) {
    if (candidate.length + 1 > toolBudget) continue;
    selectedTools.push(candidate);
    toolBudget -= candidate.length + 1;
  }
  return `[Compacted ${dropped.length} messages. User constraints and key context:\n${[userText, ...selectedTools].join('\n')}]`;
}
