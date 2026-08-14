/**
 * providerMessages.ts — shared ProviderMessage wire mapping + protocol validation (P0-B).
 *
 * Native tool-capable runners must send protocol-faithful role arrays
 * (system / user / assistant+tool_calls / tool+tool_call_id), never Markdown
 * pseudo-history flattened into a single user message.
 */

import type { ProviderMessage, ProviderToolCall } from './base.js';

/** OpenAI-compatible wire message shape used by DeepSeek / DeepInfra. */
export type WireProviderMessage = {
  role: string;
  content: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
};

export interface ProviderProtocolIssue {
  code:
    | 'tool_missing_call_id'
    | 'orphan_tool_result'
    | 'system_in_user_content'
    | 'empty_messages'
    | 'assistant_tool_call_missing_id';
  message: string;
  index?: number;
}

/**
 * Map ProviderMessage[] to the OpenAI-compatible wire format.
 * - Emits one provider-compatible system message without discarding durable
 *   system context (notably a committed compaction capsule)
 * - Preserves assistant tool_calls and tool tool_call_id
 */
export function mapProviderMessagesToWire(
  messages: ProviderMessage[],
  defaultSystemPrompt: string,
  systemPromptOverride?: string,
): WireProviderMessage[] {
  const result: WireProviderMessage[] = [];

  const systemMessages = messages.filter((message) => message.role === 'system');
  const firstSystem = systemMessages[0];
  const primarySystem = systemPromptOverride ?? firstSystem?.content ?? defaultSystemPrompt;
  // An override normally replaces the first reconstructed system prompt. Keep
  // every other durable system record, including compaction capsules, in the
  // sole system message required by these provider APIs.
  const extraSystemMessages = systemPromptOverride && firstSystem?.content === systemPromptOverride
    ? systemMessages.slice(1)
    : systemPromptOverride
      ? systemMessages
      : systemMessages.slice(1);
  result.push({
    role: 'system',
    content: [primarySystem, ...extraSystemMessages.map((message) => message.content)].join('\n\n'),
  });

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const wire: WireProviderMessage = { role: msg.role, content: msg.content };
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      wire.tool_calls = msg.tool_calls;
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      wire.tool_call_id = msg.tool_call_id;
    }
    if (msg.name) {
      wire.name = msg.name;
    }
    result.push(wire);
  }

  return result;
}

/**
 * Validate protocol fidelity of a ProviderMessage[] (pre-wire).
 * Does not mutate; returns issue list (empty = OK).
 */
export function validateProviderMessageProtocol(
  messages: ProviderMessage[],
): ProviderProtocolIssue[] {
  const issues: ProviderProtocolIssue[] = [];
  if (messages.length === 0) {
    issues.push({ code: 'empty_messages', message: 'Provider message array is empty' });
    return issues;
  }

  const knownCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'user' && looksLikeSystemInUserProse(msg.content)) {
      issues.push({
        code: 'system_in_user_content',
        message: 'User message appears to embed system/history Markdown (flattened protocol)',
        index: i,
      });
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!tc.id) {
          issues.push({
            code: 'assistant_tool_call_missing_id',
            message: 'Assistant tool_call missing id',
            index: i,
          });
        } else {
          knownCallIds.add(tc.id);
        }
      }
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        issues.push({
          code: 'tool_missing_call_id',
          message: 'Tool message missing tool_call_id',
          index: i,
        });
      } else if (!knownCallIds.has(msg.tool_call_id)) {
        issues.push({
          code: 'orphan_tool_result',
          message: `Tool result tool_call_id=${msg.tool_call_id} has no preceding assistant tool_call`,
          index: i,
        });
      }
    }
  }

  return issues;
}

/** Heuristic: Markdown conversation dump inside a user message (legacy flatten). */
function looksLikeSystemInUserProse(content: string): boolean {
  return (
    /^##\s*Conversation History/m.test(content) ||
    /^###\s*(system|assistant|user|tool)\b/m.test(content) ||
    (content.includes('## Current Request') && content.includes('## Conversation History'))
  );
}

/**
 * Count approximate retransmitted "history as prose" markers.
 * Used in tests to prove structured path avoids Markdown flatten.
 */
export function countMarkdownHistoryMarkers(messages: ProviderMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (/^##\s*Conversation History/m.test(m.content)) n += 1;
    if (/^###\s*(system|assistant|user)\b/m.test(m.content)) n += 1;
  }
  return n;
}

/**
 * Ensure the task appears once as a user message (P0-B: send user turn once).
 * Mutates `conversation` only when no matching user message exists.
 */
export function ensureProviderUserTask(
  conversation: ProviderMessage[],
  task: string,
): void {
  if (!task) return;
  const has = conversation.some((m) => m.role === 'user' && m.content === task);
  if (!has) {
    conversation.push({ role: 'user', content: task });
  }
}
