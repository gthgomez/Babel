/**
 * adversarialQALane.ts — Adversarial multi-agent QA verification
 *
 * Phase 4C: Runs a second QA pass using a DIFFERENT model/provider
 * than the original QA, actively trying to find flaws the first reviewer missed.
 * Opt-in via --adversarial-review flag.
 */

import type { SwePlan, QaVerdict, QaVerdictReject } from '../../schemas/agentContracts.js';
// TargetModel type not exported from modelPolicy; using string for model identifiers

export interface AdversarialQAInput {
  swePlan: SwePlan;
  originalQaVerdict: QaVerdict;
  rawTask: string;
  /** The model used for the original QA (so we can pick a different one) */
  originalQaModel?: string;
}

export interface AdversarialQAResult {
  /** The adversarial reviewer's verdict */
  verdict: QaVerdict;
  /** Whether the adversarial review found issues the original missed */
  foundNewIssues: boolean;
  /** Combined failure list (original + adversarial) */
  allFailures: QaVerdictReject['failures'];
  /** Whether a revision cycle is needed */
  revisionNeeded: boolean;
}

/**
 * Pick a different model for adversarial review.
 * Prefers a model from a different provider family if available.
 */
export function pickAdversarialModel(originalModel?: string): string | undefined {
  const adversarialMap = new Map<string, string>([
    ['deepseek', 'step-flash'],
    ['deepseek-v4', 'step-flash'],
    ['qwen3', 'deepseek-v4'],
    ['qwen3-32b', 'deepseek-v4'],
    ['nemotron', 'qwen3-32b'],
    ['codex', 'claude'],
    ['claude', 'gemini'],
    ['gemini', 'codex'],
  ]);

  if (!originalModel) return undefined;

  return adversarialMap.get(originalModel.toLowerCase()) ?? undefined;
}

/**
 * Build an adversarial review prompt that instructs the reviewer
 * to actively find flaws the original reviewer missed.
 */
export function buildAdversarialReviewPrompt(input: AdversarialQAInput): string {
  const failures =
    input.originalQaVerdict.verdict === 'REJECT'
      ? (input.originalQaVerdict as QaVerdictReject).failures
          .map((f) => `  - ${f.tag}: ${f.condition}`)
          .join('\n')
      : '(none — original reviewer passed)';

  return [
    'You are the Adversarial QA Reviewer. Your job is to find flaws the original QA reviewer MISSED.',
    '',
    '--- ORIGINAL QA VERDICT ---',
    `Verdict: ${input.originalQaVerdict.verdict}`,
    `Failures found by original reviewer:`,
    failures,
    '',
    '--- YOUR TASK ---',
    'Actively try to REFUTE the plan. Consider:',
    '  1. Did the original reviewer miss any security issues?',
    '  2. Are there cross-file type mismatches the original reviewer overlooked?',
    '  3. Are there stub/placeholder values the original reviewer accepted?',
    '  4. Does the plan write to files not mentioned in the task?',
    '  5. Are there edge cases or failure modes the original reviewer did not consider?',
    '  6. Does the plan make assumptions that are not grounded in evidence?',
    '',
    'If you find new issues, respond with REJECT and list ALL failures (both original and new).',
    'If the original reviewer was thorough and you find no new issues, respond with PASS.',
    '',
    '--- SWE PLAN TO REVIEW ---',
    JSON.stringify(input.swePlan, null, 2),
  ].join('\n');
}

/**
 * Combine original QA failures with adversarial QA findings.
 */
export function synthesizeAdversarialResult(
  input: AdversarialQAInput,
  adversarialVerdict: QaVerdict,
): AdversarialQAResult {
  const originalFailures =
    input.originalQaVerdict.verdict === 'REJECT'
      ? (input.originalQaVerdict as QaVerdictReject).failures
      : [];

  const adversarialFailures =
    adversarialVerdict.verdict === 'REJECT' ? (adversarialVerdict as QaVerdictReject).failures : [];

  const newFailures = adversarialFailures.filter(
    (af) => !originalFailures.some((of) => of.tag === af.tag && of.condition === af.condition),
  );

  return {
    verdict:
      originalFailures.length > 0 || adversarialFailures.length > 0
        ? ({
            verdict: 'REJECT',
            failure_count: originalFailures.length + newFailures.length,
            failures: [...originalFailures, ...newFailures],
            overall_confidence: 5,
            proposed_fix_strategy:
              'Address all failures from both original and adversarial QA reviews.',
          } as QaVerdictReject)
        : adversarialVerdict,
    foundNewIssues: newFailures.length > 0,
    allFailures: [...originalFailures, ...adversarialFailures],
    revisionNeeded: newFailures.length > 0,
  };
}

/**
 * Wire this module in the QA stage of _runBabelPipelineInternal (pipeline.ts):
 *   import { pickAdversarialModel, buildAdversarialReviewPrompt, synthesizeAdversarialResult } from './agent/lanes/adversarialQALane.js';
 *   import type { AdversarialQAInput } from './agent/lanes/adversarialQALane.js';
 *
 * Usage when BABEL_ADVERSARIAL_REVIEW env var is set:
 *   if (process.env['BABEL_ADVERSARIAL_REVIEW'] === 'true') {
 *     const adversaryModel = pickAdversarialModel(originalQaModel);
 *     if (adversaryModel) {
 *       const input: AdversarialQAInput = { swePlan, originalQaVerdict, rawTask, originalQaModel };
 *       const prompt = buildAdversarialReviewPrompt(input);
 *       const adversaryVerdict = await runQaWithModel(prompt, adversaryModel);
 *       const combined = synthesizeAdversarialResult(input, adversaryVerdict);
 *     }
 *   }
 */
