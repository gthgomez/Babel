import { z } from 'zod';

/** Accept SSE `data:` lines with or without a space after the colon. */
export function ssePayloadFromTrimmedLine(trimmed: string): string | null {
  const normalized = trimmed.replace(/\r$/, '').trim();
  if (!normalized.startsWith('data:')) return null;
  return normalized.slice(5).trimStart();
}

const optionalString = z.string().nullish();
const toolDelta = z.object({
  index: z.number().int().nonnegative(),
  id: optionalString,
  type: z.literal('function').nullish(),
  function: z.object({ name: optionalString, arguments: optionalString }).nullish(),
});
const streamFrame = z.object({
  model: optionalString,
  provider: optionalString,
  error: z.unknown().optional(),
  usage: z.object({}).passthrough().nullish(),
  openrouter_metadata: z.object({
    endpoints: z.object({
      available: z.array(z.object({}).passthrough()).nullish(),
    }).nullish(),
    attempts: z.array(z.object({}).passthrough()).nullish(),
  }).passthrough().nullish(),
  choices: z.unknown().optional(),
}).passthrough();

const singleChoice = z.array(z.object({
  // The request asks for one choice, and some compatible providers omit its index.
  index: z.literal(0).optional(),
  delta: z.object({
    content: optionalString,
    reasoning_content: optionalString,
    tool_calls: z.array(toolDelta).nullish(),
  }).nullish(),
  finish_reason: optionalString,
})).max(1).nullish();

export class MalformedChatCompletionsStreamError extends Error {}

/** Parse envelope evidence before validating the choice that could produce output. */
export function parseChatCompletionsStreamFrame(data: string): z.infer<typeof streamFrame> {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new MalformedChatCompletionsStreamError('Malformed SSE event chunk');
  }
  const parsed = streamFrame.safeParse(value);
  if (!parsed.success) throw new MalformedChatCompletionsStreamError('Malformed SSE event chunk (invalid frame fields)');
  return parsed.data;
}

/** Enforce the shared single-choice and no-output-after-finish contract. */
export function readChatCompletionsStreamChoice(
  choices: unknown,
  priorFinish: string | null,
): NonNullable<z.infer<typeof singleChoice>>[number] | undefined {
  const parsed = singleChoice.safeParse(choices);
  if (!parsed.success) {
    throw new MalformedChatCompletionsStreamError('Malformed SSE event chunk (expected a single choice at index 0 with valid fields)');
  }
  const choice = parsed.data?.[0];
  const delta = choice?.delta;
  if (priorFinish && (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length)) {
    throw new MalformedChatCompletionsStreamError('Malformed SSE event chunk (output after the reported finish)');
  }
  return choice;
}
