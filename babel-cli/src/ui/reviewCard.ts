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
  passed?: boolean;
  command?: string;
  exitCode?: number;
}

export interface ReviewCardInput {
  outcome?: TerminalOutcome | string | null | undefined;
  status?: string | null;
  changedFiles?: string[];
  verification?: ReviewVerification | null;
  summary?: string;
  costUsd?: number;
  tokens?: number;
  mutated?: boolean;
  nextActions?: string[];
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

function paintTitle(kind: ReviewCardKind, label: string): string {
  switch (kind) {
    case 'VERIFIED_COMPLETE':
      return success(`✓ ${label}`);
    case 'COMPLETE_UNVERIFIED':
      return warning(`○ ${label}`);
    case 'VERIFICATION_FAILED':
      return error(`✗ ${label}`);
    case 'BLOCKED':
      return warning(`⊘ ${label}`);
    case 'CANCELLED':
      return muted(`■ ${label}`);
    case 'BUDGET_EXHAUSTED':
      return warning(`▣ ${label}`);
    case 'INFRA_FAILURE':
    case 'AGENT_FAILURE':
      return error(`✖ ${label}`);
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

const DEFAULT_NEXT: Record<ReviewCardKind, string[]> = {
  VERIFIED_COMPLETE: ['[D] Diff', '[Enter] Continue'],
  COMPLETE_UNVERIFIED: ['[D] Diff', '[R] Run verification', '[Enter] Continue'],
  VERIFICATION_FAILED: ['[F] Fix', '[R] Rerun verification', '[D] Diff'],
  BLOCKED: ['Review the blocked capability', '[Enter] Continue'],
  CANCELLED: ['[D] Diff (if workspace changed)', '[Enter] Continue'],
  BUDGET_EXHAUSTED: ['Follow-up to continue', '[Enter] Continue'],
  INFRA_FAILURE: ['Retry', '[Enter] Continue'],
  AGENT_FAILURE: ['Inspect diagnostics', '[Enter] Continue'],
};

export function buildReviewCard(input: ReviewCardInput): ReviewCard {
  const kind = classifyReviewCard(input);
  const title = TITLES[kind];
  const lines: string[] = [];
  lines.push(paintTitle(kind, title));

  const files = input.changedFiles ?? [];
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

  lines.push(dim('Verified'));
  const v = input.verification;
  if (v?.ran && v.passed) {
    lines.push(`  ${success('✓')} ${v.command ?? 'verifier'} (exit ${v.exitCode ?? 0})`);
  } else if (v?.ran && v.passed === false) {
    lines.push(`  ${error('✗')} ${v.command ?? 'verifier'} (exit ${v.exitCode ?? '?'})`);
  } else {
    lines.push(`  ${warning('○')} Not run — not verified`);
  }

  if (input.summary?.trim()) {
    lines.push(dim('Summary'));
    lines.push(`  ${input.summary.trim().slice(0, 240)}`);
  }

  if (input.costUsd !== undefined || input.tokens !== undefined) {
    const bits: string[] = [];
    if (input.costUsd !== undefined) bits.push(`$${input.costUsd.toFixed(4)}`);
    if (input.tokens !== undefined) bits.push(`${input.tokens} tok`);
    lines.push(`${dim('Cost')}  ${bits.join('  ')}`);
  }

  const actions = input.nextActions ?? DEFAULT_NEXT[kind];
  if (kind === 'BLOCKED' && input.summary) {
    lines.push(dim('Next'));
    lines.push(`  ${actions.join('   ')}`);
  } else {
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

/** Distinct kind tokens so tests can assert visual/semantic separation. */
export function reviewCardKindToken(kind: ReviewCardKind): string {
  return `REVIEW_KIND:${kind}`;
}

export function presentChatReview(input: ReviewCardInput): ReviewCard {
  const card = buildReviewCard(input);
  const token = reviewCardKindToken(card.kind);
  return { ...card, body: `${card.body}\n${dim(token)}` };
}

export const ALL_REVIEW_KINDS = KIND_ORDER;
