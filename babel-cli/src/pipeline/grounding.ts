/**
 * grounding.ts — Plan target extraction, artifact building, and grounding helpers
 *
 * Extracted from pipeline.ts (Phase 1B pipeline decomposition).
 */

import type { SwePlan } from '../schemas/agentContracts.js';
import type { BabelIntentContract } from '../services/liteFullRouter.js';
import {
  plannedVerificationCommandsFromPlan,
  hasImplementationVerificationStrategy,
} from '../pipeline/planVerifierInjection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CriticVerdict = 'pass' | 'revise' | 'block';
export type CriticSeverity = 'minor' | 'major' | 'critical';

export interface CounterAgentCritiqueArtifact {
  schema_version: 1;
  artifact_type: 'babel_counter_agent_critique';
  critic_verdict: CriticVerdict;
  severity: CriticSeverity;
  required_changes: string[];
  optional_suggestions: string[];
}

// ─── Plan target helpers ────────────────────────────────────────────────────

export function uniqueList(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.map((value) => value?.trim() ?? '').filter((value) => value.length > 0)),
  ];
}

export function planStepString(step: SwePlan['minimal_action_set'][number]): string {
  const tool = String(step.tool ?? 'tool');
  const target = String(step.target ?? '').trim();
  return target ? `${tool}: ${target}` : tool;
}

export function plannedFileWriteTargets(plan: SwePlan | null | undefined): string[] {
  return uniqueList(
    (plan?.minimal_action_set ?? [])
      .filter((step) => String(step.tool ?? '') === 'file_write')
      .map((step) => String(step.target ?? '')),
  );
}

export function plannedVerificationCommands(plan: SwePlan | null | undefined): string[] {
  return uniqueList(plannedVerificationCommandsFromPlan(plan));
}

// ─── Artifact builders ──────────────────────────────────────────────────────

export function buildCounterAgentCritiqueArtifact(input: {
  plan: SwePlan;
  intent: BabelIntentContract;
  targetScopeViolations?: string[];
}): CounterAgentCritiqueArtifact {
  const requiredChanges: string[] = [];
  let severity: CriticSeverity = 'minor';

  if (input.plan.plan_type === 'IMPLEMENTATION_PLAN' && !input.intent.mutation_allowed) {
    severity = 'critical';
    requiredChanges.push(
      'Original intent was read-only/no-write, so an implementation plan must be converted to a report, proposal, or blocked summary before execution.',
    );
  }

  for (const violation of input.targetScopeViolations ?? []) {
    severity = 'critical';
    requiredChanges.push(violation);
  }

  const hasVerificationStrategy =
    hasImplementationVerificationStrategy(input.plan) ||
    plannedFileWriteTargets(input.plan).length === 0;

  if (
    input.plan.plan_type === 'IMPLEMENTATION_PLAN' &&
    input.intent.mutation_allowed &&
    !hasVerificationStrategy
  ) {
    severity = severity === 'critical' ? 'critical' : 'major';
    requiredChanges.push(
      'Implementation plans must include a verification command or explicit verification step before file edits are unlocked.',
    );
  }

  return {
    schema_version: 1,
    artifact_type: 'babel_counter_agent_critique',
    critic_verdict: requiredChanges.length > 0 ? 'block' : 'pass',
    severity,
    required_changes: requiredChanges,
    optional_suggestions:
      requiredChanges.length > 0
        ? []
        : ['Keep the implementation scope minimal and preserve pre-existing local changes.'],
  };
}

export function buildAcceptedRevisedPlanArtifact(input: {
  task: string;
  plan: SwePlan;
  intent: BabelIntentContract;
  targetProjectRoot: string | null;
  critique: CounterAgentCritiqueArtifact;
}): Record<string, unknown> {
  const filesLikelyToChange = plannedFileWriteTargets(input.plan);
  const verificationCommands = plannedVerificationCommands(input.plan);
  const accepted =
    input.critique.critic_verdict === 'pass' &&
    (input.plan.plan_type !== 'IMPLEMENTATION_PLAN' || input.intent.mutation_allowed) &&
    (input.plan.plan_type !== 'IMPLEMENTATION_PLAN' ||
      verificationCommands.length > 0 ||
      filesLikelyToChange.length === 0);

  return {
    schema_version: 1,
    artifact_type: 'babel_accepted_revised_plan',
    accepted,
    edits_unlocked: accepted && filesLikelyToChange.length > 0,
    original_user_intent: input.task,
    task_kind: input.intent.task_kind,
    write_intent: input.intent.write_intent,
    write_confidence: input.intent.write_confidence,
    mutation_allowed: input.intent.mutation_allowed,
    target_project_root: input.targetProjectRoot,
    files_likely_to_change: filesLikelyToChange,
    files_explicitly_forbidden: [],
    implementation_steps: input.plan.minimal_action_set.map(planStepString),
    verification_commands: verificationCommands,
    rollback_recovery_strategy:
      'Preserve pre-existing local changes; if verification or final review fails, stop with evidence and use Babel recovery/continue commands.',
    counter_agent_verdict: {
      critic_verdict: input.critique.critic_verdict,
      severity: input.critique.severity,
      required_changes: input.critique.required_changes,
      optional_suggestions: input.critique.optional_suggestions,
    },
    remaining_risks:
      input.critique.critic_verdict === 'pass'
        ? [
            'Verification may still fail at runtime; blocked runs should preserve evidence for recovery.',
          ]
        : input.critique.required_changes,
  };
}
