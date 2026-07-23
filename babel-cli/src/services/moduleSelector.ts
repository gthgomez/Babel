/**
 * moduleSelector.ts — Deterministic OLS-MCC module selector (P2(a))
 *
 * Given a task profile, selects the optimal optimizer type, depth mode,
 * and gating strategy based on the v4.5 decision guidance table.
 *
 * This is Alternative A from the P2 feasibility assessment: a rule-based
 * selector that replaces the AutoDSPy GPT-2-127M + GRPO approach (which
 * is infeasible on GTX 1650 4GB VRAM).
 *
 * When cloud GPU becomes available, this can be extended with a learned
 * ONNX policy model as an alternative path.
 *
 * Reference: ols-mcc-v4.5.md §"When to Activate v4.5 Modules" (lines 17-23)
 *            ols-mcc-v4.5.md §8.1-8.3 (optimizer modules)
 *            ols-mcc-v4.5.md §11 (metacognitive gating)
 */

import { z } from 'zod';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type OptimizerType =
  | 'SPO'
  | 'promptomatix'
  | 'reflection'
  | 'none';

export type DepthMode = 'LIGHT' | 'STANDARD' | 'DEEP' | 'PRODUCTION';

export type GatingStrategy = 'single' | 'multi';

export interface TaskProfile {
  /** Is this a high-frequency reusable prompt or agent? */
  isHighFrequency: boolean;
  /** Is this conversational, multi-turn, or compliance-oriented? */
  isConversational: boolean;
  /** Is this a complex multi-agent workflow with state? */
  isMultiAgent: boolean;
  /** Is this a self-improvement task for OLS meta-tools? */
  isSelfImproving: boolean;
  /** Is this a simple one-off prompt? */
  isSimpleOneOff: boolean;
  /** Does the task involve safety-critical operations (auth, payments, mutations)? */
  hasSafetyConstraints: boolean;
  /** Does the task involve state management or caching? */
  hasStateManagement: boolean;
  /** Explicit user-requested depth, if any. Overrides inference. */
  userRequestedDepth?: DepthMode | undefined;
}

export interface ModuleSelection {
  /** The recommended optimizer type. */
  optimizerType: OptimizerType;
  /** The recommended depth mode. */
  depthMode: DepthMode;
  /** The recommended gating strategy. */
  gating: GatingStrategy;
  /** Human-readable explanation for the selection. */
  explanation: string;
  /** Whether the user explicitly overrode the depth mode. */
  depthOverridden: boolean;
  /** Optional: alternate configuration if the primary is unsuitable. */
  alternative?: ModuleSelection | undefined;
}

// ─── Zod schemas ───────────────────────────────────────────────────────────────

export const TaskProfileSchema = z.object({
  isHighFrequency: z.boolean(),
  isConversational: z.boolean(),
  isMultiAgent: z.boolean(),
  isSelfImproving: z.boolean(),
  isSimpleOneOff: z.boolean(),
  hasSafetyConstraints: z.boolean(),
  hasStateManagement: z.boolean(),
  userRequestedDepth: z
    .enum(['LIGHT', 'STANDARD', 'DEEP', 'PRODUCTION'])
    .optional(),
});

export const ModuleSelectionSchema = z.object({
  optimizerType: z.enum(['SPO', 'promptomatix', 'reflection', 'none']),
  depthMode: z.enum(['LIGHT', 'STANDARD', 'DEEP', 'PRODUCTION']),
  gating: z.enum(['single', 'multi']),
  explanation: z.string(),
  depthOverridden: z.boolean(),
  alternative: z
    .object({
      optimizerType: z.enum(['SPO', 'promptomatix', 'reflection', 'none']),
      depthMode: z.enum(['LIGHT', 'STANDARD', 'DEEP', 'PRODUCTION']),
      gating: z.enum(['single', 'multi']),
      explanation: z.string(),
      depthOverridden: z.boolean(),
    })
    .optional(),
});

// ─── Core Selector ─────────────────────────────────────────────────────────────

/** Max depth allowed when safety constraints are active and no user override. */
const MAX_SAFETY_DEPTH: DepthMode = 'PRODUCTION';
/** Min depth enforced for self-improving tasks. */
const MIN_SELF_IMPROVE_DEPTH: DepthMode = 'PRODUCTION';

/**
 * Selects the optimal OLS-MCC module configuration for a given task profile.
 *
 * Decision rules derived from ols-mcc-v4.5.md lines 17-23, with extensions
 * from §8.1-8.3 (optimizer selection) and §11 (gating strategy).
 */
