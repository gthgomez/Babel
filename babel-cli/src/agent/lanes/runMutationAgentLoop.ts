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
import { existsSync, readFileSync } from 'node:fs';
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

// ─── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MUTATION_LOOP_MAX_ROUNDS = 8;

const MUTATION_TOOL_TYPES = new Set<AgentAction['type']>([
  'write_file',
  'apply_patch',
  'run_command',
]);

// ─── Types ─────────────────────────────────────────────────────────────────────

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
  /** Optional runDir for WorktreeSafetyController backup root */
  runDir?: string;
  /** If true, use deterministic mock actions instead of calling the LLM */
  useDeterministicMock?: boolean;
}

export interface MutationAgentLoopResult {
  /** Whether all steps completed successfully */
  success: boolean;
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

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readFileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return hashContent(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function isMutationAction(action: AgentAction): boolean {
  return MUTATION_TOOL_TYPES.has(action.type);
}

function actionTargetPath(action: AgentAction): string | null {
  if (action.type === 'write_file' || action.type === 'read_file') return action.path;
  if (action.type === 'list_dir') return action.path;
  if (action.type === 'apply_patch') return null;
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
    '',
    '# Prior Tool Observations',
    input.priorObservations.trim().length > 0 ? input.priorObservations : '(none yet)',
    '',
    'Use write_file and run_command to make changes. Finish when the task is complete.',
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

  // ─── Deterministic mock path ────────────────────────────────────────────
  const useMock =
    input.useDeterministicMock === true ||
    process.env['BABEL_LITE_OFFLINE'] === '1';

  if (useMock) {
    const mockActions = buildDeterministicMockActions(writeScope);
    let mockError: string | null = null;
    let mockSuccess = true;

    for (const action of mockActions) {
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
          safetyController.snapshotBeforeWrite(action.path);
        }
      }

      // Execute via the tool executor
      const execution = await executeActionWithPolicy(action, 'workspace_write', input.toolContext, {
        executor,
      });
      const lastResult = execution.results[execution.results.length - 1];
      if (!lastResult) continue;

      if (action.type === 'write_file') {
        const afterHash = readFileHash(resolve(projectRoot, action.path));
        const beforeHash = readFileHash(resolve(projectRoot, action.path));
        changedFiles.push({
          path: action.path,
          rationale: `Write by sub-agent ${agentId} (mock)`,
          before_hash: beforeHash,
          after_hash: afterHash ?? hashContent(action.content),
          bytes: action.content.length,
        });
      }

      toolCallLog.push(buildToolCallLogEntry(toolCallLog.length + 1, action, lastResult));
      priorObservations += '\n' + formatMutationObservation(action, lastResult);
    }

    backgroundTaskRegistry.complete(taskId);
    return {
      success: mockSuccess,
      summary: mockSuccess
        ? `Sub-agent ${agentId} (mock) completed ${toolCallLog.length} step(s), ${changedFiles.length} file(s) changed.`
        : `Sub-agent ${agentId} (mock) failed: ${mockError ?? 'unknown error'}`,
      changedFiles,
      toolCallLog,
      stepsExecuted: toolCallLog.length,
      error: mockError,
      rollbackSummary: null,
      rollback: async () =>
        safetyController
          ? safetyController.rollbackTouchedFiles('mock mode — no changes made')
          : createEmptyRollbackSummary('No safety controller — no rollback needed'),
    };
  }

  // ─── Main loop ──────────────────────────────────────────────────────────
  let success = true;
  let error: string | null = null;
  let rollbackSummary: WorktreeRollbackSummary | null = null;
  let round = 0;

