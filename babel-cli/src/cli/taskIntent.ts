import type { LiteVerb } from './structuredOutput.js';

/** Classify ordinary task text without loading a workflow or execution engine. */
export function classifyDoTask(task: string): Exclude<LiteVerb, 'do'> {
  const normalized = task.toLowerCase();
  const hasMutationIntent =
    /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/.test(
      normalized,
    );
  const startsWithPlanningIntent =
    /^\s*(plan|design|approach|compare|outline)\b/.test(normalized) ||
    /\b(implementation path|migration plan)\b/.test(normalized);
  if (
    startsWithPlanningIntent &&
    !/^\s*(apply|fix|repair|write|create|delete|remove)\b/.test(normalized)
  ) {
    return 'plan';
  }
  if (
    /\b(explain|summarize|what|why|how|read[- ]only|do not edit|do not modify|without editing|without changes)\b/.test(
      normalized,
    ) &&
    !hasMutationIntent
  ) {
    return 'ask';
  }
  if (
    /\b(plan|design|approach|compare|implementation path)\b/.test(normalized) &&
    !hasMutationIntent
  ) {
    return 'plan';
  }
  if (
    /\b(investigate|analy[sz]e|audit|diagnose|diagnostic|assess|report|findings?|evaluate)\b/.test(
      normalized,
    ) &&
    !hasMutationIntent
  ) {
    return 'report';
  }
  if (
    /\b(patch|diff|propose|proposal)\b/.test(normalized) &&
    !/\b(apply|edit|modify|change|fix|repair|implement|write|create|delete|remove)\b/.test(
      normalized,
    )
  ) {
    return 'patch';
  }
  if (hasMutationIntent) {
    return 'fix';
  }
  return 'plan';
}
