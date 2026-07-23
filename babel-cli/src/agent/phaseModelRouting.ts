// ─── Phase Model Routing ─────────────────────────────────────────────────────
// Pure resolver: "which model name for phase X given configured limits?"
// Extracted from chatEngine.resolveRoutedRunner() for unit-testability.
// The runner instantiation stays in chatEngine; this module only answers the
// model-name question.

import type { ChatPhase } from './chatPhaseNudge.js';

/**
 * Resolve which model name to use for a given chat phase.
 *
 * Pure function — no side effects, no env reads, no runner instantiation.
 * Callers pass already-resolved limits (from resolveChatEngineLimits or env).
 *
 * Routing contract:
 * - investigateModel wins when phase is null (first turn) or 'investigate'
 * - mutateModel wins when phase is non-null and not 'investigate'
 * - undefined (caller uses primary deliberation model) otherwise
 *
 * @param phase   Current phase (null = first turn, not yet classified)
 * @param limits  investigateModel / mutateModel from resolved engine limits
 * @returns The model name to use, or undefined to use the primary deliberation model
 */
export function resolvePhaseModelName(
  phase: ChatPhase | null,
  limits: { investigateModel?: string | undefined; mutateModel?: string | undefined },
): string | undefined {
  if (limits.investigateModel && (!phase || phase === 'investigate')) {
    return limits.investigateModel;
  }
  if (limits.mutateModel && phase && phase !== 'investigate') {
    return limits.mutateModel;
  }
  return undefined;
}
