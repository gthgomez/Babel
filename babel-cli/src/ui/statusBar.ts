import {
  getEffectiveTerminalWidth,
  visibleLength,
  warning,
  muted,
  info,
  dim,
  bold,
  truncate,
  stripAnsi,
  bgPanel,
} from './theme.js';
import { renderCompactTokenBar, getContextLimit } from './tokenBar.js';
import { renderBackgroundTaskFooter } from './backgroundTaskProgress.js';
import { getGlobalRateLimitState, renderCompactRateLimit } from './rateLimitWidget.js';
import type { BackgroundTaskState } from './backgroundTaskProgress.js';

/**
 * State object for the status bar displayed between REPL turns.
 */
export interface StatusBarState {
  /** Active model name (e.g. "DeepSeek v4 Flash") */
  model: string;
  /** Active model ID for context limit lookup (e.g. "deepseek-v4-flash") */
  modelId?: string | undefined;
  /** Active mode label (e.g. "default", "plan", "deep") */
  mode: string;
  /** Active project label (e.g. "my-project" or "global") */
  project: string;
  /** Active context telemetry from latest provider invocation */
  activeContext?: {
    tokens: number;
    modelId: string;
    source: 'policy' | 'provider' | 'provider_prompt_tokens' | 'estimated' | 'unknown';
  } | null | undefined;
  /** Active input context tokens from latest turn (for context window meter) */
  activeContextTokens?: number | undefined;
  /** Total tokens consumed in this session */
  totalTokens: number;
  /** Total cost in USD for this session */
  totalCost: number;
  /** Number of turns completed */
  turnCount: number;
  /** Run status: 'ready' | 'complete' | 'blocked' | 'failed' */
  status?: string | undefined;
  /** Active background tasks for progress display in the status bar. */
  backgroundTasks?: BackgroundTaskState[] | undefined;
  /** Terminal width override (auto-detected if omitted) */
  width?: number | undefined;
  /** Whether to show the token context bar (default: true) */
  showTokenBar?: boolean | undefined;
  /** Current git branch name (e.g. "main", "feature/foo"). Shown next to project. */
  gitBranch?: string | null | undefined;
  /** Whether the working tree has uncommitted changes. Shown as * suffix. */
  gitDirty?: boolean | undefined;
  /** Knowledge graph state for compact indicator in the status bar. */
  knowledgeGraph?: {
    status: 'empty' | 'indexing' | 'ready' | 'stale';
    nodeCount: number | undefined;
  } | undefined;
  /**
   * Compact routing-status label for the REPL status bar.
   * Set from the last turn routing receipt to show model tier + phase.
   * Examples: "Flash·mutate", "Pro·investigate", "escalate".
   * When undefined or empty, no routing cue is shown.
   */
  routingLabel?: string | null | undefined;
}

/**
 * Render the status bar for display between interactive REPL turns.
 */
