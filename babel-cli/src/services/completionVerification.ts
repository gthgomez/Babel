import type { WorkspaceVerifyReport } from './workspaceManager.js';

export type CompletionVerificationStatus = 'not_required' | 'pass' | 'fail';

export interface CompletionVerificationGate {
  schema_version: 1;
  status: CompletionVerificationStatus;
  reason: string;
  required: boolean;
  verification: WorkspaceVerifyReport | null;
}

export function evaluateCompletionVerification(input: {
  pipelineStatus: string;
  executionProfile?: string | null;
  projectRoot?: string | null;
  verification?: WorkspaceVerifyReport | null;
}): CompletionVerificationGate {
  const required = input.pipelineStatus === 'COMPLETE' &&
    input.executionProfile === 'workspace_manager' &&
    Boolean(input.projectRoot);

  if (!required) {
    return {
      schema_version: 1,
      status: 'not_required',
      reason: 'Completion verification is only required for completed example_autonomous_agent manager runs with an approved project root.',
      required: false,
      verification: input.verification ?? null,
    };
  }

  if (!input.verification) {
    return {
      schema_version: 1,
      status: 'fail',
      reason: 'example_autonomous_agent manager completion requires a local verification report before COMPLETE is accepted.',
      required: true,
      verification: null,
    };
  }

  if (input.verification.status !== 'pass') {
    return {
      schema_version: 1,
      status: 'fail',
      reason: input.verification.status === 'no_commands'
        ? 'example_autonomous_agent manager completion requires at least one detected or explicit verification command.'
        : 'example_autonomous_agent manager local verification command failed.',
      required: true,
      verification: input.verification,
    };
  }

  return {
    schema_version: 1,
    status: 'pass',
    reason: 'example_autonomous_agent manager local verification passed.',
    required: true,
    verification: input.verification,
  };
}
