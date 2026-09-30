/**
 * Plan mode adapter — the read-only plan lane behind the shared runtime facade.
 *
 * Plan remains a hard-plan ChatEngine lane on this surface (P02 capability).
 * The adapter routes to the same structural subject as chat but preserves the
 * distinct `plan` controller semantics: read-only mutation policy,
 * handoff-required approval and plan-artifact completion are still enforced by
 * `modePolicyFor('plan')`, `assertEffectAllowed` and the kernel completion
 * decision. This adapter never authorizes an executor terminal.
 */

import { modePolicyFor } from '../../executor/contracts.js';
import { resolveModeCapability } from '../../executor/modeAdapters.js';
import {
  type RuntimeModeAdapter,
  type RuntimeTurnRequest,
} from '../contracts.js';
import { requireRuntimeSubject } from './chat.js';

/** Plan controller: read_only mutation, plan_artifact completion. */
export function createPlanRuntimeAdapter(): RuntimeModeAdapter {
  // Guard the invariant the adapter depends on: if plan policy ever stops being
  // read-only, routing a Plan turn through this adapter would be unsafe.
  if (modePolicyFor('plan').mutationPolicy !== 'read_only') {
    throw new Error('Plan runtime adapter requires the read_only mode policy');
  }

  return {
    mode: 'plan',
    controller: 'chat_engine',
    capability: resolveModeCapability('plan'),
    async *submit(request: RuntimeTurnRequest) {
      const subject = requireRuntimeSubject(request);
      yield* subject.submitMessageStream(request.task, request.intent);
    },
    async cancel(request) {
      requireRuntimeSubject(request).cancel?.();
    },
  };
}
