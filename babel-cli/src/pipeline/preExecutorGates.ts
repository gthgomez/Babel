/**
 * preExecutorGates.ts — Shared Pre-Executor Safety Gates
 *
 * Called from both the primary pipeline path and resumeManualBridge before
 * the executor loop activates. Runs four gates in sequence:
 *   1. Plan target scope validation
 *   2. Verifier step injection
 *   3. Counter-agent critique
 *   4. Workspace lock check
 *
 * Any gate failure returns a structured halt result so the caller can
 * handle logging, telemetry, and finalization in its own style.
 */

import type { SwePlan } from '../schemas/agentContracts.js';
import { validatePlanTargetsWithinEffectiveRoots } from './targetConsistency.js';
import { injectVerificationStepsIntoPlan } from './planVerifierInjection.js';
import {
  buildCounterAgentCritiqueArtifact,
  buildAcceptedRevisedPlanArtifact,
  type CounterAgentCritiqueArtifact,
} from './grounding.js';
import { checkWorkspaceLocks } from './contractEnforcement.js';
import type { BabelIntentContract } from '../services/liteFullRouter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreExecutorGateContext {
  approvedPlan: SwePlan;
  projectRoot: string;
  taskContext: string;
  intentContract: BabelIntentContract;
  babelRoot: string;
}

export interface PreExecutorGatePassed {
  ok: true;
  /** The plan after verifier injection (may differ from input). */
  approvedPlan: SwePlan;
}

export interface PreExecutorGateBlocked {
  ok: false;
  reason: string;
  gate: string;
  errors?: string[];
}

export type PreExecutorGateResult = PreExecutorGatePassed | PreExecutorGateBlocked;

// ─── Public API ────────────────────────────────────────────────────────────────

export async function runPreExecutorSafetyGates(
  ctx: PreExecutorGateContext,
): Promise<PreExecutorGateResult> {
  let plan = ctx.approvedPlan;

  // (1) Plan target scope validation
  const planTargetScope = validatePlanTargetsWithinEffectiveRoots({
    effectiveTargetRoot: ctx.projectRoot,
    targets: plan.minimal_action_set.map((step) => step.target),
  });
  if (!planTargetScope.ok) {
    const reason =
      planTargetScope.violations[0] ??
      'Blocked — planned tool target is outside the resolved target root.';
    return {
      ok: false,
      reason,
      gate: 'ACTIVATION_GATE_FAIL',
      errors: planTargetScope.violations,
    };
  }

  // (2) Verifier step injection
  const verifierInjection = injectVerificationStepsIntoPlan(plan, ctx.taskContext, ctx.projectRoot);
  if (verifierInjection.injected) {
    plan = verifierInjection.plan;
  }

  // (3) Counter-agent critique
  const counterAgentCritique = buildCounterAgentCritiqueArtifact({
    plan,
    intent: ctx.intentContract,
    targetScopeViolations: planTargetScope.violations,
  });

  if (plan.plan_type === 'IMPLEMENTATION_PLAN' && counterAgentCritique.critic_verdict === 'block') {
    const reason =
      counterAgentCritique.required_changes[0] ??
      'No accepted revised plan was available to unlock file edits.';
    return {
      ok: false,
      reason,
      gate: 'ACTIVATION_GATE_FAIL',
      errors: counterAgentCritique.required_changes,
    };
  }

  // (4) Workspace lock validation
  const lockResult = await checkWorkspaceLocks(plan, ctx.babelRoot);
  if (lockResult.halted) {
    return {
      ok: false,
      reason: lockResult.reason ?? 'Workspace lock conflict — file edits blocked.',
      gate: 'ACTIVATION_GATE_FAIL',
    };
  }

  return {
    ok: true,
    approvedPlan: plan,
  };
}
