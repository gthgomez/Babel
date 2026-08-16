/**
 * autonomyPolicy.ts — Cross-harness autonomy contract (Class A–D)
 *
 * Deterministic home for the autonomy taxonomy ("autonomy limited by consequence,
 * not capability") in Babel. Pure module: no I/O, no imports from the V9 lane
 * (`pipeline.ts` / `schemas/agentContracts.ts`), so it introduces zero
 * co-evolution debt and cannot alter the V9 orchestrator contract.
 *
 * The taxonomy maps onto Babel's native primitives:
 *   - task class tune   → `src/config/chatTaskClass.ts` (verificationPolicy,
 *                         strictCritic, phase-gated tools, hard stops)
 *   - permission preset → `src/agent/policy.ts` (`decideAction`)
 *   - approval sessions → `src/agent/approvalRequests.ts`
 *   - evidence gate     → `src/agent/completionGatePolicy.ts`
 *
 * Enforcement wiring today: `chatTaskClass.resolveChatTaskClass` consults
 * `BABEL_AUTONOMY_CLASS=A|B|C|D` (env-gated, additive — explicit
 * `BABEL_CHAT_TASK_CLASS` still wins). Preset-level enforcement for C/D
 * (ask / deny mutations) is wired at the dispatch boundary
 * (`agent/autonomyEnforcement.ts` → `toolExecutor.executeActionWithPolicy`
 * A–D classification), and each class maps to a default lease
 * (`defaultLeaseForAutonomyClass`) for the V2 authority PDP
 * (`authority/pdp.ts`).
 *
 * Class definitions (mission contract):
 *   A — autonomous by default: inspect/read/search, edit task files,
 *       format/lint/typecheck/build/test, local run/debug/status/diff/worktrees,
 *       bounded subagents, parallel research, evidence, retry.
 *   B — autonomous with automatic verification: multi-file refactors, dependency
 *       upgrades, CI/build changes, tested-local schema changes, large formatting,
 *       public API changes — isolate, snapshot, implement, stronger verification.
 *   C — explicit gate or deterministic boundary: live credentials, force-push,
 *       history rewrite, deleting significant user data/evidence/unrelated work,
 *       publishing, releases, production deploy, IAM/billing, purchases,
 *       expensive fan-out, external messages, protected-branch merges, destructive
 *       DB ops, disabling security controls.
 *   D — never without explicit exceptional instruction: exposing API keys,
 *       bypassing credential protections, silently force-pushing/deleting,
 *       publishing private credentials, hiding failures, fabricating evidence,
 *       claiming tests passed when they didn't.
 */

import type { ChatTaskClass, VerificationPolicy } from './chatTaskClass.js';
import type { PermissionPreset } from '../agent/policy.js';
import {
  classifyCommandSemantics,
  isGatedGitPush,
  type CommandSemanticClass,
} from '../agent/commandSemantics.js';
import { LEASE_VERSION, type AutonomyLease } from '../authority/lease.js';
import type { CapabilityId } from '../authority/capabilities.js';

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type AutonomyClass = 'A' | 'B' | 'C' | 'D';

export const AUTONOMY_CLASSES: readonly AutonomyClass[] = ['A', 'B', 'C', 'D'] as const;

/**
 * Action-level classification within the autonomy taxonomy.
 * Deterministic where a tool call can be classified statically; behavioral
 * classes (D) are enforced by the honesty gate, not tool naming.
 */
export type AutonomyActionClass =
  /** Class A actions — safe to run autonomously. */
  | 'a_autonomous'
  /** Class B actions — autonomous but require automatic verification. */
  | 'b_verified'
  /** Class C actions — require an explicit gate (approval / deterministic deny). */
  | 'c_gated'
  /** Class D actions — never without explicit exceptional instruction. */
  | 'd_forbidden';

// ─── Action classification ──────────────────────────────────────────────────

/** Read-only / inspect tools (Class A core). */
const A_READ_TOOLS = new Set([
  'file_read',
  'read_file',
  'read_range',
  'directory_list',
  'list_dir',
  'grep',
  'glob',
  'semantic_search',
  'search',
  'git_context',
  'workspace_map',
  'web_search',
  'web_fetch',
  'status',
  'diff',
  'git_status',
  'git_diff',
]);

/** Local mutating / verify tools (Class A core — edit task files, build, test). */
const A_MUTATE_TOOLS = new Set([
  'write_file',
  'file_write',
  'str_replace',
  'edit',
  'apply_patch',
  'run_command',
  'shell_exec',
  'test_run',
  'exec_command',
  'todo_write',
  'bounded_parallel',
  // Engine shell surfaces (chatEngine.ts:1105-1106). Class A by TOOL NAME only —
  // the command-semantic layer (classifyCommandSemantics) is evaluated first
  // when commandText is present, so force-push / credential-dump commands via
  // bash still classify c_gated / d_forbidden.
  'bash',
  'shell',
]);

