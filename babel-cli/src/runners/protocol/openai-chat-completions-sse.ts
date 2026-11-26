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
const toolStreamFrame = z.object({
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
  choices: z.array(z.object({
    // The request asks for one choice. A fragment from another choice must
    // not be combined with a pending call from the first.
    index: z.literal(0).optional(),
    delta: z.object({
      content: optionalString,
      reasoning_content: optionalString,
      tool_calls: z.array(toolDelta).nullish(),
    }).nullish(),
    finish_reason: optionalString,
  })).max(1).nullish(),
}).passthrough();

export class MalformedToolStreamError extends Error {}

/** Validate executable stream fragments before any can enter the tool accumulator. */
export function parseToolStreamFrame(data: string): z.infer<typeof toolStreamFrame> {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new MalformedToolStreamError('Malformed SSE event chunk');
  }
  const parsed = toolStreamFrame.safeParse(value);
  if (!parsed.success) throw new MalformedToolStreamError('Malformed SSE event chunk (invalid frame fields)');
  return parsed.data;
}