export function selectModules(profile: TaskProfile): ModuleSelection {
  // ── Self-improvement tasks (highest priority) ──
  if (profile.isSelfImproving) {
    const primary = buildSelection(
      'reflection',
      enforceMinDepth(profile, MIN_SELF_IMPROVE_DEPTH),
      'multi',
      profile.userRequestedDepth !== undefined,
      'Self-improvement of OLS meta-tools requires Reflection Optimizer with PRODUCTION depth and multi-perspective gating per v4.5 §8 + §11. Requires human + skill-auditor review.',
      {
        optimizerType: 'SPO',
        depthMode: 'DEEP',
        gating: 'single',
        explanation:
          'If full GRPO training is unavailable, fall back to SPO bootstrapping at DEEP depth with single-perspective gating.',
        depthOverridden: false,
      },
    );
    return primary;
  }

  // ── Complex multi-agent with state ──
  if (profile.isMultiAgent && profile.hasStateManagement) {
    return buildSelection(
      'reflection',
      enforceMinDepth(profile, 'DEEP'),
      'multi',
      profile.userRequestedDepth !== undefined,
      'Complex multi-agent workflows with state require Enhanced Multi-Agent Patterns + Dynamic Alignment at DEEP depth, with multi-perspective gating per v4.5 §10 + §11.',
    );
  }

  // ── Conversational / multi-turn / compliance ──
  if (profile.isConversational) {
    const depth = profile.hasSafetyConstraints
      ? enforceMinDepth(profile, 'DEEP')
      : enforceMinDepth(profile, 'STANDARD');
    return buildSelection(
      'promptomatix',
      depth,
      profile.hasSafetyConstraints ? 'multi' : 'single',
      profile.userRequestedDepth !== undefined,
      profile.hasSafetyConstraints
        ? 'Conversational/compliance agents with safety constraints use Promptomatix cost-aware optimization + multi-perspective gating per v4.5 §8.2 + §11.'
        : 'Conversational agents without hard safety constraints use Promptomatix at STANDARD+ depth with single-perspective gating per v4.5 §8.2.',
    );
  }

  // ── High-frequency reusable prompt/agent ──
  if (profile.isHighFrequency) {
    const depth = enforceMinDepth(profile, 'DEEP');
    return buildSelection(
      'SPO',
      depth,
      depth === 'PRODUCTION' ? 'multi' : 'single',
      profile.userRequestedDepth !== undefined,
      'High-frequency reusable prompts use SPO self-supervised bootstrapping as the default optimizer per v4.5 §8.3. DEEP+ depth because the prompt is reused.',
      depth === 'PRODUCTION'
        ? undefined
        : {
            optimizerType: 'reflection',
            depthMode: 'PRODUCTION',
            gating: 'multi',
            explanation:
              'If the prompt is mission-critical, escalate to Reflection Optimizer at PRODUCTION depth.',
            depthOverridden: true,
          },
    );
  }

  // ── Simple one-off prompt ──
  if (profile.isSimpleOneOff) {
    return buildSelection(
      'none',
      enforceMinDepth(profile, 'STANDARD'),
      'single',
      profile.userRequestedDepth !== undefined,
      'Simple one-off prompts use v4.4 behavior at STANDARD depth — no optimizer overhead per v4.5 decision guidance row 5.',
    );
  }

  // ── Default / ambiguous profile ──
  // If no profile flags are set, default to STANDARD with no optimizer.
  // This is the safe, low-cost default.
  return buildSelection(
    'none',
    enforceMinDepth(profile, 'STANDARD'),
    'single',
    profile.userRequestedDepth !== undefined,
    'Ambiguous task profile — defaulting to STANDARD depth with no optimizer. Reclassify the task with explicit profile flags for a more targeted recommendation.',
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildSelection(
  optimizerType: OptimizerType,
  depthMode: DepthMode,
  gating: GatingStrategy,
  depthOverridden: boolean,
  explanation: string,
  alternative?: ModuleSelection | undefined,
): ModuleSelection {
  return { optimizerType, depthMode, gating, explanation, depthOverridden, alternative };
}

/**
 * Returns the user-requested depth if present, otherwise the inferred depth,
 * clamped to safety minimums.
 */
function enforceMinDepth(
  profile: TaskProfile,
  inferred: DepthMode,
): DepthMode {
  const base = profile.userRequestedDepth ?? inferred;
  // Safety constraints force minimum DEEP unless user explicitly requests lower
  if (profile.hasSafetyConstraints && !profile.userRequestedDepth) {
    return depthMax(base, 'DEEP');
  }
  return base;
}

/** Returns the deeper (more rigorous) of two depth modes. */
export function depthMax(a: DepthMode, b: DepthMode): DepthMode {
  const order: DepthMode[] = ['LIGHT', 'STANDARD', 'DEEP', 'PRODUCTION'];
  const idxA = order.indexOf(a);
  const idxB = order.indexOf(b);
  return order[Math.max(idxA, idxB)]!;
}

// ─── Archetype presets ─────────────────────────────────────────────────────────

/** The 5 archetypes from the v4.5 decision guidance table. */
export const ARCHETYPES: Record<string, TaskProfile> = {
  highFrequencyReusable: {
    isHighFrequency: true,
    isConversational: false,
    isMultiAgent: false,
    isSelfImproving: false,
    isSimpleOneOff: false,
    hasSafetyConstraints: false,
    hasStateManagement: false,
  },
  conversationalCompliance: {
    isHighFrequency: false,
    isConversational: true,
    isMultiAgent: false,
    isSelfImproving: false,
    isSimpleOneOff: false,
    hasSafetyConstraints: true,
    hasStateManagement: false,
  },
  complexMultiAgent: {
    isHighFrequency: false,
    isConversational: false,
    isMultiAgent: true,
    isSelfImproving: false,
    isSimpleOneOff: false,
    hasSafetyConstraints: true,
    hasStateManagement: true,
  },
  selfImprovingMeta: {
    isHighFrequency: false,
    isConversational: false,
    isMultiAgent: false,
    isSelfImproving: true,
    isSimpleOneOff: false,
    hasSafetyConstraints: true,
    hasStateManagement: false,
  },
  simpleOneOff: {
    isHighFrequency: false,
    isConversational: false,
    isMultiAgent: false,
    isSelfImproving: false,
    isSimpleOneOff: true,
    hasSafetyConstraints: false,
    hasStateManagement: false,
  },
};

/** Run all archetypes through the selector and return results. */
export function validateArchetypes(): Map<string, ModuleSelection> {
  const results = new Map<string, ModuleSelection>();
  for (const [name, profile] of Object.entries(ARCHETYPES)) {
    results.set(name, selectModules(profile));
  }
  return results;
}

// ─── Human-readable formatter ──────────────────────────────────────────────────

export function formatModuleSelectionHuman(
  profile: TaskProfile,
  selection: ModuleSelection,
): string {
  const lines = [
    'OLS-MCC Module Selection',
    '────────────────────────',
    '',
    'Task Profile:',
    `  High-frequency:  ${profile.isHighFrequency}`,
    `  Conversational:  ${profile.isConversational}`,
    `  Multi-agent:     ${profile.isMultiAgent}`,
    `  Self-improving:  ${profile.isSelfImproving}`,
    `  Simple one-off:  ${profile.isSimpleOneOff}`,
    `  Safety-critical: ${profile.hasSafetyConstraints}`,
    `  State mgmt:      ${profile.hasStateManagement}`,
    profile.userRequestedDepth
      ? `  User depth:      ${profile.userRequestedDepth} (overridden)`
      : '',
    '',
    'Selection:',
    `  Optimizer:  ${selection.optimizerType}`,
    `  Depth:      ${selection.depthMode}${selection.depthOverridden ? ' (user-overridden)' : ''}`,
    `  Gating:     ${selection.gating}`,
    `  Reason:     ${selection.explanation}`,
    '',
  ];

  if (selection.alternative) {
    lines.push(
      'Alternative:',
      `  Optimizer:  ${selection.alternative.optimizerType}`,
      `  Depth:      ${selection.alternative.depthMode}`,
      `  Gating:     ${selection.alternative.gating}`,
      `  Reason:     ${selection.alternative.explanation}`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Renders a summary table of archetype selections.
 * Useful for verifying the decision table against the v4.5 spec.
 */
export function formatArchetypeTable(): string {
  const results = validateArchetypes();
  const lines = [
    'Archetype                  Optimizer       Depth        Gating',
    '─────────────────────────  ──────────────  ───────────  ──────',
  ];
  for (const [name, sel] of results) {
    lines.push(
      `${name.padEnd(26)} ${sel.optimizerType.padEnd(15)} ${sel.depthMode.padEnd(12)} ${sel.gating}`,
    );
  }
  return lines.join('\n');
}
