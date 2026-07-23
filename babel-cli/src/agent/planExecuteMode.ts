/**
 * Implementor W1.3 / W1.4 — hard plan mode + plan→execute handoff + operator modes.
 * Pure helpers (no I/O except optional crypto for ids).
 */

import { randomBytes } from 'node:crypto';
import { isDirectMutationTool } from './mutationTools.js';

/** Operator policy for chat implementor path (orthogonal to ValidMode chat/plan/deep). */
export type ChatOperatorMode =
  | 'default'
  | 'hard_plan'
  | 'accept_edits'
  | 'yolo'
  | 'dry_run';

export const CHAT_OPERATOR_MODES: readonly ChatOperatorMode[] = [
  'default',
  'hard_plan',
  'accept_edits',
  'yolo',
  'dry_run',
] as const;

export function normalizeChatOperatorMode(raw: string | undefined | null): ChatOperatorMode | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/[_/]+/g, '-');
  const aliases: Record<string, ChatOperatorMode> = {
    default: 'default',
    normal: 'default',
    'hard-plan': 'hard_plan',
    hardplan: 'hard_plan',
    plan: 'hard_plan',
    'accept-edits': 'accept_edits',
    acceptedits: 'accept_edits',
    'accept-edit': 'accept_edits',
    yolo: 'yolo',
    always: 'yolo',
    'dry-run': 'dry_run',
    dryrun: 'dry_run',
    dry: 'dry_run',
  };
  return aliases[v] ?? null;
}

export interface PlanGateResult {
  blocked: boolean;
  observation?: string;
}

/**
 * Hard plan mode: block all direct mutations (and mutation sub-agents).
 * Reads and non-mutating tools remain allowed. Plan artifact is operator-side.
 */
export function evaluateHardPlanModeGate(opts: {
  toolName: string;
  hardPlanMode: boolean;
  isMutationSubAgent?: boolean;
}): PlanGateResult {
  if (!opts.hardPlanMode) return { blocked: false };
  const mutation =
    isDirectMutationTool(opts.toolName) || opts.isMutationSubAgent === true;
  if (!mutation) return { blocked: false };
  return {
    blocked: true,
    observation:
      `### ${opts.toolName}\nexit_code: 1\n` +
      `Error: hard-plan mode — mutations are blocked. Produce a plan (paths, approach, risks, test plan). ` +
      `When ready, operator runs /execute-plan to enter implement mode with this plan as intent.`,
  };
}

/** Serializable plan→execute handoff stored on REPL session / engine options. */
export interface ChatPlanExecuteHandoff {
  planId: string;
  planBody: string;
  /** Optional thread/event-log linkage for resume/forensics. */
  linkedEventId?: string;
  createdAt: string;
  /** When true, force-mutate threshold is lowered for implement start. */
  elevatedMutate: boolean;
}

export function createChatPlanExecuteHandoff(input: {
  planBody: string;
  linkedEventId?: string;
  elevatedMutate?: boolean;
  planId?: string;
  now?: Date;
}): ChatPlanExecuteHandoff {
  const body = input.planBody.trim();
  if (!body) {
    throw new Error('plan body must be non-empty');
  }
  return {
    planId: input.planId ?? `plan_${randomBytes(4).toString('hex')}`,
    planBody: body,
    ...(input.linkedEventId ? { linkedEventId: input.linkedEventId } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
    elevatedMutate: input.elevatedMutate !== false,
  };
}

/** User-message prefix injected at implement start after handoff. */
export function formatPlanHandoffUserMessage(handoff: ChatPlanExecuteHandoff): string {
  const link = handoff.linkedEventId
    ? `\nlinked_event_id: ${handoff.linkedEventId}`
    : '';
  return [
    '[Plan → Execute handoff]',
    `plan_id: ${handoff.planId}`,
    `created: ${handoff.createdAt}${link}`,
    '',
    'You are now in IMPLEMENT mode. Follow this plan. Prefer str_replace for the fix.',
    'Do not re-plan unless blocked. After mutations, run a targeted verifier if possible.',
    '',
    '## Approved plan',
    handoff.planBody,
  ].join('\n');
}

/**
 * Force-mutate turn threshold with handoff elevation (implementor starts writing sooner).
 */
export function resolveForceMutateTurnsForHandoff(
  baseForceMutateTurns: number,
  handoff: ChatPlanExecuteHandoff | null | undefined,
): number {
  if (!handoff?.elevatedMutate) return baseForceMutateTurns;
  return Math.min(baseForceMutateTurns, 1);
}

/** Whether operator mode should set BABEL_DRY_RUN for the session. */
export function operatorModeImpliesDryRun(mode: ChatOperatorMode): boolean {
  return mode === 'dry_run';
}

/** Whether operator mode should auto-allow file mutations (accept edits / yolo). */
export function operatorModeAutoAcceptsEdits(mode: ChatOperatorMode): boolean {
  return mode === 'accept_edits' || mode === 'yolo';
}

export function operatorModeIsHardPlan(mode: ChatOperatorMode): boolean {
  return mode === 'hard_plan';
}

export const OPERATOR_MODE_HELP: Record<ChatOperatorMode, string> = {
  default: 'Normal chat implementor policies (mutate-pressure on coding classes).',
  hard_plan: 'Mutations blocked — produce a plan only; then /execute-plan.',
  accept_edits: 'Prefer auto-accept of file edits (still re-prompts dangerous shell).',
  yolo: 'Low-friction implement mode (auto-accept edits; not a license for secrets).',
  dry_run: 'Mutations simulated (BABEL_DRY_RUN); good for demos.',
};
