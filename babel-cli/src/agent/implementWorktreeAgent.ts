/**
 * W2.1 — Implement worktree agent
 *
 * Spawns a mutation-capable implement child inside an isolated git worktree
 * with a required, disjoint path allowlist (write_scope). Parent working tree
 * must remain clean of child writes.
 *
 * Reuses:
 * - worktreeIsolation.createWorktree / removeWorktree
 * - runMutationAgentLoop (write_scope enforcement + tool loop)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveIsolationBrokerFlags } from './chatEngineIsolationFlags.js';
import { runWithTaskMutationWorkspace } from './executionContext.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { createWorktree, removeWorktree, type WorktreeInfo } from '../services/worktreeIsolation.js';
import { isCredentialTargetPath } from '../authority/protectedPath.js';
import { runWithProjectRoot, type ToolContext } from '../localTools.js';
import type { ToolExecutor } from './toolExecutor.js';
import {
  childBudgetAttribution,
  classifySubagentFailure,
  runMutationAgentLoop,
  type MutationAgentLoopResult,
  type ChildExecutionEnvelope,
  type SubagentAttribution,
} from './lanes/runMutationAgentLoop.js';
import {
  createChildBudgetController,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from './childBudget.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImplementWorktreeAgentSpec {
  /** Stable agent id (used in worktree name + logs). */
  id: string;
  /** Implement task for the child agent. */
  task: string;
  /**
   * Paths the child may mutate, relative to project/worktree root.
   * Required and non-empty for implement agents (mutation without scope is rejected).
   */
  writeScope: string[];
  maxRounds?: number;
  model?: string;
  /** S03: extra instructions from the advertised sub_agent contract. */
  instructions?: string;
}

export interface ImplementWorktreeAgentOptions {
  /** Parent project root (must be a git repo). */
  projectRoot: string;
  /** Artifact root for this implement run. */
  runDir?: string;
  /** Git ref for the worktree base. Default HEAD. */
  baseRef?: string;
  /** When true, remove the worktree after the run (default false — leave for merge/review). */
  cleanupWorktree?: boolean;
  /**
   * Explicitly discard unadopted child changes during cleanup. Without this,
   * a worktree that contains changes is retained and reported, so a child
   * patch is never silently dropped.
   */
  discardChildChanges?: boolean;
  abortSignal?: AbortSignal;
  executor?: ToolExecutor;
  /** Validated controller constraints; never infer an OS sandbox from a Git worktree. */
  executionEnvelope?: ChildExecutionEnvelope;
  useDeterministicMock?: boolean;
  /** Partial tool context; runDir/agentId filled by the runner. */
  toolContext?: Partial<ToolContext>;
  /** Bounded allowance inherited from the parent delegation point. */
  inheritedAllowance?: InheritedChildAllowance;
  /** Parent callback for durable task-cost checkpointing. */
  onUsageRecorded?: () => void;
}

export interface ImplementWorktreeAgentResult {
  agentId: string;
  success: boolean;
  attribution: SubagentAttribution;
  summary: string;
  writeScope: string[];
  worktree: WorktreeInfo;
  /** Observed committed base of the isolated workspace, distinct from parent dirty state. */
  baseSha?: string;
  /** True when parent `git status --porcelain` is unchanged by the child run. */
  parentTreeClean: boolean;
  parentStatusBefore: string;
  parentStatusAfter: string;
  changedFiles: MutationAgentLoopResult['changedFiles'];
  indeterminatePaths?: string[];
  stepsExecuted: number;
  error: string | null;
  mutation: MutationAgentLoopResult;
  diagnostics: Array<{ code: string; message: string }>;
  /** Durable manifest the parent uses for governed adoption. */
  adoptionManifestPath?: string;
  inheritedBudgetExceeded?: boolean;
  inheritedBudgetLimiter?: ChildBudgetLimiter;
}

export interface WriteScopeValidation {
  ok: boolean;
  diagnostics: Array<{ code: string; message: string; path?: string }>;
  normalizedScope: string[];
}

// ─── Path / scope helpers ─────────────────────────────────────────────────────

export function normalizeWriteScopeEntry(entry: string): string {
  return entry.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

export function isPathInWriteScope(
  path: string,
  writeScope: string[],
  projectRoot: string,
): boolean {
  if (writeScope.length === 0) return false;
  const absPath = resolve(projectRoot, path);
  return writeScope.some((scope) => {
    const scopeAbs = resolve(projectRoot, scope);
    const rel = relative(scopeAbs, absPath);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !rel.startsWith('/'));
  });
}

export function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeWriteScopeEntry(left);
  const b = normalizeWriteScopeEntry(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Validate a single implement agent's write_scope.
 * Empty scope is rejected (implement agents must declare mutation paths).
 */
export function validateImplementWriteScope(
  writeScope: string[],
  projectRoot: string,
): WriteScopeValidation {
  const diagnostics: WriteScopeValidation['diagnostics'] = [];
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    diagnostics.push({
      code: 'write_scope_required',
      message: 'Implement worktree agents require a non-empty write_scope path allowlist.',
    });
    return { ok: false, diagnostics, normalizedScope: [] };
  }

  const normalizedScope: string[] = [];
  for (const raw of writeScope) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      diagnostics.push({
        code: 'write_scope_invalid',
        message: 'Write scope entries must be non-empty relative paths.',
        path: String(raw),
      });
      continue;
    }
    const normalized = normalizeWriteScopeEntry(raw);
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      diagnostics.push({
        code: 'write_scope_absolute',
        message: `Write scope must be project-relative (got absolute path "${raw}").`,
        path: raw,
      });
      continue;
    }
    if (normalized.includes('..')) {
      diagnostics.push({
        code: 'write_scope_escape',
        message: `Write scope must not contain ".." segments ("${raw}").`,
        path: raw,
      });
      continue;
    }
    const resolved = resolve(projectRoot, normalized);
    const rel = relative(projectRoot, resolved);
    if (rel.startsWith('..') || rel.startsWith(sep) || rel.startsWith('/')) {
      diagnostics.push({
        code: 'write_scope_outside_root',
        message: `Write scope "${raw}" resolves outside project root.`,
        path: raw,
      });
      continue;
    }
    normalizedScope.push(normalized);
  }

  return {
    ok: diagnostics.length === 0 && normalizedScope.length > 0,
    diagnostics,
    normalizedScope,
  };
}

