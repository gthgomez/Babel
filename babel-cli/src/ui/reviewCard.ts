/**
 * Truthful operator-facing completion / review card for chat-mode TUI.
 * Never paints unverified or failed verification as verified success.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import { dim, error, muted, success, warning } from './theme.js';

export type ReviewCardKind =
  | 'VERIFIED_COMPLETE'
  | 'COMPLETE_UNVERIFIED'
  | 'VERIFICATION_FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'BUDGET_EXHAUSTED'
  | 'INFRA_FAILURE'
  | 'AGENT_FAILURE';

export interface ReviewVerification {
  ran: boolean;
  passed?: boolean | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
  status?: 'passed' | 'failed' | 'blocked' | 'not_applicable' | 'not_run' | undefined;
}

export interface ReviewCardInput {
  outcome?: TerminalOutcome | string | null | undefined;
  status?: string | null | undefined;
  changedFiles?: string[] | undefined;
  verification?: ReviewVerification | null | undefined;
  verificationPolicy?: 'none' | 'required' | 'strict' | 'not_applicable' | undefined;
  verificationApplicability?: 'applicable' | 'not_applicable' | 'optional' | undefined;
  summary?: string | undefined;
  costUsd?: number | undefined;
  tokens?: number | undefined;
  mutated?: boolean | undefined;
  nextActions?: string[] | undefined;
  /** Only for SESSION_EVENT_LIFECYCLE_CAUSALITY — not every AGENT_FAILURE. */
  sessionConsistencyFailure?: boolean | undefined;
}

export interface ReviewCard {
  kind: ReviewCardKind;
  title: string;
  body: string;
  looksLikeVerifiedSuccess: boolean;
}

const KIND_ORDER: ReviewCardKind[] = [
  'VERIFIED_COMPLETE',
  'COMPLETE_UNVERIFIED',
  'VERIFICATION_FAILED',
  'BLOCKED',
  'CANCELLED',
  'BUDGET_EXHAUSTED',
  'INFRA_FAILURE',
  'AGENT_FAILURE',
];

export function classifyReviewCard(input: ReviewCardInput): ReviewCardKind {
  const o = (input.outcome ?? '').toString().toUpperCase();
  const status = (input.status ?? '').toString().toLowerCase();
  const v = input.verification;

  if (o === 'CANCELLED' || status === 'cancelled') return 'CANCELLED';
  if (o === 'BUDGET_EXHAUSTED' || status === 'budget_exhausted') return 'BUDGET_EXHAUSTED';
  if (
    o === 'BLOCKED' ||
    o === 'BLOCKED_EXTERNAL' ||
    o === 'BLOCKED_POLICY' ||
    o === 'NEEDS_HUMAN_DECISION' ||
    status === 'blocked'
  ) {
    return 'BLOCKED';
  }
  if (o === 'INFRA_FAILURE') return 'INFRA_FAILURE';
  if (o === 'AGENT_FAILURE' || status === 'failed') return 'AGENT_FAILURE';

  if (v?.ran && v.passed === false) return 'VERIFICATION_FAILED';
  if (o === 'VERIFIED_COMPLETE' && v?.ran && v.passed === true) return 'VERIFIED_COMPLETE';
  if (o === 'VERIFIED_COMPLETE' && !v?.ran) return 'COMPLETE_UNVERIFIED';
  if (o === 'UNVERIFIED_PATCH' || o === 'NO_CHANGE_REQUIRED') return 'COMPLETE_UNVERIFIED';
  if (v?.ran && v.passed === true && (o === 'VERIFIED_COMPLETE' || status === 'completed')) {
    return 'VERIFIED_COMPLETE';
  }
  if (status === 'completed' || o === 'UNVERIFIED_PATCH' || !o) {
    if (v?.ran && v.passed === false) return 'VERIFICATION_FAILED';
    if (!v?.ran) return 'COMPLETE_UNVERIFIED';
  }
  return 'AGENT_FAILURE';
}

export function looksLikeVerifiedSuccess(kind: ReviewCardKind): boolean {
  return kind === 'VERIFIED_COMPLETE';
}

