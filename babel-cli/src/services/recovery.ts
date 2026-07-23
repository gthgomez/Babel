import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { readLatestRunPointer } from '../cli/helpers.js';
import {
  SCHEMA_FAILURE_LEDGER_FILENAME,
  SCHEMA_LEARNING_DIR,
  SCHEMA_SHADOW_HINTS_FILENAME,
} from './schemaFailureLedger.js';

export type RecoveryClassification =
  | 'retry_same_command'
  | 'retry_with_schema_repair'
  | 'continue_from_plan'
  | 'rerun_verifier'
  | 'requires_user_decision';

export interface RecoverySummary {
  status: 'CONTINUE_READY' | 'NO_LATEST_RUN' | 'RUN_NOT_FOUND';
  run_dir: string | null;
  classification: RecoveryClassification | null;
  retryable: boolean;
  reason: string;
  next_command: string | null;
  available_artifacts: Record<string, string>;
  missing_artifacts: string[];
  evidence: {
    terminal_status: string | null;
    execution_status: string | null;
    failure_capsule_id: string | null;
  };
  next: string[];
}

export interface RecoveryArtifactRef {
  key: string;
  filename: string;
  path: string;
}

export interface MissingRecoveryArtifactRef {
  key: string;
  filename: string;
}

export interface RecoveryAssessment {
  status: 'CONTINUE_READY' | 'NO_LATEST_RUN' | 'RUN_NOT_FOUND';
  run_dir: string | null;
  resolved_from: 'latest' | 'run_dir' | 'run' | 'none';
  classification: RecoveryClassification | null;
  retryable: boolean;
  reason: string;
  next_action: string;
  next_command: string | null;
  available_artifacts: RecoveryArtifactRef[];
  missing_artifacts: MissingRecoveryArtifactRef[];
  terminal_status_summary: Record<string, unknown> | null;
  execution_report: Record<string, unknown> | null;
  failure_capsule: Record<string, unknown> | null;
  failure_code: string | null;
  failed_command: string | null;
}

export interface RecoveryAssessmentOptions {
  run?: string;
  runDir?: string;
  run_dir?: string;
  runsDir?: string;
  project?: string;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    // Lightweight integrity check: reject empty or trivially small files
    // as corrupt rather than silently consuming them.
    if (statSync(path).size < 10) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unwrapFailureCapsule(
  capsule: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!capsule) {
    return null;
  }
  const nested = capsule['capsule'];
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return {
      ...capsule,
      ...(nested as Record<string, unknown>),
    };
  }
  return capsule;
}

