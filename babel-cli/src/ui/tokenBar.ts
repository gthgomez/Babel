/**
 * TokenBar — visual context window utilization bar.
 *
 * Renders an inline progress bar showing what percentage of the model's
 * context window is consumed. Uses Unicode block characters for smooth
 * gradients and color-codes by utilization level.
 *
 * Also provides model-specific context limits and a compact summary
 * for use in status bars and conversation footers.
 *
 * Usage:
 *   import { renderTokenBar, renderCompactTokenBar } from './tokenBar.js';
 *
 *   const bar = renderTokenBar(45000, 200000); // 45K / 200K tokens
 *   // " ████░░░░  22%  45k/200k  "
 *
 *   const compact = renderCompactTokenBar(45000, 200000, 26);
 *   // "[████░░░░  22%]"
 *
 * @module tokenBar
 */

import { muted, ghost, success, warning, error, info, bold } from './theme.js';
import { getEffectiveTerminalWidth } from './theme.js';
import { type TokenUsageTracker, renderTokenSparkline } from './tokenHistory.js';
import { getModelContextWindow } from '../modelPolicy.js';

// ── Context window limits by model family ───────────────────────────────────────

export interface ContextLimit {
  /** Display name */
  label: string;
  /** Context window in tokens */
  tokens: number;
}

/**
 * Known context window limits.
 * Keep in sync with model pricing registry and provider docs.
 * When a model isn't listed, defaults to 200K (Claude-family standard).
 */
export const CONTEXT_LIMITS: Record<string, ContextLimit> = {
  // Claude family
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', tokens: 200_000 },
  'claude-sonnet-4-5': { label: 'Sonnet 4.5', tokens: 200_000 },
  'claude-opus-4-8': { label: 'Opus 4.8', tokens: 200_000 },
  'claude-opus-4-7': { label: 'Opus 4.7', tokens: 200_000 },
  'claude-opus-4-6': { label: 'Opus 4.6', tokens: 200_000 },
  'claude-haiku-4-5': { label: 'Haiku 4.5', tokens: 200_000 },
  'claude-fable-5': { label: 'Fable 5', tokens: 200_000 },

  // DeepSeek family — policy context_window is canonical (128k for V4).
  // Hard-coded values match policy; do not invent a conflicting 1M limit (P1-E).
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', tokens: 128_000 },
  'deepseek-v4-flash': { label: 'DeepSeek V4 Flash', tokens: 128_000 },
  'deepseek-v4': { label: 'DeepSeek V4', tokens: 128_000 },
  'deepseek-v3': { label: 'DeepSeek V3', tokens: 128_000 },

  // Fallback
  __default__: { label: 'Model', tokens: 200_000 },
};

// ── Bar character sets ──────────────────────────────────────────────────────────

/** Unicode block characters for smooth 1/8-step gradients */
const BAR_CHARS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

const BAR_WIDTH_DEFAULT = 10; // characters

// ── Utilization thresholds ──────────────────────────────────────────────────────

enum UtilizationTier {
  Safe = 'safe', // 0-50%
  Moderate = 'moderate', // 50-75%
  High = 'high', // 75-90%
  Critical = 'critical', // 90%+
}

interface UtilizationInfo {
  tier: UtilizationTier;
  percent: number;
}