export type ReviewTitleTone = 'success' | 'warning' | 'error' | 'muted';

/** Semantic paint for a review title. Color is not the only carrier — glyphs stay. */
export function reviewTitleTone(
  kind: ReviewCardKind,
  isNotApplicable = false,
): ReviewTitleTone {
  if (isNotApplicable && (kind === 'COMPLETE_UNVERIFIED' || kind === 'VERIFIED_COMPLETE')) {
    return 'muted';
  }
  switch (kind) {
    case 'VERIFIED_COMPLETE':
      return 'success';
    case 'COMPLETE_UNVERIFIED':
    case 'BLOCKED':
    case 'BUDGET_EXHAUSTED':
      return 'warning';
    case 'CANCELLED':
      return 'muted';
    case 'VERIFICATION_FAILED':
    case 'INFRA_FAILURE':
    case 'AGENT_FAILURE':
      return 'error';
  }
}

function paintByTone(tone: ReviewTitleTone, text: string): string {
  switch (tone) {
    case 'success':
      return success(text);
    case 'warning':
      return warning(text);
    case 'error':
      return error(text);
    case 'muted':
      return muted(text);
  }
}

function paintTitle(kind: ReviewCardKind, label: string, isNotApplicable = false): string {
  const tone = reviewTitleTone(kind, isNotApplicable);
  if (isNotApplicable && (kind === 'COMPLETE_UNVERIFIED' || kind === 'VERIFIED_COMPLETE')) {
    return paintByTone(tone, `✓ ${label}`);
  }
  switch (kind) {
    case 'VERIFIED_COMPLETE':
      return paintByTone(tone, `✓ ${label}`);
    case 'COMPLETE_UNVERIFIED':
      return paintByTone(tone, `○ ${label}`);
    case 'VERIFICATION_FAILED':
      return paintByTone(tone, `✗ ${label}`);
    case 'BLOCKED':
      return paintByTone(tone, `⊘ ${label}`);
    case 'CANCELLED':
      return paintByTone(tone, `■ ${label}`);
    case 'BUDGET_EXHAUSTED':
      return paintByTone(tone, `▣ ${label}`);
    case 'INFRA_FAILURE':
    case 'AGENT_FAILURE':
      return paintByTone(tone, `✖ ${label}`);
  }
}

const TITLES: Record<ReviewCardKind, string> = {
  VERIFIED_COMPLETE: 'Verified complete',
  COMPLETE_UNVERIFIED: 'Complete — unverified',
  VERIFICATION_FAILED: 'Verification failed',
  BLOCKED: 'Blocked',
  CANCELLED: 'Cancelled',
  BUDGET_EXHAUSTED: 'Budget exhausted',
  INFRA_FAILURE: 'Infrastructure failure',
  AGENT_FAILURE: 'Agent failure',
};

export function getContextualNextActions(
  kind: ReviewCardKind,
  input: ReviewCardInput,
): string[] {
  if (input.nextActions) return input.nextActions;
  const hasFiles = (input.changedFiles ?? []).length > 0 || input.mutated === true;
  const hasVerifier = Boolean(
    input.verification?.command ||
      input.verification?.ran ||
      input.verificationPolicy === 'required' ||
      input.verificationPolicy === 'strict' ||
      input.verification != null,
  );

  switch (kind) {
    case 'VERIFIED_COMPLETE':
      return hasFiles ? ['[D] Diff'] : [];
    case 'COMPLETE_UNVERIFIED':
      if (hasFiles && hasVerifier) {
        return ['[D] Diff', '[R] Run verification'];
      }
      if (hasFiles) {
        return ['[D] Diff'];
      }
      return [];
    case 'VERIFICATION_FAILED':
      return hasFiles
        ? ['[F] Fix', '[R] Rerun verification', '[D] Diff']
        : ['[F] Fix', '[R] Rerun verification'];
    case 'BLOCKED':
      return ['Review the blocked capability'];
    case 'CANCELLED':
      return hasFiles ? ['[D] Diff (if workspace changed)'] : [];
    case 'BUDGET_EXHAUSTED':
      return ['Follow-up to continue'];
    case 'INFRA_FAILURE':
      return ['Retry'];
    case 'AGENT_FAILURE':
      return input.sessionConsistencyFailure
        ? ['Inspect diagnostics', 'Do not resume this session blindly']
        : ['Inspect diagnostics'];
  }
}

