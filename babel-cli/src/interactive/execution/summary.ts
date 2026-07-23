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
import { updateConversationMemory } from '../turns.js';

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
  });
  console.log(`\n${human}\n`);
  const note = formatHumanOutputReviewNote(review);
  if (note) {
    console.log(muted(`  ${note}\n`));
  }
  // One-line compact cost summary after every run
  const sessionCost = globalCostTracker.getSessionSummary();
  const runStatus = ctx.state.lastRunUserStatus ?? String(result.status ?? '');
  const costLine =
    typeof sessionCost.totalCostUSD === 'number' ? `$${sessionCost.totalCostUSD.toFixed(4)}` : '--';
  const runLabel = userStatusForRun(String(result.status ?? ''));
  console.log(
    dim(`  ${runLabel} | Session cost: ${costLine} | Next: /inspect, or type your next task\n`),
  );
}
