import type { ToolCallLog } from '../schemas/agentContracts.js';
import type {
  AutonomousRepairProofTimeline,
  RepairProofFileHash,
} from './autonomousRepairProofEvidence.js';
import type { VerifierContractSummary } from './requiredVerifierContract.js';

export const TERMINAL_STATUSES = [
  'COMPLETE',
  'COMPLETE_NO_MODIFICATION',
  'DIRECT_MODE_NO_EXECUTOR',
  'SWARM_NO_EXECUTOR_BOUND',
  'EXACT_INSTRUCTION_DRIFT',
  'AMBIGUOUS_LITERAL_BINDING',
  'VERIFIER_FAILED',
  'VERIFIER_NOT_FOUND',
  'REQUIRED_VERIFIER_MISSING',
  'REQUIRED_VERIFIER_SKIPPED',
  'REQUIRED_VERIFIER_FAILED',
  'VERIFIER_CONTRACT_UNSATISFIED',
  'SMALL_FIX_COMPLETE',
  'SMALL_FIX_FAILED',
  'REPAIR_REPEATED_FAILURE',
  'REPAIR_MAX_ATTEMPTS_REACHED',
  'SHELL_COMMAND_DENIED',
  'SHELL_COMMAND_FAILED',
  'READ_ONLY_NO_MODIFICATION',
  'EXECUTOR_HALTED',
  'WORKTREE_DIRTY_UNSAFE',
  'ROLLBACK_APPLIED',
  'ROLLBACK_FAILED',
  'QA_REJECTED_MAX_LOOPS',
  'EVIDENCE_LOOP_EXCEEDED',
  'MANUAL_BRIDGE_REQUIRED',
  'MANUAL_PLAN_INVALID',
  'FATAL_ERROR',
  'PARTIAL',
  'FAILED',
] as const;

export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export type TerminalReasonCategory =
  | 'complete'
  | 'complete_no_modification'
  | 'execution_mode_refused'
  | 'exact_contract_failure'
  | 'verifier_failure'
  | 'verifier_not_found'
  | 'verifier_contract'
  | 'repair_repeated_failure'
  | 'repair_budget_exhausted'
  | 'shell_command_denied'
  | 'shell_command_failed'
  | 'read_only_no_modification'
  | 'executor_halted'
  | 'worktree_safety'
  | 'rollback'
  | 'small_fix_complete'
  | 'small_fix_failed'
  | 'qa_rejected'
  | 'manual_bridge'
  | 'fatal_error'
  | 'partial'
  | 'unknown_failure';

export type ChangeDisposition =
  | 'none'
  | 'intentionally_left'
  | 'preserved_for_inspection'
  | 'rolled_back'
  | 'unknown';

export type RollbackMode =
  | 'none'
  | 'snapshot_only'
  | 'rollback_applied'
  | 'rollback_not_needed'
  | 'rollback_skipped_user_dirty_target'
  | 'rollback_failed';

export interface ProjectSafetySnapshot {
  root: string | null;
  files: Record<string, string>;
  file_count: number;
  truncated: boolean;
  ignored_directories: string[];
}

export interface AttemptSafetySummary {
  schema_version: 1;
  artifact_type: 'babel_attempt_safety_summary';
  proof_kind: string | null;
  deterministic_test_double: boolean | null;
  final_status: string | null;
  attempt_count: number;
  rollback_mode: RollbackMode;
  rollback_status?: string | null;
  rollback_summary_path?: string | null;
  worktree_safety_summary_path?: string | null;
  restored_files?: string[];
  dirty_files_preserved?: string[];
  target_dirty_conflicts?: string[];
  touched_files: string[];
  changed_files_by_attempt: Array<{
    attempt: number;
    status: string;
    changed_files: string[];
  }>;
  pre_run_file_hashes: Record<string, string | null>;
  post_attempt_file_hashes: Array<{
    attempt: number;
    status: string;
    file_hashes: Record<string, RepairProofFileHash>;
  }>;
  final_file_hashes: Record<string, string | null>;
  unrelated_dirty_file_preservation: {
    status: 'preserved' | 'changed' | 'not_evaluated';
    unrelated_changed_files: string[];
    snapshot_truncated: boolean;
  };
  final_repository_cleanliness_summary: {
    status: 'clean_relative_to_touched_files' | 'unrelated_changes_detected' | 'not_evaluated';
    touched_file_count: number;
    unrelated_changed_file_count: number;
    snapshot_file_count: number;
    snapshot_truncated: boolean;
  };
  user_change_preservation_summary: {
    status: 'preserved' | 'changed' | 'not_evaluated';
    summary: string;
  };
}

