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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  createWorktree,
  removeWorktree,
  type WorktreeInfo,
} from '../services/worktreeIsolation.js';
import type { ToolContext } from '../localTools.js';
import type { ToolExecutor } from './toolExecutor.js';
import {
  runMutationAgentLoop,
  type MutationAgentLoopResult,
} from './lanes/runMutationAgentLoop.js';

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
  abortSignal?: AbortSignal;
  executor?: ToolExecutor;
  useDeterministicMock?: boolean;
  /** Partial tool context; runDir/agentId filled by the runner. */
  toolContext?: Partial<ToolContext>;
}

export interface ImplementWorktreeAgentResult {
  agentId: string;
  success: boolean;
  summary: string;
  writeScope: string[];
  worktree: WorktreeInfo;
  /** True when parent `git status --porcelain` is unchanged by the child run. */
  parentTreeClean: boolean;
  parentStatusBefore: string;
  parentStatusAfter: string;
  changedFiles: MutationAgentLoopResult['changedFiles'];
  stepsExecuted: number;
  error: string | null;
  mutation: MutationAgentLoopResult;
  diagnostics: Array<{ code: string; message: string }>;
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

function gitPorcelainStatus(projectRoot: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return (result.stderr || result.stdout || '').trim();
  }
  return filterParentStatusLines(result.stdout ?? '');
}

