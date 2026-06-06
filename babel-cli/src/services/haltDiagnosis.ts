import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompletionVerificationGate } from './completionVerification.js';
import type { ModelEscalationRecommendation } from './modelEscalationRules.js';

export interface HaltDiagnosis {
  schema_version: 1;
  status:
    | 'complete_verified'
    | 'complete_unverified'
    | 'verification_failed'
    | 'approval_required'
    | 'executor_halted'
    | 'qa_rejected'
    | 'failed'
    | 'unknown';
  run_dir: string | null;
  headline: string;
  halt_tag: string | null;
  denial_reason_codes: string[];
  warning_tags: string[];
  next_actions: string[];
  escalation: ModelEscalationRecommendation | null;
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function collectStringsByKey(value: unknown, key: string, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsByKey(item, key, acc);
    }
    return acc;
  }
  if (!value || typeof value !== 'object') {
    return acc;
  }
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryKey === key && typeof entryValue === 'string' && entryValue.length > 0) {
      acc.push(entryValue);
    }
    collectStringsByKey(entryValue, key, acc);
  }
  return acc;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function statusFromInputs(input: {
  pipelineStatus?: string | null;
  approvalRequired?: boolean;
  verification?: CompletionVerificationGate | null;
  executionStatus?: string | null;
  haltTag?: string | null;
}): HaltDiagnosis['status'] {
  if (input.approvalRequired === true) return 'approval_required';
  if (input.verification?.status === 'fail') return 'verification_failed';
  if (input.pipelineStatus === 'COMPLETE' && input.verification?.status === 'pass') return 'complete_verified';
  if (input.pipelineStatus === 'COMPLETE') return 'complete_unverified';
  if (input.pipelineStatus === 'QA_REJECTED_MAX_LOOPS') return 'qa_rejected';
  if (input.pipelineStatus === 'EXECUTOR_HALTED' || input.executionStatus === 'EXECUTION_HALTED' || input.haltTag) return 'executor_halted';
  if (input.pipelineStatus === 'FATAL_ERROR' || input.pipelineStatus === 'FAILED') return 'failed';
  return 'unknown';
}

function headlineForStatus(status: HaltDiagnosis['status']): string {
  switch (status) {
    case 'complete_verified':
      return 'Run completed and local verification passed.';
    case 'complete_unverified':
      return 'Run completed, but no required local verification evidence was attached.';
    case 'verification_failed':
      return 'Run reached completion boundary but local verification failed.';
    case 'approval_required':
      return 'Run is blocked on an explicit approval.';
    case 'executor_halted':
      return 'Executor halted before a verified completion.';
    case 'qa_rejected':
      return 'QA rejected available plans until the loop limit.';
    case 'failed':
      return 'Run failed before completion.';
    case 'unknown':
      return 'Run outcome is unknown from available artifacts.';
  }
}

function nextActionsFor(input: {
  status: HaltDiagnosis['status'];
  denialReasonCodes: string[];
  escalation: ModelEscalationRecommendation | null;
}): string[] {
  const actions: string[] = [];
  if (input.status === 'approval_required') {
    actions.push('Run `babel approvals list --status pending --json`, approve or deny the relevant request, then resume the job.');
  }
  if (input.status === 'verification_failed' || input.status === 'complete_unverified') {
    actions.push('Run `babel verify <project-root> --json` or provide explicit verification commands before accepting COMPLETE.');
  }
  if (input.status === 'qa_rejected') {
    actions.push('Reduce the plan to concrete file edits plus verifier commands, then rerun.');
  }
  if (input.denialReasonCodes.includes('dependency_install_requires_approval')) {
    actions.push('Approve the exact install request or choose a source-only route that avoids dependency installation.');
  }
  if (input.denialReasonCodes.includes('command_allowlist_rejected')) {
    actions.push('Use a profile-supported command or add a narrowly scoped benchmark/local capability with tests.');
  }
  if (input.escalation?.should_escalate === true) {
    actions.push('Request/approve model escalation for the exact task before retrying.');
  }
  if (actions.length === 0) {
    actions.push('Inspect the run artifacts and rerun with stricter evidence requirements.');
  }
  return actions;
}

export function diagnoseRun(input: {
  runDir?: string | null;
  pipelineStatus?: string | null;
  approvalRequired?: boolean;
  verification?: CompletionVerificationGate | null;
  escalation?: ModelEscalationRecommendation | null;
}): HaltDiagnosis {
  const executionReport = input.runDir ? readJson(join(input.runDir, '04_execution_report.json')) : null;
  const runtimeTelemetry = input.runDir ? readJson(join(input.runDir, '06_runtime_telemetry.json')) : null;
  const executionStatus = asRecord(executionReport)['status'];
  const pipelineError = asRecord(asRecord(executionReport)['pipeline_error']);
  const haltTag =
    typeof pipelineError['halt_tag'] === 'string' ? pipelineError['halt_tag'] :
    typeof asRecord(runtimeTelemetry)['halt_tag'] === 'string' ? String(asRecord(runtimeTelemetry)['halt_tag']) :
    null;
  const denialReasonCodes = unique([
    ...collectStringsByKey(executionReport, 'reason_code'),
    ...collectStringsByKey(runtimeTelemetry, 'reason_code'),
  ]);
  const warningTags = unique([
    ...collectStringsByKey(executionReport, 'warning_tag'),
    ...collectStringsByKey(runtimeTelemetry, 'warning_tag'),
    ...collectStringsByKey(runtimeTelemetry, 'tag'),
  ]);
  const statusInput: Parameters<typeof statusFromInputs>[0] = {
    pipelineStatus: input.pipelineStatus ?? (typeof asRecord(runtimeTelemetry)['final_outcome'] === 'string'
      ? String(asRecord(runtimeTelemetry)['final_outcome'])
      : null),
    verification: input.verification ?? null,
    executionStatus: typeof executionStatus === 'string' ? executionStatus : null,
    haltTag,
  };
  if (input.approvalRequired !== undefined) {
    statusInput.approvalRequired = input.approvalRequired;
  }
  const status = statusFromInputs(statusInput);

  return {
    schema_version: 1,
    status,
    run_dir: input.runDir ?? null,
    headline: headlineForStatus(status),
    halt_tag: haltTag,
    denial_reason_codes: denialReasonCodes,
    warning_tags: warningTags,
    next_actions: nextActionsFor({ status, denialReasonCodes, escalation: input.escalation ?? null }),
    escalation: input.escalation ?? null,
  };
}

export function formatHaltDiagnosisHuman(diagnosis: HaltDiagnosis): string {
  return [
    'Babel Halt Diagnosis',
    `Status: ${diagnosis.status}`,
    `Headline: ${diagnosis.headline}`,
    `Run: ${diagnosis.run_dir ?? '(none)'}`,
    `Halt tag: ${diagnosis.halt_tag ?? '(none)'}`,
    `Denials: ${diagnosis.denial_reason_codes.join(', ') || '(none)'}`,
    `Warnings: ${diagnosis.warning_tags.join(', ') || '(none)'}`,
    'Next actions:',
    ...diagnosis.next_actions.map(action => `  - ${action}`),
  ].join('\n');
}