export interface TerminalStatusSummary {
  schema_version: 1;
  artifact_type: 'babel_terminal_status_summary';
  status: TerminalStatus;
  reason_category: TerminalReasonCategory;
  failed_command: string | null;
  changed_files: string[];
  change_disposition: ChangeDisposition;
  rollback_mode: RollbackMode;
  rollback_summary_path?: string | null;
  worktree_safety_summary_path?: string | null;
  target_dirty_conflicts?: string[];
  failure_capsule_path: string | null;
  next_recommended_operator_action: string;
  parseable_json_stdout_required: boolean;
  attempt_safety_summary_path: string | null;
  repair_attempt_timeline_path: string | null;
  condition_summary: string | null;
  verifier_contract: VerifierContractSummary | null;
}

export interface TerminalStatusInput {
  status?: string | null;
  condition?: string | null;
  toolCallLog?: readonly ToolCallLog[];
  changedFiles?: readonly string[];
  failureCapsulePath?: string | null;
  rollbackMode?: RollbackMode;
  rollbackSummaryPath?: string | null;
  worktreeSafetySummaryPath?: string | null;
  targetDirtyConflicts?: readonly string[];
  readOnlyNoModification?: boolean;
  attemptSafetySummaryPath?: string | null;
  repairAttemptTimelinePath?: string | null;
  verifierContractSummary?: VerifierContractSummary | null;
}

export function isReadOnlyNoModificationRequest(input: {
  task: string;
  mode: string;
  allowedTools?: readonly string[];
}): boolean {
  const task = input.task.toLowerCase();
  const allowedTools = input.allowedTools ?? [];
  const explicitReadOnlyTools =
    allowedTools.length > 0 &&
    allowedTools.every(tool => ['directory_list', 'file_read', 'semantic_search', 'web_search', 'web_fetch'].includes(tool));
  const asksNoModification = /\b(do not modify|inspect only|read[- ]only|do not edit|no changes)\b/.test(task);
  const asksInspection = /\b(inspect|read|determine|audit|review|summarize|check whether)\b/.test(task);
  const asksWrite =
    /\b(create|write|update|edit|modify|patch|fix|repair|delete|remove)\b/.test(task) &&
    !asksNoModification;

  return input.mode !== 'manual' &&
    explicitReadOnlyTools &&
    asksNoModification &&
    asksInspection &&
    !asksWrite;
}

interface ParsedVerifierCommand {
  executable: string;
  args: string[];
}

export function isVerifierCommand(command: string | null | undefined): boolean {
  return verifierCommandMatch(parseVerifierCommand(command));
}

