/**
 * Every file mutation, including exact string replace, uses one
 * governed policy / checkpoint / integrity / cache path.
 *
 * str_replace is implemented as: read → replace → executeActionWithPolicy(write_file).
 * Callers must not bypass this with direct writeFile.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import {
  executeActionWithPolicy,
  type PolicyGatedExecutionResult,
  type ToolExecutionBudget,
  type ToolExecutor,
} from './toolExecutor.js';
import { decideAction, type PermissionPreset } from './policy.js';

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
  },
): Promise<GovernedStrReplaceResult> {
  const preset = options.preset ?? 'workspace_write';
  const absolutePath = resolveProjectPath(options.projectRoot, input.file_path);
  const target = input.file_path;

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

  const firstIdx = content.indexOf(input.old_str);
  if (firstIdx === -1) {
    return {
      observation: `### str_replace ${target}\nError: str_replace: old_str not found in file`,
      exit_code: 1,
      error: 'str_replace: old_str not found',
      policyBlocked: false,
      terminal: false,
      absolutePath,
    };
  }
  const lastIdx = content.lastIndexOf(input.old_str);
  if (firstIdx !== lastIdx) {
    return {
      observation: `### str_replace ${target}\nError: str_replace: old_str matches multiple locations — make it more specific`,
      exit_code: 1,
      error: 'str_replace: ambiguous match',
      policyBlocked: false,
      terminal: false,
      absolutePath,
    };
  }

  const lineNumber = content.substring(0, firstIdx).split('\n').length;
  const newContent = content.replace(input.old_str, input.new_str);

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
        ...(options.executor ? { executor: options.executor } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.onAskApproval ? { onAskApproval: options.onAskApproval } : {}),
        decide: decideAction,
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

  const previewLines = newContent.split('\n');
  const pStart = Math.max(0, lineNumber - 2);
  const pEnd = Math.min(previewLines.length, lineNumber + 3);
  const preview = previewLines
    .slice(pStart, pEnd)
    .map((l, i) => `${pStart + i + 1}:${l}`)
    .join('\n');

  return {
    observation: `### str_replace ${target} (line ${lineNumber})\nexit_code: 0\n\`\`\`\n${preview}\n\`\`\``,
    exit_code: 0,
    policyBlocked: false,
    terminal: result.terminal === true,
    lineNumber,
    absolutePath,
    policyDecision: result.policyDecision,
  };
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