/**
 * Map a command-semantic class (agent/commandSemantics.ts) to its autonomy
 * action class. Returns null when the command's semantics do not themselves
 * gate or forbid — tool-name classification and the existing policy layers
 * (decideAction / capability broker / sandbox) then apply as before.
 *
 * Deliberately conservative per the cross-review (§7):
 *  - 'unrecognized' and local classes → null (NOT forbidden).
 *  - Clearly external/public/destructive effects → c_gated (explicit gate).
 *  - Credential exposure → d_forbidden (never, without exceptional instruction).
 *  - Plain `git push` of a non-main branch classifies a_autonomous at the
 *    A–D layer (rule 05 autonomy contract); force / history-rewriting /
 *    main|master / --delete pushes gate. Publication AUTHORITY still rests
 *    with the lease/PDP: a class-A default lease denies publication
 *    (pdp.not_in_lease), and B/C lease it as verify-gated.
 */
export function autonomyClassForCommandSemantics(
  semantic: CommandSemanticClass,
  commandText: string,
): AutonomyActionClass | null {
  switch (semantic) {
    case 'credential_access':
      return 'd_forbidden';
    case 'git_push':
      return isGatedGitPush(commandText) ? 'c_gated' : null;
    case 'git_history_rewrite':
    case 'delete_destructive':
    case 'create_pr':
    case 'external_message':
    case 'deploy':
    case 'infrastructure_mutation':
    case 'financial_external_effect':
      return 'c_gated';
    default:
      return null;
  }
}

/**
 * Deterministic action classifier: map a Babel tool name (and optional shell
 * command text) to its autonomy action class.
 *
 * Command text (run_command / test_run / bash / shell) is classified first via
 * the command-semantic layer (`classifyCommandSemantics`), which normalizes
 * wrappers (sudo, bash -c, powershell, cmd /c), strips executable paths, and
 * detects clear external/public/destructive/credential effects regardless of
 * how the command is spelled. Tool-name classification follows.
 *
 * Fail-closed: unknown tool names classify as `c_gated` — matching Babel's
 * deny-unknown posture (`classifyToolEffect` treats unknown tools as
 * `external_side_effect` and denies them at dispatch).
 *
 * Note: class D is primarily *behavioral* (fabricating evidence, claiming tests
 * passed, hiding failures). No tool-name table can detect that — it is enforced
 * by the honesty gate (`completionGatePolicy.ts:evaluateCompletionGateForEngine`)
 * and adversarial-signal detectors (`deriveAdversarialSignals`). The classifier
 * here catches only the mechanically detectable credential-exposure commands.
 */
export function classifyAutonomyAction(
  toolName: string,
  commandText?: string | null,
): AutonomyActionClass {
  const tool = toolName.trim().toLowerCase();
  const command = commandText ?? '';

  if (command) {
    const semantic = classifyCommandSemantics(command);
    const autonomy = autonomyClassForCommandSemantics(semantic, command);
    if (autonomy) return autonomy;
  }

  if (A_READ_TOOLS.has(tool) || A_MUTATE_TOOLS.has(tool)) {
    return 'a_autonomous';
  }

  // Multi-file / large-surface edits are class B *by scope*, which a single
  // tool call cannot determine — scope classification happens at task level
  // (chatTaskClass auto-classification → general_swe).
  if (tool === 'sub_agent' || tool === 'parallel') {
    return 'b_verified';
  }

  return 'c_gated';
}

// ─── Profiles ────────────────────────────────────────────────────────────────

export type AutonomyApprovalMode = 'auto' | 'ask' | 'deny';
export type AutonomyMutationPolicy = 'enabled' | 'ask' | 'denied';

export interface AutonomyProfile {
  class: AutonomyClass;
  title: string;
  description: string;
  /** Native task class this class maps to (drives the tune + verification policy). */
  mapsToTaskClass: ChatTaskClass;
  /** Verification tier required at the completion gate. */
  verification: VerificationPolicy;
  /** Permission preset for tool dispatch (decideAction). */
  preset: PermissionPreset;
  strictCritic: boolean;
  phaseGatedTools: boolean;
  restrictToolsOnPolicyFire: boolean;
  /** How out-of-class / gated actions are handled. */
  approvalMode: AutonomyApprovalMode;
  mutationPolicy: AutonomyMutationPolicy;
  /** Where this class is actually enforced today. */
  enforcement: string;
}

