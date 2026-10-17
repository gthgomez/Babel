/**
 * Mutation agent loop for live LLM sub-agents with isolation and rollback.
 *
 * Modeled on runReadOnlyAgentLoop.ts but:
 * - Accepts a broader tool set (file_write, shell_exec, file_delete, file_move)
 * - Accepts writeScope restriction — blocks writes outside declared paths
 * - Integrates WorktreeSafetyController for snapshot/rollback
 * - Registers with BackgroundTaskRegistry for TUI visibility
 * - Uses child AbortController for cancellation
 * - Returns SubagentEvidence-shaped result with rollback method
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { WorktreeRollbackSummary } from '../../services/worktreeSafety.js';
import { WorktreeSafetyController } from '../../services/worktreeSafety.js';
import { backgroundTaskRegistry } from '../../services/backgroundTaskRegistry.js';
import type { ToolContext } from '../../localTools.js';
import { runWithPrimaryOnlyFallback } from '../../execute.js';
import { AgentActionsEnvelopeSchema, type AgentAction } from '../actions.js';
import { executeActionWithPolicy, defaultToolExecutor, type ToolExecutor } from '../toolExecutor.js';
import type { PermissionPreset } from '../policy.js';
import type { ToolCallLog } from '../../schemas/agentContracts.js';
import {
  createChildBudgetController,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from '../childBudget.js';
import { WorkspaceTransactionManager } from '../../services/workspaceTransactions.js';
import { extractPatchRawTargets } from '../../authority/patchTargets.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MUTATION_LOOP_MAX_ROUNDS = 8;

const MUTATION_TOOL_TYPES = new Set<AgentAction['type']>([
  'write_file',
  'apply_patch',
  'run_command',
]);

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Controller-owned execution constraints; a worktree alone is not an OS sandbox. */
export type ChildExecutionEnvelope = Pick<
  NonNullable<Parameters<typeof executeActionWithPolicy>[3]>,
  'isolationRequired' | 'isolationAvailable' | 'hostFallbackAllowed' | 'authoritySession' | 'mode'
>;

export interface MutationAgentLoopInput {
  /** Agent identifier for logging and TUI registration */
  agentId: string;
  /** The task for this sub-agent to perform */
  task: string;
  /** Project root for resolving absolute paths */
  projectRoot: string;
  /** Paths the agent is allowed to write to (relative to projectRoot) */
  writeScope: string[];
  /** Optional worktree-isolated workspace root */
  workspaceRoot?: string | undefined;
  /** Tool context for execution */
  toolContext: ToolContext;
  /** Max loop rounds before forced termination */
  maxRounds?: number;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Optional tool executor override */
  executor?: ToolExecutor;
  /** P-5: Model override for sub-agent LLM calls (e.g. 'deepseek-v4-flash'). */
  model?: string;
  /** Permission preset for tool execution */
  preset?: PermissionPreset;
  /** Validated parent/controller constraints, never supplied by the model. */
  executionEnvelope?: ChildExecutionEnvelope;
  /** Optional runDir for WorktreeSafetyController backup root */
  runDir?: string;
  /** If true, use deterministic mock actions instead of calling the LLM */
  useDeterministicMock?: boolean;
  /** Optional model-boundary resolver for deterministic integration tests. */
  actionResolver?: (prompt: string, signal: AbortSignal) => Promise<AgentAction[]>;
  /** S03: extra instructions from the advertised sub_agent contract. */
  additionalInstructions?: string;
  /** Optional wall-clock timeout for the child loop (child_timeout). */
  timeoutMs?: number;
  /** Bounded allowance inherited from the parent delegation point. */
  inheritedAllowance?: InheritedChildAllowance;
  /** Parent callback for durable task-cost checkpointing. */
  onUsageRecorded?: () => void;
}

export type SubagentAttribution =
  | 'child_success'
  | 'child_noop'
  | 'child_timeout'
  | 'child_round_exhaustion'
  /** S03/T04: inherited parent wall-clock allowance exhausted (not rounds). */
  | 'child_wall_exhaustion'
  /** S03/T04: inherited parent cost allowance exhausted (not rounds). */
  | 'child_cost_exhaustion'
  | 'child_provider_failure'
  | 'child_policy_block'
  | 'child_environment_failure'
  | 'child_cancellation';

/**
 * S03/T04: an inherited budget stop is caused by the parent wall/cost limiter,
 * not by the child's round count. Label it truthfully instead of collapsing to
 * `child_round_exhaustion`.
 */
export function childBudgetAttribution(
  limiter: ChildBudgetLimiter | undefined,
): SubagentAttribution {
  if (limiter === 'wall') return 'child_wall_exhaustion';
  if (limiter === 'cost') return 'child_cost_exhaustion';
  return 'child_round_exhaustion';
}

