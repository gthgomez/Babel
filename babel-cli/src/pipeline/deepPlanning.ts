import { compileContext } from '../compiler.js';
import { runWithFallback } from '../execute.js';
import type { EvidenceBundle } from '../evidence.js';
import type { ExecutionProfileName } from '../config/executionProfiles.js';
import {
  SwePlanSchema,
  type OrchestratorManifest,
  type SwePlan,
} from '../schemas/agentContracts.js';
import { assessPlanningComplexity } from '../services/plannerRouter.js';
import {
  normalizePlanTargetsAgainstGrounding,
  type TaskGrounding,
} from '../taskCompletion.js';
import { normalizePlanTargetsAgainstRequestedOutputs } from '../stages/verification.js';
import { splitChainedShellSteps } from './executorPlanNormalize.js';
import { inferProjectRoot } from './manifestContext.js';
import { buildSweTask } from './sweTask.js';
import { normalizeSwePlan } from './sweUtils.js';
import { log, logDetail } from './logging.js';

export interface DeepPlanningInput {
  manifest: OrchestratorManifest;
  ownerTask: string;
  planningContext: string;
  qaRejections: string[];
  proposedFixStrategy: string | undefined;
  additionalEvidenceContext: string;
  groundingContext: string;
  taskGrounding: TaskGrounding | null;
  executionProfile: ExecutionProfileName;
  attempt: number;
  previousRejectionTags: string[][];
  smartPlannerEnabled: boolean;
  evidence: EvidenceBundle;
  pruningStubs: Map<string, string>;
}

/** Propose and normalize one plan. The pipeline owns retries, review and authority. */
export async function proposeDeepPlan(
  input: DeepPlanningInput,
): Promise<{ plan: SwePlan; warnings: string[] }> {
  const { manifest, evidence, attempt } = input;
  const context = await compileContext(
    manifest.prompt_manifest,
    buildSweTask(
      manifest,
      input.ownerTask,
      input.qaRejections,
      input.proposedFixStrategy,
      input.additionalEvidenceContext,
      input.groundingContext,
      input.executionProfile,
    ),
    inferProjectRoot(manifest),
    input.pruningStubs,
  );
  evidence.writeCompiledContext(`swe_v${attempt}`, context);

  let plannerStartTierIndex: number | undefined;
  let plannerSkipTierNames: string[] | undefined;
  if (input.smartPlannerEnabled) {
    const complexity = manifest.analysis?.complexity_estimate;
    const decision = assessPlanningComplexity({
      task: input.planningContext,
      ...(complexity === 'Low' ||
      complexity === 'Medium' ||
      complexity === 'High'
        ? { manifestComplexity: complexity }
        : {}),
      qaRejections: input.qaRejections,
      previousRejectionTags: input.previousRejectionTags,
      attempt,
    });
    if (decision.startTierIndex > 0 || decision.skipTierKeys.length > 0) {
      plannerStartTierIndex = decision.startTierIndex;
      plannerSkipTierNames = decision.skipTierKeys;
      log(
        `  Smart Planner: ${decision.rationale}` +
          (decision.escalatedByRepeatedFailure
            ? ' [REPEATED FAILURE ESCALATION]'
            : ''),
      );
      evidence.writeDebugFile(
        `debug_smart_planner_v${attempt}.json`,
        `${JSON.stringify(decision, null, 2)}\n`,
      );
    }
    // Preserve the existing opt-in Smart Planner policy; pinned routing stays in runWithFallback.
    if (decision.recommendedEffort === 'max')
      process.env['BABEL_REASONING_EFFORT'] = 'max';
  }

  const raw = await runWithFallback(context, SwePlanSchema, {
    evidence,
    stage: 'planning',
    schemaName: 'SwePlanSchema',
    ...(plannerStartTierIndex !== undefined
      ? { startTierIndex: plannerStartTierIndex }
      : {}),
    ...(plannerSkipTierNames !== undefined
      ? { skipTierNames: plannerSkipTierNames }
      : {}),
  });
  const normalized = normalizeSwePlan(raw);
  const grounded = normalizePlanTargetsAgainstGrounding(
    input.taskGrounding,
    normalized.plan,
  );
  const requested = process.env['BABEL_PARITY_OFFLINE_FIX_MAP']?.trim()
    ? { plan: grounded.plan, warnings: [] as string[] }
    : normalizePlanTargetsAgainstRequestedOutputs(
        input.ownerTask,
        grounded.plan,
      );
  const warnings = [
    ...normalized.warnings,
    ...grounded.warnings,
    ...requested.warnings,
  ];
  warnings.forEach((warning) => logDetail(`SWE plan warning: ${warning}`));
  return { plan: splitChainedShellSteps(requested.plan), warnings };
}
