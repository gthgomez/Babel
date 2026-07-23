import { renderOperatorHeader, renderPlanModeWarning } from '../../ui/renderers.js';
import { describeVisibleMode } from '../types.js';
import { muted, humanizeModelId } from '../../ui/theme.js';
import { readRuntimeMode } from '../../config/runtimeMode.js';
import { backgroundTaskRegistry } from '../../services/backgroundTaskRegistry.js';
import { toTaskState } from '../../ui/backgroundTaskProgress.js';
import { renderStatusBar } from '../../ui/statusBar.js';
import { getGitInfo } from '../../ui/gitInfo.js';
import { getCachedIndexStatus } from '../../services/knowledgeGraphIndexer.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import type { ReplContext } from '../context.js';

export function printIdleHeader(ctx: ReplContext): void {
  const header = renderOperatorHeader({
    ...ctx.state,
    turnCount: ctx.turnCounter,
    resolvedModelId: ctx.state.resolvedModelId || ctx.state.model,
  } as Record<string, unknown>);
  const runtimePlan = readRuntimeMode() === 'plan';
  const sessionPlan = ctx.state.mode === 'plan';
  const planWarning = runtimePlan || sessionPlan ? `\n${renderPlanModeWarning()}\n` : '';
  const hint = muted('  › type a task, or /help for commands\n');
  // Unified write path — avoids interleaving with SessionPicker / PromptInput frames
  OutputBuffer.getInstance().write(header + planWarning + hint);
}

export function renderTurnStatusBar(ctx: ReplContext): void {
  const activeTasks = backgroundTaskRegistry.getActiveTasks();
  const taskStates = activeTasks.length > 0 ? activeTasks.map((t) => toTaskState(t)) : undefined;
  let gitBranch: string | null = null;
  let gitDirty = false;
  try {
    const git = getGitInfo();
    gitBranch = git.branch;
    gitDirty = git.dirty;
  } catch {
    /* git optional */
  }

  const barState: Parameters<typeof renderStatusBar>[0] = {
    model: humanizeModelId(ctx.state.model ?? 'qwen3-32b'),
    ...(ctx.state.resolvedModelId !== undefined ? { modelId: ctx.state.resolvedModelId } : {}),
    mode: describeVisibleMode(ctx.state.mode).toLowerCase(),
    project: ctx.state.project ?? 'global',
    totalTokens: ctx.state.costTotals.totalTokens,
    totalCost: ctx.state.costTotals.totalCostUSD,
    turnCount: ctx.turnCounter,
    status: ctx.state.lastRunUserStatus ?? 'ready',
    gitBranch,
    gitDirty,
  };
  if (taskStates !== undefined) barState.backgroundTasks = taskStates;

  // Wire knowledge-graph indicator from the background indexer cache
  const cachedKg = getCachedIndexStatus();
  if (cachedKg) {
    barState.knowledgeGraph = { status: 'ready', nodeCount: cachedKg.nodeCount };
  }

  // U1.3: Surface last routing label (model tier + phase) on status bar
  if (ctx.lastRoutingLabel) {
    barState.routingLabel = ctx.lastRoutingLabel;
  }

  OutputBuffer.getInstance().write(renderStatusBar(barState));
}