  try {
    while (round < maxRounds) {
      // Check cancellation
      if (input.abortSignal?.aborted ?? false) {
        backgroundTaskRegistry.fail(taskId, 'Aborted');
        return buildAbortedResult(agentId, error, changedFiles, toolCallLog, round, safetyController);
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
      });

      // Resolve agent actions from LLM
      let actions: AgentAction[];
      try {
        const envelope = await runWithPrimaryOnlyFallback(prompt, AgentActionsEnvelopeSchema, {
          stage: 'executor',
          schemaName: 'AgentActionsEnvelopeSchema',
          maxCliAttempts: 2,
          ...(input.model ? { model: input.model } : {}),
        });
        actions = envelope.actions;
      } catch (err) {
        error = `Failed to resolve agent actions: ${err instanceof Error ? err.message : String(err)}`;
        success = false;
        break;
      }

      // Execute each action
      for (const action of actions) {
        // Check cancellation between actions
        if (input.abortSignal?.aborted ?? false) {
          backgroundTaskRegistry.fail(taskId, 'Aborted');
          return buildAbortedResult(agentId, error, changedFiles, toolCallLog, round, safetyController);
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
          const targetPath =
            action.type === 'write_file' ? action.path : '.babel-lite/apply.patch';
          if (!isPathInScope(targetPath, writeScope, projectRoot)) {
            error = `Write blocked: "${targetPath}" is outside write scope [${writeScope.join(', ')}] for agent ${agentId}.`;
            success = false;
            break;
          }
        }

        // Snapshot before mutation for rollback
        if (
          isMutationAction(action) &&
          safetyController &&
          action.type === 'write_file'
        ) {
          safetyController.snapshotBeforeWrite(action.path, round);
        }

        // Execute the action through the policy gate
        const execution = await executeActionWithPolicy(action, 'workspace_write', input.toolContext, {
          executor,
        });

        const lastResult = execution.results[execution.results.length - 1];
        if (!lastResult) {
          continue;
        }

        // Track changed files for mutation actions
        if (action.type === 'write_file') {
          const afterHash = readFileHash(resolve(projectRoot, action.path));
          const beforeHash = readFileHash(resolve(projectRoot, action.path));
          changedFiles.push({
            path: action.path,
            rationale: `Write by sub-agent ${agentId}`,
            before_hash: beforeHash,
            after_hash: afterHash ?? hashContent(action.content),
            bytes: action.content.length,
          });
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
        priorObservations +=
          '\n' + formatMutationObservation(action, lastResult);
      }

      // If we broke out of the inner loop with an error or terminal action, exit the outer loop
      if (error !== null || !success) break;

      // Check if the last action was a finish
      const lastAction = actions[actions.length - 1];
      if (lastAction?.type === 'finish') break;
    }

    backgroundTaskRegistry.complete(taskId);
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    backgroundTaskRegistry.fail(taskId, error);

    // Auto-rollback on failure
    if (safetyController && changedFiles.length > 0) {
      rollbackSummary = safetyController.rollbackTouchedFiles(
        `Rollback on sub-agent ${agentId} failure: ${error}`,
      );
    }
  }

  // Build the result
  const result: MutationAgentLoopResult = {
    success,
    summary: success
      ? `Sub-agent ${agentId} completed ${toolCallLog.length} step(s), ${changedFiles.length} file(s) changed.`
      : `Sub-agent ${agentId} failed: ${error ?? 'unknown error'}`,
    changedFiles,
    toolCallLog,
    stepsExecuted: toolCallLog.length,
    error,
    rollbackSummary,
    rollback: async () => {
      if (safetyController) {
        const summary = safetyController.rollbackTouchedFiles(
          `Manual rollback for sub-agent ${agentId}`,
        );
        rollbackSummary = summary;
        return summary;
      }
      return createEmptyRollbackSummary('No safety controller — no rollback needed');
    },
  };

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAbortedResult(
  agentId: string,
  error: string | null,
  changedFiles: MutationAgentLoopResult['changedFiles'],
  toolCallLog: ToolCallLog[],
  round: number,
  safetyController: WorktreeSafetyController | null,
): MutationAgentLoopResult {
  return {
    success: false,
    summary: `Sub-agent ${agentId} was aborted after ${round} round(s).`,
    changedFiles,
    toolCallLog,
    stepsExecuted: toolCallLog.length,
    error: error ?? 'Aborted by user or parent',
    rollbackSummary: null,
    rollback: async () => {
      if (safetyController) {
        return safetyController.rollbackTouchedFiles(
          `Rollback on abort for sub-agent ${agentId}`,
        );
      }
      return createEmptyRollbackSummary('No safety controller — nothing to rollback');
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
