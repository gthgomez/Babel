import {
  getEffectiveTerminalWidth,
  visibleLength,
  truncate,
  stripAnsi,
  bgPanel,
} from './theme.js';
import { renderCompactTokenBar, getContextLimit } from './tokenBar.js';
import { renderBackgroundTaskFooter } from './backgroundTaskProgress.js';
import {
  classifyRateLimit,
  getGlobalRateLimitState,
  RateLimitTier,
  renderCompactRateLimit,
} from './rateLimitWidget.js';
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

export type RateLimitAttentionLevel = 'none' | 'warning' | 'critical';

export type StatusBarRightSlot =
  | 'sessionTokens'
  | 'cost'
  | 'turn'
  | 'rateLimit'
  | 'bgTasks'
  | 'context';

export interface StatusBarRightPart {
  slot: StatusBarRightSlot;
  text: string;
}

/**
 * Attention-preemption policy.
 *
 * The static shed matrix is the default. When something actually matters,
 * it may appear below its static band and take space from quieter chrome —
 * it does not end-truncate the right cluster (that clipped the context meter).
 *
 * Width 60:
 *   normal:    model                         context
 *   critical:  model              rate-limit context
 *
 * Wider bands keep the same rule: insert the live signal, then drop
 * `displaceInOrder` if the right cluster still cannot fit.
 */
export const ATTENTION_PREEMPTION = {
  /** Exhausted / critical rate-limit may break through to the 60-band. */
  criticalRateLimitMinBand: 60 as StatusWidthBand,
  /** Warning pressure stays on the static 80+ gate. */
  warningRateLimitMinBand: 80 as StatusWidthBand,
  /**
   * First listed is dropped first when the right cluster still overflows.
   * Context is omitted. `rateLimit` is skipped while the signal is critical.
   */
  displaceInOrder: [
    'turn',
    'sessionTokens',
    'cost',
    'bgTasks',
    'rateLimit',
  ] as const satisfies readonly StatusBarRightSlot[],
} as const;

export function isRateLimitAttention(remaining: number, limit: number): boolean {
  return classifyRateLimitAttention(remaining, limit) !== 'none';
}

/**
 * Map remaining/limit onto status-bar attention.
 * Warning is pressure (80+). Critical/exhausted may preempt quieter chrome at 60.
 */
export function classifyRateLimitAttention(
  remaining: number,
  limit: number,
): RateLimitAttentionLevel {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return 'none';
  const { tier } = classifyRateLimit(remaining, limit);
  if (tier === RateLimitTier.Exhausted || tier === RateLimitTier.Critical) return 'critical';
  if (tier === RateLimitTier.Warning) return 'warning';
  return 'none';
}

function joinRightParts(parts: readonly StatusBarRightPart[]): string {
  return parts
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join('  ');
}

/**
 * Drop ATTENTION_PREEMPTION.displaceInOrder until the cluster fits.
 *
 * @param parts - Named right-cluster slots already selected by the static matrix
 * @param maxWidth - Visible-column budget for the right cluster
 * @param protectRateLimit - Keep the rate-limit slot (critical/exhausted)
 * @returns Joined right-cluster text
 */
export function applyAttentionPreemption(
  parts: readonly StatusBarRightPart[],
  maxWidth: number,
  protectRateLimit = false,
): string {
  const kept = parts.filter((part) => part.text.length > 0);
  for (const slot of ATTENTION_PREEMPTION.displaceInOrder) {
    if (visibleLength(joinRightParts(kept)) <= maxWidth) break;
    if (slot === 'rateLimit' && protectRateLimit) continue;
    const idx = kept.findIndex((part) => part.slot === slot);
    if (idx >= 0) kept.splice(idx, 1);
  }
  const packed = joinRightParts(kept);
  if (visibleLength(packed) <= maxWidth) return packed;
  return truncate(stripAnsi(packed), maxWidth);
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
 * ATTENTION_PREEMPTION may then let a live signal appear below its
 * static band and displace quieter right-cluster fields.
 */
export function planStatusBarFields(
  width: number,
  input: {
    mode: string;
    hasBranch: boolean;
    hasBgTasks: boolean;
    hasActiveRateLimit: boolean;
    hasCriticalRateLimit?: boolean;
  },
): StatusBarFieldPolicy {
  const band = classifyStatusWidth(width);
  const rateLimitMinBand = input.hasCriticalRateLimit
    ? ATTENTION_PREEMPTION.criticalRateLimitMinBand
    : ATTENTION_PREEMPTION.warningRateLimitMinBand;
  return {
    band,
    showMode: !isDefaultStatusMode(input.mode) && band >= 80,
    showCost: band >= 100,
    showSessionTokens: band >= 120,
    showBranch: input.hasBranch && band >= 120,
    showTurn: band >= 160,
    showKg: false,
    showRouting: false,
    showRateLimit: Boolean(input.hasActiveRateLimit || input.hasCriticalRateLimit)
      && band >= rateLimitMinBand,
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
  const rateAttention = rateState
    ? classifyRateLimitAttention(rateState.remaining, rateState.limit)
    : 'none';
  const policy = planStatusBarFields(width, {
    mode: state.mode,
    hasBranch,
    hasBgTasks,
    hasActiveRateLimit: rateAttention !== 'none',
    hasCriticalRateLimit: rateAttention === 'critical',
  });

  const leftParts: string[] = [state.model];
  if (policy.showMode) leftParts.push(state.mode);
  if (policy.showBranch && state.gitBranch) {
    leftParts.push(`${state.gitBranch}${state.gitDirty ? '*' : ''}`);
  }
  const left = leftParts.join(' · ');

  const rightParts: StatusBarRightPart[] = [];
  if (policy.showSessionTokens) {
    rightParts.push({ slot: 'sessionTokens', text: `${state.totalTokens.toLocaleString()} tok` });
  }
  if (policy.showCost) {
    rightParts.push({ slot: 'cost', text: `$${state.totalCost.toFixed(4)}` });
  }
  if (policy.showTurn) {
    rightParts.push({ slot: 'turn', text: `turn ${state.turnCount}` });
  }
  if (policy.showRateLimit) {
    const rl = renderCompactRateLimit(rateState);
    if (rl) rightParts.push({ slot: 'rateLimit', text: rl });
  }
  if (policy.showBgTasks && state.backgroundTasks) {
    const footerWidth = Math.max(10, Math.floor(width / 4));
    const bg = renderBackgroundTaskFooter(state.backgroundTasks, footerWidth);
    if (bg) rightParts.push({ slot: 'bgTasks', text: bg });
  }
  const contextMeter = renderActiveContextMeter(state, width);
  if (contextMeter) rightParts.push({ slot: 'context', text: contextMeter });

  const minSpacing = 2;
  const minLeft = 4;
  const maxRight = Math.max(8, width - minLeft - minSpacing);
  const right = applyAttentionPreemption(
    rightParts,
    maxRight,
    rateAttention === 'critical',
  );

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
