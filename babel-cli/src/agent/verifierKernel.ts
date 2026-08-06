/**
 * Verifier Kernel promotion + anti-reward-hacking (H5).
 *
 * Extends baseline structural verifier identity and directional coverage with
 * richer receipts, minimum profiles by task class, and adversarial gates.
 * Does not reimplement baseline honesty — builds on it.
 */

import { createHash } from 'node:crypto';
import type { WorkspaceRevisionIdentity } from '../executor/contracts.js';

export const VERIFIER_RECEIPT_V2 = 2 as const;

export type VerifierScope = 'full_suite' | 'targeted' | 'smoke' | 'property' | 'security';

export type MutatingTaskClass =
  | 'quick_fix'
  | 'general_swe'
  | 'refactor'
  | 'high_assurance'
  | 'unknown';

export interface VerifierReceiptV2 {
  schema_version: typeof VERIFIER_RECEIPT_V2;
  receipt_id: string;
  verifier_id: string;
  /** Exact argv. */
  argv: string[];
  cwd: string;
  /** Hash of relevant env / execution profile. */
  env_profile_hash: string;
  container_id?: string;
  started_at: string;
  ended_at: string;
  exit_code: number;
  signal?: string | null;
  timed_out: boolean;
  tests_total?: number;
  tests_passed?: number;
  tests_failed?: number;
  tests_skipped?: number;
  stdout_hash: string;
  stderr_hash: string;
  /** Baseline receipt id when paired. */
  baseline_receipt_id?: string;
  workspace_revision: WorkspaceRevisionIdentity | { compositeTreeHash: string };
  scope: VerifierScope;
  /** Display command string. */
  command: string;
  authoritative: boolean;
  freshness: 'fresh' | 'stale' | 'unknown';
  flake_history?: Array<{ at: string; exit_code: number }>;
  evidence_refs: string[];
}

export interface VerifierProfile {
  task_class: MutatingTaskClass;
  min_scope: VerifierScope;
  require_authoritative: boolean;
  allow_targeted_as_full: false;
  require_revision_bind: boolean;
  /** Held-out / extra checks selected by risk — not universal. */
  optional_checks: Array<
    'held_out' | 'property' | 'metamorphic' | 'mutation' | 'differential' | 'security' | 'performance' | 'a11y' | 'ui'
  >;
}

export const VERIFIER_PROFILES: Record<MutatingTaskClass, VerifierProfile> = {
  quick_fix: {
    task_class: 'quick_fix',
    min_scope: 'targeted',
    require_authoritative: true,
    allow_targeted_as_full: false,
    require_revision_bind: true,
    optional_checks: [],
  },
  general_swe: {
    task_class: 'general_swe',
    min_scope: 'full_suite',
    require_authoritative: true,
    allow_targeted_as_full: false,
    require_revision_bind: true,
    optional_checks: ['security'],
  },
  refactor: {
    task_class: 'refactor',
    min_scope: 'full_suite',
    require_authoritative: true,
    allow_targeted_as_full: false,
    require_revision_bind: true,
    optional_checks: ['differential', 'property'],
  },
  high_assurance: {
    task_class: 'high_assurance',
    min_scope: 'full_suite',
    require_authoritative: true,
    allow_targeted_as_full: false,
    require_revision_bind: true,
    optional_checks: ['held_out', 'mutation', 'security'],
  },
  unknown: {
    task_class: 'unknown',
    min_scope: 'full_suite',
    require_authoritative: true,
    allow_targeted_as_full: false,
    require_revision_bind: true,
    optional_checks: [],
  },
};

export function profileForTaskClass(taskClass: string): VerifierProfile {
  if (taskClass in VERIFIER_PROFILES) {
    return VERIFIER_PROFILES[taskClass as MutatingTaskClass];
  }
  return VERIFIER_PROFILES.unknown;
}