function withProjectRootEnv<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = projectRoot;
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previous;
    }
  });
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
  const scopeValidation = validateImplementWriteScope(spec.writeScope, projectRoot);
  const diagnostics = scopeValidation.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
  }));

  if (!scopeValidation.ok) {
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

  const parentStatusBefore = gitPorcelainStatus(projectRoot);
  const name = worktreeNameForAgent(spec.id);
  let worktree: WorktreeInfo;
  try {
    worktree = createWorktree(name, {
      projectRoot,
      detach: true,
      baseRef: options.baseRef ?? 'HEAD',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({ code: 'worktree_create_failed', message });
    const failedMutation = emptyMutationResult(`Worktree create failed: ${message}`);
    return {
      agentId: spec.id,
      success: false,
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
      parentStatusAfter: gitPorcelainStatus(projectRoot),
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
    ...(options.toolContext?.signal ? { signal: options.toolContext.signal } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  };

  let mutation: MutationAgentLoopResult;
  try {
    mutation = await withProjectRootEnv(worktree.path, () =>
      runMutationAgentLoop({
        agentId: spec.id,
        task: spec.task,
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
        runDir,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push({ code: 'implement_run_failed', message });
    mutation = emptyMutationResult(message);
  }

  const parentStatusAfter = gitPorcelainStatus(projectRoot);
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

  if (options.cleanupWorktree) {
    try {
      removeWorktree(name, { projectRoot, force: true });
    } catch (err) {
      diagnostics.push({
        code: 'worktree_cleanup_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const success =
    mutation.success && parentTreeClean && !diagnostics.some((d) => d.code === 'write_scope_violation');

  return {
    agentId: spec.id,
    success,
    summary: success
      ? `Implement worktree agent ${spec.id}: ${mutation.changedFiles.length} file(s) in ${worktree.path} (parent clean).`
      : `Implement worktree agent ${spec.id} failed: ${mutation.error ?? diagnostics.map((d) => d.message).join('; ')}`,
    writeScope: scopeValidation.normalizedScope,
    worktree,
    parentTreeClean,
    parentStatusBefore,
    parentStatusAfter,
    changedFiles: mutation.changedFiles,
    stepsExecuted: mutation.stepsExecuted,
    error: success ? null : (mutation.error ?? diagnostics.map((d) => d.message).join('; ')),
    mutation,
    diagnostics,
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

/** True when a path exists under a worktree but not (or differently) under parent — debug helper. */
export function worktreePathExists(worktreePath: string, relativePath: string): boolean {
  return existsSync(join(worktreePath, relativePath));
}

// ─── W2.1 promote / merge worktree → parent ───────────────────────────────────

export type ImplementPromoteMode = 'copy' | 'dry_run';

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
}

export interface PromoteImplementWorktreeResult {
  success: boolean;
  mode: ImplementPromoteMode;
  promotedPaths: string[];
  skippedPaths: Array<{ path: string; reason: string }>;
  diagnostics: Array<{ code: string; message: string }>;
  parentStatusBefore: string;
  parentStatusAfter: string;
  worktreeRemoved: boolean;
  summary: string;
  error: string | null;
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
  const promotedPaths: string[] = [];

  const scopeValidation = validateImplementWriteScope(input.writeScope, projectRoot);
  if (!scopeValidation.ok) {
    return {
      success: false,
      mode,
      promotedPaths: [],
      skippedPaths: [],
      diagnostics: scopeValidation.diagnostics.map((d) => ({ code: d.code, message: d.message })),
      parentStatusBefore: '',
      parentStatusAfter: '',
      worktreeRemoved: false,
      summary: 'Promote rejected: invalid write_scope',
      error: 'invalid write_scope',
    };
  }

  if (!existsSync(worktreePath)) {
    diagnostics.push({
      code: 'worktree_missing',
      message: `Worktree path does not exist: ${worktreePath}`,
    });
    return {
      success: false,
      mode,
      promotedPaths: [],
      skippedPaths: [],
      diagnostics,
      parentStatusBefore: '',
      parentStatusAfter: '',
      worktreeRemoved: false,
      summary: 'Promote rejected: worktree missing',
      error: 'worktree missing',
    };
  }

  const parentStatusBefore = gitPorcelainStatus(projectRoot);
  const candidates =
    input.paths && input.paths.length > 0
      ? input.paths.map(normalizeWriteScopeEntry)
      : listWorktreeScopedChanges(worktreePath, scopeValidation.normalizedScope, projectRoot);

  // Filter candidates to write_scope
  const inScope = candidates.filter((p) =>
    isPathInWriteScope(p, scopeValidation.normalizedScope, projectRoot),
  );
  for (const p of candidates) {
    if (!isPathInWriteScope(p, scopeValidation.normalizedScope, projectRoot)) {
      skippedPaths.push({ path: p, reason: 'outside write_scope' });
    }
  }

  const files = resolvePromoteFileList(worktreePath, inScope);

  for (const rel of files) {
    if (!isPathInWriteScope(rel, scopeValidation.normalizedScope, projectRoot)) {
      skippedPaths.push({ path: rel, reason: 'outside write_scope' });
      continue;
    }
    const src = join(worktreePath, rel);
    const dest = join(projectRoot, rel);

    if (!existsSync(src)) {
      // Deletion promote is opt-in later — skip with reason
      skippedPaths.push({ path: rel, reason: 'missing in worktree (deletes not auto-promoted)' });
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

  let worktreeRemoved = false;
  if (mode === 'copy' && input.cleanupWorktree && diagnostics.every((d) => d.code !== 'promote_copy_failed')) {
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

  const parentStatusAfter = gitPorcelainStatus(projectRoot);
  const hardFail = diagnostics.some(
    (d) => d.code === 'worktree_missing' || d.code === 'promote_copy_failed',
  );
  const success =
    !hardFail &&
    (promotedPaths.length > 0 || skippedPaths.every((s) => s.reason === 'already identical'));

  return {
    success,
    mode,
    promotedPaths,
    skippedPaths,
    diagnostics,
    parentStatusBefore,
    parentStatusAfter,
    worktreeRemoved,
    summary: success
      ? `Promote ${mode}: ${promotedPaths.length} path(s)${worktreeRemoved ? ' (worktree removed)' : ''}`
      : `Promote failed or empty: ${diagnostics.map((d) => d.message).join('; ') || 'no paths promoted'}`,
    error: success ? null : diagnostics.map((d) => d.message).join('; ') || 'no paths promoted',
  };
}
