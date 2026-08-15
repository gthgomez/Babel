import {
  getEffectiveTerminalWidth,
  visibleLength,
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

export type StatusWidthBand = 60 | 80 | 100 | 120 | 160;

/** Map a terminal width onto the Stage 0 shed bands. */
export function classifyStatusWidth(width: number): StatusWidthBand {
  if (width < 80) return 60;
  if (width < 100) return 80;
  if (width < 120) return 100;
  if (width < 160) return 120;
  return 160;
}

export function isDefaultStatusMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return normalized === '' || normalized === 'default' || normalized === 'chat';
}

export function isRateLimitAttention(remaining: number, limit: number): boolean {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return false;
  return remaining / limit <= 0.25;
}

export interface StatusBarFieldPolicy {
  band: StatusWidthBand;
  showMode: boolean;
  showCost: boolean;
  showSessionTokens: boolean;
  showBranch: boolean;
  showTurn: boolean;
  showKg: boolean;
  showRouting: boolean;
  showRateLimit: boolean;
  showBgTasks: boolean;
}

/**
 * Explicit field shedding — fields are omitted by policy, not rendered then truncated.
 *
 * 60:  model · active-context
 * 80:  + mode if non-default
 * 100: + cost
 * 120: + session tok (kept distinct from the active-context %) + branch
 * 160: + turn
 *
 * kg / routing / default-mode / idle rate-limit never persist.
 */
export function planStatusBarFields(
  width: number,
  input: {
    mode: string;
    hasBranch: boolean;
    hasBgTasks: boolean;
    hasActiveRateLimit: boolean;
  },
): StatusBarFieldPolicy {
  const band = classifyStatusWidth(width);
  return {
    band,
    showMode: !isDefaultStatusMode(input.mode) && band >= 80,
    showCost: band >= 100,
    showSessionTokens: band >= 120,
    showBranch: input.hasBranch && band >= 120,
    showTurn: band >= 160,
    showKg: false,
    showRouting: false,
    showRateLimit: input.hasActiveRateLimit && band >= 80,
    showBgTasks: input.hasBgTasks && band >= 80,
  };
}

function renderActiveContextMeter(state: StatusBarState, width: number): string {
  if (state.showTokenBar === false) return '';
  const activeTokens = state.activeContext ? state.activeContext.tokens : state.activeContextTokens;
  const hasActiveContext = activeTokens !== undefined && activeTokens !== null;
  const targetModelId = state.activeContext?.modelId ?? state.modelId;
  if (!targetModelId) return '';
  const limit = getContextLimit(targetModelId);
  const barWidth = Math.min(12, Math.floor(width / 8));
  return renderCompactTokenBar(
    hasActiveContext ? activeTokens : 0,
    limit.tokens,
    Math.max(6, barWidth),
    hasActiveContext,
  );
}

/**
 * Render the status bar for display between interactive REPL turns.
 */
export function renderStatusBar(state: StatusBarState): string {
  const width = state.width ?? getEffectiveTerminalWidth();
  const rateState = getGlobalRateLimitState();
  const hasBranch = Boolean(state.gitBranch && state.gitBranch !== 'HEAD');
  const hasBgTasks = Boolean(state.backgroundTasks && state.backgroundTasks.length > 0);
  const hasActiveRateLimit = Boolean(
    rateState && isRateLimitAttention(rateState.remaining, rateState.limit),
  );
  const policy = planStatusBarFields(width, {
    mode: state.mode,
    hasBranch,
    hasBgTasks,
    hasActiveRateLimit,
  });

  const leftParts: string[] = [state.model];
  if (policy.showMode) leftParts.push(state.mode);
  if (policy.showBranch && state.gitBranch) {
    leftParts.push(`${state.gitBranch}${state.gitDirty ? '*' : ''}`);
  }
  const left = leftParts.join(' · ');

  const rightParts: string[] = [];
  if (policy.showSessionTokens) {
    rightParts.push(`${state.totalTokens.toLocaleString()} tok`);
  }
  if (policy.showCost) {
    rightParts.push(`$${state.totalCost.toFixed(4)}`);
  }
  if (policy.showTurn) {
    rightParts.push(`turn ${state.turnCount}`);
  }
  if (policy.showRateLimit) {
    const rl = renderCompactRateLimit(rateState);
    if (rl) rightParts.push(rl);
  }
  if (policy.showBgTasks && state.backgroundTasks) {
    const footerWidth = Math.max(10, Math.floor(width / 4));
    const bg = renderBackgroundTaskFooter(state.backgroundTasks, footerWidth);
    if (bg) rightParts.push(bg);
  }
  const contextMeter = renderActiveContextMeter(state, width);
  if (contextMeter) rightParts.push(contextMeter);

  let right = rightParts.join('  ');

  const minSpacing = 2;
  // Context meter is the last right-hand field. If the right cluster still
  // cannot fit, shrink it rather than wrapping — model identity is truncated
  // only after the right cluster has been reduced.
  if (visibleLength(right) + minSpacing > width) {
    const maxRight = Math.max(8, width - minSpacing);
    right = truncate(stripAnsi(right), maxRight);
  }

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  let line: string;

  if (leftLen + rightLen + minSpacing <= width) {
    const padding = width - leftLen - rightLen;
    line = left + ' '.repeat(padding) + right;
  } else {
    const maxLeftLen = Math.max(4, width - rightLen - minSpacing);
    const truncatedLeft = truncate(stripAnsi(left), maxLeftLen);
    const truncatedLen = visibleLength(truncatedLeft);
    const padding = Math.max(minSpacing, width - truncatedLen - rightLen);
    line = truncatedLeft + ' '.repeat(padding) + right;
  }

  let lineVisLen = visibleLength(line);
  if (lineVisLen > width) {
    line = truncate(stripAnsi(line), width);
    lineVisLen = visibleLength(line);
  }

  const fillSpaces = ' '.repeat(Math.max(0, width - lineVisLen));
  return `${bgPanel(`${line}${fillSpaces}`)}\n`;
}