/**
 * Reject overlapping write scopes across concurrent implement agents (fan-out safety).
 */
export function validateDisjointWriteScopes(
  agents: Array<{ id: string; writeScope: string[] }>,
): Array<{ code: string; message: string }> {
  const diagnostics: Array<{ code: string; message: string }> = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const left = agents[i]!;
      const right = agents[j]!;
      for (const leftScope of left.writeScope) {
        for (const rightScope of right.writeScope) {
          if (scopesOverlap(leftScope, rightScope)) {
            diagnostics.push({
              code: 'write_scope_conflict',
              message: `Implement agents "${left.id}" and "${right.id}" have overlapping write scopes: ${leftScope} / ${rightScope}.`,
            });
          }
        }
      }
    }
  }
  return diagnostics;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

/**
 * Parent-tree cleanliness for W2.1 ignores Babel worktree / run artifacts under
 * `.babel/` (and common OS noise). Those paths are expected when creating an
 * implement worktree inside the project root; the gate is that *source* files
 * in the parent tree must not change because of the child agent.
 */
function filterParentStatusLines(porcelain: string): string {
  return porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => {
      // porcelain: XY <path>  or  XY <old> -> <new>
      const pathPart = line.length >= 3 ? line.slice(3).trim() : line;
      const normalized = pathPart.replace(/\\/g, '/').replace(/ -> /g, ' ');
      const candidates = normalized.split(/\s+/);
      return !candidates.some(
        (p) =>
          p === '.babel' ||
          p.startsWith('.babel/') ||
          p.includes('/.babel/') ||
          p.startsWith('.git/'),
      );
    })
    .join('\n');
}

function gitPorcelainStatus(
  projectRoot: string,
  control?: { deadlineAtMs?: number; abortSignal?: AbortSignal },
): string {
  if (control?.abortSignal?.aborted) return '[parent-cancelled]';
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    ...(control?.deadlineAtMs !== undefined
      ? { timeout: Math.max(0, control.deadlineAtMs - Date.now()) }
      : {}),
  });
  if (result.error) return `[git-status-error] ${result.error.message}`;
  if (result.status !== 0) {
    return (result.stderr || result.stdout || '').trim();
  }
  return filterParentStatusLines(result.stdout ?? '');
}

