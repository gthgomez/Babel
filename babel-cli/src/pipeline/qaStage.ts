/**
 * qaStage.ts — Stage 3 QA Review processing
 *
 * Extracted from pipeline.ts (P1.2 decomposition). Encapsulates:
 * - Adversarial QA gate — second-pass review with a different model
 * - QA rejection state population
 *
 * The QA model invocation itself stays in pipeline.ts (tightly coupled to
 * context compilation and waterfall configuration). This module handles
 * the verdict processing that follows the model call.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SwePlan, QaVerdict, QaVerdictReject } from '../schemas/agentContracts.js';

import {
  pickAdversarialModel,
  buildAdversarialReviewPrompt,
  synthesizeAdversarialResult,
} from '../agent/lanes/adversarialQALane.js';
import type { AdversarialQAInput } from '../agent/lanes/adversarialQALane.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { QaVerdictSchema } from '../schemas/agentContracts.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type { z } from 'zod';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdversarialQaGateResult {
  passed: boolean;
  reason?: string;
  allFailures?: QaVerdictReject['failures'] | undefined;
  qaRejections?: string[] | undefined;
  proposedFixStrategy?: string | undefined;
  adversarialVerdict?: z.infer<typeof QaVerdictSchema> | undefined;
}

// ─── Model ID mapping ─────────────────────────────────────────────────────────

const ADVERSARIAL_MODEL_ID: Record<string, string> = {
  nemotron: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  'deepseek-v4': 'deepseek-ai/DeepSeek-V3-0324',
  'qwen3-32b': 'Qwen/Qwen3-32B',
  'step-flash': 'stepfun-ai/Step-3.5-Flash',
  claude: 'anthropic/claude-sonnet-4-20250514',
  gemini: 'google/gemini-2.5-pro',
  codex: 'openai/gpt-5.1',
};

// ─── Adversarial QA gate ──────────────────────────────────────────────────────

export async function runAdversarialQaGate(
  swePlan: SwePlan,
  originalVerdict: QaVerdict,
  rawTask: string,
  attempt: number,
  runDir: string,
  logDetail: (msg: string) => void,
  originalQaModel = 'deepseek',
): Promise<AdversarialQaGateResult> {
  if (process.env['BABEL_ADVERSARIAL_REVIEW'] !== 'true') {
    return { passed: true };
  }

  const adversaryModel = pickAdversarialModel(originalQaModel);
  if (!adversaryModel) {
    console.warn('[ADVERSARIAL_QA] No adversarial model available; skipping adversarial review.');
    return { passed: true };
  }

  const modelId = ADVERSARIAL_MODEL_ID[adversaryModel] ?? adversaryModel;
  logDetail(`Running adversarial QA review with model: ${adversaryModel}`);

  const advInput: AdversarialQAInput = {
    swePlan,
    originalQaVerdict: originalVerdict,
    rawTask,
    originalQaModel,
  };
  const advPrompt = buildAdversarialReviewPrompt(advInput);

  try {
    const advRunner = new DeepInfraApiRunner(modelId);
    const advVerdict = await advRunner.execute(advPrompt, QaVerdictSchema);

    // Write adversarial verdict to evidence directory
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, `03_qa_verdict_v${attempt}_adversarial.json`),
        JSON.stringify(advVerdict, null, 2),
        'utf-8',
      );
    } catch {
      /* best effort — evidence writing is not load-bearing */
    }

    const advResult = synthesizeAdversarialResult(advInput, advVerdict);

    if (advResult.foundNewIssues) {
      const origCount =
        originalVerdict.verdict === 'REJECT'
          ? (originalVerdict as QaVerdictReject).failure_count
          : 0;
      logDetail(
        `Adversarial QA: REJECT (${advResult.allFailures.length} failure(s) — ` +
          `${advResult.allFailures.length - origCount} new)`,
      );
      advResult.allFailures.forEach((f, i) => {
        logDetail(`  ${i + 1}. [${f.tag}]  ${f.condition}`);
      });

      return {
        passed: false,
        allFailures: advResult.allFailures,
        qaRejections: advResult.allFailures.map((f) =>
          f.fix_hint
            ? `[${f.tag}] ${f.condition} (hint: ${f.fix_hint})`
            : `[${f.tag}] ${f.condition}`,
        ),
        proposedFixStrategy:
          (advResult.verdict as QaVerdictReject).proposed_fix_strategy ?? undefined,
        adversarialVerdict: advVerdict,
      };
    }

    logDetail('Adversarial QA: PASS (no new issues found)');
    return { passed: true, adversarialVerdict: advVerdict };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Phase 1c: Control adversarial QA failure mode via env var.
    // 'halt' (default): treat unavailability as a reject — pipeline loops or halts.
    // 'warn': log a warning and pass (old behavior, less safe).
    // 'skip': silently pass (least safe, for dry-run / smoke scenarios).
    const fallback = (process.env['BABEL_ADVERSARIAL_QA_FALLBACK'] ?? 'halt').toLowerCase();
    if (fallback === 'warn') {
      logDetail(
        `Adversarial QA runner failed: ${message}. ` +
          `Allowing primary verdict to stand (BABEL_ADVERSARIAL_QA_FALLBACK=warn).`,
      );
      return { passed: true, reason: 'adversarial_review_unavailable' };
    }
    if (fallback === 'skip') {
      return { passed: true, reason: 'adversarial_review_skipped' };
    }

    // Default: 'halt' — treat unavailability as adversarial failure
    logDetail(
      `Adversarial QA runner failed: ${message}. ` +
        `Treating as REJECT — adversarial review unavailable (BABEL_ADVERSARIAL_QA_FALLBACK=halt).`,
    );
    return {
      passed: false,
      reason: `Adversarial QA runner failed: ${message}`,
      qaRejections: [`[adversarial_qa] Adversarial review unavailable: ${message}`],
      proposedFixStrategy: 'Re-run with a different adversarial model or fix the underlying error.',
    };
  }
}
