import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type EvidenceValidationStatus = 'pass' | 'fail';

export interface EvidenceValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  artifact?: string;
}

export interface EvidenceArtifactCheck {
  artifact: string;
  required: boolean;
  exists: boolean;
  parseable: boolean | null;
}

export interface EvidenceValidationResult {
  schema_version: 1;
  status: EvidenceValidationStatus;
  run_dir: string;
  inferred_status: string | null;
  pipeline_mode: string | null;
  artifacts: EvidenceArtifactCheck[];
  issues: EvidenceValidationIssue[];
}

function readJsonArtifact(runDir: string, artifact: string): { exists: boolean; parseable: boolean; data: unknown | null } {
  const path = join(runDir, artifact);
  if (!existsSync(path)) {
    return { exists: false, parseable: false, data: null };
  }

  try {
    return {
      exists: true,
      parseable: true,
      data: JSON.parse(readFileSync(path, 'utf-8')),
    };
  } catch {
    return { exists: true, parseable: false, data: null };
  }
}

function objectValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringValue(value: unknown, key: string): string | null {
  const raw = objectValue(value, key);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function nestedStringValue(value: unknown, keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    current = objectValue(current, key);
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

function listVersionedArtifacts(runDir: string, prefix: string): string[] {
  if (!existsSync(runDir)) {
    return [];
  }
  return readdirSync(runDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
}

function addArtifact(
  artifacts: EvidenceArtifactCheck[],
  artifact: string,
  required: boolean,
  exists: boolean,
  parseable: boolean | null,
): void {
  artifacts.push({ artifact, required, exists, parseable });
}

function addIssue(
  issues: EvidenceValidationIssue[],
  severity: EvidenceValidationIssue['severity'],
  code: string,
  message: string,
  artifact?: string,
): void {
  issues.push({
    severity,
    code,
    message,
    ...(artifact !== undefined ? { artifact } : {}),
  });
}

export function validateEvidenceBundleRun(runDir: string): EvidenceValidationResult {
  const issues: EvidenceValidationIssue[] = [];
  const artifacts: EvidenceArtifactCheck[] = [];

  if (!existsSync(runDir)) {
    addIssue(issues, 'error', 'run_dir_missing', `Run directory does not exist: ${runDir}`);
    return {
      schema_version: 1,
      status: 'fail',
      run_dir: runDir,
      inferred_status: null,
      pipeline_mode: null,
      artifacts,
      issues,
    };
  }

  const manifest = readJsonArtifact(runDir, '01_manifest.json');
  addArtifact(artifacts, '01_manifest.json', true, manifest.exists, manifest.exists ? manifest.parseable : null);
  if (!manifest.exists) {
    addIssue(issues, 'error', 'manifest_missing', 'Completion evidence requires 01_manifest.json.', '01_manifest.json');
  } else if (!manifest.parseable) {
    addIssue(issues, 'error', 'manifest_unparseable', '01_manifest.json is not valid JSON.', '01_manifest.json');
  }

  const runtimeTelemetry = readJsonArtifact(runDir, '06_runtime_telemetry.json');
  addArtifact(artifacts, '06_runtime_telemetry.json', false, runtimeTelemetry.exists, runtimeTelemetry.exists ? runtimeTelemetry.parseable : null);
  if (runtimeTelemetry.exists && !runtimeTelemetry.parseable) {
    addIssue(issues, 'warning', 'runtime_telemetry_unparseable', '06_runtime_telemetry.json is not valid JSON.', '06_runtime_telemetry.json');
  }

  const executionReport = readJsonArtifact(runDir, '04_execution_report.json');
  addArtifact(artifacts, '04_execution_report.json', false, executionReport.exists, executionReport.exists ? executionReport.parseable : null);
  if (executionReport.exists && !executionReport.parseable) {
    addIssue(issues, 'error', 'execution_report_unparseable', '04_execution_report.json is not valid JSON.', '04_execution_report.json');
  }

  const swePlans = listVersionedArtifacts(runDir, '02_swe_plan_v');
  const qaVerdicts = listVersionedArtifacts(runDir, '03_qa_verdict_v');
  addArtifact(artifacts, '02_swe_plan_v*.json', false, swePlans.length > 0, swePlans.length > 0 ? true : null);
  addArtifact(artifacts, '03_qa_verdict_v*.json', false, qaVerdicts.length > 0, qaVerdicts.length > 0 ? true : null);

  const pipelineMode =
    nestedStringValue(manifest.data, ['analysis', 'pipeline_mode']) ??
    nestedStringValue(manifest.data, ['runtime_telemetry', 'pipeline_mode']);
  const executionStatus = stringValue(executionReport.data, 'status');
  const finalOutcome =
    stringValue(runtimeTelemetry.data, 'final_outcome') ??
    nestedStringValue(manifest.data, ['runtime_telemetry', 'final_outcome']);
  const inferredStatus = executionStatus ?? finalOutcome;
  const completionClaimed = finalOutcome === 'COMPLETE' || executionStatus === 'EXECUTION_COMPLETE';

  if (completionClaimed) {
    if (swePlans.length === 0) {
      addIssue(issues, 'error', 'swe_plan_missing_for_completion', 'Completed runs require at least one 02_swe_plan_v*.json artifact.', '02_swe_plan_v*.json');
    }

    if (pipelineMode !== 'direct' && pipelineMode !== 'manual' && qaVerdicts.length === 0) {
      addIssue(issues, 'error', 'qa_verdict_missing_for_completion', 'Completed verified/autonomous runs require at least one 03_qa_verdict_v*.json artifact.', '03_qa_verdict_v*.json');
    }

    if (pipelineMode === 'autonomous' && !executionReport.exists) {
      addIssue(issues, 'error', 'execution_report_missing_for_autonomous_completion', 'Completed autonomous runs require 04_execution_report.json.', '04_execution_report.json');
    }

    if (executionStatus === 'EXECUTION_COMPLETE') {
      const toolCallLog = objectValue(executionReport.data, 'tool_call_log');
      if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) {
        addIssue(issues, 'error', 'execution_log_empty_for_completion', 'EXECUTION_COMPLETE requires a non-empty tool_call_log.', '04_execution_report.json');
      }
    }
  }

  if (
    finalOutcome === 'COMPLETE' &&
    (executionStatus === 'EXECUTION_HALTED' || executionStatus === 'ACTIVATION_REFUSED')
  ) {
    addIssue(
      issues,
      'error',
      'terminal_status_conflict',
      `Runtime telemetry claims COMPLETE but execution report status is ${executionStatus}.`,
      '04_execution_report.json',
    );
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  return {
    schema_version: 1,
    status: hasErrors ? 'fail' : 'pass',
    run_dir: runDir,
    inferred_status: inferredStatus,
    pipeline_mode: pipelineMode,
    artifacts,
    issues,
  };
}

export function formatEvidenceValidationHuman(result: EvidenceValidationResult): string {
  const lines = [
    `Evidence validation: ${result.status}`,
    `Run: ${result.run_dir}`,
    `Inferred status: ${result.inferred_status ?? '(unknown)'}`,
    `Pipeline mode: ${result.pipeline_mode ?? '(unknown)'}`,
  ];

  if (result.issues.length === 0) {
    lines.push('Issues: none');
    return lines.join('\n');
  }

  lines.push('Issues:');
  for (const issue of result.issues) {
    lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
  }
  return lines.join('\n');
}