function resolveLatestByMtime(): string | null {
  if (!existsSync(BABEL_RUNS_DIR)) {
    return null;
  }
  const candidates = readdirSync(BABEL_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(BABEL_RUNS_DIR, entry.name))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

function readLatestPointerFromRunsDir(runsDir: string, project?: string): string | null {
  const scoped = project ? join(runsDir, `.latest.${project}.json`) : null;
  const candidates = scoped
    ? [scoped, join(runsDir, '.latest.json')]
    : [join(runsDir, '.latest.json')];
  for (const candidate of candidates) {
    const parsed = readJson(candidate);
    const runDir = parsed?.['run_dir'];
    if (typeof runDir === 'string' && runDir.length > 0) {
      return runDir;
    }
  }
  return null;
}

export function resolveRecoveryRunDir(reference: string, project?: string): string | null {
  if (reference === 'latest') {
    return readLatestRunPointer(project)?.run_dir ?? resolveLatestByMtime();
  }
  return isAbsolute(reference) ? reference : resolve(reference);
}

function findFailureCapsule(
  runDir: string,
  terminal: Record<string, unknown> | null,
): string | null {
  const terminalPath =
    typeof terminal?.['failure_capsule_path'] === 'string'
      ? terminal['failure_capsule_path']
      : null;
  if (terminalPath && existsSync(terminalPath)) {
    return terminalPath;
  }

  const known = [
    join(runDir, '12_pre_execution_failure_capsule.json'),
    join(runDir, '12_repair_failure_capsule_attempt_1.json'),
  ];
  for (const path of known) {
    if (existsSync(path)) {
      return path;
    }
  }

  if (!existsSync(runDir)) {
    return null;
  }
  const dynamic = readdirSync(runDir)
    .filter((name) => /failure_capsule.*\.json$/i.test(name))
    .map((name) => join(runDir, name));
  return dynamic[0] ?? null;
}

function sanitizeTerminalSummary(
  terminal: Record<string, unknown> | null,
  availableCapsulePath: string | null,
): Record<string, unknown> | null {
  if (!terminal) {
    return null;
  }
  return {
    ...terminal,
    failure_capsule_path: availableCapsulePath,
  };
}

function classifyRecovery(input: {
  terminal: Record<string, unknown> | null;
  execution: Record<string, unknown> | null;
  capsule: Record<string, unknown> | null;
  hasManualPlan: boolean;
}): {
  classification: RecoveryClassification;
  reason: string;
  retryable: boolean;
  nextCommand: string;
} {
  const terminalStatus = String(input.terminal?.['status'] ?? '');
  const executionStatus = String(input.execution?.['status'] ?? '');
  const capsuleCategory = String(
    input.capsule?.['category'] ?? input.capsule?.['reason_category'] ?? '',
  );
  const capsuleFailureCode = String(input.capsule?.['failure_code'] ?? '');
  const terminalReason = String(
    input.terminal?.['reason_category'] ?? input.terminal?.['condition_summary'] ?? '',
  );
  const executionCondition = JSON.stringify(input.execution?.['pipeline_error'] ?? '');
  const capsuleRetryable =
    typeof input.capsule?.['retryable'] === 'boolean'
      ? (input.capsule['retryable'] as boolean)
      : null;
  // Match patterns against specific structured fields instead of a
  // concatenated blob. Narrow regexes prevent false positives where
  // unrelated fields coincidentally contain substrings like "test" or
  // "manual" (e.g., in serialized error messages or stack traces).
  const fieldHas = (pattern: RegExp, ...fs: (string | undefined | null)[]): boolean =>
    fs.some((f) => typeof f === 'string' && pattern.test(f));

  // (1) User-decision checks — approval, permission, ambiguous contracts
  if (
    fieldHas(
      /APPROVAL_REQUIRED|permission|blocked|requires_user|AMBIGUOUS|exact_contract_failure|dependency installation requires explicit approval/i,
      terminalStatus,
      terminalReason,
      capsuleCategory,
      capsuleFailureCode,
      executionStatus,
    )
  ) {
    return {
      classification: 'requires_user_decision',
      reason:
        'The next step needs a user decision such as approval, credentials, or a policy choice.',
      retryable: false,
      nextCommand: fieldHas(
        /approval|dependency installation/i,
        terminalStatus,
        terminalReason,
        capsuleFailureCode,
      )
        ? 'babel approvals list --status pending'
        : 'babel continue latest',
    };
  }
  // (2) Schema/provider failures — Zod, JSON, invalid schema
  if (
    fieldHas(
      /schema|PROVIDER_SCHEMA_INVALID|invalid json|zod/i,
      terminalStatus,
      capsuleFailureCode,
      executionStatus,
    )
  ) {
    return {
      classification: 'retry_with_schema_repair',
      reason: 'Provider output failed a structured schema before the task could finish.',
      retryable: capsuleRetryable ?? true,
      nextCommand: 'babel continue latest',
    };
  }
  // (3) Network/provider timeouts and transient errors — keep narrow
  if (
    fieldHas(
      /provider_timeout|request timeout|network error|fetch failed|HTTP 408|HTTP 429|HTTP 5\d\d/i,
      capsuleFailureCode,
      executionCondition,
    )
  ) {
    return {
      classification: 'retry_same_command',
      reason:
        'The provider or network failed before the task could finish; retry the same command or choose another model tier.',
      retryable: capsuleRetryable ?? true,
      nextCommand: 'babel continue latest',
    };
  }
  // (4) Manual bridge / plan continuation — match only terminal/manual fields
  if (
    fieldHas(/MANUAL_BRIDGE_REQUIRED|manual/i, terminalStatus, executionStatus) ||
    input.hasManualPlan
  ) {
    return {
      classification: 'continue_from_plan',
      reason: 'A plan artifact is available or the run paused for plan continuation.',
      retryable: true,
      nextCommand: 'babel resume --run "<run_dir>"',
    };
  }
  // (5) Verifier failure — match verifier-specific fields only, not generic "test"
  if (
    fieldHas(
      /VERIFIER_FAILED|REQUIRED_VERIFIER|verifier/i,
      terminalStatus,
      terminalReason,
      capsuleFailureCode,
    )
  ) {
    return {
      classification: 'rerun_verifier',
      reason: 'The run reached verification and needs the verifier result addressed or rerun.',
      retryable: capsuleRetryable ?? true,
      nextCommand: 'babel continue latest',
    };
  }
  return {
    classification: 'retry_same_command',
    reason:
      'No specialized recovery path was detected; retrying the same user command is the safest next action.',
    retryable: capsuleRetryable ?? true,
    nextCommand: 'babel continue latest',
  };
}

function addArtifact(
  available: RecoveryArtifactRef[],
  missing: MissingRecoveryArtifactRef[],
  key: string,
  path: string,
): boolean {
  const filename = path.split(/[\\/]/).pop() ?? path;
  if (existsSync(path)) {
    available.push({ key, filename, path });
    return true;
  }
  missing.push({ key, filename });
  return false;
}

function addOptionalArtifact(available: RecoveryArtifactRef[], key: string, path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  const filename = path.split(/[\\/]/).pop() ?? path;
  available.push({ key, filename, path });
  return true;
}

function resolveAssessmentRunDir(options: RecoveryAssessmentOptions): {
  runDir: string | null;
  resolvedFrom: RecoveryAssessment['resolved_from'];
} {
  const runsDir = resolve(options.runsDir ?? BABEL_RUNS_DIR);
  const direct = options.runDir ?? options.run_dir;
  if (direct) {
    return { runDir: isAbsolute(direct) ? direct : resolve(direct), resolvedFrom: 'run_dir' };
  }
  if (options.run && options.run !== 'latest') {
    return {
      runDir: isAbsolute(options.run) ? options.run : resolve(options.run),
      resolvedFrom: 'run',
    };
  }
  const latest = readLatestPointerFromRunsDir(runsDir, options.project);
  if (latest) {
    return { runDir: latest, resolvedFrom: 'latest' };
  }
  const newest = options.runsDir ? null : resolveLatestByMtime();
  return { runDir: newest, resolvedFrom: newest ? 'latest' : 'none' };
}

export function buildRecoveryAssessment(
  options: RecoveryAssessmentOptions = {},
): RecoveryAssessment {
  const { runDir, resolvedFrom } = resolveAssessmentRunDir(options);
  if (!runDir) {
    return {
      status: 'NO_LATEST_RUN',
      run_dir: null,
      resolved_from: 'none',
      classification: null,
      retryable: false,
      reason: 'No latest Babel run pointer or run directory was found.',
      next_action: 'Run a Babel command first, then retry continue latest.',
      next_command: null,
      available_artifacts: [],
      missing_artifacts: [
        { key: 'terminal_status_summary', filename: 'terminal_status_summary.json' },
        { key: 'execution_report', filename: '04_execution_report.json' },
      ],
      terminal_status_summary: null,
      execution_report: null,
      failure_capsule: null,
      failure_code: null,
      failed_command: null,
    };
  }
  if (!existsSync(runDir)) {
    return {
      status: 'RUN_NOT_FOUND',
      run_dir: runDir,
      resolved_from: resolvedFrom,
      classification: null,
      retryable: false,
      reason: 'The requested run directory does not exist.',
      next_action: 'Check the run path or use continue latest.',
      next_command: null,
      available_artifacts: [],
      missing_artifacts: [{ key: 'run_dir', filename: runDir }],
      terminal_status_summary: null,
      execution_report: null,
      failure_capsule: null,
      failure_code: null,
      failed_command: null,
    };
  }

  const available: RecoveryArtifactRef[] = [];
  const missing: MissingRecoveryArtifactRef[] = [];
  const terminalPath = join(runDir, 'terminal_status_summary.json');
  const executionPath = join(runDir, '04_execution_report.json');
  const planPath = join(runDir, '02_swe_plan.json');
  const manualPlanPath = join(runDir, 'manual', 'plan.json');
  addArtifact(available, missing, 'terminal_status_summary', terminalPath);
  addArtifact(available, missing, 'execution_report', executionPath);
  const schemaFailureLedgerPath = join(runDir, SCHEMA_FAILURE_LEDGER_FILENAME);
  const shadowHintsPath = join(dirname(runDir), SCHEMA_LEARNING_DIR, SCHEMA_SHADOW_HINTS_FILENAME);
  addOptionalArtifact(available, 'schema_failure_ledger', schemaFailureLedgerPath);
  addOptionalArtifact(available, 'schema_shadow_hints', shadowHintsPath);
  const terminal = readJson(terminalPath);
  const execution = readJson(executionPath);
  const capsulePath = findFailureCapsule(runDir, terminal);
  const capsule = unwrapFailureCapsule(capsulePath ? readJson(capsulePath) : null);
  if (capsulePath && capsule) {
    available.push({
      key: 'failure_capsule',
      filename: capsulePath.split(/[\\/]/).pop() ?? capsulePath,
      path: capsulePath,
    });
  } else if (
    (terminal !== null || execution !== null) &&
    terminal?.['status'] !== 'COMPLETE' &&
    terminal?.['status'] !== 'COMPLETE_NO_MODIFICATION' &&
    terminal?.['status'] !== 'READ_ONLY_NO_MODIFICATION' &&
    terminal?.['status'] !== 'ANSWER_READY' &&
    terminal?.['status'] !== 'SMALL_FIX_COMPLETE'
  ) {
    missing.push({ key: 'failure_capsule', filename: 'failure capsule' });
  }
  const hasPlan = existsSync(planPath) || existsSync(manualPlanPath);
  if (existsSync(planPath)) {
    available.push({ key: 'swe_plan', filename: '02_swe_plan.json', path: planPath });
  }
  if (existsSync(manualPlanPath)) {
    available.push({ key: 'manual_plan', filename: 'plan.json', path: manualPlanPath });
  }

  const recovery = classifyRecovery({
    terminal,
    execution,
    capsule,
    hasManualPlan: hasPlan,
  });
  const failureCode =
    typeof capsule?.['failure_code'] === 'string' ? capsule['failure_code'] : null;
  const failedCommand =
    typeof terminal?.['failed_command'] === 'string'
      ? terminal['failed_command']
      : typeof capsule?.['failed_command'] === 'string'
        ? capsule['failed_command']
        : null;
  const completeStatus =
    terminal?.['status'] === 'COMPLETE' ||
    terminal?.['status'] === 'COMPLETE_NO_MODIFICATION' ||
    terminal?.['status'] === 'READ_ONLY_NO_MODIFICATION' ||
    terminal?.['status'] === 'ANSWER_READY' ||
    terminal?.['status'] === 'SMALL_FIX_COMPLETE';
  if (completeStatus) {
    return {
      status: 'CONTINUE_READY',
      run_dir: runDir,
      resolved_from: resolvedFrom,
      classification: null,
      retryable: false,
      reason: 'The latest run already completed successfully.',
      next_action: 'No continuation needed.',
      next_command: null,
      available_artifacts: available,
      missing_artifacts: missing,
      terminal_status_summary: sanitizeTerminalSummary(terminal, null),
      execution_report: execution,
      failure_capsule: null,
      failure_code: null,
      failed_command: null,
    };
  }
  const nextCommand = recovery.nextCommand.replace('<run_dir>', runDir);

  return {
    status: 'CONTINUE_READY',
    run_dir: runDir,
    resolved_from: resolvedFrom,
    classification: recovery.classification,
    retryable: recovery.retryable,
    reason: recovery.reason,
    next_action:
      recovery.classification === 'requires_user_decision'
        ? 'operator review required before continuing'
        : nextCommand,
    next_command: nextCommand,
    available_artifacts: available,
    missing_artifacts: missing,
    terminal_status_summary: sanitizeTerminalSummary(
      terminal,
      capsulePath && capsule ? capsulePath : null,
    ),
    execution_report: execution,
    failure_capsule: capsule,
    failure_code: failureCode,
    failed_command: failedCommand,
  };
}

export function formatRecoveryAssessmentHuman(assessment: RecoveryAssessment): string {
  const lines = ['Babel Continue', `Status: ${assessment.status}`];
  if (assessment.run_dir) {
    lines.push(`Run: ${assessment.run_dir}`);
  }
  if (assessment.classification) {
    lines.push(`Recovery: ${assessment.classification}`);
  }
  lines.push(`Reason: ${assessment.reason}`);
  lines.push(`Next: ${assessment.next_action}`);
  lines.push('');
  lines.push('Available evidence:');
  if (assessment.available_artifacts.length === 0) {
    lines.push('- none');
  } else {
    for (const artifact of assessment.available_artifacts) {
      lines.push(`- ${artifact.key}: ${artifact.path}`);
    }
  }
  if (assessment.missing_artifacts.length > 0) {
    lines.push('');
    lines.push('Missing artifacts:');
    for (const artifact of assessment.missing_artifacts) {
      lines.push(`- ${artifact.filename}`);
    }
  }
  return lines.join('\n');
}

export function buildRecoverySummary(
  reference = 'latest',
  options: { project?: string } = {},
): RecoverySummary {
  const runDir = resolveRecoveryRunDir(reference, options.project);
  if (!runDir) {
    return {
      status: 'NO_LATEST_RUN',
      run_dir: null,
      classification: null,
      retryable: false,
      reason: 'No latest Babel run pointer or run directory was found.',
      next_command: null,
      available_artifacts: {},
      missing_artifacts: [
        'terminal_status_summary.json',
        '04_execution_report.json',
        'failure capsule',
      ],
      evidence: { terminal_status: null, execution_status: null, failure_capsule_id: null },
      next: ['Run babel "<task>" or babel plan first, then retry babel continue latest.'],
    };
  }
  if (!existsSync(runDir)) {
    return {
      status: 'RUN_NOT_FOUND',
      run_dir: runDir,
      classification: null,
      retryable: false,
      reason: 'The requested run directory does not exist.',
      next_command: null,
      available_artifacts: {},
      missing_artifacts: [runDir],
      evidence: { terminal_status: null, execution_status: null, failure_capsule_id: null },
      next: ['Check the run path or use babel continue latest.'],
    };
  }

  const terminalPath = join(runDir, 'terminal_status_summary.json');
  const executionPath = join(runDir, '04_execution_report.json');
  const manualPlanPath = join(runDir, 'manual', 'plan.json');
  const terminal = readJson(terminalPath);
  const execution = readJson(executionPath);
  const capsulePath = findFailureCapsule(runDir, terminal);
  const capsule = unwrapFailureCapsule(capsulePath ? readJson(capsulePath) : null);
  const availableArtifacts: Record<string, string> = {};
  const missingArtifacts: string[] = [];

  if (terminal) {
    availableArtifacts['terminal_status_summary'] = terminalPath;
  } else {
    missingArtifacts.push('terminal_status_summary.json');
  }
  if (execution) {
    availableArtifacts['execution_report'] = executionPath;
  } else {
    missingArtifacts.push('04_execution_report.json');
  }
  if (capsulePath && capsule) {
    availableArtifacts['failure_capsule'] = capsulePath;
  } else {
    missingArtifacts.push('failure capsule');
  }
  if (existsSync(manualPlanPath)) {
    availableArtifacts['manual_plan'] = manualPlanPath;
  }

  const recovery = classifyRecovery({
    terminal,
    execution,
    capsule,
    hasManualPlan: existsSync(manualPlanPath),
  });
  const nextCommand = recovery.nextCommand.replace('<run_dir>', runDir);

  return {
    status: 'CONTINUE_READY',
    run_dir: runDir,
    classification: recovery.classification,
    retryable: recovery.retryable,
    reason: recovery.reason,
    next_command: nextCommand,
    available_artifacts: availableArtifacts,
    missing_artifacts: missingArtifacts,
    evidence: {
      terminal_status: typeof terminal?.['status'] === 'string' ? terminal['status'] : null,
      execution_status: typeof execution?.['status'] === 'string' ? execution['status'] : null,
      failure_capsule_id:
        typeof capsule?.['failure_capsule_id'] === 'string'
          ? capsule['failure_capsule_id']
          : typeof capsule?.['capsule_id'] === 'string'
            ? capsule['capsule_id']
            : null,
    },
    next: [
      nextCommand,
      missingArtifacts.length > 0
        ? `Missing artifacts: ${missingArtifacts.join(', ')}. Use available artifacts above as fallback evidence.`
        : 'All expected recovery artifacts are present.',
    ],
  };
}

export function formatRecoverySummaryHuman(summary: RecoverySummary): string {
  const lines = ['Babel Continue', `Status: ${summary.status}`];
  if (summary.run_dir) {
    lines.push(`Run: ${summary.run_dir}`);
  }
  if (summary.classification) {
    lines.push(`Recovery: ${summary.classification}`);
  }
  lines.push(`Reason: ${summary.reason}`);
  if (summary.next_command) {
    lines.push(`Next command: ${summary.next_command}`);
  }
  lines.push('');
  lines.push('Available evidence:');
  const available = Object.entries(summary.available_artifacts);
  if (available.length === 0) {
    lines.push('- none');
  } else {
    for (const [name, path] of available) {
      lines.push(`- ${name}: ${path}`);
    }
  }
  if (summary.missing_artifacts.length > 0) {
    lines.push('');
    lines.push('Missing artifacts:');
    for (const artifact of summary.missing_artifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  return lines.join('\n');
}
