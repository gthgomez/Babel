/**
 * DeepSeek direct API native tool-stream wire body (distinct from OpenAI-compatible).
 * Shared between transport and compaction admission probes.
 */
import type { ProviderMessage, ToolDefinition } from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';

/** Chat native system prompt for DeepSeek tool streams. */
export const DEEPSEEK_CHAT_NATIVE_SYSTEM_PROMPT =
  'You are an expert software engineer in a terminal chat session. ' +
  'Answer the user conversationally in natural language. ' +
  'Use tools to read files and gather context as needed. ' +
  'Be concise but thorough. Use markdown for formatting. ' +
  'Do NOT output JSON — respond in plain natural language.';

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

function resolveReasoningEffort(): string | undefined {
  const raw = process.env['BABEL_REASONING_EFFORT']?.trim().toLowerCase();
  return raw && VALID_REASONING_EFFORTS.has(raw) ? raw : undefined;
}

export interface DeepSeekNativeToolsWireInput {
  model: string;
  maxTokens: number;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  systemPrompt?: string;
  toolChoice?: 'auto' | 'required';
  stream: boolean;
}

/** Serialize the exact JSON POSTed for DeepSeek native tool streams. */
export function buildDeepSeekNativeToolsWireBody(input: DeepSeekNativeToolsWireInput): string {
  const effort = resolveReasoningEffort();
  const wantThinking = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
  const allowThinkingWithTools = process.env['BABEL_DEEPSEEK_THINKING_WITH_TOOLS'] === '1';
  const thinkingEnabled = wantThinking && allowThinkingWithTools;
  const choice = (input.toolChoice ?? 'auto') as 'auto' | 'required';
  return JSON.stringify({
    model: input.model,
    max_tokens: input.maxTokens,
    temperature: 0,
    stream: input.stream,
    stream_options: { include_usage: true },
    tools: input.tools,
    ...(thinkingEnabled ? {} : { tool_choice: choice }),
    ...(effort ? { reasoning_effort: effort } : {}),
    thinking: { type: thinkingEnabled ? 'enabled' as const : 'disabled' as const },
    messages: mapProviderMessagesToWire(
      input.messages,
      DEEPSEEK_CHAT_NATIVE_SYSTEM_PROMPT,
      input.systemPrompt,
    ),
  });
}
