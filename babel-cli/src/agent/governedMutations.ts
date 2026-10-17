/**
 * Every file mutation, including exact string replace, uses one
 * governed policy / checkpoint / integrity / cache path.
 *
 * str_replace is implemented as: read → replace → executeActionWithPolicy(write_file).
 * Callers must not bypass this with direct writeFile.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { FileWriteMutex, canonicalizeLockPath, type FileLockHandle } from '../services/editReliability.js';
import { applyUniqueEdit, formatEditObservation } from './codingLoop/editApply.js';
import { applyPatchInMemory, parseUnifiedDiff } from './codingLoop/patchApply.js';
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
  effectTransaction?: PolicyGatedExecutionResult['effectTransaction'];
  /** Exact edit validation failed before any executor dispatch. */
  preDispatchNoEffect?: boolean;
  /** Fuzzy assist auto-applied this write (similarity >= 0.90, unique candidate). */
  fuzzyAssisted?: true | undefined;
  /** Similarity of the fuzzy-assisted match, when fuzzyAssisted. */
  fuzzySimilarity?: number | undefined;
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
      // editApply already surfaces the scored near-miss suggestion
      // (did-you-mean lines X-Y with similarity) in the failure message.
      return {
        observation: formatEditObservation(target, applied),
        exit_code: 1,
        error: applied.message,
        policyBlocked: false,
        terminal: false,
        absolutePath,
        preDispatchNoEffect: true,
      };
    }
    const newContent = applied.content;
    const lineNumber = applied.startLine;
    const fuzzyAssisted = applied.matchKind === 'fuzzy_assist';
    const fuzzySimilarity = fuzzyAssisted ? (applied.fuzzySimilarity ?? 0) : undefined;
    const baseObservation = formatEditObservation(target, applied);
    const observation = fuzzyAssisted
      ? `${baseObservation}\nfuzzy_assist: similarity ${fuzzySimilarity?.toFixed(2)} — fuzzy-assisted write recorded in mutation receipt`
      : baseObservation;

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
      ...(result.mutationPaths ? { mutationPaths: result.mutationPaths } : {}),
      ...(result.preBatchHash ? { preBatchHash: result.preBatchHash } : {}),
      ...(result.postBatchHash ? { postBatchHash: result.postBatchHash } : {}),
      ...(result.mutationReceipt ? { mutationReceipt: result.mutationReceipt } : {}),
      ...(result.effectTransaction ? { effectTransaction: result.effectTransaction } : {}),
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
      ...(result.mutationPaths ? { mutationPaths: result.mutationPaths } : {}),
      ...(result.preBatchHash ? { preBatchHash: result.preBatchHash } : {}),
      ...(result.postBatchHash ? { postBatchHash: result.postBatchHash } : {}),
      ...(result.mutationReceipt ? { mutationReceipt: result.mutationReceipt } : {}),
      ...(result.effectTransaction ? { effectTransaction: result.effectTransaction } : {}),
    };
  }

    return {
      observation,
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
      ...(fuzzyAssisted ? { fuzzyAssisted: true, fuzzySimilarity } : {}),
      ...(result.effectTransaction ? { effectTransaction: result.effectTransaction } : {}),
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

// ── apply_patch: governed unified-diff application ─────────────────────────

export interface GovernedApplyPatchResult {
  observation: string;
  exit_code: number;
  error?: string;
  policyBlocked: boolean;
  /** Terminal circuit-breaker or finish — loop must stop. */
  terminal: boolean;
  absolutePaths: string[];
  policyDecision?: string;
  mutationPaths?: string[];
  preBatchHash?: Record<string, string>;
  postBatchHash?: Record<string, string>;
  mutationReceipt?: MutationBatchReceipt;
  effectTransaction?: PolicyGatedExecutionResult['effectTransaction'];
  /** Patch parse/validation/apply failed before any executor dispatch. */
  preDispatchNoEffect?: boolean;
}

export interface ApplyPatchInput {
  patch: string;
}

/**
 * Apply a unified diff through the central policy gate, identically to
 * str_replace: each target file's new content is written via a write_file
 * AgentAction so checkpoint, integrity, and cache invalidation share the same
 * path as other mutations. Whole-patch semantics are transactional: hunks are
 * applied in memory first; any failed hunk means nothing is written.
 */
interface PatchRollbackOutcome {
  rolledBack: string[];
  failures: string[];
}

/**
 * Restore only the paths this patch still owns. A path is only restored while
 * it still holds the exact bytes the patch wrote; anything else (a newer
 * external write, an external deletion, a non-regular file) is left in place
 * and reported instead. Blindly writing the pre-image over newer content would
 * destroy work this patch does not own while claiming atomicity.
 */
async function rollbackWrittenPaths(
  paths: string[],
  originalContents: Map<string, string>,
  createdPaths: Set<string>,
  writtenContents: Map<string, string>,
): Promise<PatchRollbackOutcome> {
  const rolledBack: string[] = [];
  const failures: string[] = [];
  for (const path of paths) {
    const expected = writtenContents.get(path);
    let current: string | null;
    try {
      current = await readFile(path, 'utf-8');
    } catch {
      current = null;
    }
    if (createdPaths.has(path) && current === null && !existsSync(path)) {
      rolledBack.push(path); // created file is already gone — outcome holds
      continue;
    }
    if (expected === undefined || current !== expected) {
      failures.push(
        `${path}: not restored — the file no longer holds the bytes this patch wrote`,
      );
      continue;
    }
    try {
      if (createdPaths.has(path)) {
        await rm(path, { force: true });
      } else {
        await writeFile(path, originalContents.get(path) ?? '', 'utf-8');
      }
      rolledBack.push(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${path}: restore failed — ${msg}`);
    }
  }
  return { rolledBack, failures };
}

/** Report a rollback truthfully: restored paths and paths deliberately left in place. */
function formatRollbackOutcome(rollback: PatchRollbackOutcome): string {
  const sections: string[] = [];
  if (rollback.rolledBack.length > 0) {
    sections.push(
      `Rolled back ${rollback.rolledBack.length} file(s): ${rollback.rolledBack.join(', ')}`,
    );
  }
  if (rollback.failures.length > 0) {
    sections.push(`Not restored: ${rollback.failures.join('; ')}`);
  }
  return sections.map((section) => `\n\n${section}`).join('');
}

/**
 * A failure result may only carry effect-transaction evidence that covers the
 * whole patch. A per-file dispatch transaction proves nothing about the other
 * targets, and presenting it as batch evidence let a patch that left a file
 * modified classify as `confirmed_no_change`.
 */
function batchScopedEffectTransaction(
  dispatch: PolicyGatedExecutionResult | null | undefined,
  batchPaths: string[],
): PolicyGatedExecutionResult['effectTransaction'] {
  const transaction = dispatch?.effectTransaction;
  if (!transaction || batchPaths.length === 0) return undefined;
  const covered = new Set(transaction.paths.map((path) => resolve(path)));
  return batchPaths.every((path) => covered.has(resolve(path))) ? transaction : undefined;
}

async function runExclusivePaths<T>(
  paths: string[],
  fn: (handles: FileLockHandle[]) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(paths.map((path) => canonicalizeLockPath(path)))].sort();
  const acquire = async (index: number, handles: FileLockHandle[]): Promise<T> => {
    if (index >= ordered.length) return fn(handles);
    const canonical = ordered[index];
    const path = paths.find((candidate) => canonicalizeLockPath(candidate) === canonical);
    if (!path) {
      throw new Error(`patch lock path missing: ${canonical}`);
    }
    return FileWriteMutex.runExclusive(
      path,
      async (handle) => acquire(index + 1, [...handles, handle]),
      { lockContext: handles },
    );
  };
  return acquire(0, []);
}

export async function governedApplyPatch(
  input: ApplyPatchInput,
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
): Promise<GovernedApplyPatchResult> {
  const preset = options.preset ?? 'workspace_write';
  const parsed = parseUnifiedDiff(input.patch);
  if (!parsed.ok) {
    return {
      observation: `### apply_patch\nError: ${parsed.message}`,
      exit_code: 1,
      error: parsed.message,
      policyBlocked: false,
      terminal: false,
      absolutePaths: [],
      preDispatchNoEffect: true,
    };
  }

  const targets = parsed.files.map((f) => f.newPath || f.oldPath || '');
  const absolutePaths = targets.map((t) => resolveProjectPath(options.projectRoot, t));

  // Phase A: read all target files.
  const contents = new Map<string, string>();
  const createdPaths = new Set<string>();
  for (let i = 0; i < parsed.files.length; i++) {
    const file = parsed.files[i];
    const absolutePath = absolutePaths[i];
    if (!file || !absolutePath) continue;
    if (contents.has(absolutePath)) continue; // same file addressed twice
    if (file.createsFile) {
      createdPaths.add(absolutePath);
      contents.set(absolutePath, '');
      continue;
    }
    try {
      contents.set(absolutePath, await readFile(absolutePath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const observation = `### apply_patch ${targets[i] ?? ''}\nError: cannot read patch target: ${msg}`;
      return {
        observation,
        exit_code: 1,
        error: observation,
        policyBlocked: false,
        terminal: false,
        absolutePaths,
        preDispatchNoEffect: true,
      };
    }
  }

  // Phase B: apply hunks in memory — all-or-nothing.
  const applied = applyPatchInMemory(parsed.files, (path) => {
    const absolutePath = resolveProjectPath(options.projectRoot, path);
    return contents.get(absolutePath) ?? '';
  });
  if (!applied.ok) {
    const observation =
      `### apply_patch\nError: patch failed to apply — all-or-nothing, nothing was written\n\n${applied.diagnostics}`;
    return {
      observation,
      exit_code: 1,
      error: 'patch failed to apply',
      policyBlocked: false,
      terminal: false,
      absolutePaths,
      preDispatchNoEffect: true,
    };
  }

  // Exact bytes this patch writes per target — the ownership test for rollback.
  const writtenContents = new Map<string, string>();
  for (const appliedFile of applied.results) {
    writtenContents.set(
      resolveProjectPath(options.projectRoot, appliedFile.path),
      appliedFile.content,
    );
  }

  // Phase C: dispatch each file's new content through the write_file gate,
  // identically to str_replace writes. Each file is re-validated under its
  // write lock before dispatch.
  const prevRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = options.projectRoot;

  const dispatchOptions = {
    mutationRoot: options.projectRoot,
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
  };

  const observations: string[] = [];
  const dispatchState: {
    lastPolicyDecision?: string;
    lastResult: PolicyGatedExecutionResult | null;
  } = { lastResult: null };
  const writtenPaths: string[] = [];

  try {
    await runExclusivePaths(absolutePaths, async (lockHandles) => {
      for (const result of applied.results) {
        const absolutePath = resolveProjectPath(options.projectRoot, result.path);
        const fileSection = parsed.files.find((f) => (f.newPath || f.oldPath) === result.path);
        const hunkCount = fileSection?.hunks.length ?? 0;

        let current: string;
        try {
          current = await readFile(absolutePath, 'utf-8');
        } catch {
          current = '';
        }
        const expected = contents.get(absolutePath) ?? '';
        if (current !== expected) {
          const conflictObservation =
            `### apply_patch ${result.path}\nError: file changed since patch was computed — not applying this file`;
          if (writtenPaths.length > 0) {
            const rollback = await rollbackWrittenPaths(
              writtenPaths,
              contents,
              createdPaths,
              writtenContents,
            );
            const observation = conflictObservation + formatRollbackOutcome(rollback);
            throw Object.assign(new Error('patch target changed concurrently'), {
              governedPatchFailure: {
                observation,
                exit_code: 1,
                error: 'patch target changed concurrently',
                policyBlocked: false,
                terminal: false,
                absolutePaths,
                preDispatchNoEffect: false,
              } satisfies GovernedApplyPatchResult,
            });
          }
          throw Object.assign(new Error('patch target changed concurrently'), {
            governedPatchFailure: {
              observation: conflictObservation,
              exit_code: 1,
              error: 'patch target changed concurrently',
              policyBlocked: false,
              terminal: false,
              absolutePaths,
              preDispatchNoEffect: true,
            } satisfies GovernedApplyPatchResult,
          });
        }

        const action: AgentAction = {
          type: 'write_file',
          path: result.path,
          content: result.content,
        };
        let dispatch: PolicyGatedExecutionResult;
        try {
          dispatch = await executeActionWithPolicy(action, preset, options.context, {
            ...dispatchOptions,
            lockContext: lockHandles,
          });
        } catch (dispatchError) {
          // An executor-level throw (timeout, transport fault, unexpected
          // error) can arrive after an earlier file was already written. A
          // dispatch was attempted, so an effect may exist: never claim the
          // pre-dispatch state and never leave the caller with a bare
          // exception plus a half-applied patch. Restore what this patch owns
          // and report what was and was not restored.
          const message =
            dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
          const rollback = await rollbackWrittenPaths(
            writtenPaths,
            contents,
            createdPaths,
            writtenContents,
          );
          const observation =
            `### apply_patch ${result.path}\nError: ${message}` +
            formatRollbackOutcome(rollback);
          throw Object.assign(new Error(message), {
            governedPatchFailure: {
              observation,
              exit_code: 1,
              error: message,
              policyBlocked: false,
              terminal: false,
              absolutePaths,
              preDispatchNoEffect: false,
            } satisfies GovernedApplyPatchResult,
          });
        }
        dispatchState.lastResult = dispatch;
        dispatchState.lastPolicyDecision = dispatch.policyDecision;
        if (dispatch.policyBlocked) {
          const stderr = dispatch.results[0]?.stderr ?? 'policy blocked';
          let observation = `### apply_patch ${result.path}\nError: ${stderr}`;
          if (writtenPaths.length > 0) {
            const rollback = await rollbackWrittenPaths(
              writtenPaths,
              contents,
              createdPaths,
              writtenContents,
            );
            observation += formatRollbackOutcome(rollback);
          }
          const effectTransaction = batchScopedEffectTransaction(dispatch, absolutePaths);
          throw Object.assign(new Error('blocked'), {
            governedPatchFailure: {
              observation,
              exit_code: 1,
              error: 'blocked',
              policyBlocked: true,
              terminal: dispatch.terminal === true,
              absolutePaths,
              policyDecision: dispatch.policyDecision,
              preDispatchNoEffect: writtenPaths.length === 0,
              ...(dispatch.mutationPaths ? { mutationPaths: dispatch.mutationPaths } : {}),
              ...(dispatch.preBatchHash ? { preBatchHash: dispatch.preBatchHash } : {}),
              ...(dispatch.postBatchHash ? { postBatchHash: dispatch.postBatchHash } : {}),
              ...(dispatch.mutationReceipt ? { mutationReceipt: dispatch.mutationReceipt } : {}),
              ...(effectTransaction ? { effectTransaction } : {}),
            } satisfies GovernedApplyPatchResult,
          });
        }
        const last = dispatch.results[dispatch.results.length - 1];
        if ((last?.exit_code ?? 1) !== 0) {
          const stderr = last?.stderr ?? 'write failed';
          let observation = `### apply_patch ${result.path}\nError: ${stderr}`;
          if (writtenPaths.length > 0) {
            const rollback = await rollbackWrittenPaths(
              writtenPaths,
              contents,
              createdPaths,
              writtenContents,
            );
            observation += formatRollbackOutcome(rollback);
          }
          const effectTransaction = batchScopedEffectTransaction(dispatch, absolutePaths);
          throw Object.assign(new Error(stderr), {
            governedPatchFailure: {
              observation,
              exit_code: last?.exit_code ?? 1,
              error: stderr,
              policyBlocked: false,
              terminal: dispatch.terminal === true,
              absolutePaths,
              // The executor ran, so an effect may exist even though this
              // dispatch reported failure — `writtenPaths` only tracks files
              // that completed. Never claim the pre-dispatch state here.
              preDispatchNoEffect: false,
              ...(dispatch.mutationPaths ? { mutationPaths: dispatch.mutationPaths } : {}),
              ...(dispatch.preBatchHash ? { preBatchHash: dispatch.preBatchHash } : {}),
              ...(dispatch.postBatchHash ? { postBatchHash: dispatch.postBatchHash } : {}),
              ...(dispatch.mutationReceipt ? { mutationReceipt: dispatch.mutationReceipt } : {}),
              ...(effectTransaction ? { effectTransaction } : {}),
            } satisfies GovernedApplyPatchResult,
          });
        }
        writtenPaths.push(absolutePath);
        observations.push(
          `### apply_patch ${result.path}\nApplied ${hunkCount} hunk${hunkCount === 1 ? '' : 's'} (${result.strategies.join(' → ') || 'none'}).`,
        );
      }
    });
  } catch (err) {
    const failure = (err as { governedPatchFailure?: GovernedApplyPatchResult }).governedPatchFailure;
    if (failure) return failure;
    throw err;
  } finally {
    if (prevRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
    else process.env['BABEL_PROJECT_ROOT'] = prevRoot;
  }

  const completedDispatch = dispatchState.lastResult;
  return {
    observation: observations.join('\n\n'),
    exit_code: 0,
    policyBlocked: false,
    terminal: completedDispatch?.terminal === true,
    absolutePaths,
    ...(dispatchState.lastPolicyDecision !== undefined
      ? { policyDecision: dispatchState.lastPolicyDecision }
      : {}),
    ...(completedDispatch?.mutationPaths ? { mutationPaths: completedDispatch.mutationPaths } : {}),
    ...(completedDispatch?.preBatchHash ? { preBatchHash: completedDispatch.preBatchHash } : {}),
    ...(completedDispatch?.postBatchHash ? { postBatchHash: completedDispatch.postBatchHash } : {}),
    ...(completedDispatch?.mutationReceipt ? { mutationReceipt: completedDispatch.mutationReceipt } : {}),
    ...(completedDispatch?.effectTransaction ? { effectTransaction: completedDispatch.effectTransaction } : {}),
  };
}
