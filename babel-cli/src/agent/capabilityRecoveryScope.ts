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

import type { IsolationBrokerFlags } from './chatEngineIsolationFlags.js';
import type { ProgressController } from './progressController.js';

export interface CapabilityRecoveryScopeHost {
  progressController: ProgressController;
  engineRunId: string;
  executionProfile: string;
  taskAllowance: { taskOwnerId: string } | null;
  options: { projectRoot?: string | null | undefined; model?: string | null | undefined };
}

export interface IsolationPrerequisiteScopeHost extends CapabilityRecoveryScopeHost {
  isolationBrokerFlags: () => IsolationBrokerFlags;
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

/** Fingerprint of governed isolation facts; changes re-arm shell prerequisite probes. */
export function isolationPrerequisiteRevisionKey(flags: IsolationBrokerFlags): string {
  // Dirty-tree is a separate broker gate; unrelated edits must not re-admit the
  // same isolation_unavailable shell denial.
  return [
    flags.isolationRequired ? '1' : '0',
    flags.isolationAvailable ? '1' : '0',
    flags.hostFallbackAllowed ? '1' : '0',
  ].join(':');
}

export function shellBlockedByIsolation(flags: IsolationBrokerFlags): boolean {
  return (
    flags.isolationRequired &&
    !flags.isolationAvailable &&
    !flags.hostFallbackAllowed
  );
}

/** Trusted scope for a bounded isolation prerequisite denial probe. */
export function bindIsolationPrerequisiteScope(host: IsolationPrerequisiteScopeHost): {
  prerequisiteKey: string;
  taskId: string;
  environmentIdentity: string;
  revisionKey: string;
} {
  const base = bindCapabilityRecoveryScope(host);
  const flags = host.isolationBrokerFlags();
  return {
    prerequisiteKey: 'isolation_unavailable:shell',
    taskId: base.taskId,
    environmentIdentity: base.environmentIdentity,
    revisionKey: isolationPrerequisiteRevisionKey(flags),
  };
}
