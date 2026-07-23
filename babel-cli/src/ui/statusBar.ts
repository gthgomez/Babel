import {
  getTerminalWidth,
  getEffectiveTerminalWidth,
  visibleLength,
  error,
  success,
  warning,
  muted,
  info,
  dim,
  bold,
} from './theme.js';
import { renderCompactTokenBar, renderTokenBarWithHistory, getContextLimit } from './tokenBar.js';
import { renderBackgroundTaskFooter } from './backgroundTaskProgress.js';
import { getGlobalTokenTracker } from './tokenHistory.js';
import { getGlobalRateLimitState, renderCompactRateLimit } from './rateLimitWidget.js';
import type { BackgroundTaskState } from './backgroundTaskProgress.js';

/**
 * State object for the status bar displayed between REPL turns.
 */
export interface StatusBarState {
  /** Active model name (e.g. "DeepSeek v4 Flash") */
  model: string;
  /** Active model ID for context limit lookup (e.g. "deepseek-v4-pro") */
  modelId?: string;
  /** Active mode label (e.g. "default", "plan", "deep") */
  mode: string;
  /** Active project label (e.g. "my-project" or "global") */
  project: string;
  /** Total tokens consumed in this session */
  totalTokens: number;
  /** Total cost in USD for this session */
  totalCost: number;
  /** Number of turns completed */
  turnCount: number;
  /** Run status for color-coded background: 'ready' | 'complete' | 'blocked' | 'failed' */
  status?: string;
  /** Active background tasks for progress display in the status bar. */
  backgroundTasks?: BackgroundTaskState[];
  /** Terminal width override (auto-detected if omitted) */
  width?: number;
  /** Whether to show the token context bar (default: true) */
  showTokenBar?: boolean;
  /** Current git branch name (e.g. "main", "feature/foo"). Shown next to project. */
  gitBranch?: string | null;
  /** Whether the working tree has uncommitted changes. Shown as * suffix. */
  gitDirty?: boolean;
  /** Knowledge graph state for compact indicator in the status bar. */
  knowledgeGraph?: {
    status: 'empty' | 'indexing' | 'ready' | 'stale';
    nodeCount: number | undefined;
  };
  /**
   * Compact routing-status label for the REPL status bar.
   * Set from the last turn routing receipt to show model tier + phase.
   * Examples: "Flash·mutate", "Pro·investigate", "Flash".
   * When undefined or empty, no routing cue is shown.
   */
  routingLabel?: string;
}

/**
 * Render a single-line status bar using ANSI reverse video.
 *
 * Format:
 *   <model> | <mode> | <project>              <tok> tok | $<cost> | turn <n>
 *
 * The bar is padded to the full terminal width so the background highlight
 * spans edge-to-edge. The right-aligned section (tokens / cost / turn count)
 * is preserved if the bar must be truncated.
 *
 * @returns An ANSI-escaped string ending with a newline, suitable for writing
 *          directly to stdout.
 */
export function renderStatusBar(state: StatusBarState): string {
  const width = state.width ?? getEffectiveTerminalWidth(40, 200);

  // Render background tasks as a compact footer (if any)
  let bgTaskStr = '';
  if (state.backgroundTasks && state.backgroundTasks.length > 0) {
    // Allocate roughly 40% of the bar width for the task footer, clamped
    const footerWidth = Math.max(20, Math.floor(width * 0.4));
    bgTaskStr = ` ${renderBackgroundTaskFooter(state.backgroundTasks, footerWidth)}`;
  }

  // Compact token bar — integrated inline at the end of the right section
  let tokenBarStr = '';
  const showBar = state.showTokenBar !== false && state.totalTokens > 0 && state.modelId;
  if (showBar) {
    const limit = getContextLimit(state.modelId!);
    const barWidth = Math.min(12, Math.floor(width / 8));
    const compactBar = renderCompactTokenBar(
      state.totalTokens,
      limit.tokens,
      Math.max(6, barWidth),
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

  // Routing label (tier + phase) — shown next to model name when available
  let modelLabel = state.model;
  if (state.routingLabel) {
    modelLabel = `${state.model} ${bold(state.routingLabel)}`;
  }

  const left = `${modelLabel} | ${state.mode} | ${projectLabel}${kgIndicator}${bgTaskStr}`;
  const rightBase = `${state.totalTokens.toLocaleString()} tok | $${state.totalCost.toFixed(4)} | turn ${state.turnCount}`;
  const rlWidget = renderCompactRateLimit(getGlobalRateLimitState());
  const rightCore = rlWidget ? `${rightBase} | ${rlWidget}` : rightBase;
  const right = tokenBarStr ? `${rightCore}${tokenBarStr}` : rightCore;

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);

  const minSpacing = 2;
  let line: string;

  if (leftLen + rightLen + minSpacing <= width) {
    // Full bar fits comfortably
    const padding = width - leftLen - rightLen;
    line = left + ' '.repeat(padding) + right;
  } else {
    // Truncate the left side so the right-aligned info stays visible
    const maxLeftLen = Math.max(10, width - rightLen - minSpacing);
    const truncatedLeft = [...left].slice(0, Math.max(0, maxLeftLen - 1)).join('') + '…';
    const truncatedLen = visibleLength(truncatedLeft);
    const padding = Math.max(minSpacing, width - truncatedLen - rightLen);
    line = truncatedLeft + ' '.repeat(padding) + right;
  }

  // Token sparkline — rendered as a separate dim line below the main bar
  // when history data is available (compact bar alone is already inline above)
  let sparkLine = '';
  if (showBar) {
    const limit = getContextLimit(state.modelId!);
    const tracker = getGlobalTokenTracker();
    const barWithHistory = renderTokenBarWithHistory(
      state.totalTokens,
      limit.tokens,
      tracker,
      Math.min(16, Math.floor(width / 5)),
    );
    const barLines = barWithHistory.split('\n');
    if (barLines.length > 1) {
      sparkLine = `\x1b[2m ${barLines.slice(1).join('\n')}\x1b[0m\n`;
    }
  }

  // Color-coded status bar: change background based on last run status
  const bgCodes: Record<string, string> = {
    failed: '\x1b[41m', // red background
    blocked: '\x1b[43m\x1b[30m', // yellow background, black text
    complete: '\x1b[42m\x1b[30m', // green background, black text
  };
  const bgCode = state.status ? bgCodes[state.status] : null;
  if (bgCode) {
    return `${bgCode} ${line.padEnd(width - 2)} \x1b[0m\n${sparkLine}`;
  }
  // Standard reverse video for ready state
  return `\x1b[7m${line.padEnd(width)}\x1b[0m\n${sparkLine}`;
}