export interface MutationAgentLoopResult {
  /** Whether all steps completed successfully */
  success: boolean;
  /** Failure or completion attribution code */
  attribution: SubagentAttribution;
  /** Human-readable summary of what was done */
  summary: string;
  /** Changed files with before/after hashes */
  changedFiles: Array<{
    path: string;
    rationale: string;
    before_hash: string | null;
    after_hash: string;
    bytes: number;
  }>;
  /** Attempted paths whose remaining effects cannot be certified or ruled out. */
  indeterminatePaths?: string[];
  /** Tool call log for evidence collection */
  toolCallLog: ToolCallLog[];
  /** Steps executed count */
  stepsExecuted: number;
  /** Error message if failed */
  error: string | null;
  /** Rollback summary if rollback was performed */
  rollbackSummary: WorktreeRollbackSummary | null;
  /** Roll back all changes made by this agent */
  rollback(): Promise<WorktreeRollbackSummary>;
  /** True when the child stopped at an inherited parent wall/cost boundary. */
  inheritedBudgetExceeded?: boolean;
  inheritedBudgetLimiter?: ChildBudgetLimiter;
}

export function classifySubagentFailure(input: {
  success: boolean;
  error: string | null;
  changedFilesCount: number;
  aborted?: boolean;
}): SubagentAttribution {
  if (input.aborted) return 'child_cancellation';
  if (input.error) {
    const err = input.error.toLowerCase();
    if (err.includes('inherited parent') && err.includes('budget')) {
      return 'child_round_exhaustion';
    }
    if (err.includes('abort') || err.includes('cancelled') || err.includes('canceled')) {
      return 'child_cancellation';
    }
    if (err.includes('round limit reached without finish') || err.includes('max rounds reached')) {
      return 'child_round_exhaustion';
    }
    if (
      err.includes('policy blocked') ||
      err.includes('outside write scope') ||
      err.includes('no write scope')
    ) {
      return 'child_policy_block';
    }
    if (err.includes('timeout') || err.includes('timed out')) {
      return 'child_timeout';
    }
    if (
      err.includes('failed to resolve agent actions') ||
      err.includes('provider') ||
      err.includes('resolver failure') ||
      err.includes('rate limit') ||
      err.includes('503')
    ) {
      return 'child_provider_failure';
    }
    return 'child_environment_failure';
  }
  if (input.success) {
    return input.changedFilesCount > 0 ? 'child_success' : 'child_noop';
  }
  return 'child_environment_failure';
}

/** Parent progress: only a successful mutation counts. No-op / failure must not. */
export function subagentCountsAsMutation(
  detail?: string | null,
  effectStatus?: import('../mutationTools.js').MutationEffectStatus,
): boolean {
  return effectStatus === 'confirmed_change' && /attribution=child_success\b/.test(detail ?? '');
}

export function subagentFinishedCleanly(attribution: SubagentAttribution): boolean {
  return attribution === 'child_success' || attribution === 'child_noop';
}

async function resolveUntilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Aborted by user or parent'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// ─── Doterministic Mock Actions ──────────────────────────────────────────────