export function buildReviewCard(input: ReviewCardInput): ReviewCard {
  const kind = classifyReviewCard(input);
  const files = input.changedFiles ?? [];
  const v = input.verification;
  const isVerificationNotApplicable =
    !v?.ran &&
    v?.status !== 'blocked' &&
    (input.verificationApplicability === 'not_applicable' ||
      input.verificationPolicy === 'none' ||
      input.verificationPolicy === 'not_applicable' ||
      v?.status === 'not_applicable' ||
      (input.verificationApplicability === undefined &&
        input.verificationPolicy === undefined &&
        files.length === 0 &&
        !input.mutated));

  const title =
    isVerificationNotApplicable &&
    (kind === 'COMPLETE_UNVERIFIED' || kind === 'VERIFIED_COMPLETE')
      ? 'Complete'
      : TITLES[kind];

  const lines: string[] = [];
  lines.push(paintTitle(kind, title, isVerificationNotApplicable));

  if (files.length > 0) {
    lines.push(dim('Changed'));
    for (const f of files.slice(0, 12)) {
      lines.push(`  ${dim('±')} ${f}`);
    }
    if (files.length > 12) {
      lines.push(dim(`  … and ${files.length - 12} more`));
    }
  } else if (input.mutated) {
    lines.push(dim('Changed'));
    lines.push(muted('  (workspace may have partial mutations)'));
  } else if (kind === 'CANCELLED') {
    lines.push(muted('  No file list — workspace unchanged or not recorded.'));
  }

  if (!isVerificationNotApplicable) {
    lines.push(dim('Verified'));
    if (v?.ran && v.passed) {
      lines.push(`  ${success('✓')} ${v.command ?? 'verifier'} (exit ${v.exitCode ?? 0})`);
    } else if (v?.ran && v.passed === false) {
      if (v.status === 'blocked' || v.exitCode === 126 || v.exitCode === 127) {
        lines.push(`  ${warning('⊘')} ${v.command ?? 'verifier'} (blocked - exit ${v.exitCode ?? '?'})`);
      } else {
        lines.push(`  ${error('✗')} ${v.command ?? 'verifier'} (exit ${v.exitCode ?? '?'})`);
      }
    } else if (v?.status === 'blocked') {
      lines.push(`  ${warning('⊘')} Verification blocked`);
    } else {
      lines.push(`  ${warning('○')} Not run — not verified`);
    }
  }

  if (input.summary?.trim()) {
    lines.push(dim('Summary'));
    lines.push(`  ${input.summary.trim()}`);
  }

  const hasRealCost = input.costUsd !== undefined && input.costUsd > 0;
  const hasRealTokens = input.tokens !== undefined && input.tokens > 0;
  if (hasRealCost || hasRealTokens) {
    const bits: string[] = [];
    if (hasRealCost) bits.push(`$${input.costUsd!.toFixed(4)}`);
    if (hasRealTokens) bits.push(`${input.tokens} tok`);
    lines.push(`${dim('Cost')}  ${bits.join('  ')}`);
  }

  const actions = getContextualNextActions(kind, input).filter((action) => {
    const normalized = action.trim();
    return normalized !== '' && normalized !== '[Enter] Continue';
  });
  if (actions.length > 0) {
    lines.push(dim('Next'));
    lines.push(`  ${actions.join('   ')}`);
  }

  return {
    kind,
    title,
    body: lines.join('\n'),
    looksLikeVerifiedSuccess: looksLikeVerifiedSuccess(kind),
  };
}

/** Distinct kind tokens so tests and telemetry can assert visual/semantic separation. */
export function reviewCardKindToken(kind: ReviewCardKind): string {
  return `REVIEW_KIND:${kind}`;
}

export function presentChatReview(input: ReviewCardInput): ReviewCard {
  return buildReviewCard(input);
}

export const ALL_REVIEW_KINDS = KIND_ORDER;
