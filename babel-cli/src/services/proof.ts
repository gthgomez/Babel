import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isVerifierCommand } from './terminalStatus.js';

export type ProofStatus =
  | 'COMPLETE_VERIFIED'
  | 'COMPLETE_UNVERIFIED'
  | 'CLAIMED_BUT_NOT_PROVEN'
  | 'PLANNED_ONLY'
  | 'DRY_RUN_ONLY'
  | 'FAILED_TESTS'
  | 'TESTS_NOT_RUN'
  | 'REFUSED_UNSAFE'
  | 'NEEDS_HUMAN_APPROVAL'
  | 'STOPPED_NEEDS_HUMAN'
  | 'REPAIR_LIMIT_REACHED'
  | 'UNKNOWN_INSUFFICIENT_EVIDENCE';

export interface ProofStatusArtifact {
  schema_version: 1;
  artifact_type: 'babel_proof_status';
  generated_at: string;
  run_dir: string;
  run_id: string;
  task: string | null;
  project: string | null;
  mode: string | null;
  claimed_status: string | null;
  observed_status: string | null;
  proof_status: ProofStatus;
  execution_happened: boolean;
  qa_passed: boolean | null;
  tests_run: boolean;
  tests_passed: boolean | null;
  changed_files: string[];
  commands_run: string[];
  verifier_commands: string[];
  required_verifiers: string[];
  missing_verifiers: string[];
  unsafe_tool_attempts: string[];
  unrelated_changes_detected: boolean | null;
  decision_reasons: string[];
  evidence_paths: Record<string, string>;
  report_path: string;
}

export interface ProofArtifacts {
  proof: ProofStatusArtifact;
  markdown: string;
  proofStatusPath: string;
  reportPath: string;
}

const RUN_EVIDENCE_MARKERS = [
  '01_manifest.json',
  '03_plan.json',
  '04_execution_report.json',
  '06_runtime_telemetry.json',
  'terminal_status_summary.json',
  'verifier_execution_summary.json',
  'proof_status.json',
];

