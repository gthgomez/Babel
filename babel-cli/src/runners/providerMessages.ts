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
    | 'assistant_tool_call_missing_id'
    | 'duplicate_tool_result'
    | 'unanswered_tool_call';
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

/** Minimal read-only shape the protocol validator needs (wire or neutral). */
export interface ProtocolCheckableMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ProviderToolCall[];
  readonly name?: string;
}

/**
 * Validate protocol fidelity of a ProviderMessage[] (pre-wire).
 * Does not mutate; returns issue list (empty = OK).
 */
export function validateProviderMessageProtocol(
  messages: readonly ProtocolCheckableMessage[],
): ProviderProtocolIssue[] {
  const issues: ProviderProtocolIssue[] = [];
  if (messages.length === 0) {
    issues.push({ code: 'empty_messages', message: 'Provider message array is empty' });
    return issues;
  }

  const knownCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  // Call ids declared by the most recent assistant tool_calls message whose
  // results have not all been observed yet. A non-tool message (or end of
  // payload) while ids are still pending is a protocol violation.
  let pendingCallIds: Set<string> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'user' && looksLikeSystemInUserProse(msg.content)) {
      issues.push({
        code: 'system_in_user_content',
        message: 'User message appears to embed system/history Markdown (flattened protocol)',
        index: i,
      });
    }
    if (pendingCallIds && msg.role !== 'tool') {
      for (const id of pendingCallIds) {
        issues.push({
          code: 'unanswered_tool_call',
          message: `Assistant tool_call id=${id} has no tool result before the next non-tool message`,
          index: i,
        });
      }
      pendingCallIds = null;
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      const declared: string[] = [];
      for (const tc of msg.tool_calls) {
        if (!tc.id) {
          issues.push({
            code: 'assistant_tool_call_missing_id',
            message: 'Assistant tool_call missing id',
            index: i,
          });
        } else {
          knownCallIds.add(tc.id);
          declared.push(tc.id);
        }
      }
      pendingCallIds = new Set(declared);
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        issues.push({
          code: 'tool_missing_call_id',
          message: 'Tool message missing tool_call_id',
          index: i,
        });
        continue;
      }
      if (!knownCallIds.has(msg.tool_call_id)) {
        issues.push({
          code: 'orphan_tool_result',
          message: `Tool result tool_call_id=${msg.tool_call_id} has no preceding assistant tool_call`,
          index: i,
        });
      }
      if (seenResultIds.has(msg.tool_call_id)) {
        issues.push({
          code: 'duplicate_tool_result',
          message: `Tool result tool_call_id=${msg.tool_call_id} appears more than once`,
          index: i,
        });
      }
      seenResultIds.add(msg.tool_call_id);
      pendingCallIds?.delete(msg.tool_call_id);
    }
  }

  if (pendingCallIds) {
    for (const id of pendingCallIds) {
      issues.push({
        code: 'unanswered_tool_call',
        message: `Assistant tool_call id=${id} has no tool result before the end of the payload`,
        index: messages.length - 1,
      });
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
