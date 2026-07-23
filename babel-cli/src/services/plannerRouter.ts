/**
 * plannerRouter.ts — Smart Planner tier routing for the SWE planning stage.
 *
 * Assesses task difficulty before each planning-stage waterfall invocation and
 * determines whether to skip cheap/weak models in favor of stronger reasoning
 * models (deepseek-v4-pro, step-flash). The default SWE waterfall is:
 *
 *   scout → deepseek-v4-pro → step-flash → qwen3-32b
 *
 * For hard tasks (exact literals, TypeScript repairs, architecture-level work,
 * repeated QA rejections), starting at tier 0 (scout) wastes time, tokens, and
 * QA retry budget. This module produces a tier reordering/skip plan that the
 * caller passes to runWithFallback via startTierIndex + skipTierNames.
 *
 * All complexity signals consumed here already exist elsewhere in the codebase
 * (liteFullRouter, modelEscalationRules, orchestrator analysis). This module
 * wires them together into a single routing decision.
 */

import { routeLiteOrFull } from './liteFullRouter.js';
import {
  recommendModelEscalation,
  type ModelEscalationRecommendation,
} from './modelEscalationRules.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlannerRouteDecision {
  /** 0-based index into the planning waterfall to start at. */
  startTierIndex: number;
  /** Backend keys (matching model-policy.json entries) to exclude from the waterfall. */
  skipTierKeys: string[];
  /** Human-readable rationale for logging and telemetry. */
  rationale: string;
  /** Whether this decision was triggered by repeated QA failure patterns. */
  escalatedByRepeatedFailure: boolean;
  /** Recommended reasoning effort for the planning stage ('high' or 'max'). */
  recommendedEffort: 'high' | 'max';
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of SWE-QA loop attempts before the pipeline gives up.
 * Must match MAX_SWE_QA_LOOPS in pipeline.ts (currently 3).
 */
const MAX_SWE_QA_LOOPS = 3;

/**
 * Backend keys for the two weakest tiers in the planning waterfall.
 * These are the primary targets for skipping on hard tasks.
 */
const WEAK_PLANNER_KEYS = ['scout', 'qwen3-32b'];

/**
 * Risk signal codes from liteFullRouter that indicate a task needs a stronger planner.
 */
const HARD_TASK_RISK_CODES = new Set([
  'exact_literal_invariants',
  'repo_wide_or_architecture',
  'repeated_failure_or_recovery',
]);

// ─── Rejection fingerprinting ──────────────────────────────────────────────────

/**
 * Extracts failure tags from QA rejection strings in the format
 * "[TAG] condition description (hint: ...)".
 */
function extractRejectionTags(qaRejections: string[]): string[] {
  return qaRejections
    .map((r) => r.match(/^\[([^\]]+)\]/)?.[1])
    .filter((t): t is string => t !== undefined && t.length > 0);
}

/**
 * Returns true when the same failure tags appear across the last two
 * consecutive SWE-QA attempts — the planner is stuck in a loop producing
 * the same rejectable plan.
 */
function hasRepeatedFailurePattern(previousRejectionTags: string[][]): boolean {
  if (previousRejectionTags.length < 2) return false;
  const last = new Set(previousRejectionTags[previousRejectionTags.length - 1]!);
  const prev = new Set(previousRejectionTags[previousRejectionTags.length - 2]!);
  if (last.size === 0) return false;
  const overlap = [...last].filter((t) => prev.has(t));
  // At least 50% overlap signals a stuck pattern.
  return overlap.length / last.size >= 0.5;
}

// ─── Core decision function ────────────────────────────────────────────────────

export function assessPlanningComplexity(input: {
  task: string;
  manifestComplexity?: 'Low' | 'Medium' | 'High';
  qaRejections: string[];
  previousRejectionTags: string[][];
  attempt: number;
}): PlannerRouteDecision {
  // ── Priority 1: Repeated failure pattern across attempts ──────────────────
  // Max effort: the model failed twice already, give it maximum reasoning depth.
  if (input.attempt >= 2 && hasRepeatedFailurePattern(input.previousRejectionTags)) {
    return {
      startTierIndex: 2,
      skipTierKeys: [...WEAK_PLANNER_KEYS],
      rationale:
        `Repeated QA rejection pattern detected across attempts ` +
        `${input.attempt - 1}→${input.attempt}. Skipping scout and qwen3-32b — ` +
        `starting planning at tier 3 (step-flash) with max reasoning effort.`,
      escalatedByRepeatedFailure: true,
      recommendedEffort: 'max',
    };
  }

  // ── Priority 2: Final retry attempt — use strongest available model ───────
  if (input.attempt === MAX_SWE_QA_LOOPS) {
    return {
      startTierIndex: 2,
      skipTierKeys: [...WEAK_PLANNER_KEYS],
      rationale:
        `Final planning attempt (${input.attempt}/${MAX_SWE_QA_LOOPS}). ` +
        `Skipping scout and qwen3-32b — using strongest available model with max effort.`,
      escalatedByRepeatedFailure: true,
      recommendedEffort: 'max',
    };
  }

  // ── Priority 3: Orchestrator rated complexity High ────────────────────────
  if (input.manifestComplexity === 'High') {
    return {
      startTierIndex: 1,
      skipTierKeys: ['scout'],
      rationale:
        'Orchestrator rated task complexity High — starting planning at deepseek-v4-pro (tier 2), skipping scout.',
      escalatedByRepeatedFailure: false,
      recommendedEffort: 'max',
    };
  }

  // ── Priority 4: Lite/Full router risk signals ─────────────────────────────
  const liteFullRoute = routeLiteOrFull(input.task, { forceLiteOnly: false });
  const hardRiskSignals = liteFullRoute.risk_signals.filter((s) =>
    HARD_TASK_RISK_CODES.has(s.code),
  );
  if (hardRiskSignals.length > 0) {
    const codes = hardRiskSignals.map((s) => s.code).join(', ');
    return {
      startTierIndex: 1,
      skipTierKeys: ['scout'],
      rationale: `Risk signal(s) detected: ${codes} — starting planning at deepseek-v4-pro (tier 2), skipping scout.`,
      escalatedByRepeatedFailure: false,
      recommendedEffort: 'max',
    };
  }

  // ── Priority 5: Model escalation rules ────────────────────────────────────
  // Pass null for status/haltTag/verifierMessage — these are runtime pipeline
  // statuses that would self-trigger the escalation patterns (e.g. the string
  // "qa_rejected" matches the repeated_halt pattern). We only want to detect
  // hard-task signals in the task text itself, not in our own status values.
  const escalationCheck: ModelEscalationRecommendation = recommendModelEscalation({
    task: input.task,
  });
  if (escalationCheck.should_escalate) {
    const codes = escalationCheck.signals.map((s) => s.code).join(', ');
    return {
      startTierIndex: 1,
      skipTierKeys: ['scout'],
      rationale: `Escalation rule(s) triggered: ${codes} — starting planning at deepseek-v4-pro (tier 2), skipping scout.`,
      escalatedByRepeatedFailure: false,
      recommendedEffort: 'high',
    };
  }

  // ── Priority 6: Default — use the normal waterfall ────────────────────────
  return {
    startTierIndex: 0,
    skipTierKeys: [],
    rationale: 'No escalation signals detected — using default planning waterfall.',
    escalatedByRepeatedFailure: false,
    recommendedEffort: 'high',
  };
}