interface ToolCallLike {
  tool?: unknown;
  target?: unknown;
  command?: unknown;
  exit_code?: unknown;
  status?: unknown;
  verified?: unknown;
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function readArtifact(runDir: string, filename: string): { path: string; data: Record<string, unknown> | null } {
  const path = join(runDir, filename);
  return {
    path,
    data: asRecord(readJson(path)),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertWritableRunEvidenceDir(runDir: string): void {
  if (!existsSync(runDir) || !isDirectory(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }
  const hasRunEvidence = RUN_EVIDENCE_MARKERS.some((name) => existsSync(join(runDir, name)));
  if (!hasRunEvidence) {
    throw new Error(
      `Refusing to write proof artifacts because target is not a Babel run evidence directory: ${runDir}. ` +
      `Expected at least one of: ${RUN_EVIDENCE_MARKERS.join(', ')}.`,
    );
  }
}

function latestNumberedJson(runDir: string, prefix: string): { path: string; data: Record<string, unknown> | null } | null {
  if (!existsSync(runDir)) {
    return null;
  }
  const suffixNumber = (name: string): number => {
    const match = /^(\d+)/.exec(name.slice(prefix.length));
    return match ? Number(match[1]) : -1;
  };
  const candidates = readdirSync(runDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort((left, right) => suffixNumber(left) - suffixNumber(right) || left.localeCompare(right));
  const latest = candidates[candidates.length - 1];
  if (!latest) {
    return null;
  }
  return readArtifact(runDir, latest);
}

function getNestedString(record: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = record;
  for (const key of keys) {
    current = asRecord(current)[key];
  }
  return asString(current);
}

function collectToolCalls(executionReport: Record<string, unknown> | null): ToolCallLike[] {
  return asArray(executionReport?.['tool_call_log'])
    .map((entry) => asRecord(entry) as ToolCallLike);
}

function commandFromToolCall(entry: ToolCallLike): string | null {
  return asString(entry.command) ?? asString(entry.target);
}

function didToolCallPass(entry: ToolCallLike): boolean | null {
  if (typeof entry.exit_code === 'number') {
    return entry.exit_code === 0;
  }
  const status = asString(entry.status)?.toLowerCase();
  if (!status) {
    return null;
  }
  if (['pass', 'passed', 'ok', 'success', 'succeeded', 'complete', 'completed'].includes(status)) {
    return true;
  }
  if (['fail', 'failed', 'error', 'halted'].includes(status)) {
    return false;
  }
  return null;
}

function deriveChangedFiles(terminal: Record<string, unknown> | null, toolCalls: ToolCallLike[]): string[] {
  const terminalChanged = asArray(terminal?.['changed_files'])
    .map((value) => asString(value));
  const writeTargets = toolCalls
    .filter((entry) => asString(entry.tool) === 'file_write')
    .map((entry) => asString(entry.target));
  return unique([...terminalChanged, ...writeTargets]);
}

function deriveRequiredVerifiers(terminal: Record<string, unknown> | null): string[] {
  const verifierContract = asRecord(terminal?.['verifier_contract']);
  const commands = [
    ...asArray(verifierContract['required_commands']),
    ...asArray(verifierContract['commands']),
    ...asArray(terminal?.['required_verifiers']),
  ];
  return unique(commands.map((value) => asString(value)));
}

function deriveUnrelatedChanges(worktreeSafety: Record<string, unknown> | null, attemptSafety: Record<string, unknown> | null): boolean | null {
  const attemptRepo = asRecord(attemptSafety?.['final_repository_cleanliness_summary']);
  const attemptStatus = asString(attemptRepo['status']);
  if (attemptStatus === 'unrelated_changes_detected') {
    return true;
  }
  if (attemptStatus === 'clean_relative_to_touched_files') {
    return false;
  }
  const worktreeStatus = asString(worktreeSafety?.['status']);
  if (!worktreeStatus) {
    return null;
  }
  if (/unrelated|dirty/i.test(worktreeStatus)) {
    return true;
  }
  if (/clean|preserved/i.test(worktreeStatus)) {
    return false;
  }
  return null;
}

function deriveUnsafeToolAttempts(terminal: Record<string, unknown> | null, executionReport: Record<string, unknown> | null): string[] {
  const terminalStatus = asString(terminal?.['status']);
  const denied = terminalStatus && /DENIED|UNSAFE|REFUSED/.test(terminalStatus) ? [terminalStatus] : [];
  const toolCalls = collectToolCalls(executionReport)
    .filter((entry) => {
      const status = asString(entry.status);
      return status ? /denied|unsafe|refused/i.test(status) : false;
    })
    .map((entry) => `${asString(entry.tool) ?? 'tool'}:${commandFromToolCall(entry) ?? 'unknown'}`);
  return unique([...denied, ...toolCalls]);
}

function determineProofStatus(input: {
  observedStatus: string | null;
  claimedStatus: string | null;
  mode: string | null;
  executionHappened: boolean;
  qaPassed: boolean | null;
  testsRun: boolean;
  testsPassed: boolean | null;
  changedFiles: string[];
  missingVerifiers: string[];
  unsafeToolAttempts: string[];
}): { status: ProofStatus; reasons: string[] } {
  const reasons: string[] = [];
  const observed = input.observedStatus ?? '';
  const claimed = input.claimedStatus ?? '';
  const evidence = `${observed}\n${claimed}`.toUpperCase();

  if (input.unsafeToolAttempts.length > 0 || /DENIED|UNSAFE|REFUSED|WORKTREE_DIRTY_UNSAFE/.test(evidence)) {
    reasons.push('A safety, policy, or tool refusal is present in run evidence.');
    return { status: 'REFUSED_UNSAFE', reasons };
  }

  if (/MANUAL_BRIDGE_REQUIRED|DIRECT_MODE_NO_EXECUTOR|READ_ONLY_NO_MODIFICATION/.test(evidence) || input.mode === 'manual' || input.mode === 'direct') {
    reasons.push(`Run mode/status did not perform autonomous mutation (${input.mode ?? (observed || 'unknown')}).`);
    return { status: 'PLANNED_ONLY', reasons };
  }

  if (/DRY_RUN/.test(evidence)) {
    reasons.push('Run evidence indicates dry-run/shadow behavior rather than live mutation proof.');
    return { status: 'DRY_RUN_ONLY', reasons };
  }

  if (/REPAIR_MAX_ATTEMPTS_REACHED|REPAIR_REPEATED_FAILURE|EVIDENCE_LOOP_EXCEEDED/.test(evidence)) {
    reasons.push('A repair or evidence loop limit was reached.');
    return { status: 'REPAIR_LIMIT_REACHED', reasons };
  }

  if (/QA_REJECTED|MANUAL_PLAN_INVALID/.test(evidence) || input.qaPassed === false) {
    reasons.push('QA did not approve the run for completion.');
    return { status: 'STOPPED_NEEDS_HUMAN', reasons };
  }

  if (input.testsRun && input.testsPassed === false) {
    reasons.push('At least one verifier or test command failed.');
    return { status: 'FAILED_TESTS', reasons };
  }

  if (/FAILED|FAILURE|HALTED|FATAL|VERIFIER_FAILED|REQUIRED_VERIFIER_FAILED/.test(evidence)) {
    reasons.push(`Observed terminal status is not complete: ${input.observedStatus ?? 'unknown'}.`);
    return { status: input.testsRun ? 'FAILED_TESTS' : 'CLAIMED_BUT_NOT_PROVEN', reasons };
  }

  const claimsComplete = /COMPLETE|SUCCESS|PASSED/.test(evidence);
  if (claimsComplete) {
    if (!input.executionHappened && input.changedFiles.length > 0) {
      reasons.push('Run claims completion but no execution report proves mutation.');
      return { status: 'CLAIMED_BUT_NOT_PROVEN', reasons };
    }
    if (input.missingVerifiers.length > 0) {
      reasons.push(`Required verifier command(s) missing: ${input.missingVerifiers.join(', ')}.`);
      return { status: 'CLAIMED_BUT_NOT_PROVEN', reasons };
    }
    if (input.changedFiles.length > 0 && !input.testsRun) {
      reasons.push('Files changed, but no verifier/test command was observed.');
      return { status: 'CLAIMED_BUT_NOT_PROVEN', reasons };
    }
    if (input.changedFiles.length > 0 && input.testsPassed !== true) {
      reasons.push('Files changed, but passing verifier evidence is unavailable.');
      return { status: 'COMPLETE_UNVERIFIED', reasons };
    }
    reasons.push(input.changedFiles.length > 0
      ? 'Completion claim is supported by execution and passing verifier evidence.'
      : 'Completion/no-modification claim is supported by available run evidence.');
    return { status: 'COMPLETE_VERIFIED', reasons };
  }

  if (input.changedFiles.length > 0 && !input.testsRun) {
    reasons.push('Mutation evidence exists, but no verifier/test command was observed.');
    return { status: 'TESTS_NOT_RUN', reasons };
  }

  reasons.push('Run evidence is insufficient to prove or disprove completion.');
  return { status: 'UNKNOWN_INSUFFICIENT_EVIDENCE', reasons };
}

export function buildProofStatus(runDir: string): ProofStatusArtifact {
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const manifest = readArtifact(runDir, '01_manifest.json');
  const runtimeTelemetry = readArtifact(runDir, '06_runtime_telemetry.json');
  const executionReport = readArtifact(runDir, '04_execution_report.json');
  const terminal = readArtifact(runDir, 'terminal_status_summary.json');
  const verifierExecution = readArtifact(runDir, 'verifier_execution_summary.json');
  const worktreeSafety = readArtifact(runDir, 'worktree_safety_summary.json');
  const attemptSafetyPath = asString(terminal.data?.['attempt_safety_summary_path']);
  const attemptSafety = attemptSafetyPath ? asRecord(readJson(attemptSafetyPath)) : null;
  const latestQa = latestNumberedJson(runDir, '03_qa_verdict_v');
  const costLedgerPath = join(runDir, 'cost_ledger.json');
  const reportPath = join(runDir, 'BABEL_RUN_REPORT.md');

  const toolCalls = collectToolCalls(executionReport.data);
  const changedFiles = deriveChangedFiles(terminal.data, toolCalls);
  const commandToolCalls = toolCalls.filter((entry) => {
    const tool = asString(entry.tool);
    const command = commandFromToolCall(entry);
    return tool === 'test_run' || tool === 'shell_exec' || isVerifierCommand(command);
  });
  const commandsRun = unique(commandToolCalls.map(commandFromToolCall));
  const verifierCommands = unique(commandsRun.filter(isVerifierCommand));
  const testCalls = toolCalls.filter((entry) => {
    const tool = asString(entry.tool);
    const command = commandFromToolCall(entry);
    return tool === 'test_run' || isVerifierCommand(command);
  });
  const testsRun = testCalls.length > 0;
  const testResults = testCalls.map(didToolCallPass).filter((value): value is boolean => value !== null);
  const testsPassed = testsRun ? testResults.length > 0 && testResults.every(Boolean) : null;
  const requiredVerifiers = deriveRequiredVerifiers(terminal.data);
  const missingVerifiers = requiredVerifiers.filter((required) => !verifierCommands.some((actual) => actual.includes(required) || required.includes(actual)));
  const executionHappened = Boolean(executionReport.data && (
    toolCalls.length > 0 ||
    typeof executionReport.data['steps_executed'] === 'number' && executionReport.data['steps_executed'] > 0 ||
    asString(executionReport.data['status']) === 'EXECUTION_COMPLETE' ||
    asString(executionReport.data['status']) === 'EXECUTION_HALTED'
  ));
  const qaVerdict = asString(runtimeTelemetry.data?.['qa_verdict']) ?? asString(latestQa?.data?.['verdict']);
  const qaPassed = qaVerdict ? qaVerdict === 'PASS' : null;
  const mode =
    asString(runtimeTelemetry.data?.['pipeline_mode']) ??
    getNestedString(manifest.data ?? {}, ['analysis', 'pipeline_mode']);
  const observedStatus =
    asString(terminal.data?.['status']) ??
    asString(runtimeTelemetry.data?.['final_outcome']) ??
    asString(executionReport.data?.['status']);
  const claimedStatus =
    asString(runtimeTelemetry.data?.['final_outcome']) ??
    asString(executionReport.data?.['status']) ??
    asString(terminal.data?.['status']);
  const unsafeToolAttempts = deriveUnsafeToolAttempts(terminal.data, executionReport.data);
  const unrelatedChangesDetected = deriveUnrelatedChanges(worktreeSafety.data, attemptSafety);
  const proofDecision = determineProofStatus({
    observedStatus,
    claimedStatus,
    mode,
    executionHappened,
    qaPassed,
    testsRun,
    testsPassed,
    changedFiles,
    missingVerifiers,
    unsafeToolAttempts,
  });
  const evidencePaths: Record<string, string> = {};
  for (const [key, path] of Object.entries({
    manifest: manifest.path,
    runtime_telemetry: runtimeTelemetry.path,
    execution_report: executionReport.path,
    terminal_status_summary: terminal.path,
    verifier_execution_summary: verifierExecution.path,
    worktree_safety_summary: worktreeSafety.path,
    latest_qa_verdict: latestQa?.path,
    cost_ledger: existsSync(costLedgerPath) ? costLedgerPath : null,
  })) {
    if (path && existsSync(path)) {
      evidencePaths[key] = path;
    }
  }

  return {
    schema_version: 1,
    artifact_type: 'babel_proof_status',
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    run_id: basename(runDir),
    task:
      getNestedString(manifest.data ?? {}, ['analysis', 'task_summary']) ??
      getNestedString(manifest.data ?? {}, ['handoff_payload', 'user_request']) ??
      asString(manifest.data?.['task_summary']) ??
      asString(manifest.data?.['user_request']),
    project: asString(manifest.data?.['target_project']),
    mode,
    claimed_status: claimedStatus,
    observed_status: observedStatus,
    proof_status: proofDecision.status,
    execution_happened: executionHappened,
    qa_passed: qaPassed,
    tests_run: testsRun,
    tests_passed: testsPassed,
    changed_files: changedFiles,
    commands_run: commandsRun,
    verifier_commands: verifierCommands,
    required_verifiers: requiredVerifiers,
    missing_verifiers: missingVerifiers,
    unsafe_tool_attempts: unsafeToolAttempts,
    unrelated_changes_detected: unrelatedChangesDetected,
    decision_reasons: proofDecision.reasons,
    evidence_paths: evidencePaths,
    report_path: reportPath,
  };
}

function markdownList(values: string[], fallback: string): string {
  if (values.length === 0) {
    return `- ${fallback}`;
  }
  return values.map((value) => `- ${value}`).join('\n');
}

function markdownField(label: string, value: unknown): string {
  if (Array.isArray(value)) {
    return `- ${label}: ${value.length > 0 ? value.join(', ') : '(none)'}`;
  }
  return `- ${label}: ${value === null || value === undefined || value === '' ? '(unknown)' : String(value)}`;
}

export function formatRunReportMarkdown(proof: ProofStatusArtifact): string {
  return [
    '# BABEL_RUN_REPORT',
    '',
    '## Proof Status',
    '',
    markdownField('Status', proof.proof_status),
    markdownField('Run', proof.run_dir),
    markdownField('Task', proof.task),
    markdownField('Project', proof.project),
    markdownField('Mode', proof.mode),
    markdownField('Claimed status', proof.claimed_status),
    markdownField('Observed status', proof.observed_status),
    markdownField('Execution happened', proof.execution_happened),
    markdownField('QA passed', proof.qa_passed),
    markdownField('Tests run', proof.tests_run),
    markdownField('Tests passed', proof.tests_passed),
    markdownField('Unrelated changes detected', proof.unrelated_changes_detected),
    '',
    '## Decision Reasons',
    '',
    markdownList(proof.decision_reasons, 'No decision reasons recorded.'),
    '',
    '## Files Changed',
    '',
    markdownList(proof.changed_files, 'No changed files observed.'),
    '',
    '## Commands Run',
    '',
    markdownList(proof.commands_run, 'No commands observed.'),
    '',
    '## Verifier Evidence',
    '',
    markdownField('Verifier commands', proof.verifier_commands),
    markdownField('Required verifiers', proof.required_verifiers),
    markdownField('Missing verifiers', proof.missing_verifiers),
    '',
    '## Safety',
    '',
    markdownList(proof.unsafe_tool_attempts, 'No unsafe tool attempts observed.'),
    '',
    '## Evidence Paths',
    '',
    markdownList(Object.entries(proof.evidence_paths).map(([key, path]) => `${key}: ${path}`), 'No supporting evidence artifacts found.'),
    '',
    '## Next Commands',
    '',
    `- babel prove "${proof.run_dir}"`,
    `- babel inspect report "${proof.run_dir}"`,
    `- babel inspect outcome "${proof.run_dir}"`,
    '',
  ].join('\n');
}

export function writeProofArtifacts(runDir: string): ProofArtifacts {
  assertWritableRunEvidenceDir(runDir);
  const proof = buildProofStatus(runDir);
  const markdown = formatRunReportMarkdown(proof);
  const proofStatusPath = join(runDir, 'proof_status.json');
  const reportPath = join(runDir, 'BABEL_RUN_REPORT.md');
  writeFileSync(proofStatusPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf-8');
  writeFileSync(reportPath, markdown, 'utf-8');
  return {
    proof: {
      ...proof,
      report_path: reportPath,
    },
    markdown,
    proofStatusPath,
    reportPath,
  };
}

export function formatProofStatusHuman(proof: ProofStatusArtifact): string {
  return [
    `STATUS: ${proof.proof_status}`,
    '',
    `Run: ${proof.run_dir}`,
    `Task: ${proof.task ?? '(unknown)'}`,
    `Mode: ${proof.mode ?? '(unknown)'}`,
    `Claimed: ${proof.claimed_status ?? '(unknown)'}`,
    `Observed: ${proof.observed_status ?? '(unknown)'}`,
    `Execution: ${proof.execution_happened ? 'yes' : 'no'}`,
    `Tests: ${proof.tests_run ? (proof.tests_passed ? 'passed' : 'failed') : 'not observed'}`,
    `Changed files: ${proof.changed_files.length}`,
    '',
    'Reasons:',
    markdownList(proof.decision_reasons, 'No decision reasons recorded.'),
    '',
    `Report: ${proof.report_path}`,
  ].join('\n');
}
