/**
 * Trusted scope for a bounded capability recovery probe.
 *
 * Derived from host state (engine run, project, configured model, profile and
 * durable task allowance identity) — never from model output or submission
 * generation — so a model cannot mint a fresh probe budget by relabelling its
 * environment or by an explicit Continue that only bumps generation. Kept out
 * of the action executor so the executor stays under its architectural size
 * budget.
 */

import type { ProgressController } from './progressController.js';

export interface CapabilityRecoveryScopeHost {
  progressController: ProgressController;
  engineRunId: string;
  executionProfile: string;
  taskAllowance: { taskOwnerId: string } | null;
  options: { projectRoot?: string | null | undefined; model?: string | null | undefined };
}

/** Bind the trusted environment identity and return the probe scope key. */
export function bindCapabilityRecoveryScope(
  host: CapabilityRecoveryScopeHost,
): { taskId: string; environmentIdentity: string } {
  const environmentIdentity = [
    host.engineRunId,
    host.options.projectRoot ?? '',
    host.options.model ?? '',
    host.executionProfile,
  ].join('|');
  host.progressController.setTrustedEnvironmentIdentity(environmentIdentity);
  const taskOwnerId = host.taskAllowance?.taskOwnerId?.trim() ?? '';
  return { taskId: taskOwnerId, environmentIdentity };
}
