/**
 * structuredRunner.ts — Sentinel-Wrapped Runner with Repair Loop
 *
 * Wraps any LlmRunner with two defence layers:
 *
 *   1. Sentinel Prompting — Appends <<BABEL_JSON_BEGIN>> / <<BABEL_JSON_END>>
 *      markers to the prompt so JSON extraction is deterministic even in noisy
 *      CLI output (banners, tool-call traces, prose preambles).
 *
 *   2. Repair Loop — If the inner runner throws a CliParseError (JSON parse or
 *      Zod validation failure), attempts recovery in two passes:
 *        a. Pass 0 (Sentinel extraction): Extract content between sentinel
 *           markers directly from rawStdout, then re-validate with the schema.
 *        b. Pass 1 (API repair): Send rawStdout to an API repair runner
 *           (Gemini API → Anthropic) with a targeted "extract the JSON" prompt.
 *      If both passes fail, the original CliParseError is re-thrown so the
 *      outer waterfall cascade in execute.ts continues to the next tier.
 *
 * Non-parse errors (spawn failure, rate-limit, timeout) bypass the repair loop
 * entirely — they are re-thrown immediately for the outer waterfall to handle.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner }    from './base.js';
import { CliParseError }     from './cliBase.js';
import { GeminiApiRunner }   from './geminiApi.js';
import { ApiFallbackRunner } from './apiFallback.js';
import { extractJson }       from '../utils/extractJson.js';

// ─── Sentinel constants ────────────────────────────────────────────────────────

const SENTINEL_BEGIN = '<<BABEL_JSON_BEGIN>>';
const SENTINEL_END   = '<<BABEL_JSON_END>>';

// ─── Sentinel instruction appended to every prompt ────────────────────────────

/**
 * Appended verbatim to the end of every prompt so the model knows to wrap its
 * JSON response between recognisable sentinel markers, even if other format
 * instructions are present earlier in the context.
 */
const SENTINEL_INSTRUCTION = [
  '',
  '---',
  'OUTPUT FORMAT REQUIREMENT (overrides all other format instructions):',
  `Wrap your entire JSON response between these exact sentinel markers on their own lines:`,
  SENTINEL_BEGIN,
  '{ ...your json here... }',
  SENTINEL_END,
  'Output NOTHING outside the sentinels. No prose, no markdown fences, no explanation.',
].join('\n');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extracts content between sentinel markers, or returns null if not found. */
function extractFromSentinels(rawStdout: string): string | null {
  const start = rawStdout.indexOf(SENTINEL_BEGIN);
  const end   = rawStdout.indexOf(SENTINEL_END);
  if (start === -1 || end === -1 || end <= start) return null;
  return rawStdout.slice(start + SENTINEL_BEGIN.length, end).trim();
}

/**
 * Builds a repair prompt that asks an API runner to extract the JSON object
 * from noisy raw CLI output.
 */
function buildRepairPrompt(rawStdout: string): string {
  return [
    'A CLI agent produced the following raw output. It should contain a JSON object',
    'but may be wrapped in prose, markdown fences, tool-call traces, or other noise.',
    'Extract ONLY the valid JSON object and output it as raw JSON with no other text.',
    '',
    '--- RAW CLI OUTPUT ---',
    rawStdout.slice(0, 8000), // safety limit — prevents oversized repair prompts
    '--- END RAW CLI OUTPUT ---',
  ].join('\n');
}

/**
 * Attempts to construct a repair API runner.
 * Priority order:
 *   1. Gemini API (GEMINI_API_KEY) — large context window, near-zero cost;
 *      best choice for repairing large EVIDENCE_REQUEST log outputs.
 *   2. Anthropic (ANTHROPIC_API_KEY) — last resort.
 * Returns null if no API keys are configured.
 */
function createRepairRunner(): LlmRunner | null {
  try { return new GeminiApiRunner(); }   catch { /* GEMINI_API_KEY not set */ }
  try { return new ApiFallbackRunner(); } catch { /* ANTHROPIC_API_KEY not set */ }
  return null;
}

// ─── StructuredRunner ─────────────────────────────────────────────────────────

export class StructuredRunner implements LlmRunner {
  private readonly inner: LlmRunner;
  private readonly label: string;

  /**
   * @param inner  The CLI runner to wrap (e.g. CodexCliRunner, GeminiCliRunner).
   * @param label  Human-readable label for log messages. Defaults to the inner
   *               runner's constructor name.
   */
  constructor(inner: LlmRunner, label?: string) {
    this.inner = inner;
    this.label = label ?? inner.constructor.name;
  }

  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    // ── Step 1: Append sentinel instruction to the prompt. ──────────────────
    const wrappedPrompt = prompt + SENTINEL_INSTRUCTION;

    // ── Step 2: Attempt the inner (CLI) runner. ─────────────────────────────
    let cliErr: CliParseError | null = null;

    try {
      return await this.inner.execute(wrappedPrompt, schema);
    } catch (err) {
      if (!(err instanceof CliParseError)) {
        // Spawn errors, rate-limits, timeouts — re-throw immediately so the
        // waterfall cascade handles them (sentinel repair is not applicable).
        throw err;
      }
      cliErr = err;
    }

    // ── Step 3: Sentinel extraction pass. ───────────────────────────────────
    // Try to pull valid JSON from between the sentinel markers in rawStdout.
    const sentinelContent = extractFromSentinels(cliErr.rawStdout);
    if (sentinelContent) {
      try {
        const parsed = extractJson(sentinelContent);
        const result = schema.safeParse(parsed);
        if (result.success) {
          console.log(`[structuredRunner] ${this.label} — sentinel extraction rescued output.`);
          return result.data;
        }
      } catch {
        // Sentinel content wasn't valid / schema-conformant — fall through to repair.
      }
    }

    // ── Step 4: API repair loop. ─────────────────────────────────────────────
    // Send the raw stdout to a fresh API runner with a targeted repair prompt.
    const repairRunner = createRepairRunner();
    if (!repairRunner) {
      // No API keys configured — re-throw the original CliParseError so the
      // outer waterfall can cascade to the next tier.
      throw cliErr;
    }

    try {
      const repairPrompt = buildRepairPrompt(cliErr.rawStdout);
      const result = await repairRunner.execute<T>(repairPrompt, schema);
      console.log(`[structuredRunner] ${this.label} — API repair succeeded.`);
      return result;
    } catch {
      // Repair also failed — re-throw the original CliParseError so the
      // outer waterfall cascade continues correctly.
      throw cliErr;
    }
  }
}
