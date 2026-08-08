/**
 * Capability broker + transactional effect records (H4).
 *
 * Completes typed effect classification across the tool surface, capability
 * checks before execution, structured denials, and revision-linked
 * reconciliation for reconcilable mutations including shell-side effects.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import {
  classifyToolEffect,
  type ToolEffectClass,
  type WorkspaceRevisionIdentity,
} from '../executor/contracts.js';

/**
 * Detect a dirty git working tree from workspace evidence (not env-only).
 * Returns false when git is unavailable / not a repo (fail-open on detection).
 * Env overrides for tests: BABEL_DIRTY_TREE=1 force dirty, =0 force clean.
 */
export function detectWorkingTreeDirty(projectRoot: string): boolean {
  if (process.env['BABEL_DIRTY_TREE'] === '1') return true;
  if (process.env['BABEL_DIRTY_TREE'] === '0') return false;
  try {
    const result = spawnSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return false;
    return String(result.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/** Capture a bounded workspace identity for shell-side effect reconciliation. */
export function captureWorkspaceRevisionIdentity(projectRoot: string): WorkspaceRevisionIdentity {
  const capturedAt = Date.now()
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (head.status === 0 && status.status === 0) {
      const gitCommitHash = String(head.stdout ?? '').trim() || null
      const state = `${gitCommitHash ?? ''}\n${String(status.stdout ?? '')}`
      return {
        gitCommitHash,
        compositeTreeHash: createHash('sha256').update(state).digest('hex').slice(0, 32),
        fileHashes: {},
        capturedAt,
      }
    }
  } catch {
    // Fall through to a bounded filesystem identity for non-git workspaces.
  }

  const fileHashes: Record<string, string> = {}
  const queue = [projectRoot]
  while (queue.length > 0 && Object.keys(fileHashes).length < 5000) {
    const dir = queue.shift()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'runs') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
      } else if (entry.isFile()) {
        try {
          const rel = relative(projectRoot, path).replaceAll('\\', '/')
          const stat = statSync(path)
          const content = readFileSync(path)
          fileHashes[rel] = createHash('sha256')
            .update(content)
            .update(String(stat.mode))
            .digest('hex')
        } catch {
          // A concurrently changed file is represented by its absence.
        }
      }
      if (Object.keys(fileHashes).length >= 5000) break
    }
  }
  const compositeTreeHash = createHash('sha256')
    .update(Object.entries(fileHashes).sort().map(([path, hash]) => `${path}:${hash}`).join('\n'))
    .digest('hex')
    .slice(0, 32)
  return { gitCommitHash: null, compositeTreeHash, fileHashes, capturedAt }
}

export type CapabilityDenialReason =
  | 'unknown_tool_conservative'
  | 'effect_not_allowed'
  | 'protected_path'
  | 'dirty_tree_fail_closed'
  | 'isolation_unavailable'
  | 'host_fallback_forbidden'
  | 'plan_read_only'
  | 'idempotency_replay'
  | 'capability_missing';

export interface CapabilityCheckInput {
  toolName: string;
  effectClass?: ToolEffectClass;
  allowedEffects: readonly ToolEffectClass[];
  mode: 'chat' | 'plan' | 'deep';
  targetPath?: string;
  protectedPaths?: readonly string[];
  dirtyTree?: boolean;
  isolationRequired?: boolean;
  isolationAvailable?: boolean;
  hostFallbackAllowed?: boolean;
  completedIdempotencyKeys?: readonly string[];
  idempotencyKey?: string;
}

export interface CapabilityCheckResult {
  allowed: boolean;
  effectClass: ToolEffectClass;
  denial?: CapabilityDenialReason;
  message?: string;
}

/**
 * Classify + authorize a tool invocation before execution (H4).
 * Unknown tools remain conservative via classifyToolEffect.
 */
export function checkToolCapability(input: CapabilityCheckInput): CapabilityCheckResult {
  const effectClass = input.effectClass ?? classifyToolEffect(input.toolName);

  if (input.mode === 'plan' && effectClass !== 'read_only') {
    return {
      allowed: false,
      effectClass,
      denial: 'plan_read_only',
      message: 'Plan mode is read-only; mutations are denied',
    };
  }

  if (input.idempotencyKey && input.completedIdempotencyKeys?.includes(input.idempotencyKey)) {
    return {
      allowed: false,
      effectClass,
      denial: 'idempotency_replay',
      message: `Idempotency key ${input.idempotencyKey} already completed; refusing double mutation`,
    };
  }

  if (!input.allowedEffects.includes(effectClass)) {
    // Unknown / external side effects fail closed when not explicitly allowed
    if (effectClass === 'external_side_effect' || effectClass === 'non_idempotent_local_effect') {
      return {
        allowed: false,
        effectClass,
        denial: 'unknown_tool_conservative',
        message: `Effect class ${effectClass} not in allowed set`,
      };
    }
    return {
      allowed: false,
      effectClass,
      denial: 'effect_not_allowed',
      message: `Effect class ${effectClass} not allowed for this task`,
    };
  }

  if (input.targetPath && input.protectedPaths?.length) {
    const hit = input.protectedPaths.some(
      (p) => input.targetPath === p || input.targetPath!.startsWith(p.replace(/\*\*$/, '')),
    );
    if (hit && effectClass !== 'read_only') {
      return {
        allowed: false,
        effectClass,
        denial: 'protected_path',
        message: `Protected path: ${input.targetPath}`,
      };
    }
  }

  if (input.dirtyTree && effectClass === 'reconcilable_mutation') {
    return {
      allowed: false,
      effectClass,
      denial: 'dirty_tree_fail_closed',
      message: 'Dirty tree: refuse reconcilable mutation without explicit policy',
    };
  }

  // Isolation gates host-executing effects (shell/network). Pure filesystem tools
  // (read_only / reconcilable_mutation) use project-root path sandboxes, not Docker.
  // Applying isolation_unavailable to every tool would CAPABILITY_DENY read_file
  // whenever Docker is down — a product-breaking mis-map (H4).
  if (
    input.isolationRequired &&
    !input.isolationAvailable &&
    (effectClass === 'non_idempotent_local_effect' ||
      effectClass === 'external_side_effect')
  ) {
    if (!input.hostFallbackAllowed) {
      return {
        allowed: false,
        effectClass,
        denial: 'isolation_unavailable',
        message: 'Isolation required but unavailable; host fallback forbidden',
      };
    }
    // Explicit escalation path — still allowed but caller must record boundary evidence
  }

  return { allowed: true, effectClass };
}