function buildDeterministicMockActions(writeScope: string[]): AgentAction[] {
  const actions: AgentAction[] = [];
  // Always start by listing the project root
  actions.push({ type: 'list_dir', path: '.' });
  // If there's a write scope, try to read existing files and write a result
  for (const scope of writeScope) {
    actions.push({ type: 'read_file', path: scope });
    actions.push({
      type: 'write_file',
      path: `${scope}/result.txt`,
      content: 'Mutation agent result\n',
    });
  }
  actions.push({
    type: 'finish',
    summary: 'Deterministic mock mutation complete',
    verification: [],
  });
  return actions;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** null is an observed absent path; undefined is an unreadable/unknown postimage. */
function readFilePostimage(path: string): { hash: string | null; bytes: number } | undefined {
  try {
    const bytes = readFileSync(path);
    return { hash: hashContent(bytes), bytes: bytes.byteLength };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { hash: null, bytes: 0 } : undefined;
  }
}

function reconcileChangedFiles(
  changedFiles: MutationAgentLoopResult['changedFiles'],
  projectRoot: string,
): boolean {
  let determinate = true;
  for (let index = changedFiles.length - 1; index >= 0; index--) {
    const file = changedFiles[index]!;
    const observed = readFilePostimage(resolve(projectRoot, file.path));
    const afterHash = observed?.hash === null ? WorkspaceTransactionManager.missingPathDigest() : observed?.hash;
    const unknown = observed === undefined || (observed.hash !== file.before_hash && afterHash !== file.after_hash);
    if (unknown) determinate = false;
    if (unknown || observed?.hash === file.before_hash) {
      changedFiles.splice(index, 1);
    } else {
      file.after_hash = observed.hash ?? WorkspaceTransactionManager.missingPathDigest();
      file.bytes = observed.bytes;
    }
  }
  return determinate;
}

function rollbackChildChanges(
  controller: WorktreeSafetyController,
  changedFiles: MutationAgentLoopResult['changedFiles'],
  reason: string,
): WorktreeRollbackSummary {
  const summary = controller.rollbackTouchedFiles(reason);
  if (controller.projectRoot) reconcileChangedFiles(changedFiles, controller.projectRoot);
  return summary;
}

function isMutationAction(action: AgentAction): boolean {
  return MUTATION_TOOL_TYPES.has(action.type);
}

function mutationTargetPaths(action: AgentAction): string[] {
  if (action.type === 'write_file') return [action.path];
  if (action.type === 'apply_patch') return extractPatchRawTargets(action.patch);
  return [];
}

function actionTargetPath(action: AgentAction): string | null {
  if (action.type === 'write_file' || action.type === 'read_file') return action.path;
  if (action.type === 'list_dir') return action.path;
  if (action.type === 'apply_patch') {
    const targets = mutationTargetPaths(action);
    return targets[0] ?? null;
  }
  if (action.type === 'grep') return action.path ?? null;
  if (action.type === 'glob') return null;
  if (action.type === 'search') return null;
  if (action.type === 'run_command') return null;
  if (action.type === 'finish') return null;
  if (action.type === 'ask_approval') return null;
  return null;
}

function isPathInScope(path: string, writeScope: string[], projectRoot: string): boolean {
  if (writeScope.length === 0) return false;
  const absPath = resolve(projectRoot, path);
  return writeScope.some((scope) => {
    const scopeAbs = resolve(projectRoot, scope);
    const rel = relative(scopeAbs, absPath);
    return !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\');
  });
}

function formatMutationObservation(
  action: AgentAction,
  result: { stdout: string; stderr: string; exit_code: number },
): string {
  const body =
    result.stdout.trim().length > 0
      ? result.stdout
      : result.stderr.trim().length > 0
        ? result.stderr
        : '(no output)';
  return [
    `### ${action.type} ${actionTargetPath(action) ?? ''}`,
    `exit_code: ${result.exit_code}`,
    body.length > 2000 ? `${body.slice(0, 2000)}\n...[truncated]` : body,
  ].join('\n');
}

function buildToolCallLogEntry(
  step: number,
  action: AgentAction,
  result: { stdout: string; stderr: string; exit_code: number },
): ToolCallLog {
  return {
    step,
    tool: action.type as ToolCallLog['tool'],
    target: actionTargetPath(action) ?? '',
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    verified: result.exit_code === 0,
  };
}

// ─── Prompt Building ──────────────────────────────────────────────────────────

export function buildMutationAgentTurnPrompt(input: {
  task: string;
  projectRoot: string;
  round: number;
  maxRounds: number;
  priorObservations: string;
  writeScope: string[];
  workspaceRoot?: string;
  additionalInstructions?: string;
}): string {
  const sections: string[] = [
    '# Babel Mutation Sub-Agent Loop',
    '',
    'You are a mutation-capable sub-agent. Return one JSON object with an `actions` array.',
    'Allowed action types: read_file, list_dir, search, grep, glob, write_file, apply_patch, run_command, finish, ask_approval.',
    '',
    'Shape:',
    '{"actions":[{"type":"read_file","path":"src/example.ts"},{"type":"write_file","path":"src/fix.ts","content":"..."},{"type":"finish","summary":"done","verification":[]}]}',
    '',
    `Round: ${input.round}/${input.maxRounds}`,
    `Project root: ${input.projectRoot}`,
    input.workspaceRoot ? `Workspace root: ${input.workspaceRoot}` : '',
    input.writeScope.length > 0
      ? `Write scope: ${input.writeScope.join(', ')}`
      : 'Write scope: (read-only — no mutation tools allowed)',
    '',
    `Task: ${input.task}`,
    ...(input.additionalInstructions
      ? ['', '# Additional Instructions', input.additionalInstructions]
      : []),
    '',
    '# Prior Tool Observations',
    input.priorObservations.trim().length > 0 ? input.priorObservations : '(none yet)',
    '',
    'Use write_file and run_command to make changes. Finish when the task is complete.',
    'This child action protocol supports write_file and apply_patch for edits, not str_replace. If caller instructions describe a string replacement, inspect the current file and express the equivalent scoped edit with a supported action; preserve all unrelated bytes. Caller wording cannot add action types or widen write scope.',
    'You MUST write files only within the declared write scope.',
  ];
  return sections.filter(Boolean).join('\n');
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

export async function runMutationAgentLoop(
  input: MutationAgentLoopInput,
): Promise<MutationAgentLoopResult> {
  const executor = input.executor ?? defaultToolExecutor;
  const maxRounds = input.maxRounds ?? DEFAULT_MUTATION_LOOP_MAX_ROUNDS;
  const projectRoot = input.projectRoot;
  const writeScope = input.writeScope;
  const agentId = input.agentId;
  const isReadOnly = writeScope.length === 0;

  // Register with BackgroundTaskRegistry
  const taskLabel = `Mutation sub-agent ${agentId}: ${input.task.slice(0, 60)}`;
  const taskId = backgroundTaskRegistry.register(taskLabel);
  backgroundTaskRegistry.updateProgress(taskId, 0, maxRounds);

  // Create WorktreeSafetyController for snapshot/rollback (only if we have write scope)
  const runDir = input.runDir ?? join(projectRoot, '.babel', 'runs', 'agents', agentId);
  const safetyController = isReadOnly
    ? null
    : new WorktreeSafetyController({
        projectRoot,
        runDir,
      });

  const changedFiles: Array<{
    path: string;
    rationale: string;
    before_hash: string | null;
    after_hash: string;
    bytes: number;
  }> = [];
  const toolCallLog: ToolCallLog[] = [];
  let priorObservations = '';
  let roundForBudgetResult = 0;
  const budgetController = createChildBudgetController(
    input.inheritedAllowance,
    input.abortSignal,
    input.timeoutMs,
  );
  const effectiveAbortSignal = budgetController.signal;
  const preset = input.preset ?? 'workspace_write';
  const normalizeMutationPath = (path: string): string => relative(projectRoot, resolve(projectRoot, path)).replace(/\\/g, '/');
  const attemptedPaths = new Set<string>();
  const confirmedPostimages = new Map<string, string | null>();
  const indeterminatePaths: string[] = [];
  const refreshUncertainty = (): string[] => {
    indeterminatePaths.length = 0;
    const snapshots = safetyController?.buildSummary().snapshots ?? [];
    for (const path of attemptedPaths) {
      const snapshot = snapshots.find((entry) => entry.relative_path === path);
      const observed = readFilePostimage(resolve(projectRoot, path));
      if (!snapshot || observed === undefined ||
        (observed.hash !== snapshot.hash_before &&
          (!confirmedPostimages.has(path) || observed.hash !== confirmedPostimages.get(path)))) {
        indeterminatePaths.push(path);
      }
    }
    return indeterminatePaths;
  };
  const withMutationState = (result: MutationAgentLoopResult): MutationAgentLoopResult => {
    refreshUncertainty();
    result.indeterminatePaths = indeterminatePaths;
    if (result.success && indeterminatePaths.length > 0) {
      result.success = false;
      result.attribution = 'child_environment_failure';
      result.error = 'Mutation postimages are indeterminate';
      result.summary = `Sub-agent ${agentId} failed: ${result.error}`;
      backgroundTaskRegistry.fail(taskId, result.error);
    }
    const rollback = result.rollback;
    result.rollback = async () => {
      const summary = await rollback();
      refreshUncertainty();
      return summary;
    };
    return result;
  };
  const prepareMutation = (action: AgentAction, attempt: number): string | null => {
    if (action.type !== 'write_file' && action.type !== 'apply_patch') return null;
    for (const target of mutationTargetPaths(action)) {
      const snapshot = safetyController?.snapshotBeforeWrite(target, attempt);
      if (snapshot && !snapshot.ok) return `Policy blocked: ${snapshot.reason ?? snapshot.status}`;
      const path = normalizeMutationPath(target);
      if (safetyController && !attemptedPaths.has(path)) {
        const initial = safetyController.buildSummary().snapshots.find(entry => entry.relative_path === path);
        if (!initial || !safetyController.recordConfirmedPostimage(target, initial.hash_before)) {
          return `Policy blocked: target changed before dispatch: ${target}`;
        }
      }
    }
    for (const target of mutationTargetPaths(action)) attemptedPaths.add(normalizeMutationPath(target));
    return null;
  };
  const bindFailedWriteForRollback = (action: AgentAction, execution: Awaited<ReturnType<typeof executeActionWithPolicy>>): void => {
    if (action.type !== 'write_file' || !safetyController) return;
    const transaction = execution.effectTransaction;
    if (transaction?.status !== 'rollback_failed' && transaction?.status !== 'reconcile_needed') return;
    const absolute = resolve(projectRoot, action.path);
    if (!transaction.paths.includes(absolute)) return;
    const observed = readFilePostimage(absolute);
    // This grants rollback ownership only: a failed effect never enters the
    // successful change list. Unbound partial bytes remain indeterminate.
    if (observed?.hash === hashContent(action.content)) {
      safetyController.recordConfirmedPostimage(action.path, observed.hash);
    }
  };
  const recordMutation = (action: AgentAction, execution: Awaited<ReturnType<typeof executeActionWithPolicy>>): void => {
    if (action.type !== 'write_file' && action.type !== 'apply_patch') return;
    if (execution.policyBlocked || execution.results.length === 0 || execution.results.some((result) => result.exit_code !== 0)) return;
    const receipt = execution.mutationReceipt;
    if (receipt?.status !== 'committed' || execution.effectTransaction?.status !== 'commit') {
      throw new Error('Mutation effect is indeterminate: committed executor evidence is missing');
    }
    for (const rawPath of mutationTargetPaths(action)) {
      const path = normalizeMutationPath(rawPath);
      const absolute = resolve(projectRoot, path);
      const observed = readFilePostimage(absolute);
      if (observed === undefined) throw new Error(`Mutation postimage is indeterminate: ${path}`);
      const afterHash = observed.hash ?? WorkspaceTransactionManager.missingPathDigest();
      if (receipt.postImageHashes[absolute] !== afterHash) {
        throw new Error(`Mutation postimage disagrees with committed receipt: ${path}`);
      }
      const beforeHash = receipt.preImageHashes[absolute];
      if (beforeHash === undefined) throw new Error(`Mutation preimage is indeterminate: ${path}`);
      if (safetyController && !safetyController.recordConfirmedPostimage(path, observed.hash)) {
        throw new Error(`Mutation postimage changed during reconciliation: ${path}`);
      }
      confirmedPostimages.set(path, observed.hash);
      if (beforeHash === afterHash) continue;
      const existing = changedFiles.find((file) => file.path === path);
      if (existing) {
        existing.after_hash = afterHash;
        existing.bytes = observed.bytes;
      } else {
        changedFiles.push({
          path,
          rationale: `${action.type} by sub-agent ${agentId}`,
          before_hash: beforeHash === WorkspaceTransactionManager.missingPathDigest() ? null : beforeHash,
          after_hash: afterHash,
          bytes: observed.bytes,
        });
      }
    }
    if (!reconcileChangedFiles(changedFiles, projectRoot)) {
      throw new Error('Mutation postimages are indeterminate');
    }
  };
  const inheritedBudgetResult = (limiter: ChildBudgetLimiter): MutationAgentLoopResult => {
    backgroundTaskRegistry.fail(taskId, `Inherited parent ${limiter} budget exhausted`);
    budgetController.dispose();
    return withMutationState(buildInheritedBudgetResult(
      agentId,
      limiter,
      changedFiles,
      toolCallLog,
      safetyController,
      roundForBudgetResult,
    ));
  };

  // ─── Deterministic mock path ────────────────────────────────────────────
  const useMock =
    input.useDeterministicMock === true ||
    process.env['BABEL_LITE_OFFLINE'] === '1';

  if (useMock) {
    const inheritedLimiter = budgetController.limiter();
    if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
    const mockActions = buildDeterministicMockActions(writeScope);
    let mockError: string | null = null;
    let mockSuccess = true;

    for (const action of mockActions) {
      const inheritedLimiter = budgetController.limiter();
      if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
      if (effectiveAbortSignal.aborted) {
        backgroundTaskRegistry.fail(taskId, 'Aborted');
        budgetController.dispose();
        return withMutationState(buildAbortedResult(agentId, null, changedFiles, toolCallLog, 0, safetyController, budgetController.timedOut()));
      }
      if (action.type === 'finish') {
        toolCallLog.push({
          step: toolCallLog.length + 1,
          tool: 'file_read' as ToolCallLog['tool'],
          target: '',
          exit_code: 0,
          stdout: action.summary,
          stderr: '',
          verified: true,
        });
        break;
      }

      if (isMutationAction(action) && isReadOnly) {
        mockError = `Mutation action "${action.type}" blocked: sub-agent ${agentId} has no write scope.`;
        mockSuccess = false;
        break;
      }

      if (action.type === 'write_file') {
        const targetPath = action.path;
        if (!isReadOnly && !isPathInScope(targetPath, writeScope, projectRoot)) {
          mockError = `Write blocked: "${targetPath}" is outside write scope [${writeScope.join(', ')}] for agent ${agentId}.`;
          mockSuccess = false;
          break;
        }
        if (safetyController) {
          const refusal = prepareMutation(action, 0);
          if (refusal) { mockError = refusal; mockSuccess = false; break; }
        }
      }

      // Execute via the tool executor
      let execution: Awaited<ReturnType<typeof executeActionWithPolicy>>;
      try {
        execution = await executeActionWithPolicy(action, preset, {
          ...input.toolContext,
          projectRoot,
          signal: effectiveAbortSignal,
        }, {
          ...input.executionEnvelope,
          executor,
        });
      } catch (err) {
        mockError = err instanceof Error ? err.message : String(err);
        mockSuccess = false;
        break;
      }
      bindFailedWriteForRollback(action, execution);
      const lastResult = execution.results[execution.results.length - 1];
      if (!lastResult) { mockError = 'Tool execution returned no settlement result'; mockSuccess = false; break; }

      try {
        recordMutation(action, execution);
      } catch (error) {
        mockError = error instanceof Error ? error.message : String(error);
        mockSuccess = false;
        break;
      }

      toolCallLog.push(buildToolCallLogEntry(toolCallLog.length + 1, action, lastResult));
      priorObservations += '\n' + formatMutationObservation(action, lastResult);
      if (execution.policyBlocked || execution.results.some((result) => result.exit_code !== 0)) {
        mockError = execution.policyBlocked ? `Policy blocked: ${lastResult.stderr}` : lastResult.stderr || 'Tool execution failed';
        mockSuccess = false;
        break;
      }

      const postActionLimiter = budgetController.limiter();
      if (postActionLimiter) return inheritedBudgetResult(postActionLimiter);
    }

    if (!mockSuccess && safetyController && refreshUncertainty().length > 0) {
      rollbackChildChanges(safetyController, changedFiles, `Rollback on failed mock mutation for ${agentId}`);
    }
    if (budgetController.timedOut()) { mockSuccess = false; mockError = 'Child timed out at local deadline'; }
    if (!reconcileChangedFiles(changedFiles, projectRoot)) { mockSuccess = false; mockError = 'Mutation postimages are indeterminate'; }
    const mockAttribution = budgetController.timedOut() ? 'child_timeout' : classifySubagentFailure({
      success: mockSuccess,
      error: mockError,
      changedFilesCount: changedFiles.length,
      aborted: effectiveAbortSignal.aborted && budgetController.limiter() === null,
    });

    if (mockSuccess) {
      backgroundTaskRegistry.complete(taskId);
    } else {
      backgroundTaskRegistry.fail(taskId, mockError ?? 'Failed');
    }

    budgetController.dispose();
    return withMutationState({
      success: mockSuccess,
      attribution: mockAttribution,
      summary: mockSuccess
        ? changedFiles.length > 0
          ? `Sub-agent ${agentId} (mock) completed ${toolCallLog.length} step(s), ${changedFiles.length} file(s) changed.`
          : `Sub-agent ${agentId} (mock) completed ${toolCallLog.length} step(s), 0 changed (no-op).`
        : `Sub-agent ${agentId} (mock) failed: ${mockError ?? 'unknown error'}`,
      changedFiles,
      toolCallLog,
      stepsExecuted: toolCallLog.length,
      error: mockError,
      rollbackSummary: null,
      rollback: async () =>
        safetyController
          ? rollbackChildChanges(safetyController, changedFiles, `Manual rollback for sub-agent ${agentId} (mock)`)
          : createEmptyRollbackSummary('No safety controller — no rollback needed'),
    });
  }

  // ─── Main loop ──────────────────────────────────────────────────────────
  let success = true;
  let error: string | null = null;
  let rollbackSummary: WorktreeRollbackSummary | null = null;
  let round = 0;
  let finished = false;

  try {
    while (round < maxRounds) {
      roundForBudgetResult = round;
      const inheritedLimiter = budgetController.limiter();
      if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
      // Check cancellation
      if (effectiveAbortSignal.aborted) {
        backgroundTaskRegistry.fail(taskId, 'Aborted');
        budgetController.dispose();
        return withMutationState(buildAbortedResult(agentId, error, changedFiles, toolCallLog, round, safetyController, budgetController.timedOut()));
      }

      round += 1;
      backgroundTaskRegistry.updateProgress(taskId, round, maxRounds);

      // Build prompt
      const prompt = buildMutationAgentTurnPrompt({
        task: input.task,
        projectRoot,
        round,
        maxRounds,
        priorObservations,
        writeScope,
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(input.additionalInstructions
          ? { additionalInstructions: input.additionalInstructions }
          : {}),
      });

      // Resolve agent actions from LLM (race abort so cancel during execution is noticed)
      let actions: AgentAction[];
      try {
        const resolvePromise = input.actionResolver
          ? input.actionResolver(prompt, effectiveAbortSignal).then((resolved) =>
              AgentActionsEnvelopeSchema.parse({ actions: resolved }),
            )
          : runWithPrimaryOnlyFallback(prompt, AgentActionsEnvelopeSchema, {
              stage: 'executor',
              schemaName: 'AgentActionsEnvelopeSchema',
              maxCliAttempts: 2,
              signal: effectiveAbortSignal,
              budgetGuard: () => budgetController.limiter(),
              ...(input.onUsageRecorded ? { onUsageRecorded: () => input.onUsageRecorded?.() } : {}),
              ...(input.inheritedAllowance?.taskOwnerId &&
              input.inheritedAllowance.parentTaskOwnerId
                ? {
                    usageAttribution: {
                      taskOwnerId: input.inheritedAllowance.taskOwnerId,
                      parentTaskOwnerId: input.inheritedAllowance.parentTaskOwnerId,
                      projectRoot: realpathSync(projectRoot),
                      projectRootVersion: 1 as const,
                    },
                  }
                : {}),
              ...(input.model ? { model: input.model } : {}),
            });
        const envelope = effectiveAbortSignal
          ? await resolveUntilAbort(resolvePromise, effectiveAbortSignal)
          : await resolvePromise;
        actions = envelope.actions;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const inheritedLimiter = budgetController.limiter();
        if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
        if (effectiveAbortSignal.aborted || /abort/i.test(message)) {
          backgroundTaskRegistry.fail(taskId, 'Aborted');
          budgetController.dispose();
          return withMutationState(buildAbortedResult(agentId, message, changedFiles, toolCallLog, round, safetyController, budgetController.timedOut()));
        }
        error = `Failed to resolve agent actions: ${message}`;
        success = false;
        break;
      }

      // Execute each action
      for (const action of actions) {
        const inheritedLimiter = budgetController.limiter();
        if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
        // Check cancellation between actions
        if (effectiveAbortSignal.aborted) {
          backgroundTaskRegistry.fail(taskId, 'Aborted');
          budgetController.dispose();
          return withMutationState(buildAbortedResult(agentId, error, changedFiles, toolCallLog, round, safetyController, budgetController.timedOut()));
        }

        // Terminal actions
        if (action.type === 'finish') {
          toolCallLog.push({
            step: toolCallLog.length + 1,
            tool: 'file_read' as ToolCallLog['tool'],
            target: '',
            exit_code: 0,
            stdout: action.summary,
            stderr: '',
            verified: true,
          });
          // If we got here, we finished normally
          finished = true;
          break;
        }

        if (action.type === 'ask_approval') {
          toolCallLog.push({
            step: toolCallLog.length + 1,
            tool: 'file_read' as ToolCallLog['tool'],
            target: '',
            exit_code: 0,
            stdout: `Ask approval: ${action.reason}`,
            stderr: '',
            verified: true,
          });
          // Treat ask_approval as non-terminal for sub-agents — log it and continue
          continue;
        }

        // Validate write scope for mutation actions
        if (isMutationAction(action) && isReadOnly) {
          error = `Mutation action "${action.type}" blocked: sub-agent ${agentId} has no write scope.`;
          success = false;
          break;
        }

        // Validate path is in write scope for file writes
        if (
          (action.type === 'write_file' || action.type === 'apply_patch') &&
          !isReadOnly
        ) {
          const targetPaths = mutationTargetPaths(action);
          if (targetPaths.length === 0) {
            error = `Write blocked: apply_patch has no parseable targets for agent ${agentId}.`;
            success = false;
            break;
          }
          const outOfScope = targetPaths.find(
            (targetPath) => !isPathInScope(targetPath, writeScope, projectRoot),
          );
          if (outOfScope) {
            error = `Write blocked: "${outOfScope}" is outside write scope [${writeScope.join(', ')}] for agent ${agentId}.`;
            success = false;
            break;
          }
        }

        // Every parsed file target participates in whole-child rollback.
        const refusal = prepareMutation(action, round);
        if (refusal) { error = refusal; success = false; break; }

        // Execute the action through the policy gate
        const execution = await executeActionWithPolicy(action, preset, {
          ...input.toolContext,
          projectRoot,
          signal: effectiveAbortSignal,
        }, {
          ...input.executionEnvelope,
          executor,
        });

        bindFailedWriteForRollback(action, execution);
        const lastResult = execution.results[execution.results.length - 1];
        if (!lastResult) {
          error = 'Tool execution returned no settlement result';
          success = false;
          break;
        }

        if (execution.policyBlocked) {
          const blockReason = lastResult.stderr || 'Policy blocked mutation tool';
          toolCallLog.push({
            step: toolCallLog.length + 1,
            tool: action.type as ToolCallLog['tool'],
            target: actionTargetPath(action) ?? '',
            exit_code: lastResult.exit_code,
            stdout: lastResult.stdout,
            stderr: blockReason,
            verified: false,
          });
          error = `Policy blocked: ${blockReason}`;
          success = false;
          break;
        }

        // Log the tool call
        toolCallLog.push(buildToolCallLogEntry(toolCallLog.length + 1, action, lastResult));
        recordMutation(action, execution);
        if (execution.results.some((result) => result.exit_code !== 0)) {
          error = lastResult.stderr || 'Tool execution failed';
          success = false;
          break;
        }
        priorObservations +=
          '\n' + formatMutationObservation(action, lastResult);

        const postActionLimiter = budgetController.limiter();
        if (postActionLimiter) return inheritedBudgetResult(postActionLimiter);
      }

      // If we broke out of the inner loop with an error or terminal action, exit the outer loop
      if (error !== null || !success) break;

      if (finished) break;
    }

    if (!finished && error === null) {
      success = false;
      error = 'Round limit reached without finish';
      if (safetyController && changedFiles.length > 0 && rollbackSummary === null) {
        rollbackSummary = rollbackChildChanges(safetyController, changedFiles,
          `Rollback on sub-agent ${agentId} failure: ${error}`,
        );
      }
    }

    if (success) {
      backgroundTaskRegistry.complete(taskId);
    } else {
      backgroundTaskRegistry.fail(taskId, error ?? 'Failed');
    }
  } catch (err) {
    const inheritedLimiter = budgetController.limiter();
    if (inheritedLimiter) return inheritedBudgetResult(inheritedLimiter);
    success = false;
    error = budgetController.timedOut() ? 'Child timed out at local deadline' : err instanceof Error ? err.message : String(err);
    backgroundTaskRegistry.fail(taskId, error);

    // Auto-rollback on failure
    if (safetyController && changedFiles.length > 0) {
      rollbackSummary = rollbackChildChanges(safetyController, changedFiles,
        `Rollback on sub-agent ${agentId} failure: ${error}`,
      );
    }
  }

  if (!success && safetyController && refreshUncertainty().length > 0 && rollbackSummary === null) {
    rollbackSummary = rollbackChildChanges(safetyController, changedFiles, `Rollback on failed mutation for ${agentId}`);
  }
  if (budgetController.timedOut()) { success = false; error = 'Child timed out at local deadline'; }
  if (!reconcileChangedFiles(changedFiles, projectRoot)) { success = false; error = 'Mutation postimages are indeterminate'; }
  const attribution = budgetController.timedOut() ? 'child_timeout' : classifySubagentFailure({
    success,
    error,
    changedFilesCount: changedFiles.length,
    aborted: effectiveAbortSignal.aborted && !budgetController.timedOut() && budgetController.limiter() === null,
  });

  // Build the result
  const result: MutationAgentLoopResult = {
    success,
    attribution,
    summary: success
      ? changedFiles.length > 0
        ? `Sub-agent ${agentId} completed ${toolCallLog.length} step(s), ${changedFiles.length} file(s) changed.`
        : `Sub-agent ${agentId} completed ${toolCallLog.length} step(s), 0 changed (no-op).`
      : `Sub-agent ${agentId} failed: ${error ?? 'unknown error'}`,
    changedFiles,
    toolCallLog,
    stepsExecuted: toolCallLog.length,
    error,
    rollbackSummary,
    rollback: async () => {
      if (safetyController) {
        const summary = rollbackChildChanges(safetyController, changedFiles,
          `Manual rollback for sub-agent ${agentId}`,
        );
        rollbackSummary = summary;
        return summary;
      }
      return createEmptyRollbackSummary('No safety controller — no rollback needed');
    },
  };

  budgetController.dispose();

  return withMutationState(result);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAbortedResult(
  agentId: string,
  error: string | null,
  changedFiles: MutationAgentLoopResult['changedFiles'],
  toolCallLog: ToolCallLog[],
  round: number,
  safetyController: WorktreeSafetyController | null,
  timedOut = false,
): MutationAgentLoopResult {
  return {
    success: false,
    attribution: timedOut ? 'child_timeout' : 'child_cancellation',
    summary: `Sub-agent ${agentId} was aborted after ${round} round(s).`,
    changedFiles,
    toolCallLog,
    stepsExecuted: toolCallLog.length,
    error: timedOut ? 'Child timed out at local deadline' : error ?? 'Aborted by user or parent',
    rollbackSummary: null,
    rollback: async () => {
      if (safetyController) {
        return rollbackChildChanges(safetyController, changedFiles,
          `Rollback on abort for sub-agent ${agentId}`,
        );
      }
      return createEmptyRollbackSummary('No safety controller — nothing to rollback');
    },
  };
}

function buildInheritedBudgetResult(
  agentId: string,
  limiter: ChildBudgetLimiter,
  changedFiles: MutationAgentLoopResult['changedFiles'],
  toolCallLog: ToolCallLog[],
  safetyController: WorktreeSafetyController | null,
  round: number,
): MutationAgentLoopResult {
  const reason = `Inherited parent ${limiter} budget exhausted`;
  return {
    success: false,
    // T04: a wall/cost stop is not round exhaustion.
    attribution: childBudgetAttribution(limiter),
    summary: `Sub-agent ${agentId} stopped after ${round} round(s): ${reason}.`,
    changedFiles,
    toolCallLog,
    stepsExecuted: toolCallLog.length,
    error: reason,
    // Confirmed effects are intentionally preserved. The parent decides
    // whether reconciliation or rollback is appropriate after the boundary.
    rollbackSummary: null,
    inheritedBudgetExceeded: true,
    inheritedBudgetLimiter: limiter,
    rollback: async () => {
      if (safetyController) {
        return rollbackChildChanges(safetyController, changedFiles,
          `Manual rollback for inherited-budget stop of sub-agent ${agentId}`,
        );
      }
      return createEmptyRollbackSummary('No safety controller — no rollback needed');
    },
  };
}

function createEmptyRollbackSummary(reason: string): WorktreeRollbackSummary {
  return {
    schema_version: 1,
    artifact_type: 'babel_rollback_summary',
    status: 'rollback_not_needed',
    reason,
    restored_files: [],
    removed_files: [],
    rollback_not_needed_files: [],
    dirty_files_preserved: [],
    unrelated_untracked_files_preserved: [],
    target_dirty_conflicts: [],
    protected_path_conflicts: [],
    failed_files: [],
    changed_files_before_rollback: [],
    changed_files_after_rollback: [],
    next_recommended_operator_action: 'No action needed.',
  };
}