export function hashOutput(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export function buildVerifierReceiptV2(input: {
  receipt_id: string;
  verifier_id: string;
  argv: string[];
  cwd: string;
  env_profile_hash: string;
  container_id?: string;
  started_at: string;
  ended_at: string;
  exit_code: number;
  signal?: string | null;
  timed_out?: boolean;
  tests_total?: number;
  tests_passed?: number;
  tests_failed?: number;
  tests_skipped?: number;
  stdout: string;
  stderr: string;
  baseline_receipt_id?: string;
  workspace_revision: VerifierReceiptV2['workspace_revision'];
  scope: VerifierScope;
  command: string;
  authoritative: boolean;
  freshness?: VerifierReceiptV2['freshness'];
  flake_history?: VerifierReceiptV2['flake_history'];
  evidence_refs?: string[];
}): VerifierReceiptV2 {
  return {
    schema_version: VERIFIER_RECEIPT_V2,
    receipt_id: input.receipt_id,
    verifier_id: input.verifier_id,
    argv: [...input.argv],
    cwd: input.cwd,
    env_profile_hash: input.env_profile_hash,
    ...(input.container_id ? { container_id: input.container_id } : {}),
    started_at: input.started_at,
    ended_at: input.ended_at,
    exit_code: input.exit_code,
    signal: input.signal ?? null,
    timed_out: input.timed_out ?? false,
    ...(input.tests_total !== undefined ? { tests_total: input.tests_total } : {}),
    ...(input.tests_passed !== undefined ? { tests_passed: input.tests_passed } : {}),
    ...(input.tests_failed !== undefined ? { tests_failed: input.tests_failed } : {}),
    ...(input.tests_skipped !== undefined ? { tests_skipped: input.tests_skipped } : {}),
    stdout_hash: hashOutput(input.stdout),
    stderr_hash: hashOutput(input.stderr),
    ...(input.baseline_receipt_id
      ? { baseline_receipt_id: input.baseline_receipt_id }
      : {}),
    workspace_revision: input.workspace_revision,
    scope: input.scope,
    command: input.command,
    authoritative: input.authoritative,
    freshness: input.freshness ?? 'fresh',
    ...(input.flake_history ? { flake_history: input.flake_history } : {}),
    evidence_refs: input.evidence_refs ?? [],
  };
}

export type VerifierGateDenial =
  | 'empty_verifier_plan'
  | 'targeted_cannot_satisfy_full'
  | 'stale_receipt'
  | 'wrong_revision'
  | 'tampered_verifier_def'
  | 'tests_deleted_or_skipped'
  | 'shortcut_noop'
  | 'hardcoded_fixture'
  | 'flaky_green'
  | 'baseline_already_failing'
  | 'non_authoritative';

export interface VerifierPromotionInput {
  mutating: boolean;
  task_class: string;
  required_verifier_commands: readonly string[];
  receipts: readonly VerifierReceiptV2[];
  current_revision_hash: string;
  /** Detected adversarial signals from fixtures / review. */
  adversarial?: {
    tests_deleted?: boolean;
    shortcut_noop?: boolean;
    hardcoded_fixture?: boolean;
    flaky_green?: boolean;
    baseline_failing?: boolean;
    verifier_def_tampered?: boolean;
  };
}

export interface VerifierPromotionResult {
  authorize_verified_complete: boolean;
  denials: VerifierGateDenial[];
  profile: VerifierProfile;
}

/**
 * H5 promotion gate: empty plans, targeted-as-full, stale/wrong revision,
 * tamper/shortcut adversarial fixtures cannot authorize completion.
 */
export function evaluateVerifierPromotion(
  input: VerifierPromotionInput,
): VerifierPromotionResult {
  const profile = profileForTaskClass(input.task_class);
  const denials: VerifierGateDenial[] = [];

  if (!input.mutating) {
    return { authorize_verified_complete: false, denials, profile };
  }

  if (input.required_verifier_commands.length === 0) {
    denials.push('empty_verifier_plan');
  }

  if (input.receipts.length === 0 && input.required_verifier_commands.length > 0) {
    denials.push('empty_verifier_plan');
  }

  for (const r of input.receipts) {
    if (profile.min_scope === 'full_suite' && r.scope === 'targeted') {
      denials.push('targeted_cannot_satisfy_full');
    }
    if (r.freshness === 'stale') {
      denials.push('stale_receipt');
    }
    const revHash =
      'compositeTreeHash' in r.workspace_revision
        ? r.workspace_revision.compositeTreeHash
        : '';
    if (profile.require_revision_bind && revHash && revHash !== input.current_revision_hash) {
      denials.push('wrong_revision');
    }
    if (profile.require_authoritative && !r.authoritative) {
      denials.push('non_authoritative');
    }
    if (r.tests_skipped !== undefined && r.tests_total !== undefined) {
      if (r.tests_skipped > 0 && r.tests_failed === 0 && r.exit_code === 0) {
        // Suspicious skip-heavy green — flag when all tests skipped
        if (r.tests_skipped >= (r.tests_total || 0) && r.tests_total > 0) {
          denials.push('tests_deleted_or_skipped');
        }
      }
    }
  }

  const adv = input.adversarial ?? {};
  if (adv.tests_deleted) denials.push('tests_deleted_or_skipped');
  if (adv.shortcut_noop) denials.push('shortcut_noop');
  if (adv.hardcoded_fixture) denials.push('hardcoded_fixture');
  if (adv.flaky_green) denials.push('flaky_green');
  if (adv.baseline_failing) denials.push('baseline_already_failing');
  if (adv.verifier_def_tampered) denials.push('tampered_verifier_def');

  // All required commands must have a green authoritative receipt
  for (const cmd of input.required_verifier_commands) {
    const match = input.receipts.find(
      (r) => r.command === cmd || r.argv.join(' ') === cmd,
    );
    if (!match || match.exit_code !== 0) {
      if (!denials.includes('empty_verifier_plan')) {
        denials.push('empty_verifier_plan');
      }
    }
  }

  const unique = [...new Set(denials)];
  return {
    authorize_verified_complete: unique.length === 0 && input.receipts.some((r) => r.exit_code === 0),
    denials: unique,
    profile,
  };
}

/**
 * Clean-room promotion decision (extends high-assurance profiles).
 */
export function evaluateCleanRoomPromotion(input: {
  profile: VerifierProfile;
  clean_room_receipts: readonly VerifierReceiptV2[];
  primary_receipts: readonly VerifierReceiptV2[];
}): { promote: boolean; reason: string } {
  if (!input.profile.optional_checks.includes('held_out') &&
      input.profile.task_class !== 'high_assurance') {
    return { promote: true, reason: 'clean_room_not_required' };
  }
  if (input.clean_room_receipts.length === 0) {
    return { promote: false, reason: 'missing_clean_room_receipts' };
  }
  const allGreen = input.clean_room_receipts.every((r) => r.exit_code === 0);
  if (!allGreen) return { promote: false, reason: 'clean_room_failed' };
  return { promote: true, reason: 'clean_room_green' };
}