function classifyUtilization(used: number, limit: number): UtilizationInfo {
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  if (percent >= 90) return { tier: UtilizationTier.Critical, percent };
  if (percent >= 75) return { tier: UtilizationTier.High, percent };
  if (percent >= 50) return { tier: UtilizationTier.Moderate, percent };
  return { tier: UtilizationTier.Safe, percent };
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Get the context limit for a given model ID.
 *
 * First tries the model policy config (`model-policy.json`), which is the
 * canonical source for policy-controlled models. Falls back to the hardcoded
 * map for models not tracked in the policy (e.g. Claude family models used
 * directly via provider APIs).
 *
 * Falls through to a 200K default for completely unknown models.
 */
export function getContextLimit(modelId: string): ContextLimit {
  const policyLimit = getContextLimitFromPolicy(modelId);
  if (policyLimit) return policyLimit;
  return CONTEXT_LIMITS[modelId] ?? CONTEXT_LIMITS['__default__']!;
}

/**
 * Look up a model's context limit from the model policy system.
 *
 * Queries the `context_window` field from the model policy config
 * for models that are tracked there. Returns `null` when the model
 * is not found in the policy or the policy file cannot be loaded.
 *
 * This is the primary path for policy-controlled models; the caller
 * should fall back to the hardcoded CONTEXT_LIMITS map for models
 * that are not registered in the policy.
 */
export function getContextLimitFromPolicy(modelId: string): ContextLimit | null {
  const ctxWindow = getModelContextWindow(modelId);
  if (ctxWindow === undefined) return null;

  // Derive a human-friendly label from the model ID
  const label = CONTEXT_LIMITS[modelId]?.label ?? humanizeModelId(modelId);
  return { label, tokens: ctxWindow };
}

/**
 * Convert a kebab-case model ID to a display label.
 */
function humanizeModelId(modelId: string): string {
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Render a full-width token utilization bar.
 *
 * @param usedTokens  Total tokens consumed so far
 * @param contextLimit  Model context window size (tokens)
 * @param modelLabel  Optional model display name (auto-derived from limit if omitted)
 * @param width  Bar width in characters (default: auto-fit to terminal)
 * @returns ANSI-escaped string
 */
export function renderTokenBar(
  usedTokens: number,
  contextLimit: number,
  modelLabel?: string,
  width?: number,
): string {
  const effectiveWidth = width ?? Math.min(50, getEffectiveTerminalWidth(40, 120) - 4);
  const barChars = Math.max(6, effectiveWidth - 18); // Reserve space for labels
  const { tier, percent } = classifyUtilization(usedTokens, contextLimit);
  const label = modelLabel ?? formatTokenCount(usedTokens);

  const bar = buildBar(usedTokens, contextLimit, barChars, tier);

  const percentStr = `${percent}%`.padStart(4);
  const usageStr = `${formatTokenCount(usedTokens)}/${formatTokenCount(contextLimit)}`;

  // Color the percentage based on utilization
  let coloredPercent: string;
  switch (tier) {
    case UtilizationTier.Critical:
      coloredPercent = error(percentStr);
      break;
    case UtilizationTier.High:
      coloredPercent = warning(percentStr);
      break;
    case UtilizationTier.Moderate:
      coloredPercent = info(percentStr);
      break;
    default:
      coloredPercent = muted(percentStr);
      break;
  }

  return `${bar} ${coloredPercent}  ${ghost(usageStr)}`;
}

/**
 * Render a compact token bar suitable for status bars and footers.
 * Designed to fit in ~28-36 characters.
 *
 * @returns ANSI-escaped string like "[████░░░░  22%]"
 */
export function renderCompactTokenBar(
  usedTokens: number,
  contextLimit: number,
  barChars: number = BAR_WIDTH_DEFAULT,
): string {
  const { tier, percent } = classifyUtilization(usedTokens, contextLimit);
  const bar = buildBar(usedTokens, contextLimit, barChars, tier);
  return `[${bar} ${percent.toString().padStart(3)}%]`;
}

/**
 * Render a token summary line for the conversation footer.
 * Includes the compact bar + cost + elapsed time.
 *
 * @returns ANSI-escaped string, no trailing newline
 */
export function renderTokenSummary(
  usedTokens: number,
  contextLimit: number,
  costUSD: number,
  elapsedMs: number,
): string {
  const bar = renderCompactTokenBar(usedTokens, contextLimit);
  const costStr = costUSD > 0 ? `$${costUSD.toFixed(4)}` : '$0.0000';
  const timeStr = formatElapsedCompact(elapsedMs);
  return `${bar}  ${muted(costStr)}  ${ghost(timeStr)}`;
}

/**
 * Render a compact token bar with a sparkline showing recent usage history.
 *
 * The first line is the normal compact bar. When a tracker is provided and
 * has data, a second line shows a token sparkline:
 *
 *   [████░░░░  22%]
 *   ▂▃▅▆▇██▆▅▄▃▂
 *
 * @returns ANSI-escaped multi-line string. Falls back to the compact bar
 *          alone when no tracker or no history is available.
 */
export function renderTokenBarWithHistory(
  used: number,
  limit: number,
  tracker?: TokenUsageTracker,
  width?: number,
): string {
  const barWidth = width ? Math.min(20, Math.max(8, Math.floor(width / 4))) : 10;
  const bar = renderCompactTokenBar(used, limit, barWidth);
  if (!tracker) return bar;

  const history = tracker.getHistory();
  if (history.length === 0) return bar;

  const sparkWidth = Math.min(24, Math.max(4, (width ?? 30) - 2));
  const sparkline = renderTokenSparkline(history, sparkWidth);
  if (!sparkline) return bar;

  return `${bar}\n${sparkline}`;
}

/**
 * Get color function for a utilization tier.
 * Useful for components that want to color their own display.
 */
export function utilizationColorFn(tier: UtilizationTier): (text: string) => string {
  switch (tier) {
    case UtilizationTier.Critical:
      return error;
    case UtilizationTier.High:
      return warning;
    case UtilizationTier.Moderate:
      return info;
    default:
      return success;
  }
}

// Re-export for external use
export { UtilizationTier, classifyUtilization };

// ── Helpers ─────────────────────────────────────────────────────────────────────

function buildBar(used: number, limit: number, width: number, tier: UtilizationTier): string {
  const ratio = Math.min(1, Math.max(0, used / Math.max(1, limit)));
  const totalSteps = width * 8; // 8 sub-steps per character
  const filledSteps = Math.round(ratio * totalSteps);
  const fullChars = Math.floor(filledSteps / 8);
  const partialIdx = filledSteps % 8;

  let bar = '';
  for (let i = 0; i < fullChars; i++) {
    bar += '█';
  }
  if (partialIdx > 0 && fullChars < width) {
    bar += BAR_CHARS[partialIdx]!;
  }
  const remaining = width - fullChars - (partialIdx > 0 ? 1 : 0);
  for (let i = 0; i < remaining; i++) {
    bar += ' ';
  }

  // Color by tier
  const colorFn = utilizationColorFn(tier);
  return colorFn(bar);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function formatElapsedCompact(ms: number): string {
  if (ms < 1000) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