/** True when sandbox unavailability would silently become host execution (forbidden). */
export function wouldSilentHostFallback(input: {
  isolationRequired: boolean;
  isolationAvailable: boolean;
  hostFallbackAllowed: boolean;
}): boolean {
  return input.isolationRequired && !input.isolationAvailable && !input.hostFallbackAllowed;
}

export type EffectTransactionStatus =
  | 'prepare'
  | 'commit'
  | 'rollback'
  | 'rollback_failed'
  | 'reconcile_needed';

export interface EffectTransactionRecord {
  transaction_id: string;
  tool_name: string;
  effect_class: ToolEffectClass;
  task_id?: string;
  plan_step_id?: string;
  policy_decision_id?: string;
  idempotency_key?: string;
  paths: string[];
  pre_revision?: WorkspaceRevisionIdentity | { compositeTreeHash: string };
  post_revision?: WorkspaceRevisionIdentity | { compositeTreeHash: string };
  status: EffectTransactionStatus;
  /** True rollback result — never assumed success. */
  rollback_result?: 'success' | 'failed' | 'not_attempted' | 'partial';
  shell_side: boolean;
  boundary_escalation?: {
    kind: 'host_execution';
    reason: string;
    explicit: boolean;
  };
  created_at: string;
  updated_at: string;
}

export function beginEffectTransaction(input: {
  tool_name: string;
  effect_class: ToolEffectClass;
  paths?: string[];
  task_id?: string;
  plan_step_id?: string;
  policy_decision_id?: string;
  idempotency_key?: string;
  pre_revision?: EffectTransactionRecord['pre_revision'];
  shell_side?: boolean;
  boundary_escalation?: EffectTransactionRecord['boundary_escalation'];
}): EffectTransactionRecord {
  const now = new Date().toISOString();
  return {
    transaction_id: randomUUID(),
    tool_name: input.tool_name,
    effect_class: input.effect_class,
    paths: [...(input.paths ?? [])],
    status: 'prepare',
    shell_side: input.shell_side ?? isShellSideTool(input.tool_name),
    created_at: now,
    updated_at: now,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.plan_step_id ? { plan_step_id: input.plan_step_id } : {}),
    ...(input.policy_decision_id ? { policy_decision_id: input.policy_decision_id } : {}),
    ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    ...(input.pre_revision ? { pre_revision: input.pre_revision } : {}),
    ...(input.boundary_escalation
      ? { boundary_escalation: input.boundary_escalation }
      : {}),
  };
}

export function commitEffectTransaction(
  tx: EffectTransactionRecord,
  post_revision?: EffectTransactionRecord['post_revision'],
): EffectTransactionRecord {
  return {
    ...tx,
    status: 'commit',
    updated_at: new Date().toISOString(),
    ...(post_revision ? { post_revision } : {}),
  };
}

/**
 * A tool returned a failure result after its effect may have started. The
 * transaction is deliberately left for reconciliation rather than reported as
 * committed.
 */
export function reconcileEffectTransaction(
  tx: EffectTransactionRecord,
): EffectTransactionRecord {
  return {
    ...tx,
    status: 'reconcile_needed',
    updated_at: new Date().toISOString(),
  };
}

/**
 * Record rollback with true result (H4: never assume success).
 */
export function rollbackEffectTransaction(
  tx: EffectTransactionRecord,
  result: 'success' | 'failed' | 'partial',
): EffectTransactionRecord {
  return {
    ...tx,
    status: result === 'success' ? 'rollback' : 'rollback_failed',
    rollback_result: result,
    updated_at: new Date().toISOString(),
  };
}

export function isShellSideTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return (
    n.includes('shell') ||
    n.includes('bash') ||
    n.includes('run_command') ||
    n.includes('exec') ||
    n === 'bash' ||
    n === 'shell'
  );
}

/**
 * safe_repo UX helper: isolation required messaging without weakening fail-closed.
 */
export function safeRepoIsolationMessage(input: {
  isolationAvailable: boolean;
  hostFallbackAllowed: boolean;
}): { ok: boolean; message: string; escalate: boolean } {
  if (input.isolationAvailable) {
    return { ok: true, message: 'safe_repo isolation active', escalate: false };
  }
  if (input.hostFallbackAllowed) {
    return {
      ok: true,
      message: 'safe_repo isolation unavailable; explicit host-boundary escalation recorded',
      escalate: true,
    };
  }
  return {
    ok: false,
    message: 'safe_repo requires isolation; refusing silent host execution',
    escalate: false,
  };
}
