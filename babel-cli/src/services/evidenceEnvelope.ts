/**
 * evidenceEnvelope.ts — deterministic evidence normalization (P1-E / E2 seam).
 *
 * Reduces high-volume model-bound evidence (test/lint/typecheck output) into a
 * small structured envelope, while ALWAYS retaining the raw evidence reference.
 *
 * Hard invariant: normalization NEVER destroys raw evidence. The model-facing
 * envelope carries `rawRef`; the raw artifact lives in the evidence store and
 * can be expanded on demand (E2 experiment: envelope vs raw-heavy context).
 *
 * Conservative by design: when output does not match a known runner shape, the
 * envelope degrades to a trimmed summary and keeps the raw ref — it never
 * invents counts.
 *
 * Pure module: no I/O, no V9-lane imports.
 */

export interface EnvelopeFailure {
  test: string;
  message: string;
  sourceRef: string;
}

export interface EvidenceEnvelope {
  /** Runner name when detected (jest, pytest, vitest, node --test, unknown). */
  runner: string;
  summary: string;
  exitCode: number | null;
  passedCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  failures: EnvelopeFailure[];
  /** Immutable reference to the raw evidence (never dropped). */
  rawRef: string;
  /** Normalizer version for reproducibility. */
  normalizerVersion: string;
  /** True when the envelope is a degraded fallback (no reliable parse). */
  degraded: boolean;
}

export const EVIDENCE_ENVELOPE_VERSION = '1.0.0';

const FAILURE_LINE_RE =
  /^\s*(?:✕|×|FAIL|FAILED)\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*ms\))?\s*$/;
const PASS_LINE_RE = /^\s*(?:✓|√|PASS|ok\s+\d+)\s+(.+?)\s*$/;
const SUMMARY_PASS_RE = /(\d+)\s+pass(?:ed|ing)?/i;
const SUMMARY_FAIL_RE = /(\d+)\s+fail(?:ed|ing)?/i;
const SUMMARY_SKIP_RE = /(\d+)\s+skipp(?:ed|ing)?/i;
const EXIT_CODE_RE = /exit(?: code)?[:\s]+(-?\d+)/i;
const TEST_NAME_RE = /(?:test|spec|it)\s*\(\s*['"]([^'"]+)['"]/i;

function detectRunner(output: string): string {
  if (/jest/i.test(output) || /\bTest Suites?:/i.test(output)) return 'jest';
  // pytest-style summary block (`===== ... passed ... failed ... =====`).
  if (/=====.*(?:passed|failed|skipped).*=====/i.test(output)) return 'pytest';
  if (/vitest/i.test(output)) return 'vitest';
  if (/\btests\s+\d+/i.test(output) && /\bpass\s+\d+/i.test(output)) return 'node:test';
  return 'unknown';
}

/**
 * Build a normalized evidence envelope from raw command output.
 *
 * Never throws: any parse failure degrades to a trimmed summary with the raw
 * ref intact. Counts are only reported when the output reliably contains them.
 */
export function buildEvidenceEnvelope(input: {
  output: string;
  exitCode?: number | null;
  command?: string;
  rawRef: string;
}): EvidenceEnvelope {
  const { output, exitCode, command, rawRef } = input;
  const runner = detectRunner(output);
  const failures: EnvelopeFailure[] = [];

  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(FAILURE_LINE_RE);
    if (m) {
      failures.push({
        test: m[1]!.trim(),
        message: line.trim().slice(0, 200),
        sourceRef: rawRef,
      });
      if (failures.length >= 10) break;
    }
  }

  const passedMatch = output.match(SUMMARY_PASS_RE);
  const failedMatch = output.match(SUMMARY_FAIL_RE);
  const skippedMatch = output.match(SUMMARY_SKIP_RE);
  const exitMatch = output.match(EXIT_CODE_RE);

  const passedCount = passedMatch ? Number(passedMatch[1]) : null;
  const failedCount = failedMatch ? Number(failedMatch[1]) : null;
  const skippedCount = skippedMatch ? Number(skippedMatch[1]) : null;

  // Only trust the parsed counts when the output looks like a real runner
  // summary (or a failure line was seen) — otherwise degrade.
  const countsReliable =
    runner !== 'unknown' || failures.length > 0 || exitMatch !== null;

  const degraded = !countsReliable;
  const summary = degraded
    ? `Verifier output for "${command ?? 'unknown command'}": ${output.length} chars. ` +
      `Raw evidence: ${rawRef}. (Not parsed — use raw evidence for detail.)`
    : [
        `Verifier "${command ?? 'unknown command'}" ${exitCode ?? '?'} (exit)` +
          `${passedCount !== null ? `, ${passedCount} passed` : ''}` +
          `${failedCount !== null ? `, ${failedCount} failed` : ''}` +
          `${skippedCount !== null ? `, ${skippedCount} skipped` : ''}`,
        failures.length > 0
          ? `Failures:\n${failures.map((f) => `- ${f.test}: ${f.message}`).join('\n')}`
          : null,
        `Raw evidence: ${rawRef} (expand on demand).`,
      ]
        .filter(Boolean)
        .join('\n');

  return {
    runner,
    summary,
    exitCode: exitCode ?? null,
    passedCount: countsReliable ? passedCount : null,
    failedCount: countsReliable ? failedCount : null,
    skippedCount: countsReliable ? skippedCount : null,
    failures,
    rawRef,
    normalizerVersion: EVIDENCE_ENVELOPE_VERSION,
    degraded,
  };
}

/**
 * Best-effort single-test-name extraction for inline probes (`node -e`, `-c`).
 * Returns null when no test name is detectable.
 */
export function extractTestName(output: string): string | null {
  const m = output.match(TEST_NAME_RE);
  return m?.[1] ?? null;
}