export const AUTONOMY_PROFILES: Record<AutonomyClass, AutonomyProfile> = {
  A: {
    class: 'A',
    title: 'Autonomous by default',
    description:
      'Inspect/read/search, edit task files, format/lint/typecheck/build/test, ' +
      'local run/debug/status/diff/worktrees, bounded subagents, parallel research, ' +
      'evidence, retry. Soft fuses only; no hard tool restriction.',
    mapsToTaskClass: 'default',
    verification: 'required',
    preset: 'workspace_write',
    strictCritic: false,
    phaseGatedTools: false,
    restrictToolsOnPolicyFire: false,
    approvalMode: 'auto',
    mutationPolicy: 'enabled',
    enforcement:
      'task tune (default) + completion gate (verificationPolicy required) + ' +
      'circuit breaker + sandbox shell allowlist',
  },
  B: {
    class: 'B',
    title: 'Autonomous with automatic verification',
    description:
      'Multi-file refactors, dependency upgrades, CI/build changes, tested-local ' +
      'schema changes, large formatting, public API changes. Isolate, snapshot, ' +
      'implement, stronger verification.',
    mapsToTaskClass: 'general_swe',
    verification: 'required',
    preset: 'workspace_write',
    strictCritic: true,
    phaseGatedTools: false,
    restrictToolsOnPolicyFire: false,
    approvalMode: 'auto',
    mutationPolicy: 'enabled',
    enforcement:
      'task tune (general_swe: strict critic, long budgets) + completion gate ' +
      '(verificationPolicy required, authoritative verifier receipts, revision-bound)',
  },
  C: {
    class: 'C',
    title: 'Explicit gate or deterministic boundary',
    description:
      'Live credentials, force-push, history rewrite, deleting significant user ' +
      'data/evidence/unrelated work, publishing, releases, production deploy, ' +
      'IAM/billing, purchases, expensive fan-out, external messages, ' +
      'protected-branch merges, destructive DB ops, disabling security controls.',
    mapsToTaskClass: 'governance',
    verification: 'strict',
    preset: 'ask_before_mutation',
    strictCritic: true,
    phaseGatedTools: true,
    restrictToolsOnPolicyFire: true,
    approvalMode: 'ask',
    mutationPolicy: 'ask',
    enforcement:
      'task tune (governance: green verifier mandatory, phase gates, hard tool ' +
      'restrict) + approval sessions (allow_once/allow_session/narrow_rule; ' +
      'headless = deterministic deny) + dispatch A–D gate ' +
      '(onAutonomyClassCGate, toolExecutor.executeActionWithPolicy).',
  },
  D: {
    class: 'D',
    title: 'Never without explicit exceptional instruction',
    description:
      'Exposing API keys, bypassing credential protections, silently ' +
      'force-pushing/deleting, publishing private credentials, hiding failures, ' +
      'fabricating evidence, claiming tests passed when they didn\'t.',
    mapsToTaskClass: 'governance',
    verification: 'strict',
    preset: 'read_only',
    strictCritic: true,
    phaseGatedTools: true,
    restrictToolsOnPolicyFire: true,
    approvalMode: 'deny',
    mutationPolicy: 'denied',
    enforcement:
      'read_only preset (mutations deterministically denied) + governance tune + ' +
      'honesty gate (adversarial signals: tests_deleted, shortcut_noop, ' +
      'hardcoded_fixture, flaky_green, verifier_def_tampered) + dispatch A–D ' +
      'classification (Class D semantics deny deterministically).',
  },
};

// ─── Resolution helpers ──────────────────────────────────────────────────────

/** Parse an autonomy class string ('A'|'B'|'C'|'D', case-insensitive). */
export function parseAutonomyClass(raw: string | undefined | null): AutonomyClass | null {
  if (raw === undefined || raw === null) return null;
  const key = raw.trim().toUpperCase();
  return (AUTONOMY_CLASSES as readonly string[]).includes(key) ? (key as AutonomyClass) : null;
}

/**
 * Read the autonomy class from BABEL_AUTONOMY_CLASS.
 *
 * Fail-closed: a SET-but-invalid value throws instead of silently degrading to
 * auto-classification — a `D`→`Z` typo must surface loudly at startup, never
 * turn a would-be Class-D session into default tuning. Unset/empty stays null
 * (opt-in only).
 */
export function autonomyClassFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AutonomyClass | null {
  const raw = env['BABEL_AUTONOMY_CLASS'];
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const parsed = parseAutonomyClass(raw);
  if (!parsed) {
    throw new Error(
      `BABEL_AUTONOMY_CLASS must be one of A|B|C|D (got '${raw}') — refusing to ` +
        'fall through to auto-classification on an invalid autonomy class.',
    );
  }
  return parsed;
}

/** Map an autonomy class to its native Babel task class. */
export function autonomyTaskClassFor(cls: AutonomyClass): ChatTaskClass {
  return AUTONOMY_PROFILES[cls].mapsToTaskClass;
}

export interface AutonomyOverride {
  class: AutonomyClass;
  profile: AutonomyProfile;
  taskClass: ChatTaskClass;
}