export function parseVerifierCommand(command: string | null | undefined): ParsedVerifierCommand | null {
  const normalized = String(command ?? '').trim();
  if (!normalized) {
    return null;
  }
  const tokens = tokenizeCommand(normalized);
  if (tokens.length === 0) {
    return null;
  }
  const firstToken = tokens[0];
  if (!firstToken) {
    return null;
  }
  const executable = normalizeCommandExecutable(firstToken);
  if (!executable) {
    return null;
  }
  return {
    executable,
    args: tokens.slice(1).map(normalizeCommandArg),
  };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeCommandExecutable(token: string): string {
  const trimmed = token.replace(/^['"]|['"]$/g, '').trim();
  const normalized = trimmed.split(/[\\/]/).at(-1) ?? '';
  return normalized
    .toLowerCase()
    .replace(/\.(cmd|bat|exe)$/i, '')
    .replace(/\.cmd$/i, '');
}

function normalizeCommandArg(token: string): string {
  return token.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function skipLeadingOptions(args: readonly string[]): string[] {
  const filtered = [...args];
  while (filtered.length > 0 && (filtered[0] ?? '').startsWith('-')) {
    filtered.shift();
  }
  return filtered;
}

function verifierCommandMatch(command: ParsedVerifierCommand | null): boolean {
  if (!command) {
    return false;
  }
  const executable = command.executable;
  const args = command.args;
  if (executable === 'npm') {
    const trimmed = skipLeadingOptions(args);
    if (trimmed.length === 0) {
      return false;
    }
    if (trimmed[0] === 'test') {
      return true;
    }
    if (trimmed[0] === 'run') {
      return trimmed[1] === 'typecheck' || trimmed[1] === 'build' || trimmed[1] === 'test' || trimmed[1] === 'lint';
    }
    return false;
  }
  if (executable === 'node') {
    return args.includes('--test');
  }
  if (executable === 'tsc') {
    return true;
  }
  if (executable === 'vitest') {
    return true;
  }
  if (executable === 'pytest' || executable === 'jest') {
    return true;
  }
  if (executable === 'go') {
    const trimmed = skipLeadingOptions(args);
    return trimmed[0] === 'test';
  }
  if (executable === 'cargo') {
    const trimmed = skipLeadingOptions(args);
    return trimmed[0] === 'test';
  }
  if (executable === 'gradle' || executable === 'gradlew') {
    const trimmed = skipLeadingOptions(args);
    return trimmed[0] === 'test';
  }
  return false;
}

export function resolveTerminalStatus(input: TerminalStatusInput): TerminalStatus {
  if (input.readOnlyNoModification) {
    return 'READ_ONLY_NO_MODIFICATION';
  }

  const status = String(input.status ?? '').trim();
  const condition = String(input.condition ?? '');
  const evidence = `${status}\n${condition}`.toLowerCase();
  const failedCommand = getLastFailedCommand(input.toolCallLog);

  if (status === 'COMPLETE') return 'COMPLETE';
  if (status === 'COMPLETE_NO_MODIFICATION') return 'COMPLETE_NO_MODIFICATION';
  if (status === 'REQUIRED_VERIFIER_MISSING') return 'REQUIRED_VERIFIER_MISSING';
  if (status === 'REQUIRED_VERIFIER_SKIPPED') return 'REQUIRED_VERIFIER_SKIPPED';
  if (status === 'REQUIRED_VERIFIER_FAILED') return 'REQUIRED_VERIFIER_FAILED';
  if (status === 'VERIFIER_CONTRACT_UNSATISFIED') return 'VERIFIER_CONTRACT_UNSATISFIED';
  if (status === 'READ_ONLY_NO_MODIFICATION') return 'READ_ONLY_NO_MODIFICATION';
  if (status === 'DIRECT_MODE_NO_EXECUTOR') return 'DIRECT_MODE_NO_EXECUTOR';
  if (status === 'SWARM_NO_EXECUTOR_BOUND') return 'SWARM_NO_EXECUTOR_BOUND';
  if (input.rollbackMode === 'rollback_failed') {
    return 'ROLLBACK_FAILED';
  }
  if (input.rollbackMode === 'rollback_skipped_user_dirty_target') {
    return 'WORKTREE_DIRTY_UNSAFE';
  }
  if (input.rollbackMode === 'rollback_applied') {
    return 'ROLLBACK_APPLIED';
  }
  if (status === 'WORKTREE_DIRTY_UNSAFE' || evidence.includes('worktree_dirty_unsafe')) {
    return 'WORKTREE_DIRTY_UNSAFE';
  }
  if (status === 'SMALL_FIX_COMPLETE') return 'SMALL_FIX_COMPLETE';
  if (status === 'SMALL_FIX_FAILED') return 'SMALL_FIX_FAILED';
  if (status === 'ROLLBACK_FAILED' || evidence.includes('rollback_failed')) {
    return 'ROLLBACK_FAILED';
  }
  if (status === 'ROLLBACK_APPLIED' || evidence.includes('rollback_applied')) {
    return 'ROLLBACK_APPLIED';
  }
  if (status === 'AMBIGUOUS_LITERAL_BINDING' || evidence.includes('ambiguous_literal_binding')) {
    return 'AMBIGUOUS_LITERAL_BINDING';
  }
  if (status === 'EXACT_INSTRUCTION_DRIFT' || evidence.includes('exact_instruction_drift')) {
    return 'EXACT_INSTRUCTION_DRIFT';
  }
  if (status === 'VERIFIER_NOT_FOUND' || evidence.includes('verifier_not_found')) {
    return 'VERIFIER_NOT_FOUND';
  }
  if (status === 'SHELL_COMMAND_DENIED' || evidence.includes('shell_command_denied')) {
    return 'SHELL_COMMAND_DENIED';
  }
  if (status === 'REPAIR_REPEATED_FAILURE' || evidence.includes('repair_repeated_failure')) {
    return 'REPAIR_REPEATED_FAILURE';
  }
  if (status === 'REPAIR_MAX_ATTEMPTS_REACHED' || evidence.includes('repair_max_attempts_reached')) {
    return 'REPAIR_MAX_ATTEMPTS_REACHED';
  }
  if (status === 'VERIFIER_FAILED' || evidence.includes('verifier_failed') || isVerifierCommand(failedCommand)) {
    return 'VERIFIER_FAILED';
  }
  if (status === 'SHELL_COMMAND_FAILED' || failedCommand) {
    return 'SHELL_COMMAND_FAILED';
  }
  if (status === 'QA_REJECTED_MAX_LOOPS') return 'QA_REJECTED_MAX_LOOPS';
  if (status === 'EVIDENCE_LOOP_EXCEEDED') return 'EVIDENCE_LOOP_EXCEEDED';
  if (status === 'MANUAL_BRIDGE_REQUIRED') return 'MANUAL_BRIDGE_REQUIRED';
  if (status === 'MANUAL_PLAN_INVALID') return 'MANUAL_PLAN_INVALID';
  if (status === 'FATAL_ERROR') return 'FATAL_ERROR';
  if (status === 'PARTIAL') return 'PARTIAL';
  if (status === 'FAILED') return 'FAILED';

  return 'EXECUTOR_HALTED';
}

export function buildTerminalStatusSummary(input: TerminalStatusInput): TerminalStatusSummary {
  const status = resolveTerminalStatus(input);
  const failedCommand = getLastFailedCommand(input.toolCallLog);
  const changedFiles = uniqueStrings([
    ...(input.changedFiles ?? []),
    ...changedFilesFromToolLog(input.toolCallLog ?? []),
  ]);
  const rollbackMode = input.rollbackMode ?? 'none';

  return {
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status,
    reason_category: reasonCategoryForStatus(status),
    failed_command: failedCommand,
    changed_files: changedFiles,
    change_disposition: changeDispositionForStatus(status, changedFiles, rollbackMode),
    rollback_mode: rollbackMode,
    rollback_summary_path: input.rollbackSummaryPath ?? null,
    worktree_safety_summary_path: input.worktreeSafetySummaryPath ?? null,
    target_dirty_conflicts: [...(input.targetDirtyConflicts ?? [])],
    failure_capsule_path: input.failureCapsulePath ?? null,
    next_recommended_operator_action: nextActionForStatus(status),
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: input.attemptSafetySummaryPath ?? null,
    repair_attempt_timeline_path: input.repairAttemptTimelinePath ?? null,
    condition_summary: summarizeCondition(input.condition),
    verifier_contract: input.verifierContractSummary ?? null,
  };
}

export function buildAttemptSafetySummary(input: {
  timeline: AutonomousRepairProofTimeline;
  initialSnapshot?: ProjectSafetySnapshot | null;
  finalSnapshot?: ProjectSafetySnapshot | null;
  rollbackMode?: RollbackMode;
  rollbackStatus?: string | null;
  rollbackSummaryPath?: string | null;
  worktreeSafetySummaryPath?: string | null;
  restoredFiles?: readonly string[];
  dirtyFilesPreserved?: readonly string[];
  targetDirtyConflicts?: readonly string[];
}): AttemptSafetySummary {
  const touchedFiles = uniqueStrings(input.timeline.attempts.flatMap(attempt => attempt.changed_files));
  const preRunFileHashes = Object.fromEntries(
    touchedFiles.map(path => [path, input.initialSnapshot?.files[path] ?? firstRecordedBeforeHash(input.timeline, path)]),
  );
  const finalFileHashes = Object.fromEntries(
    touchedFiles.map(path => [path, input.finalSnapshot?.files[path] ?? lastRecordedAfterHash(input.timeline, path)]),
  );
  const unrelatedChangedFiles = diffSnapshots(input.initialSnapshot, input.finalSnapshot)
    .filter(path => !touchedFiles.includes(path));
  const snapshotsEvaluated = Boolean(input.initialSnapshot && input.finalSnapshot);
  const snapshotTruncated = Boolean(input.initialSnapshot?.truncated || input.finalSnapshot?.truncated);
  const unrelatedStatus = snapshotsEvaluated
    ? unrelatedChangedFiles.length === 0 ? 'preserved' : 'changed'
    : 'not_evaluated';

  return {
    schema_version: 1,
    artifact_type: 'babel_attempt_safety_summary',
    proof_kind: input.timeline.proof_kind,
    deterministic_test_double: input.timeline.deterministic_test_double,
    final_status: input.timeline.final_status,
    attempt_count: input.timeline.attempt_count,
    rollback_mode: input.rollbackMode ?? 'snapshot_only',
    rollback_status: input.rollbackStatus ?? input.rollbackMode ?? 'snapshot_only',
    rollback_summary_path: input.rollbackSummaryPath ?? null,
    worktree_safety_summary_path: input.worktreeSafetySummaryPath ?? null,
    restored_files: [...(input.restoredFiles ?? [])],
    dirty_files_preserved: [...(input.dirtyFilesPreserved ?? [])],
    target_dirty_conflicts: [...(input.targetDirtyConflicts ?? [])],
    touched_files: touchedFiles,
    changed_files_by_attempt: input.timeline.attempts.map(attempt => ({
      attempt: attempt.attempt,
      status: attempt.status,
      changed_files: attempt.changed_files,
    })),
    pre_run_file_hashes: preRunFileHashes,
    post_attempt_file_hashes: input.timeline.attempts.map(attempt => ({
      attempt: attempt.attempt,
      status: attempt.status,
      file_hashes: attempt.file_hashes,
    })),
    final_file_hashes: finalFileHashes,
    unrelated_dirty_file_preservation: {
      status: unrelatedStatus,
      unrelated_changed_files: unrelatedChangedFiles,
      snapshot_truncated: snapshotTruncated,
    },
    final_repository_cleanliness_summary: {
      status: snapshotsEvaluated
        ? unrelatedChangedFiles.length === 0 ? 'clean_relative_to_touched_files' : 'unrelated_changes_detected'
        : 'not_evaluated',
      touched_file_count: touchedFiles.length,
      unrelated_changed_file_count: unrelatedChangedFiles.length,
      snapshot_file_count: input.finalSnapshot?.file_count ?? 0,
      snapshot_truncated: snapshotTruncated,
    },
    user_change_preservation_summary: {
      status: unrelatedStatus,
      summary: userChangeSummary(unrelatedStatus, unrelatedChangedFiles),
    },
  };
}

function reasonCategoryForStatus(status: TerminalStatus): TerminalReasonCategory {
  switch (status) {
    case 'COMPLETE': return 'complete';
    case 'COMPLETE_NO_MODIFICATION': return 'complete_no_modification';
    case 'READ_ONLY_NO_MODIFICATION': return 'read_only_no_modification';
    case 'DIRECT_MODE_NO_EXECUTOR':
    case 'SWARM_NO_EXECUTOR_BOUND': return 'execution_mode_refused';
    case 'EXACT_INSTRUCTION_DRIFT':
    case 'AMBIGUOUS_LITERAL_BINDING': return 'exact_contract_failure';
    case 'VERIFIER_FAILED': return 'verifier_failure';
    case 'VERIFIER_NOT_FOUND': return 'verifier_not_found';
    case 'SMALL_FIX_COMPLETE': return 'small_fix_complete';
    case 'SMALL_FIX_FAILED': return 'small_fix_failed';
    case 'REQUIRED_VERIFIER_MISSING':
    case 'REQUIRED_VERIFIER_SKIPPED':
    case 'REQUIRED_VERIFIER_FAILED':
    case 'VERIFIER_CONTRACT_UNSATISFIED':
      return 'verifier_contract';
    case 'REPAIR_REPEATED_FAILURE': return 'repair_repeated_failure';
    case 'REPAIR_MAX_ATTEMPTS_REACHED': return 'repair_budget_exhausted';
    case 'SHELL_COMMAND_DENIED': return 'shell_command_denied';
    case 'SHELL_COMMAND_FAILED': return 'shell_command_failed';
    case 'WORKTREE_DIRTY_UNSAFE': return 'worktree_safety';
    case 'ROLLBACK_APPLIED':
    case 'ROLLBACK_FAILED': return 'rollback';
    case 'QA_REJECTED_MAX_LOOPS': return 'qa_rejected';
    case 'MANUAL_BRIDGE_REQUIRED':
    case 'MANUAL_PLAN_INVALID': return 'manual_bridge';
    case 'FATAL_ERROR': return 'fatal_error';
    case 'PARTIAL': return 'partial';
    case 'FAILED': return 'unknown_failure';
    case 'EVIDENCE_LOOP_EXCEEDED':
    case 'EXECUTOR_HALTED':
      return 'executor_halted';
  }
}

function nextActionForStatus(status: TerminalStatus): string {
  switch (status) {
    case 'COMPLETE':
      return 'No operator action required; requested completion criteria passed.';
    case 'COMPLETE_NO_MODIFICATION':
    case 'READ_ONLY_NO_MODIFICATION':
      return 'No file changes were needed; review the read-only findings or rerun with a write-capable mode if edits are required.';
    case 'DIRECT_MODE_NO_EXECUTOR':
      return 'Rerun in autonomous mode or provide an executor-capable workflow for write requests.';
    case 'SWARM_NO_EXECUTOR_BOUND':
      return 'Use autonomous mode for write tasks until swarm executor ownership is implemented.';
    case 'EXACT_INSTRUCTION_DRIFT':
    case 'AMBIGUOUS_LITERAL_BINDING':
      return 'Clarify or correct the exact instruction contract before retrying.';
    case 'VERIFIER_FAILED':
      return 'Inspect the failed verifier output, patch the cause, and rerun the same verifier.';
    case 'VERIFIER_NOT_FOUND':
      return 'Add or select a runnable verifier command before retrying.';
    case 'REQUIRED_VERIFIER_MISSING':
      return 'Run every required verifier before completing, or halt with a non-complete status.';
    case 'REQUIRED_VERIFIER_SKIPPED':
      return 'Inspect the prior required verifier failure and rerun the skipped required verifier after repair.';
    case 'REQUIRED_VERIFIER_FAILED':
      return 'Inspect the failed required verifier output, patch the cause, and rerun all required verifiers.';
    case 'VERIFIER_CONTRACT_UNSATISFIED':
      return 'Inspect verifier_plan.json and verifier_execution_summary.json before retrying.';
    case 'SMALL_FIX_COMPLETE':
      return 'Review the changed file and commit when ready.';
    case 'SMALL_FIX_FAILED':
      return 'Inspect verifier output and rerun with the verified pipeline if needed.';
    case 'REPAIR_REPEATED_FAILURE':
      return 'Inspect failure capsules and change repair strategy; do not repeat the same patch loop.';
    case 'REPAIR_MAX_ATTEMPTS_REACHED':
      return 'Review the attempt timeline and failure capsules before starting a new repair run.';
    case 'SHELL_COMMAND_DENIED':
      return 'Adjust allowed tools or choose a permitted command; retrying the denied command will not help.';
    case 'SHELL_COMMAND_FAILED':
      return 'Inspect the command stderr/stdout and rerun after addressing the command failure.';
    case 'WORKTREE_DIRTY_UNSAFE':
      return 'Review dirty worktree files and preserve or isolate user changes before retrying.';
    case 'ROLLBACK_APPLIED':
      return 'Rollback was applied; inspect the safety summary before rerunning.';
    case 'ROLLBACK_FAILED':
      return 'Stop and manually inspect the worktree; automatic rollback did not complete.';
    case 'QA_REJECTED_MAX_LOOPS':
      return 'Revise the plan to satisfy QA before execution.';
    case 'EVIDENCE_LOOP_EXCEEDED':
      return 'Use the collected evidence to narrow the task before retrying.';
    case 'MANUAL_BRIDGE_REQUIRED':
    case 'MANUAL_PLAN_INVALID':
      return 'Provide or repair the manual bridge plan.';
    case 'FATAL_ERROR':
    case 'FAILED':
    case 'EXECUTOR_HALTED':
    case 'PARTIAL':
      return 'Inspect terminal_status_summary.json, 04_execution_report.json, and logs for the next manual action.';
  }
}

function changeDispositionForStatus(
  status: TerminalStatus,
  changedFiles: readonly string[],
  rollbackMode: RollbackMode,
): ChangeDisposition {
  if (changedFiles.length === 0) return 'none';
  if (rollbackMode === 'rollback_applied') return 'rolled_back';
  if (rollbackMode === 'rollback_not_needed') return 'preserved_for_inspection';
  if (rollbackMode === 'rollback_skipped_user_dirty_target') return 'preserved_for_inspection';
  if (rollbackMode === 'rollback_failed') return 'unknown';
  if (status === 'COMPLETE') return 'intentionally_left';
  return 'preserved_for_inspection';
}

function getLastFailedCommand(toolCallLog: readonly ToolCallLog[] | undefined): string | null {
  const entry = [...(toolCallLog ?? [])]
    .reverse()
    .find(item =>
      (item.tool === 'shell_exec' || item.tool === 'test_run') &&
      item.exit_code !== 0
    );
  return entry?.target ?? null;
}

function changedFilesFromToolLog(toolCallLog: readonly ToolCallLog[]): string[] {
  return uniqueStrings(toolCallLog
    .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
    .map(entry => entry.target));
}

function summarizeCondition(condition: string | null | undefined): string | null {
  const normalized = String(condition ?? '').trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized.slice(0, 700) : null;
}

function diffSnapshots(
  before: ProjectSafetySnapshot | null | undefined,
  after: ProjectSafetySnapshot | null | undefined,
): string[] {
  if (!before || !after) {
    return [];
  }
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths]
    .filter(path => before.files[path] !== after.files[path])
    .sort();
}

function firstRecordedBeforeHash(timeline: AutonomousRepairProofTimeline, path: string): string | null {
  for (const attempt of timeline.attempts) {
    const before = attempt.file_hashes[path]?.before;
    if (before !== undefined) {
      return before;
    }
  }
  return null;
}

function lastRecordedAfterHash(timeline: AutonomousRepairProofTimeline, path: string): string | null {
  for (const attempt of [...timeline.attempts].reverse()) {
    const after = attempt.file_hashes[path]?.after;
    if (after !== undefined) {
      return after;
    }
  }
  return null;
}

function userChangeSummary(status: 'preserved' | 'changed' | 'not_evaluated', files: readonly string[]): string {
  if (status === 'preserved') {
    return 'No unrelated file changes were detected relative to the safety snapshot.';
  }
  if (status === 'changed') {
    return `Unrelated files changed: ${files.join(', ')}`;
  }
  return 'User-change preservation could not be evaluated because safety snapshots were unavailable or truncated.';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}
