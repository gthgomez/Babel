/**
 * capabilities.ts — structured capability registry (V2 authority).
 *
 * Capabilities are the unit of authorization: an ActionRequest names exactly
 * one capability; the PDP decides that capability against the lease. Raw
 * command strings are parsed into capabilities by gitCommand.ts — the parser
 * is defense in depth; the lease decision is the boundary.
 */

export type CapabilityId =
  // Local / reversible (Class A)
  | 'inspect_repository'
  | 'search_repository'
  | 'edit_task_files'
  | 'create_task_branch'
  | 'create_worktree'
  | 'run_tests'
  | 'run_build'
  | 'run_lint'
  | 'run_typecheck'
  | 'run_local_command'
  | 'delete_task_temp'
  // Bounded publication (Class B)
  | 'stage_ship_set'
  | 'commit_ship_set'
  | 'push_feature_branch'
  | 'pr_create_draft'
  | 'pr_update_draft'
  | 'pr_inspect'
  | 'ci_inspect'
  | 'ci_repair_in_scope'
  | 'ci_rerun_transient'
  // Privileged (Class C) — require explicit lease membership + constraints
  | 'merge'
  | 'pr_mark_ready'
  | 'release'
  | 'production_deploy'
  | 'repo_admin'
  | 'security_policy_change'
  | 'credential_access'
  | 'destructive_data_delete'
  | 'shared_history_rewrite'
  | 'force_push'
  | 'scope_expansion'
  // Denied (Class D) / unknown
  | 'expose_credentials'
  | 'unknown';

export type CapabilityKind = 'local' | 'publication' | 'gated' | 'forbidden';

export const CAPABILITY_KINDS: Record<CapabilityId, CapabilityKind> = {
  inspect_repository: 'local',
  search_repository: 'local',
  edit_task_files: 'local',
  create_task_branch: 'local',
  create_worktree: 'local',
  run_tests: 'local',
  run_build: 'local',
  run_lint: 'local',
  run_typecheck: 'local',
  // Unclassified non-git/gh shell commands: bounded, reversible, task-scoped
  // by the harness sandbox → local. The PDP's fail-closed rule applies to
  // unknown PRIVILEGED actions (git/gh/credential surfaces), not routine
  // engineering (mission §12: raw shell remains useful for ordinary work).
  run_local_command: 'local',
  delete_task_temp: 'local',
  stage_ship_set: 'publication',
  commit_ship_set: 'publication',
  push_feature_branch: 'publication',
  pr_create_draft: 'publication',
  pr_update_draft: 'publication',
  pr_inspect: 'publication',
  ci_inspect: 'publication',
  ci_repair_in_scope: 'publication',
  ci_rerun_transient: 'publication',
  merge: 'gated',
  pr_mark_ready: 'gated',
  release: 'gated',
  production_deploy: 'gated',
  repo_admin: 'gated',
  security_policy_change: 'gated',
  credential_access: 'gated',
  destructive_data_delete: 'gated',
  shared_history_rewrite: 'gated',
  force_push: 'gated',
  scope_expansion: 'gated',
  expose_credentials: 'forbidden',
  unknown: 'forbidden',
};

export const ALL_CAPABILITIES: readonly CapabilityId[] = Object.keys(
  CAPABILITY_KINDS,
) as CapabilityId[];

export function isCapabilityId(value: string): value is CapabilityId {
  return value in CAPABILITY_KINDS;
}

/** Privileged / Class-C capabilities (kind remains `gated` for lease schema). */
export function isPrivilegedCapability(capability: CapabilityId): boolean {
  return CAPABILITY_KINDS[capability] === 'gated';
}

/**
 * Protected-branch check: is `branch` in the lease's protected set (exact
 * match or prefix wildcard, e.g. "main", "release/*").
 */
export function isProtectedBranch(branch: string, protectedBranches: readonly string[]): boolean {
  for (const pattern of protectedBranches) {
    if (pattern === branch) return true;
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (branch.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Branch-prefix check: branch must start with one of the allowed prefixes
 * (e.g. "feat/", "fix/", "refactor/", "docs/", "test/"). Empty allowlist =
 * no prefix restriction.
 */
export function isAllowedBranchPrefix(
  branch: string,
  allowedPrefixes: readonly string[],
): boolean {
  if (allowedPrefixes.length === 0) return true;
  return allowedPrefixes.some((prefix) => branch.startsWith(prefix));
}
