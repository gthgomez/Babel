// ─── Run Summary ─────────────────────────────────────────────────────────
// Extracted from interactive.ts — prints a structured run summary including
// cost, changed files, and verification status.

import type { ReplContext } from '../context.js';
import {
  buildRunResultPayload,
  formatRunResultHuman,
  writeHumanSummaryArtifact,
  formatHumanOutputReviewNote,
} from '../../cli/structuredOutput.js';
import { userStatusForRun } from '../utils.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { dim, muted } from '../../ui/theme.js';
import { sanitizeUntrustedTerminalBlock } from '../../ui/sanitize.js';
import { updateConversationMemory } from '../turns.js';

export function presentRunText(ctx: ReplContext, text: string, style?: 'muted' | 'dim', isError = false): void {
  if (ctx.shellRuntime) {
    ctx.shellRuntime.appendNotice(text, { preserveFull: true });
    return;
  }
  const safe = sanitizeUntrustedTerminalBlock(text);
  const formatted = style === 'muted' ? muted(safe) : style === 'dim' ? dim(safe) : safe;
  if (isError) console.error(formatted);
  else console.log(formatted);
}

/** Keep incomplete invoices distinct from the known or estimated subtotal. */
export function printRunCostFooter(ctx: ReplContext, status: string): void {
  const cost = globalCostTracker.getSessionSummary();
  const incomplete = cost.costComplete === false || cost.completeCostUSD === null ||
    (cost.unknownChargeCount ?? 0) > 0;
  const subtotal = cost.knownCostUSD ?? cost.totalCostUSD;
  const costText = incomplete
    ? [
        `Session cost incomplete: $${subtotal.toFixed(4)} known subtotal`,
        ...(cost.estimatedCostUSD ? [`$${cost.estimatedCostUSD.toFixed(4)} usage estimate`] : []),
        ...(cost.unknownChargeCount ? [`${cost.unknownChargeCount} unpriced charge(s)`] : []),
      ].join('; ')
    : `Session cost: $${(cost.completeCostUSD ?? cost.totalCostUSD).toFixed(4)}`;
  presentRunText(ctx, `  ${userStatusForRun(status)} | ${costText} | Next: /inspect, or type your next task\n`, 'dim');
}

export function printRunSummary(
  ctx: ReplContext,
  result: any,
  context: { input?: string; task: string; projectRoot?: string; transcript?: string },
): void {
  ctx.state.lastRunUserStatus = userStatusForRun(String(result.status ?? ''));
  if (context.projectRoot !== undefined) {
    ctx.state.lastRunTargetRoot = context.projectRoot;
  }
  const payload = buildRunResultPayload(result, {
    task: context.task,
    mode: ctx.state.mode,
    ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
    ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
    orchestrator: ctx.state.router,
    ...(ctx.state.model !== undefined ? { requestedModel: ctx.state.model } : {}),
  });
  const human = formatRunResultHuman(payload);
  const transcript = [context.input ? `You: ${context.input}` : '', context.transcript, human]
    .filter(Boolean)
    .join('\n');
  ctx.lastRunTranscript = transcript;
  const review = writeHumanSummaryArtifact(result.runDir, human, transcript);
  updateConversationMemory(ctx, payload, context.task);
  const changedFiles = Array.isArray(payload['changed_files'])
    ? payload['changed_files'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const verification =
    payload['verification'] && typeof payload['verification'] === 'object'
      ? String((payload['verification'] as Record<string, unknown>)['status'] ?? '')
      : null;
  ctx.appendTurn({
    role: 'assistant',
    ...(ctx.lastAssistantAnswer
      ? { answer: ctx.lastAssistantAnswer, summary: ctx.lastAssistantAnswer }
      : {}),
    run_dir: result.runDir,
    changed_files: changedFiles,
    verification,
    next: ctx.lastAssistantNext,
  }, String(result.status ?? ctx.state.lastRunUserStatus ?? 'completed'));
  presentRunText(ctx, `\n${human}\n`);
  const note = formatHumanOutputReviewNote(review);
  if (note) {
    presentRunText(ctx, `  ${note}\n`, 'muted');
  }
  printRunCostFooter(ctx, String(result.status ?? ''));
}
