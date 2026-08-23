/**
 * Every file mutation, including exact string replace, uses one
 * governed policy / checkpoint / integrity / cache path.
 *
 * str_replace is implemented as: read → replace → executeActionWithPolicy(write_file).
 * Callers must not bypass this with direct writeFile.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { FileWriteMutex, findNearMissContext } from '../services/editReliability.js';
import { applyUniqueEdit, formatEditObservation } from './codingLoop/editApply.js';
import type { ToolContext, ToolResult } from '../localTools.js';
import type { MutationBatchReceipt } from '../services/workspaceTransactions.js';
import type { AgentAction } from './actions.js';
import {
  executeActionWithPolicy,
  type PolicyGatedExecutionResult,
  type ToolExecutionBudget,
  type ToolExecutor,
} from './toolExecutor.js';
import type { PermissionPreset } from './policy.js';
import type { AuthoritySessionContext } from '../authority/sessionContext.js';
import type { AutonomyLease } from '../authority/lease.js';
import type { BaselineManifest } from '../authority/integrity.js';

export interface StrReplaceInput {
  file_path: string;
  old_str: string;
  new_str: string;
}

export interface GovernedStrReplaceResult {
  observation: string;
  exit_code: number;
  error?: string;
  policyBlocked: boolean;
  /** Terminal circuit-breaker or finish — loop must stop. */
  terminal: boolean;
  lineNumber?: number;
  absolutePath: string;
  policyDecision?: string;
  mutationPaths?: string[] | undefined;
  preBatchHash?: Record<string, string> | undefined;
  postBatchHash?: Record<string, string> | undefined;
  mutationReceipt?: MutationBatchReceipt | undefined;
}

function resolveProjectPath(projectRoot: string, filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(projectRoot, filePath);
}

/**
 * Apply exact string replacement through the central policy gate.
 * Uses write_file AgentAction so checkpoint, integrity, and cache invalidation
 * share the same path as other mutations.
 */
export async function governedStrReplace(
  input: StrReplaceInput,
  options: {
    projectRoot: string;
    context: ToolContext;
    preset?: PermissionPreset;
    executor?: ToolExecutor;
    budget?: ToolExecutionBudget;
    onAskApproval?: (action: AgentAction) => Promise<boolean>;
    onDispatchAuthorized?: () => { allowed: boolean; message?: string };
    onBeforeExecutorExecute?: () => void;
    authoritySession?: AuthoritySessionContext;
    lease?: AutonomyLease | null;
    baseline?: BaselineManifest;
    baselineRepoRoot?: string;
  },
): Promise<GovernedStrReplaceResult> {
  const preset = options.preset ?? 'workspace_write';
  const absolutePath = resolveProjectPath(options.projectRoot, input.file_path);
  const target = input.file_path;

  return await FileWriteMutex.runExclusive(absolutePath, async (lockHandle) => {
    let content: string;
    try {
      content = await readFile(absolutePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      observation: `### str_replace ${target}\nError: ${msg}`,
      exit_code: 1,
      error: msg,
      policyBlocked: false,
      terminal: false,
      absolutePath,
    };
  }

    const applied = applyUniqueEdit({
      content,
      oldStr: input.old_str,
      newStr: input.new_str,
    });
    if (!applied.ok) {
      let obsMsg = formatEditObservation(target, applied);
      if (applied.reason === 'not_found') {
        const candidates = findNearMissContext(content, input.old_str);
        if (candidates.length > 0) {
          const topCandidate = candidates[0]!;
          obsMsg += `\n\nDiagnostic: Did you mean lines ${topCandidate.startLine}-${topCandidate.endLine}?\n\`\`\`\n${topCandidate.context}\n\`\`\``;
        }
      }
      return {
        observation: obsMsg,
        exit_code: 1,
        error: applied.message,
        policyBlocked: false,
        terminal: false,
        absolutePath,
      };
    }
    const newContent = applied.content;
    const lineNumber = applied.startLine;

    const action: AgentAction = {
      type: 'write_file',
      path: input.file_path,
      content: newContent,
    };

  // SafeExecutor resolves paths via BABEL_PROJECT_ROOT (same pin as ChatEngine).
  // Honor BABEL_DRY_RUN — never clear it here (safety harness / dry-run must stick).
  const prevRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = options.projectRoot;

  let result: PolicyGatedExecutionResult;
  try {
    result = await executeActionWithPolicy(
      action,
      preset,
      options.context,
      {
        mutationRoot: options.projectRoot,
        lockContext: lockHandle,
        ...(options.executor ? { executor: options.executor } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.onAskApproval ? { onAskApproval: options.onAskApproval } : {}),
        ...(options.onDispatchAuthorized ? { onDispatchAuthorized: options.onDispatchAuthorized } : {}),
        ...(options.onBeforeExecutorExecute ? { onBeforeExecutorExecute: options.onBeforeExecutorExecute } : {}),
        ...(options.authoritySession ? { authoritySession: options.authoritySession } : {}),
        ...(options.lease !== undefined ? { lease: options.lease } : {}),
        ...(options.baseline && options.baselineRepoRoot
          ? { baseline: options.baseline, baselineRepoRoot: options.baselineRepoRoot }
          : {}),
      },
    );
  } finally {
    if (prevRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
    else process.env['BABEL_PROJECT_ROOT'] = prevRoot;
  }

  if (result.policyBlocked) {
    const stderr = result.results[0]?.stderr ?? 'policy blocked';
    return {
      observation: `### str_replace ${target}\nError: ${stderr}`,
      exit_code: 1,
      error: 'blocked',
      policyBlocked: true,
      terminal: result.terminal === true,
      absolutePath,
      policyDecision: result.policyDecision,
    };
  }

  const last = result.results[result.results.length - 1];
  const exitCode = last?.exit_code ?? 1;
  if (exitCode !== 0) {
    return {
      observation: `### str_replace ${target}\nError: ${last?.stderr ?? 'write failed'}`,
      exit_code: exitCode,
      error: last?.stderr ?? 'write failed',
      policyBlocked: false,
      terminal: result.terminal === true,
      absolutePath,
    };
  }

    return {
      observation: formatEditObservation(target, applied),
      exit_code: 0,
      policyBlocked: false,
      terminal: result.terminal === true,
      lineNumber,
      absolutePath,
      policyDecision: result.policyDecision,
      mutationPaths: result.mutationPaths,
      preBatchHash: result.preBatchHash,
      postBatchHash: result.postBatchHash,
      mutationReceipt: result.mutationReceipt,
    };
  });
}

/** Map a ToolResult-shaped object for callers that expect executeTool shape. */
export function governedResultToToolResult(
  result: GovernedStrReplaceResult,
): ToolResult {
  return {
    exit_code: result.exit_code,
    stdout: result.exit_code === 0 ? result.observation : '',
    stderr: result.exit_code !== 0 ? result.error ?? result.observation : '',
  };
}
