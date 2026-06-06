import { join } from 'node:path';

import { buildFailureCapsule, type FailureCapsule } from './repairGovernance.js';

export const PRE_EXECUTION_FAILURE_CAPSULE_FILENAME = '12_pre_execution_failure_capsule.json';

export interface PreExecutionFailureArtifacts {
  condition: string;
  executionReport: {
    status: 'EXECUTION_HALTED';
    stage_status: 'EXECUTION_ATTEMPTED';
    steps_executed: 0;
    tool_call_log: [];
    pipeline_error: {
      halt_tag: 'TOOL_CALL_ERROR';
      halted_at_step: 1;
      condition: string;
    };
    warnings: string[];
  };
  failureCapsule: FailureCapsule;
  failureCapsulePath: string;
}

export function buildPreExecutionFailureArtifacts(input: {
  runDir: string;
  error: unknown;
}): PreExecutionFailureArtifacts {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const condition = `[PRE_EXECUTION_FAILURE] ${message}`;
  const failureCapsulePath = join(input.runDir, PRE_EXECUTION_FAILURE_CAPSULE_FILENAME);
  const failureCapsule = buildFailureCapsule({
    attempt: 1,
    pipelineStatus: 'FATAL_ERROR',
    error: message,
    changedFiles: [],
    exactInvariantStatus: 'unknown',
  });

  return {
    condition,
    executionReport: {
      status: 'EXECUTION_HALTED',
      stage_status: 'EXECUTION_ATTEMPTED',
      steps_executed: 0,
      tool_call_log: [],
      pipeline_error: {
        halt_tag: 'TOOL_CALL_ERROR',
        halted_at_step: 1,
        condition,
      },
      warnings: [
        'Failure occurred before executor activation; this report exists so resume, inspect, and benchmark tools have a stable artifact to read.',
      ],
    },
    failureCapsule,
    failureCapsulePath,
  };
}