function worktreeNameForAgent(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return `impl-${safe}-${Date.now().toString(36)}`;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Run one implement agent in a fresh git worktree with a path allowlist.
 *
 * Acceptance (W2.1):
 * - Child writes only allowlisted paths (enforced by mutation loop + preflight)
 * - Parent dirty tree remains unchanged by the child run
 */
export async function runImplementWorktreeAgent(
  spec: ImplementWorktreeAgentSpec,
  options: ImplementWorktreeAgentOptions,
): Promise<ImplementWorktreeAgentResult> {
  const projectRoot = resolve(options.projectRoot);
  const setupBudgetController = createChildBudgetController(
    options.inheritedAllowance,
    options.abortSignal,
  );
  const setupLimiter = setupBudgetController.limiter();
  if (options.abortSignal?.aborted || setupLimiter) {
    const result = emptyInheritedWorktreeResult(
      spec,
      projectRoot,
      options.abortSignal?.aborted ? 'child_cancellation' : childBudgetAttribution(setupLimiter ?? undefined),
      setupLimiter,
    );
    setupBudgetController.dispose();
    return result;
  }
  const scopeValidation = validateImplementWriteScope(spec.writeScope, projectRoot);
  const diagnostics = scopeValidation.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
  }));

  if (!scopeValidation.ok) {
    setupBudgetController.dispose();
    const emptyWorktree: WorktreeInfo = {
      name: '',
      path: projectRoot,
      branch: 'none',
      detached: true,
      active: false,
    };
    const failedMutation = emptyMutationResult(
      `Write scope validation failed: ${diagnostics.map((d) => d.message).join('; ')}`,
    );
    return {
      agentId: spec.id,
      success: false,
      attribution: 'child_policy_block',
      summary: failedMutation.summary,
      writeScope: scopeValidation.normalizedScope,
      worktree: emptyWorktree,
      parentTreeClean: true,
      parentStatusBefore: '',
      parentStatusAfter: '',
      changedFiles: [],
      stepsExecuted: 0,
      error: failedMutation.error,
      mutation: failedMutation,
      diagnostics,
    };
  }

  const worktreeControl = {
    ...(options.inheritedAllowance?.deadlineAtMs !== null &&
    options.inheritedAllowance?.deadlineAtMs !== undefined
      ? { deadlineAtMs: options.inheritedAllowance.deadlineAtMs }
      : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
  const parentStatusBefore = gitPorcelainStatus(projectRoot, worktreeControl);
  const name = worktreeNameForAgent(spec.id);
  let worktree: WorktreeInfo;
  let baseSha: string | undefined;
  try {
    worktree = createWorktree(name, {
      projectRoot,
      detach: true,
      baseRef: options.baseRef ?? 'HEAD',
      ...(options.inheritedAllowance?.deadlineAtMs !== null &&
      options.inheritedAllowance?.deadlineAtMs !== undefined
        ? { deadlineAtMs: options.inheritedAllowance.deadlineAtMs }
        : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    const base = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.path, encoding: 'utf8', timeout: 4000, windowsHide: true,
    });
    if (base.status === 0 && /^[0-9a-f]{40,64}$/i.test(base.stdout.trim())) baseSha = base.stdout.trim();
    const afterSetupLimiter = setupBudgetController.limiter();
    setupBudgetController.dispose();
    if (options.abortSignal?.aborted || afterSetupLimiter) {
      try {
        removeWorktree(name, { projectRoot, force: true });
      } catch {
        // Preserve the inherited terminal result; cleanup diagnostics belong to
        // normal mutation completion, not an already-expired child.
      }
      return emptyInheritedWorktreeResult(
        spec,
        projectRoot,
        options.abortSignal?.aborted ? 'child_cancellation' : childBudgetAttribution(afterSetupLimiter ?? undefined),
        afterSetupLimiter,
      );
    }
  } catch (err) {
    const inheritedLimiter = setupBudgetController.limiter();
    if (options.abortSignal?.aborted || inheritedLimiter) {
      setupBudgetController.dispose();
      try {
        removeWorktree(name, { projectRoot, force: true });
      } catch {
        // Preserve the inherited terminal result if timed-out setup left no
        // registered worktree to remove.
      }
      return emptyInheritedWorktreeResult(
        spec,
        projectRoot,
        options.abortSignal?.aborted ? 'child_cancellation' : childBudgetAttribution(inheritedLimiter ?? undefined),
        inheritedLimiter,
      );
    }
    setupBudgetController.dispose();
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({ code: 'worktree_create_failed', message });
    const failedMutation = emptyMutationResult(`Worktree create failed: ${message}`);
    return {
      agentId: spec.id,
      success: false,
      attribution: 'child_environment_failure',
      summary: failedMutation.summary,
      writeScope: scopeValidation.normalizedScope,
      worktree: {
        name,
        path: join(projectRoot, '.babel', 'worktrees', name),
        branch: 'detached',
        detached: true,
        active: false,
      },
      parentTreeClean: true,
      parentStatusBefore,
      parentStatusAfter: gitPorcelainStatus(projectRoot, worktreeControl),
      changedFiles: [],
      stepsExecuted: 0,
      error: failedMutation.error,
      mutation: failedMutation,
      diagnostics,
    };
  }

  const runDir =
    options.runDir ?? join(projectRoot, '.babel', 'runs', 'implement-worktree', spec.id);
  const toolContext: ToolContext = {
    agentId: spec.id,
    runId: `implement-wt-${spec.id}`,
    runDir: join(runDir, 'tools'),
    babelRoot: process.env['BABEL_ROOT'] ?? projectRoot,
    projectRoot: worktree.path,
    ...(options.toolContext?.signal ? { signal: options.toolContext.signal } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  };

  let mutation: MutationAgentLoopResult;
  try {
    mutation = await runWithProjectRoot(worktree.path, () =>
      runWithTaskMutationWorkspace(worktree.path, spec.id, () =>
      runMutationAgentLoop({
        agentId: spec.id,
        task: spec.task,
        executionEnvelope: options.executionEnvelope ?? resolveIsolationBrokerFlags(worktree.path),
        projectRoot: worktree.path,
        writeScope: scopeValidation.normalizedScope,
        workspaceRoot: worktree.path,
        toolContext,
        ...(spec.maxRounds !== undefined ? { maxRounds: spec.maxRounds } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        ...(options.useDeterministicMock !== undefined
          ? { useDeterministicMock: options.useDeterministicMock }
          : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.instructions ? { additionalInstructions: spec.instructions } : {}),
        runDir,
        ...(options.inheritedAllowance
          ? { inheritedAllowance: options.inheritedAllowance }
          : {}),
        ...(options.onUsageRecorded ? { onUsageRecorded: options.onUsageRecorded } : {}),
      })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({ code: 'implement_run_failed', message });
    mutation = emptyMutationResult(message);
  }

  const parentStatusAfter =
    options.abortSignal?.aborted || mutation.inheritedBudgetExceeded
      ? parentStatusBefore
      : gitPorcelainStatus(projectRoot, worktreeControl);
  const parentTreeClean = parentStatusBefore === parentStatusAfter;
  if (!parentTreeClean) {
    diagnostics.push({
      code: 'parent_tree_dirty',
      message:
        'Parent working tree status changed during implement worktree run (child writes must stay in the worktree).',
    });
  }

  // Optional post-condition: every reported change is inside write_scope
  for (const change of mutation.changedFiles) {
    if (!isPathInWriteScope(change.path, scopeValidation.normalizedScope, worktree.path)) {
      diagnostics.push({
        code: 'write_scope_violation',
        message: `Changed file "${change.path}" is outside write_scope.`,
      });
    }
  }

  // Durable handoff for governed parent adoption. A child patch must remain
  // recoverable after the child process returns (and even when the worktree is
  // later pruned), so the recorded base and per-path hashes live beside the run.
  const adoptionManifestPath = join(runDir, 'child-adoption-manifest.json');
  try {
    mkdirSync(runDir, { recursive: true });
    const manifest: ChildAdoptionManifestV1 = {
      schema_version: 1,
      artifact_type: 'babel_child_adoption_manifest',
      created_at: new Date().toISOString(),
      agent_id: spec.id,
      worktree_name: worktree.name,
      worktree_path: worktree.path,
      base_sha: baseSha ?? null,
      write_scope: [...scopeValidation.normalizedScope],
      changed_files: mutation.changedFiles.map((file) => ({
        path: file.path,
        before_hash: file.before_hash,
        after_hash: file.after_hash === MISSING_PATH_DIGEST ? null : file.after_hash,
      })),
    };
    writeFileSync(adoptionManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  } catch (err) {
    diagnostics.push({
      code: 'adoption_manifest_write_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const hasUnadoptedChanges = mutation.changedFiles.length > 0;
  if (
    options.cleanupWorktree &&
    !options.abortSignal?.aborted &&
    !mutation.inheritedBudgetExceeded
  ) {
    if (hasUnadoptedChanges && options.discardChildChanges !== true) {
      // Removing the worktree here would silently discard the child patch.
      // Retain it until the parent adopts the recorded changes (or an operator
      // explicitly opts into discarding them).
      diagnostics.push({
        code: 'worktree_retained_unadopted_changes',
        message: `Worktree retained: ${mutation.changedFiles.length} unadopted change(s). Adopt from ${adoptionManifestPath} or pass discardChildChanges to remove it.`,
      });
    } else {
      try {
        removeWorktree(name, { projectRoot, force: true });
      } catch (err) {
        diagnostics.push({
          code: 'worktree_cleanup_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const hasScopeViolation = diagnostics.some((d) => d.code === 'write_scope_violation');
  const cleanupFailed = diagnostics.some((d) => d.code === 'worktree_cleanup_failed');
  const success =
    mutation.success && parentTreeClean && !hasScopeViolation && !cleanupFailed;

  let attribution: SubagentAttribution;
  if (cleanupFailed || !parentTreeClean) {
    attribution = 'child_environment_failure';
  } else if (hasScopeViolation) {
    attribution = 'child_policy_block';
  } else if (mutation.attribution) {
    attribution = mutation.attribution;
  } else {
    attribution = classifySubagentFailure({
      success,
      error: mutation.error ?? (diagnostics.length > 0 ? diagnostics.map((d) => d.message).join('; ') : null),
      changedFilesCount: mutation.changedFiles.length,
    });
  }

  const summary = success
    ? mutation.changedFiles.length > 0
      ? `Implement worktree agent ${spec.id}: ${mutation.changedFiles.length} file(s) in ${worktree.path} (parent clean).`
      : `Implement worktree agent ${spec.id}: 0 file(s) changed in ${worktree.path} (no-op; parent clean).`
    : `Implement worktree agent ${spec.id} failed: ${mutation.error ?? diagnostics.map((d) => d.message).join('; ')}`;

  return {
    agentId: spec.id,
    success,
    attribution,
    summary,
    writeScope: scopeValidation.normalizedScope,
    worktree,
    ...(baseSha ? { baseSha } : {}),
    parentTreeClean,
    parentStatusBefore,
    parentStatusAfter,
    changedFiles: mutation.changedFiles,
    ...(mutation.indeterminatePaths ? { indeterminatePaths: mutation.indeterminatePaths } : {}),
    stepsExecuted: mutation.stepsExecuted,
    error: success ? null : (mutation.error ?? diagnostics.map((d) => d.message).join('; ')),
    mutation,
    diagnostics,
    adoptionManifestPath,
    ...(mutation.inheritedBudgetExceeded
      ? {
          inheritedBudgetExceeded: true,
          ...(mutation.inheritedBudgetLimiter
            ? { inheritedBudgetLimiter: mutation.inheritedBudgetLimiter }
            : {}),
        }
      : {}),
  };
}

/**
 * Fan-out multiple implement agents with disjoint scopes (serial for safety in v1).
 * Overlapping scopes fail before any worktree is created.
 */
export async function runImplementWorktreeAgents(
  specs: ImplementWorktreeAgentSpec[],
  options: ImplementWorktreeAgentOptions,
): Promise<ImplementWorktreeAgentResult[]> {
  const conflict = validateDisjointWriteScopes(
    specs.map((s) => ({ id: s.id, writeScope: s.writeScope })),
  );
  if (conflict.length > 0) {
    return specs.map((spec) => {
      const failed = emptyMutationResult(conflict.map((c) => c.message).join('; '));
      return {
        agentId: spec.id,
        success: false,
        attribution: 'child_policy_block' as SubagentAttribution,
        summary: failed.summary,
        writeScope: spec.writeScope.map(normalizeWriteScopeEntry),
        worktree: {
          name: '',
          path: options.projectRoot,
          branch: 'none',
          detached: true,
          active: false,
        },
        parentTreeClean: true,
        parentStatusBefore: '',
        parentStatusAfter: '',
        changedFiles: [],
        stepsExecuted: 0,
        error: failed.error,
        mutation: failed,
        diagnostics: conflict,
      };
    });
  }

  const results: ImplementWorktreeAgentResult[] = [];
  for (const spec of specs) {
    results.push(await runImplementWorktreeAgent(spec, options));
  }
  return results;
}

function emptyMutationResult(error: string): MutationAgentLoopResult {
  return {
    success: false,
    attribution: classifySubagentFailure({ success: false, error, changedFilesCount: 0 }),
    summary: error,
    changedFiles: [],
    toolCallLog: [],
    stepsExecuted: 0,
    error,
    rollbackSummary: null,
    rollback: async () => ({
      schema_version: 1 as const,
      artifact_type: 'babel_rollback_summary' as const,
      status: 'rollback_not_needed' as const,
      reason: error,
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
    }),
  };
}

function emptyInheritedWorktreeResult(
  spec: ImplementWorktreeAgentSpec,
  projectRoot: string,
  attribution: SubagentAttribution,
  limiter: ChildBudgetLimiter | null,
): ImplementWorktreeAgentResult {
  const error = limiter
    ? `Inherited parent ${limiter} budget exhausted`
    : 'Aborted by user or parent';
  const mutation = {
    ...emptyMutationResult(error),
    attribution,
    ...(limiter
      ? { inheritedBudgetExceeded: true, inheritedBudgetLimiter: limiter }
      : {}),
  };
  return {
    agentId: spec.id,
    success: false,
    attribution,
    summary: error,
    writeScope: spec.writeScope,
    worktree: {
      name: '',
      path: projectRoot,
      branch: 'none',
      detached: true,
      active: false,
    },
    parentTreeClean: true,
    parentStatusBefore: '',
    parentStatusAfter: '',
    changedFiles: [],
    stepsExecuted: 0,
    error,
    mutation,
    diagnostics: [{
      code: limiter ? 'inherited_budget_exhausted' : 'aborted',
      message: error,
    }],
    ...(limiter
      ? { inheritedBudgetExceeded: true, inheritedBudgetLimiter: limiter }
      : {}),
  };
}

/** True when a path exists under a worktree but not (or differently) under parent — debug helper. */
export function worktreePathExists(worktreePath: string, relativePath: string): boolean {
  return existsSync(join(worktreePath, relativePath));
}

// ─── W2.1 promote / merge worktree → parent ───────────────────────────────────

export type ImplementPromoteMode = 'copy' | 'dry_run';

/** One recorded child change. A null hash means the path was absent on that side. */
export interface ChildChangeRecord {
  path: string;
  before_hash: string | null;
  after_hash: string | null;
}

/** Durable handoff manifest written beside the child run. */
export interface ChildAdoptionManifestV1 {
  schema_version: 1;
  artifact_type: 'babel_child_adoption_manifest';
  created_at: string;
  agent_id: string;
  worktree_name: string;
  worktree_path: string;
  base_sha: string | null;
  write_scope: string[];
  changed_files: ChildChangeRecord[];
}

export type AdoptionConflictCode =
  | 'invalid_path'
  | 'foreign_worktree'
  | 'outside_write_scope'
  | 'credential_path'
  | 'unsafe_symlink'
  | 'stale_child_base'
  | 'child_postimage_missing'
  | 'child_postimage_mismatch'
  | 'parent_preimage_conflict'
  | 'duplicate_change'
  | 'apply_failed';

export interface AdoptionConflict {
  path: string;
  code: AdoptionConflictCode;
  message: string;
}

export interface AdoptionVerificationContext {
  projectRoot: string;
  adoptedPaths: string[];
  deletedPaths: string[];
}

export interface AdoptionVerificationResult {
  ok: boolean;
  summary: string;
  diagnostics?: Array<{ code: string; message: string }>;
}

export type AdoptionStatus = 'adopted' | 'dry_run' | 'refused' | 'noop' | 'verification_failed';

export interface PromoteImplementWorktreeInput {
  /** Parent project root (receives promoted files). */
  projectRoot: string;
  /** Absolute path to the implement worktree. */
  worktreePath: string;
  /** Same write_scope used for the implement run (required). */
  writeScope: string[];
  /**
   * Optional explicit relative paths to promote. When omitted, discovers dirty
   * paths under write_scope in the worktree (git status + untracked).
   */
  paths?: string[];
  /** copy (default) applies files; dry_run only reports what would change. */
  mode?: ImplementPromoteMode;
  /**
   * When true (default), refuse promote if a parent path already has uncommitted
   * changes outside of an exact content match with the worktree.
   */
  requireParentPathClean?: boolean;
  /** When true, remove the worktree after a successful promote (not dry_run). */
  cleanupWorktree?: boolean;
  /** Worktree name for removeWorktree (defaults to basename of worktreePath). */
  worktreeName?: string;
  /** Base commit recorded by the child result; enables stale-base refusal. */
  baseSha?: string;
  /**
   * Exact child changes recorded by the child result. When present, adoption is
   * all-or-nothing and verifies both the child postimage and parent preimage.
   */
  expectedChanges?: ChildChangeRecord[];
  /** Explicit operator override for a parent that advanced past the child base. */
  allowAdvancedBase?: boolean;
  /** Parent-side reverification after adoption. */
  verify?: (context: AdoptionVerificationContext) => AdoptionVerificationResult;
}

export interface PromoteImplementWorktreeResult {
  success: boolean;
  status: AdoptionStatus;
  mode: ImplementPromoteMode;
  promotedPaths: string[];
  adoptedPaths: string[];
  deletedPaths: string[];
  skippedPaths: Array<{ path: string; reason: string }>;
  conflicts: AdoptionConflict[];
  diagnostics: Array<{ code: string; message: string }>;
  parentStatusBefore: string;
  parentStatusAfter: string;
  parentHeadSha: string | null;
  childBaseSha: string | null;
  verification: AdoptionVerificationResult | null;
  worktreeRemoved: boolean;
  summary: string;
  error: string | null;
}

const MISSING_PATH_DIGEST = createHash('sha256')
  .update('babel://workspace-transactions/missing-path/v1')
  .digest('hex');

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash a file's bytes, the missing-path digest when absent, or null when unreadable. */
function hashWorkspacePath(path: string): string | null {
  try {
    return hashBuffer(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MISSING_PATH_DIGEST;
    return null;
  }
}

function gitHeadSha(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const sha = (result.stdout ?? '').trim();
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}

/** Resolve the repository identity shared by a parent checkout and its worktree. */
function gitCommonDir(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  // Older Git prints a relative path; resolve it against the queried checkout.
  return value.length > 0 ? resolve(root, value) : null;
}

/** Reject a path that escapes the root through `..`, a drive letter or a symlink. */
function adoptionPathSafety(root: string, relativePath: string): AdoptionConflict | null {
  const normalized = normalizeWriteScopeEntry(relativePath);
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.split('/').includes('.git')
  ) {
    return { path: relativePath, code: 'invalid_path', message: `Path "${relativePath}" is not a safe project-relative path.` };
  }
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('/')) {
    return { path: relativePath, code: 'invalid_path', message: `Path "${relativePath}" resolves outside the project root.` };
  }
  if (isCredentialTargetPath(normalized)) {
    return { path: relativePath, code: 'credential_path', message: `Path "${relativePath}" is a credential/protected path.` };
  }
  // Existing symlink components can redirect a write outside the project.
  let cursor = target;
  while (cursor !== root && cursor.startsWith(root)) {
    if (existsSync(cursor)) {
      try {
        const stats = lstatSync(cursor);
        if (stats.isSymbolicLink()) {
          return { path: relativePath, code: 'unsafe_symlink', message: `Path "${relativePath}" traverses a symlink.` };
        }
      } catch {
        return { path: relativePath, code: 'invalid_path', message: `Path "${relativePath}" could not be inspected.` };
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/** Write bytes atomically (same-directory temp file + rename). */
function writeFileAtomic(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.babel-adopt-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * List project-relative paths under write_scope that differ in the worktree
 * (modified or untracked), using git status --porcelain in the worktree.
 */
export function listWorktreeScopedChanges(
  worktreePath: string,
  writeScope: string[],
  projectRootForScope: string,
): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '-uall'], {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return [];
  }
  const paths: string[] = [];
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // porcelain: XY <path>  or  XY <old> -> <new>
    let pathPart = line.length >= 3 ? line.slice(3).trim() : line.trim();
    if (pathPart.includes(' -> ')) {
      pathPart = pathPart.split(' -> ').pop()!.trim();
    }
    // Strip quotes if git quoted the path
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.slice(1, -1);
    }
    const normalized = normalizeWriteScopeEntry(pathPart);
    if (!normalized || normalized.startsWith('.babel/') || normalized.startsWith('.git/')) {
      continue;
    }
    if (isPathInWriteScope(normalized, writeScope, projectRootForScope)) {
      if (!paths.includes(normalized)) paths.push(normalized);
    }
  }
  return paths;
}

/**
 * Recursively collect files under a directory relative to worktree root (for new dirs).
 */
function listFilesUnderRelativeDir(root: string, relDir: string): string[] {
  const abs = join(root, relDir);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [normalizeWriteScopeEntry(relDir)];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === '.git' || name === 'node_modules') continue;
    const childRel = normalizeWriteScopeEntry(join(relDir, name));
    out.push(...listFilesUnderRelativeDir(root, childRel));
  }
  return out;
}

/**
 * Expand promote path list: files stay files; directories expand to files under worktree.
 */
export function resolvePromoteFileList(
  worktreePath: string,
  candidates: string[],
): string[] {
  const files: string[] = [];
  for (const rel of candidates) {
    const abs = join(worktreePath, rel);
    if (!existsSync(abs)) {
      // Deletion in worktree — still record for skip/diagnostic later
      files.push(normalizeWriteScopeEntry(rel));
      continue;
    }
    if (statSync(abs).isDirectory()) {
      files.push(...listFilesUnderRelativeDir(worktreePath, rel));
    } else {
      files.push(normalizeWriteScopeEntry(rel));
    }
  }
  return [...new Set(files)];
}

/**
 * Promote implement worktree changes into the parent tree (operator-gated merge).
 *
 * Safety:
 * - Only paths inside write_scope are copied
 * - Default refuses when parent path is dirty and differs from worktree
 * - dry_run reports without writing
 * - Optional cleanup removes worktree after success
 */
export function promoteImplementWorktree(
  input: PromoteImplementWorktreeInput,
): PromoteImplementWorktreeResult {
  const projectRoot = resolve(input.projectRoot);
  const worktreePath = resolve(input.worktreePath);
  const mode: ImplementPromoteMode = input.mode ?? 'copy';
  const requireParentPathClean = input.requireParentPathClean !== false;
  const diagnostics: Array<{ code: string; message: string }> = [];
  const skippedPaths: Array<{ path: string; reason: string }> = [];
  const conflicts: AdoptionConflict[] = [];
  const promotedPaths: string[] = [];
  const adoptedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const parentHeadSha = existsSync(projectRoot) ? gitHeadSha(projectRoot) : null;
  const childBaseSha = input.baseSha
    ?? (existsSync(worktreePath) ? gitHeadSha(worktreePath) : null);
  const parentStatusBefore = existsSync(projectRoot) ? gitPorcelainStatus(projectRoot) : '';

  const buildResult = (
    overrides: Partial<PromoteImplementWorktreeResult>,
  ): PromoteImplementWorktreeResult => ({
    success: false,
    status: 'refused',
    mode,
    promotedPaths,
    adoptedPaths,
    deletedPaths,
    skippedPaths,
    conflicts,
    diagnostics,
    parentStatusBefore,
    parentStatusAfter: parentStatusBefore,
    parentHeadSha,
    childBaseSha,
    verification: null,
    worktreeRemoved: false,
    summary: '',
    error: null,
    ...overrides,
  });

  const scopeValidation = validateImplementWriteScope(input.writeScope, projectRoot);
  if (!scopeValidation.ok) {
    diagnostics.push(...scopeValidation.diagnostics.map((d) => ({ code: d.code, message: d.message })));
    return buildResult({
      summary: 'Promote rejected: invalid write_scope',
      error: 'invalid write_scope',
    });
  }

  if (!existsSync(worktreePath)) {
    diagnostics.push({
      code: 'worktree_missing',
      message: `Worktree path does not exist: ${worktreePath}`,
    });
    return buildResult({
      summary: 'Promote rejected: worktree missing',
      error: 'worktree missing',
    });
  }

  const parentCommonDir = gitCommonDir(projectRoot);
  const worktreeCommonDir = gitCommonDir(worktreePath);
  if (
    parentCommonDir === null ||
    worktreeCommonDir === null ||
    parentCommonDir !== worktreeCommonDir
  ) {
    conflicts.push({
      path: '(repository)',
      code: 'foreign_worktree',
      message: 'The worktree does not belong to the parent repository; refusing a cross-project adoption.',
    });
  }

  if (
    input.baseSha !== undefined &&
    parentHeadSha !== null &&
    parentHeadSha !== input.baseSha &&
    input.allowAdvancedBase !== true
  ) {
    conflicts.push({
      path: '(repository)',
      code: 'stale_child_base',
      message: `Parent HEAD ${parentHeadSha} advanced past the child base ${input.baseSha}; adopt from a fresh child or explicitly allow an advanced base.`,
    });
  }

  if (conflicts.length > 0) {
    return buildResult({
      summary: `Adoption refused: ${conflicts.length} conflict(s); no parent bytes were written.`,
      error: conflicts.map((conflict) => `${conflict.code}: ${conflict.message}`).join('; '),
    });
  }

  if (input.expectedChanges) {
    const records: ChildChangeRecord[] = [];
    const seen = new Set<string>();
    for (const raw of input.expectedChanges) {
      const path = normalizeWriteScopeEntry(raw.path);
      if (seen.has(path)) {
        conflicts.push({ path, code: 'duplicate_change', message: `Path "${path}" is listed more than once.` });
        continue;
      }
      seen.add(path);
      const unsafe = adoptionPathSafety(projectRoot, path);
      if (unsafe) {
        conflicts.push(unsafe);
        continue;
      }
      if (!isPathInWriteScope(path, scopeValidation.normalizedScope, projectRoot)) {
        conflicts.push({
          path,
          code: 'outside_write_scope',
          message: `Path "${path}" is outside the declared write_scope.`,
        });
        continue;
      }
      const record: ChildChangeRecord = {
        path,
        before_hash: raw.before_hash ?? null,
        after_hash: raw.after_hash ?? null,
      };
      records.push(record);

      const expectedChild = record.after_hash ?? MISSING_PATH_DIGEST;
      const childHash = hashWorkspacePath(join(worktreePath, path));
      if (childHash !== expectedChild) {
        conflicts.push({
          path,
          code: record.after_hash === null ? 'child_postimage_mismatch' : childHash === MISSING_PATH_DIGEST ? 'child_postimage_missing' : 'child_postimage_mismatch',
          message: record.after_hash === null
            ? `Child was recorded as deleting "${path}" but the worktree still has different bytes there.`
            : `Child postimage for "${path}" no longer matches the recorded hash.`,
        });
      }

      const expectedParent = record.before_hash ?? MISSING_PATH_DIGEST;
      const parentHash = hashWorkspacePath(join(projectRoot, path));
      if (parentHash !== expectedParent) {
        conflicts.push({
          path,
          code: 'parent_preimage_conflict',
          message: `Parent bytes for "${path}" differ from the child's recorded preimage.`,
        });
      }
    }

    const active = records.filter((record) => record.before_hash !== record.after_hash);
    if (active.length === 0 && conflicts.length === 0) {
      return buildResult({
        success: true,
        status: 'noop',
        summary: 'Adoption no-op: the child recorded no effective change.',
      });
    }

    if (conflicts.length > 0) {
      return buildResult({
        summary: `Adoption refused: ${conflicts.length} conflict(s); no parent bytes were written.`,
        error: conflicts.map((conflict) => `${conflict.code}: ${conflict.message}`).join('; '),
      });
    }

    if (mode === 'dry_run') {
      promotedPaths.push(...active.map((record) => record.path));
      return buildResult({
        success: true,
        status: 'dry_run',
        summary: `Adoption dry run: ${active.length} path(s) would be adopted.`,
      });
    }

    const snapshots: Array<{ path: string; bytes: Buffer | null }> = active.map((record) => {
      const parentPath = join(projectRoot, record.path);
      return {
        path: parentPath,
        bytes: existsSync(parentPath) ? readFileSync(parentPath) : null,
      };
    });
    const rollback = (): void => {
      for (const snapshot of snapshots.reverse()) {
        try {
          if (snapshot.bytes === null) rmSync(snapshot.path, { force: true });
          else writeFileAtomic(snapshot.path, snapshot.bytes);
        } catch {
          // Best-effort rollback; the conflict report below remains authoritative.
        }
      }
    };

    try {
      for (const record of active) {
        const parentPath = join(projectRoot, record.path);
        const expectedParent = record.before_hash ?? MISSING_PATH_DIGEST;
        if (hashWorkspacePath(parentPath) !== expectedParent) {
          conflicts.push({
            path: record.path,
            code: 'parent_preimage_conflict',
            message: `Parent bytes for "${record.path}" changed while adoption was running.`,
          });
          throw new Error('parent preimage changed during adoption');
        }
        if (record.after_hash === null) {
          rmSync(parentPath, { force: true });
          deletedPaths.push(record.path);
        } else {
          writeFileAtomic(parentPath, readFileSync(join(worktreePath, record.path)));
          adoptedPaths.push(record.path);
        }
      }

      for (const record of active) {
        const expectedChild = record.after_hash ?? MISSING_PATH_DIGEST;
        if (hashWorkspacePath(join(projectRoot, record.path)) !== expectedChild) {
          conflicts.push({
            path: record.path,
            code: 'apply_failed',
            message: `Parent postimage for "${record.path}" does not match the child hash after writing.`,
          });
          throw new Error('parent postimage verification failed');
        }
      }
    } catch (error) {
      rollback();
      promotedPaths.length = 0;
      adoptedPaths.length = 0;
      deletedPaths.length = 0;
      diagnostics.push({
        code: 'adoption_rolled_back',
        message: error instanceof Error ? error.message : String(error),
      });
      return buildResult({
        summary: 'Adoption failed and was rolled back; the child worktree is unchanged.',
        error: conflicts.map((conflict) => conflict.message).join('; ') || 'apply failed',
      });
    }

    promotedPaths.push(...adoptedPaths, ...deletedPaths);
    let verification: AdoptionVerificationResult | null = null;
    if (input.verify) {
      try {
        verification = input.verify({ projectRoot, adoptedPaths: [...adoptedPaths], deletedPaths: [...deletedPaths] });
      } catch (error) {
        verification = {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (verification && !verification.ok) {
      return buildResult({
        success: false,
        status: 'verification_failed',
        verification,
        parentStatusAfter: gitPorcelainStatus(projectRoot),
        summary: `Adoption applied ${adoptedPaths.length + deletedPaths.length} path(s) but parent verification failed: ${verification.summary}`,
        error: verification.summary,
      });
    }

    let worktreeRemoved = false;
    if (mode === 'copy' && input.cleanupWorktree) {
      const name =
        input.worktreeName ??
        worktreePath.split(/[\\/]/).filter(Boolean).pop() ??
        '';
      if (name) {
        try {
          removeWorktree(name, { projectRoot, force: true });
          worktreeRemoved = true;
        } catch (err) {
          diagnostics.push({
            code: 'worktree_cleanup_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return buildResult({
      success: true,
      status: 'adopted',
      verification,
      worktreeRemoved,
      parentStatusAfter: gitPorcelainStatus(projectRoot),
      summary: `Adopted ${adoptedPaths.length} file(s) and ${deletedPaths.length} deletion(s) from the child worktree.`,
    });
  }

  // Legacy discovery path: no recorded child hashes. Each candidate is still
  // scope- and path-checked; anything skipped is reported, never silently lost.
  const candidates =
    input.paths && input.paths.length > 0
      ? input.paths.map(normalizeWriteScopeEntry)
      : listWorktreeScopedChanges(worktreePath, scopeValidation.normalizedScope, projectRoot);

  const inScope = candidates.filter((p) =>
    isPathInWriteScope(p, scopeValidation.normalizedScope, projectRoot),
  );
  for (const p of candidates) {
    if (!isPathInWriteScope(p, scopeValidation.normalizedScope, projectRoot)) {
      skippedPaths.push({ path: p, reason: 'outside write_scope' });
      conflicts.push({ path: p, code: 'outside_write_scope', message: `Path "${p}" is outside the declared write_scope.` });
    }
  }

  const files = resolvePromoteFileList(worktreePath, inScope);

  for (const rel of files) {
    if (!isPathInWriteScope(rel, scopeValidation.normalizedScope, projectRoot)) {
      skippedPaths.push({ path: rel, reason: 'outside write_scope' });
      conflicts.push({ path: rel, code: 'outside_write_scope', message: `Path "${rel}" is outside the declared write_scope.` });
      continue;
    }
    const unsafe = adoptionPathSafety(projectRoot, rel);
    if (unsafe) {
      conflicts.push(unsafe);
      skippedPaths.push({ path: rel, reason: unsafe.message });
      continue;
    }
    const src = join(worktreePath, rel);
    const dest = join(projectRoot, rel);

    if (!existsSync(src)) {
      // Without recorded hashes a deletion cannot be verified. Keep it visible.
      skippedPaths.push({ path: rel, reason: 'deletion requires recorded child hashes (missing in worktree)' });
      diagnostics.push({
        code: 'deletion_not_promoted',
        message: `"${rel}" is deleted in the worktree; adopt with the child manifest to verify and apply the deletion.`,
      });
      continue;
    }
    if (statSync(src).isDirectory()) {
      skippedPaths.push({ path: rel, reason: 'directory entry skipped (files expanded separately)' });
      continue;
    }

    if (existsSync(dest) && requireParentPathClean) {
      try {
        const parentBody = readFileSync(dest);
        const wtBody = readFileSync(src);
        if (Buffer.compare(parentBody, wtBody) === 0) {
          skippedPaths.push({ path: rel, reason: 'already identical' });
          continue;
        }
        // Parent dirty relative to HEAD?
        const st = spawnSync('git', ['status', '--porcelain', '--', rel], {
          cwd: projectRoot,
          encoding: 'utf-8',
        });
        if ((st.stdout ?? '').trim().length > 0) {
          skippedPaths.push({
            path: rel,
            reason: 'parent path has local modifications (set requireParentPathClean=false to overwrite)',
          });
          conflicts.push({
            path: rel,
            code: 'parent_preimage_conflict',
            message: `Parent bytes for "${rel}" have local modifications.`,
          });
          continue;
        }
      } catch (err) {
        diagnostics.push({
          code: 'parent_read_failed',
          message: `${rel}: ${err instanceof Error ? err.message : String(err)}`,
        });
        skippedPaths.push({ path: rel, reason: 'parent read failed' });
        continue;
      }
    }

    if (mode === 'dry_run') {
      promotedPaths.push(rel);
      continue;
    }

    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      promotedPaths.push(rel);
    } catch (err) {
      diagnostics.push({
        code: 'promote_copy_failed',
        message: `${rel}: ${err instanceof Error ? err.message : String(err)}`,
      });
      skippedPaths.push({ path: rel, reason: 'copy failed' });
    }
  }

  const hardFail = diagnostics.some(
    (d) => d.code === 'worktree_missing' || d.code === 'promote_copy_failed' || d.code === 'adoption_rolled_back',
  );
  const onlyIdentical = skippedPaths.every((s) => s.reason === 'already identical');
  const success = !hardFail && (mode === 'dry_run' || promotedPaths.length > 0 || onlyIdentical);
  const status: AdoptionStatus = success
    ? promotedPaths.length > 0 || mode === 'dry_run'
      ? mode === 'dry_run' ? 'dry_run' : 'adopted'
      : 'noop'
    : 'refused';

  let worktreeRemoved = false;
  if (mode === 'copy' && input.cleanupWorktree) {
    const cleanupSafe =
      success &&
      conflicts.length === 0 &&
      diagnostics.every((d) => d.code !== 'promote_copy_failed') &&
      skippedPaths.every((s) => s.reason === 'already identical');
    const name =
      input.worktreeName ??
      worktreePath.split(/[\\/]/).filter(Boolean).pop() ??
      '';
    if (!cleanupSafe || !name) {
      diagnostics.push({
        code: 'worktree_retained_unadopted_changes',
        message: 'Worktree retained because not every child change was adopted; inspect the report before removing it.',
      });
    } else {
      try {
        removeWorktree(name, { projectRoot, force: true });
        worktreeRemoved = true;
      } catch (err) {
        diagnostics.push({
          code: 'worktree_cleanup_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const parentStatusAfter = gitPorcelainStatus(projectRoot);
  return buildResult({
    success,
    status,
    parentStatusAfter,
    worktreeRemoved,
    summary: success
      ? `Promote ${mode}: ${promotedPaths.length} path(s)${worktreeRemoved ? ' (worktree removed)' : ''}`
      : `Promote failed: ${diagnostics.map((d) => d.message).join('; ') || 'no paths promoted'}`,
    error: success ? null : diagnostics.map((d) => d.message).join('; ') || 'no paths promoted',
  });
}
