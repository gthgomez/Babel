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
const responseEnvelope = z.object({
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
  message: z.object({ content: optionalString }).nullish(),
  finish_reason: optionalString,
})).max(1).nullish();

export class MalformedChatCompletionsResponseError extends Error {}

/** Capture envelope evidence separately from the choice that could produce output. */
export function readChatCompletionsEnvelope(value: unknown, source: string): z.infer<typeof responseEnvelope> {
  const parsed = responseEnvelope.safeParse(value);
  if (!parsed.success) throw new MalformedChatCompletionsResponseError(`${source} (invalid envelope fields)`);
  return parsed.data;
}

/** Parse envelope evidence before validating the choice that could produce output. */
export function parseChatCompletionsStreamFrame(data: string): z.infer<typeof responseEnvelope> {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new MalformedChatCompletionsResponseError('Malformed SSE event chunk');
  }
  return readChatCompletionsEnvelope(value, 'Malformed SSE event chunk');
}

/** A missing index is supported; an explicit index must be zero. */
export function readSingleChatCompletionsChoice(
  choices: unknown,
  source: string,
): NonNullable<z.infer<typeof singleChoice>>[number] | undefined {
  const parsed = singleChoice.safeParse(choices);
  if (!parsed.success) {
    throw new MalformedChatCompletionsResponseError(`${source} (expected a single choice at index 0 with valid fields)`);
  }
  return parsed.data?.[0];
}

/** Enforce the shared single-choice and no-output-after-finish contract. */
export function readChatCompletionsStreamChoice(
  choices: unknown,
  priorFinish: string | null,
): NonNullable<z.infer<typeof singleChoice>>[number] | undefined {
  const choice = readSingleChatCompletionsChoice(choices, 'Malformed SSE event chunk');
  const delta = choice?.delta;
  if (priorFinish && (delta?.content || delta?.reasoning_content || delta?.tool_calls?.length)) {
    throw new MalformedChatCompletionsResponseError('Malformed SSE event chunk (output after the reported finish)');
  }
  return choice;
}
