/**
 * commandSemantics.ts — semantic classification surface (P0-2 convergence).
 *
 * Convergence shim: the single parse authority now lives in
 * `authority/commandDecoder.ts` (quote/escape-aware tokenizer + semantic
 * decoder). This module keeps its historical public surface — every symbol
 * imported by autonomy policy, tests, and the executor — as a re-export, so
 * there is exactly ONE parser in the system. Consumers that need structured
 * capabilities use `decodeCommand` / `parseGitCommand` directly.
 *
 * Design constraints (carried over from P0-D):
 *  - Pure module: no V9-lane imports — zero co-evolution debt.
 *  - Conservative: ambiguous commands classify as 'unrecognized' (NOT a
 *    denial class — the PDP and lease allowlist are the authority).
 *  - This is NOT a shell interpreter. The decoder is a conservative lexical
 *    decoder, and nothing more.
 */

import { SEMANTIC_SEVERITY, decodeCommand, splitChains } from '../authority/commandDecoder.js';
import type { CommandSemanticClass } from '../authority/commandDecoder.js';

export {
  SEMANTIC_SEVERITY,
  decodeCommand,
  isCredentialExposureCommand,
  isGatedGitPush,
  splitChains,
  splitChains as splitCommandSegments,
  splitCommandParts,
  tokenize,
  unwrapCommandWrappers,
} from '../authority/commandDecoder.js';
export type { CommandSemanticClass, DecodedCommand } from '../authority/commandDecoder.js';

const SEVERITY_INDEX = new Map<CommandSemanticClass, number>(
  SEMANTIC_SEVERITY.map((cls, i) => [cls, i]),
);

/**
 * Classify one normalized command segment into the semantic taxonomy.
 * 'unrecognized' is the conservative default — it is NOT a denial class.
 */
export function classifyCommandSegment(segment: string): CommandSemanticClass {
  return decodeCommand(segment).semantic;
}

/**
 * Classify a full command string (possibly chained) into the most severe
 * semantic class of any segment. Chain splitting is quote-aware: separators
 * inside quotes are not boundaries.
 */
export function classifyCommandSemantics(command: string): CommandSemanticClass {
  const segments = splitChains(command);
  if (segments.length === 0) return 'unrecognized';
  return segments
    .map(classifyCommandSegment)
    .reduce((a, b) =>
      (SEVERITY_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) <=
      (SEVERITY_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
        ? a
        : b,
    );
}