export function renderStatusBar(state: StatusBarState): string {
  const width = state.width ?? getEffectiveTerminalWidth();

  // Background task progress segment
  let bgTaskStr = '';
  if (state.backgroundTasks && state.backgroundTasks.length > 0) {
    const footerWidth = Math.max(10, Math.floor(width / 3));
    bgTaskStr = ` ${renderBackgroundTaskFooter(state.backgroundTasks, footerWidth)}`;
  }

  // Compact token bar — strictly uses active request context; NEVER falls back to cumulative session tokens
  let tokenBarStr = '';
  const activeTokens = state.activeContext ? state.activeContext.tokens : state.activeContextTokens;
  const hasActiveContext = activeTokens !== undefined && activeTokens !== null;
  const showBar = state.showTokenBar !== false && state.modelId;
  if (showBar) {
    const limit = getContextLimit(state.modelId!);
    const barWidth = Math.min(12, Math.floor(width / 8));
    const compactBar = renderCompactTokenBar(
      hasActiveContext ? activeTokens : 0,
      limit.tokens,
      Math.max(6, barWidth),
      hasActiveContext,
    );
    tokenBarStr = `  ${compactBar}`;
  }

  // Git info: show branch + dirty indicator when in a repo
  let projectLabel = state.project;
  if (state.gitBranch && state.gitBranch !== 'HEAD') {
    const dirtyMark = state.gitDirty ? '*' : '';
    projectLabel = `${state.project} (${state.gitBranch}${dirtyMark})`;
  }

  // Knowledge graph indicator
  let kgIndicator = '';
  if (state.knowledgeGraph) {
    if (state.knowledgeGraph.status === 'ready') {
      const nodes = state.knowledgeGraph.nodeCount ?? 0;
      const nodesStr =
        nodes >= 1000 ? `${(nodes / 1000).toFixed(1)}k` : String(nodes);
      kgIndicator = ` ${muted('kg')} ${info(nodesStr)}`;
    } else if (state.knowledgeGraph.status === 'empty') {
      kgIndicator = ` ${dim('kg empty')}`;
    } else if (state.knowledgeGraph.status === 'indexing') {
      kgIndicator = ` ${muted('kg')} ${warning('…')}`;
    } else if (state.knowledgeGraph.status === 'stale') {
      kgIndicator = ` ${muted('kg')} ${warning('stale')}`;
    }
  }

  // Routing label cleanup: avoid repeating model name (e.g. "DeepSeek V4 Flash Flash·escalate" -> "DeepSeek V4 Flash · escalate")
  let modelLabel = state.model;
  if (state.routingLabel) {
    let cleanLabel = state.routingLabel;
    const modelLower = state.model.toLowerCase();
    if (modelLower.includes('flash') && cleanLabel.toLowerCase().startsWith('flash·')) {
      cleanLabel = cleanLabel.slice(6);
    } else if (modelLower.includes('pro') && cleanLabel.toLowerCase().startsWith('pro·')) {
      cleanLabel = cleanLabel.slice(4);
    } else if (modelLower.includes('flash') && cleanLabel.toLowerCase() === 'flash') {
      cleanLabel = '';
    } else if (modelLower.includes('pro') && cleanLabel.toLowerCase() === 'pro') {
      cleanLabel = '';
    }
    if (cleanLabel) {
      modelLabel = `${state.model} ${dim('·')} ${bold(cleanLabel)}`;
    }
  }

  const left = `${modelLabel} | ${state.mode} | ${projectLabel}${kgIndicator}${bgTaskStr}`;
  const rightBase = `${state.totalTokens.toLocaleString()} tok | $${state.totalCost.toFixed(4)} | turn ${state.turnCount}`;
  const rlWidget = renderCompactRateLimit(getGlobalRateLimitState());
  const rightCore = rlWidget ? `${rightBase} | ${rlWidget}` : rightBase;
  let right = tokenBarStr ? `${rightCore}${tokenBarStr}` : rightCore;

  const minSpacing = 2;
  // When the right cluster alone exceeds the bar width, shrink it so the line
  // never wraps (turn count / token bar used to spill onto a second row).
  if (visibleLength(right) + minSpacing > width) {
    const maxRight = Math.max(8, width - minSpacing);
    right = truncate(stripAnsi(right), maxRight);
  }

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  let line: string;

  if (leftLen + rightLen + minSpacing <= width) {
    // Full bar fits comfortably
    const padding = width - leftLen - rightLen;
    line = left + ' '.repeat(padding) + right;
  } else {
    // Truncate the left side so the right-aligned info stays visible
    const maxLeftLen = Math.max(4, width - rightLen - minSpacing);
    const truncatedLeft = truncate(stripAnsi(left), maxLeftLen);
    const truncatedLen = visibleLength(truncatedLeft);
    const padding = Math.max(minSpacing, width - truncatedLen - rightLen);
    line = truncatedLeft + ' '.repeat(padding) + right;
  }

  // Clamp final line so reverse-video fill never exceeds terminal width
  // (defensive: truncation math + ANSI edge cases).
  let lineVisLen = visibleLength(line);
  if (lineVisLen > width) {
    line = truncate(stripAnsi(line), width);
    lineVisLen = visibleLength(line);
  }

  // Render on subtle theme panel background (avoids blinding inverted blocks)
  const fillSpaces = ' '.repeat(Math.max(0, width - lineVisLen));
  return `${bgPanel(`${line}${fillSpaces}`)}\n`;
}
