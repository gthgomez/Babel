// ─── Turn Tracking ────────────────────────────────────────────────────────────
// Extracted from interactive.ts — turn recording, follow-up context
// construction, and conversation memory management. All functions that
// modify state take ReplContext as their first parameter.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildLiteSessionHandoff } from '../services/liteSessionHandoff.js';
import { classifyInteractiveTaskIntent } from './parsers.js';
import { APPROVAL_READY_STATUSES } from './types.js';
import type { ReplContext } from './context.js';
import type { InteractiveTurn } from './types.js';

export function appendTurn(
  ctx: ReplContext,
  turn: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>,
): InteractiveTurn {
  const record: InteractiveTurn = {
    schema_version: 1,
    turn_id: typeof ctx.turnCounter === 'number' ? ++ctx.turnCounter : 1,
    ts: new Date().toISOString(),
    ...turn,
  };
  if (Array.isArray(ctx.turns)) {
    ctx.turns.push(record);
  }
  if (ctx.interactiveTranscriptPath) {
    fs.mkdirSync(path.dirname(ctx.interactiveTranscriptPath), { recursive: true });
    fs.appendFileSync(ctx.interactiveTranscriptPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }
  return record;
}

export function isFollowUpInput(ctx: ReplContext, input: string): boolean {
  if (!ctx.lastAssistantAnswer) {
    return false;
  }
  return /^(why|how|what about|explain|more|continue|go ahead|do that|apply that|make that change|yes|ok|okay)\b/i.test(
    input.trim(),
  );
}

export function resolveInteractiveTask(ctx: ReplContext, input: string): string {
  if (!isFollowUpInput(ctx, input)) {
    return input;
  }
  const parts = [
    `Follow-up request: ${input}`,
    '',
    'Previous assistant answer:',
    ctx.lastAssistantAnswer ?? '',
  ];
  if (ctx.lastAssistantNext) {
    parts.push('', `Previous recommended next step: ${ctx.lastAssistantNext}`);
  }
  if (ctx.lastResolvedTask) {
    parts.push('', `Previous resolved task: ${ctx.lastResolvedTask}`);
  }
  const sessionRunDir = ctx.lastSessionRunDir ?? ctx.lastRunDir;
  if (sessionRunDir) {
    const handoff = buildLiteSessionHandoff(sessionRunDir);
    if (handoff?.summary) {
      parts.push(
        '',
        '# Prior Session Context',
        `Session run dir: ${handoff.sessionRunDir}`,
        handoff.summary,
      );
    } else if (handoff) {
      parts.push('', '# Prior Session Context', `Session run dir: ${handoff.sessionRunDir}`);
    }
  }
  return parts.join('\n');
}

export function resolveApprovalFollowUpTask(ctx: ReplContext, input: string): string {
  const priorKind =
    ctx.lastAssistantStatus === 'PROPOSAL_READY' || ctx.lastAssistantStatus === 'PATCH_READY'
      ? 'proposal'
      : 'plan';
  const parts = [
    `Apply the prior ${priorKind} from the previous turn.`,
    '',
    `User confirmation: ${input}`,
  ];
  if (ctx.lastResolvedTask) {
    parts.push('', `Previous resolved task: ${ctx.lastResolvedTask}`);
  }
  if (ctx.lastAssistantAnswer) {
    parts.push('', 'Previous assistant answer:', ctx.lastAssistantAnswer);
  }
  const sessionRunDir = ctx.lastSessionRunDir ?? ctx.lastRunDir;
  if (sessionRunDir) {
    const handoff = buildLiteSessionHandoff(sessionRunDir);
    if (handoff?.summary) {
      parts.push(
        '',
        '# Prior Session Context',
        `Session run dir: ${handoff.sessionRunDir}`,
        handoff.summary,
      );
    } else if (handoff) {
      parts.push('', '# Prior Session Context', `Session run dir: ${handoff.sessionRunDir}`);
    }
  }
  return parts.join('\n');
}

export function classifyInteractiveLane(
  ctx: ReplContext,
  input: string,
): ReturnType<typeof classifyInteractiveTaskIntent> {
  return classifyInteractiveTaskIntent(input, {
    hasPreviousAnswer: Boolean(ctx.lastAssistantAnswer),
    lastStatus: ctx.lastAssistantStatus,
  });
}

export function extractAnswerFromPayload(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  const answer = payload['answer'];
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    const record = answer as Record<string, unknown>;
    if (typeof record['answer'] === 'string' && record['answer'].trim().length > 0) {
      return record['answer'].trim();
    }
    if (typeof record['summary'] === 'string' && record['summary'].trim().length > 0) {
      return record['summary'].replace(/\bOBJECTIVE:\s*/gi, '').trim();
    }
  }
  const plan = payload['plan'];
  if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
    const summary = (plan as Record<string, unknown>)['task_summary'];
    if (typeof summary === 'string' && summary.trim().length > 0) {
      return summary.replace(/\bOBJECTIVE:\s*/gi, '').trim();
    }
  }
  return fallback;
}

export function updateConversationMemory(
  ctx: ReplContext,
  payload: Record<string, unknown>,
  resolvedTask: string,
): void {
  ctx.lastResolvedTask = resolvedTask;
  ctx.lastAssistantAnswer = extractAnswerFromPayload(payload, 'Babel completed the latest turn.');
  const next = payload['next'];
  ctx.lastAssistantNext = Array.isArray(next) && typeof next[0] === 'string' ? next[0] : null;
  ctx.lastAssistantStatus = typeof payload['status'] === 'string' ? payload['status'] : null;
  ctx.lastSessionRunDir =
    typeof payload['session_run_dir'] === 'string'
      ? payload['session_run_dir']
      : typeof payload['run_dir'] === 'string'
        ? payload['run_dir']
        : null;
}