/** Resolve the full autonomy override from env, or null when unset/invalid. */
export function resolveAutonomyOverride(
  env: NodeJS.ProcessEnv = process.env,
): AutonomyOverride | null {
  const cls = autonomyClassFromEnv(env);
  if (!cls) return null;
  const profile = AUTONOMY_PROFILES[cls];
  return { class: cls, profile, taskClass: profile.mapsToTaskClass };
}

// ─── Default leases (V2 authority bridge) ────────────────────────────────────

/** Local, reversible capability set — the Class A core. */
const CLASS_A_LEASED_CAPABILITIES: readonly CapabilityId[] = [
  'inspect_repository',
  'search_repository',
  'edit_task_files',
  'create_task_branch',
  'create_worktree',
  'run_tests',
  'run_build',
  'run_lint',
  'run_typecheck',
  'run_local_command',
  'delete_task_temp',
];

/** Publication capability set added for Class B/C (still verify-gated by the PDP). */
const CLASS_B_PUBLICATION_CAPABILITIES: readonly CapabilityId[] = [
  'stage_ship_set',
  'commit_ship_set',
  'push_feature_branch',
  'pr_create_draft',
  'pr_update_draft',
  'pr_inspect',
  'ci_inspect',
  'ci_repair_in_scope',
  'ci_rerun_transient',
];

/** Read-only capability set for Class D (mutations need explicit exceptional instruction). */
const CLASS_D_READONLY_CAPABILITIES: readonly CapabilityId[] = [
  'inspect_repository',
  'search_repository',
];

/** Gated capability set — never `allowed` in a default lease; resolves to ASK. */
const GATED_CAPABILITY_IDS: readonly CapabilityId[] = [
  'merge',
  'pr_mark_ready',
  'release',
  'production_deploy',
  'repo_admin',
  'security_policy_change',
  'credential_access',
  'destructive_data_delete',
  'shared_history_rewrite',
  'force_push',
  'scope_expansion',
];

/**
 * Default lease for an autonomy class (V2 authority bridge).
 *
 * The A–D taxonomy is the consequence/UX layer; the lease is how a class is
 * expressed to the PDP (`authority/pdp.ts`). A/B/C scope progressively broader
 * autonomous capability; D allows read-only inspection only. Gated
 * capabilities are never `allowed` — they resolve to ASK; real force pushes
 * deny deterministically in every class because the PDP checks
 * `constraints.forcePush` before the gated branch (C's contract — "explicit
 * gate or deterministic boundary" — permits either).
 *
 * `repository` should be supplied by the caller. The placeholder default
 * fails closed against any caller that supplies a real repo
 * (DENY_LEASE_MISMATCH); the dispatch wire path (`actionRequestFromAction`)
 * does not yet populate `request.repository`, so only remote mismatch fires
 * through the wire today.
 *
 * Lease ids are static per class (`default-a`…`default-d`): baseline-drift
 * invalidation is keyed by leaseId and permanent within the process, so
 * long-lived sessions MUST supply a unique `leaseId`.
 *
 * `budgets` are declared but not yet enforced (DENY_BUDGET_EXHAUSTED exists
 * in reasonCodes; no decision path emits it) — enforcement is a future seam.
 */
export function defaultLeaseForAutonomyClass(
  cls: AutonomyClass,
  opts: { repository?: string; leaseId?: string } = {},
): AutonomyLease {
  const allowedCapabilities: CapabilityId[] =
    cls === 'D'
      ? [...CLASS_D_READONLY_CAPABILITIES]
      : cls === 'A'
        ? [...CLASS_A_LEASED_CAPABILITIES]
        : [...CLASS_A_LEASED_CAPABILITIES, ...CLASS_B_PUBLICATION_CAPABILITIES];
  return {
    version: LEASE_VERSION,
    leaseId: opts.leaseId ?? `default-${cls.toLowerCase()}`,
    scope: {
      repository: opts.repository ?? 'current_repository',
      remote: 'origin',
      worktree: 'current',
      objective: `default ${cls} autonomy`,
    },
    allowedCapabilities,
    branchPrefixes: ['feat/', 'fix/', 'refactor/', 'docs/', 'test/'],
    constraints: {
      protectedBranches: ['main'],
      forcePush: false,
      remoteRefDelete: false,
      releasePublish: false,
      productionDeploy: false,
      repositoryAdmin: false,
      secretsAccess: false,
      billing: false,
      destructiveDb: false,
      scopeExpansion: false,
    },
    budgets: {
      ciProductRepairRounds: 3,
      ciTransientReruns: 1,
      prRecreateRounds: 1,
      parallelAgents: 8,
    },
    gates: [...GATED_CAPABILITY_IDS],
    forbidden: ['expose_credentials'],
  };
}
