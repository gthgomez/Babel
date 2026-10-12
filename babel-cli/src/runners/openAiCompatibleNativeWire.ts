/**
 * Shared OpenAI-compatible native tool-call wire body used by API runners
 * and Chat compaction prepared-request admission (must match POST bytes).
 */
import { buildWireRequestFromEnvelope } from '../intelligence/wire.js';
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js';
import type { ProviderMessage, ToolDefinition } from './base.js';

/** Default system prompt for chat native tool streams (DeepInfra family). */
export const CHAT_NATIVE_DEFAULT_SYSTEM_PROMPT =
  'You are an expert software engineer in a terminal chat session. ' +
  'Answer the user conversationally in natural language. ' +
  'Use tools to read files and gather context as needed. ' +
  'Be concise but thorough. Use markdown for formatting. ' +
  'Do NOT output JSON — respond in plain natural language.';

export interface OpenAiCompatibleNativeWireInput {
  model: string;
  maxTokens: number | null;
  temperature: number;
  executionEnvelope?: ResolvedExecutionEnvelope | undefined;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  systemPrompt?: string;
  toolChoice?: 'auto' | 'required';
  stream: boolean;
  requestBodyExtras?: Record<string, unknown>;
  mapMessages: (
    messages: ProviderMessage[],
    defaultSystemPrompt: string,
    systemPrompt?: string,
  ) => unknown[];
}

/** Serialize the exact JSON body POSTed for native tool streams. */
export function buildOpenAiCompatibleNativeWireBody(
  input: OpenAiCompatibleNativeWireInput,
): string {
  if (input.executionEnvelope && !input.executionEnvelope.tools.effective) {
    throw new Error(
      '[openAiCompatibleNativeWire] tools were requested but the resolved envelope disabled tools.',
    );
  }
  const envelopeBody = input.executionEnvelope
    ? buildWireRequestFromEnvelope(input.executionEnvelope, {
        stream: input.stream,
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice ?? 'auto',
      })
    : {
        model: input.model,
        ...(input.maxTokens === null ? {} : { max_tokens: input.maxTokens }),
        temperature: input.temperature,
        tools: input.tools,
        tool_choice: (input.toolChoice ?? 'auto') as 'auto' | 'required',
        messages: input.mapMessages(
          input.messages,
          CHAT_NATIVE_DEFAULT_SYSTEM_PROMPT,
          input.systemPrompt,
        ),
      };
  return JSON.stringify({
    ...envelopeBody,
    stream: input.stream,
    ...(input.requestBodyExtras ?? {}),
    messages: input.executionEnvelope
      ? envelopeBody.messages
      : input.mapMessages(
          input.messages,
          CHAT_NATIVE_DEFAULT_SYSTEM_PROMPT,
          input.systemPrompt,
        ),
  });
}
