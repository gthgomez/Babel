/**
 * qaStage.ts — Stage 3 QA Review processing
 *
 * Extracted from pipeline.ts (P1.2 decomposition). Encapsulates:
 * - Adversarial QA gate — second-pass review with a different enabled model
 * - Standard review compilation, invocation and normalization shared by Deep
 *   and manual resume. The pipeline retains attempt and approval authority.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SwePlan, QaVerdict, QaVerdictReject, OrchestratorManifest } from '../schemas/agentContracts.js';
import {compileContext} from '../compiler.js';
import type {EvidenceBundle} from '../evidence.js';
import type {ExecutionProfileName} from '../config/executionProfiles.js';
import type {JavaRuntimeStatus,CommandRuntimeStatus,AndroidSdkStatus} from '../stages/runtimePreflight.js';
import {buildQaTask} from './qaTask.js';
import {inferProjectRoot} from './manifestContext.js';
import {abs,QA_PATHS} from './paths.js';
import {sanitizeQaVerdictForDeterministicGradleBootstrapLane,sanitizeWindowsGradlewPermissionQaVerdict,sanitizeExistingWrapperQaVerdict} from './qaVerdictSanitizers.js';

import {
  pickAdversarialModel,
  buildAdversarialReviewPrompt,
  synthesizeAdversarialResult,
} from '../agent/lanes/adversarialQALane.js';
import type { AdversarialQAInput } from '../agent/lanes/adversarialQALane.js';
import { createProviderRunner } from '../runners/providerEngine.js';
import {runWithFallback, getPipelineSelectedModel, withPipelineModelRoute} from '../execute.js';
import {getAvailableModels, resolveStagePolicyRoutes, isLiveModelId} from '../modelPolicy.js';
import { QaVerdictSchema } from '../schemas/agentContracts.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type { z } from 'zod';

export interface QaReviewInput {
  plan: SwePlan;
  manifest: OrchestratorManifest;
  ownerTask: string;
  javaRuntimeStatus: JavaRuntimeStatus;
  gradleRuntimeStatus: CommandRuntimeStatus;
  androidSdkStatus: AndroidSdkStatus;
  deterministicGradleBootstrapLaneActive: boolean;
  executionProfile?: ExecutionProfileName;
  evidence: EvidenceBundle;
  attempt: number;
}

export async function compileQaReviewContext(
  input: QaReviewInput,
): Promise<string> {
  const context = await compileContext(
    abs(QA_PATHS),
    buildQaTask(
      input.plan,
      input.javaRuntimeStatus,
      input.gradleRuntimeStatus,
      input.androidSdkStatus,
      input.ownerTask,
      input.deterministicGradleBootstrapLaneActive,
      input.executionProfile,
    ),
    inferProjectRoot(input.manifest),
  );
  input.evidence.writeCompiledContext(`qa_v${input.attempt}`, context);
  return context;
}

export async function reviewDeepPlan(input: {
  context: string;
  plan: SwePlan;
  manifest: OrchestratorManifest;
  evidence: EvidenceBundle;
}): Promise<QaVerdict> {
  let verdict = await runWithFallback(input.context, QaVerdictSchema, {
    evidence: input.evidence,
    stage: 'qa',
    schemaName: 'QaVerdictSchema',
  });
  verdict = sanitizeQaVerdictForDeterministicGradleBootstrapLane(
    verdict,
    input.plan,
    input.manifest,
  );
  verdict = sanitizeWindowsGradlewPermissionQaVerdict(verdict, input.plan);
  return sanitizeExistingWrapperQaVerdict(verdict, input.plan, input.manifest);
}

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

  const primaryModel = getPipelineSelectedModel();
  const legacyOffline = process.env['BABEL_PIPELINE_V9_OFFLINE'] === '1' && !primaryModel;
  const adversaryModel = pickAdversarialModel(originalQaModel);
  if (legacyOffline && !adversaryModel) {
    console.warn('[ADVERSARIAL_QA] No adversarial model available; skipping legacy offline review.');
    return {passed:true};
  }
  const modelId = ADVERSARIAL_MODEL_ID[adversaryModel ?? ''] ?? adversaryModel ?? '';

  const advInput: AdversarialQAInput = {
    swePlan,
    originalQaVerdict: originalVerdict,
    rawTask,
    originalQaModel:primaryModel ?? originalQaModel,
  };
  const advPrompt = buildAdversarialReviewPrompt(advInput);

  try {
    const originalBackend = primaryModel ?? (legacyOffline ? undefined : resolveStagePolicyRoutes({liveOnly:true}).find(route => route.stage === 'qa')?.primaryBackendKey);
    const selectedConnection = primaryModel?.startsWith('connection/') ? primaryModel : undefined;
    const reviewBackend = selectedConnection ? { key: selectedConnection } : legacyOffline ? undefined : getAvailableModels().find(({key,entry}) =>
      key !== originalBackend && entry.enabled !== false && entry.provider === 'openrouter' && isLiveModelId(key));
    if (!legacyOffline && !reviewBackend) throw new Error('Independent adversarial review requires an explicit provider connection or a configured independent model route.');
    logDetail(`Running independent adversarial QA with model: ${reviewBackend?.key ?? adversaryModel}`);
    const advVerdict = legacyOffline
      ? await createProviderRunner({ provider: 'deepinfra', modelId }).execute(advPrompt, QaVerdictSchema)
      : await withPipelineModelRoute(reviewBackend!.key, () => runWithFallback(advPrompt, QaVerdictSchema, {stage:'qa',schemaName:'AdversarialQaVerdict',fallbackPolicy:'primary_only'}));

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
      allFailures: [{tag:'EVIDENCE-GATE', confidence:5, condition:`Adversarial review unavailable: ${message}`, fix_hint:'Enable a qualified independent review model and retry.'}],
      reason: `Adversarial QA runner failed: ${message}`,
      qaRejections: [`[adversarial_qa] Adversarial review unavailable: ${message}`],
      proposedFixStrategy: 'Re-run with a different adversarial model or fix the underlying error.',
    };
  }
}
