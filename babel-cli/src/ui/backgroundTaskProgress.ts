/**
 * Background task progress renderer — per-task progress bars and spinners.
 *
 * Provides two rendering modes:
 *   - `renderBackgroundTaskFooter`: compact single-line for the status bar
 *   - `renderBackgroundTaskProgress`: expanded multi-line for a progress panel
 *
 * Uses theme colors from ./theme.js and follows the same visual language as
 * AgentProgressPane in agentProgress.ts.
 *
 * @module backgroundTaskProgress
 */

import type { BackgroundTask } from '../services/backgroundTaskRegistry.js';
import { accent, dim, muted, success, error, ghost, bold, visibleLength } from './theme.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Static spinner character for running tasks in one-shot renders. */
const RUNNING_SPINNER = '◌'; // ◌
const COMPLETED_MARK = '✓'; // ✓
const FAILED_MARK = '✗'; // ✗

/** Progress bar width in characters. */
const PROGRESS_BAR_WIDTH = 10;

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackgroundTaskState {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  /** Progress percentage 0–100, undefined = indeterminate. */
  progress?: number;
  total?: number;
  current?: number;
  elapsedMs?: number;
  errorMessage?: string;
}

// ── Converters ─────────────────────────────────────────────────────────────

/** Convert a registry BackgroundTask to a render-ready BackgroundTaskState. */
export function toTaskState(task: BackgroundTask): BackgroundTaskState {
  const state: BackgroundTaskState = {
    id: task.id,
    label: task.label,
    status: task.status,
    elapsedMs: Date.now() - task.startedAt,
  };
  if (task.error !== undefined) {
    state.errorMessage = task.error;
  }
  if (task.progress !== undefined && task.progress.total > 0) {
    state.current = task.progress.current;
    state.total = task.progress.total;
    state.progress = Math.round((task.progress.current / task.progress.total) * 100);
  }
  return state;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a count for fixed-width display — no locale commas that cause layout jitter. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * Render a determinate progress bar.
 *
 *   [██████░░░░]  60%
 *
 * The bar fills from left to right as pct goes from 0 to 100.
 */
function renderProgressBar(pct: number, barWidth: number): string {
  const filled = Math.round((barWidth * pct) / 100);
  const empty = barWidth - filled;
  const filledPart = filled > 0 ? accent('█'.repeat(filled)) : '';
  const emptyPart = empty > 0 ? ghost('░'.repeat(empty)) : '';
  return filledPart + emptyPart;
}

/**
 * Render an indeterminate (shimmer-style) progress bar.
 *
 * Uses a scrolling-wave effect via half-block density progression.
 * At any point in time, the bar shows a gradient from dim to accent to dim,
 * simulating a sweep animation.
 */
function renderIndeterminateBar(barWidth: number, tick: number = 0): string {
  // Create a smooth wave: dim → accent → dim across the bar width
  const chars: string[] = [];
  const wavePos = tick % (barWidth * 2);
  for (let i = 0; i < barWidth; i++) {
    const dist = Math.abs(i - (wavePos < barWidth ? wavePos : barWidth * 2 - wavePos));
    if (dist <= 1) {
      chars.push(accent('░'));
    } else if (dist <= 3) {
      chars.push(ghost('░'));
    } else {
      chars.push(muted('░'));
    }
  }
  return chars.join('');
}

// ── Public Renderers ───────────────────────────────────────────────────────

/**
 * Render a compact single-line footer for the status bar.
 *
 * Format examples:
 *   ◌ Indexing 45%  567/1,234 files
 *   ◌ Scanning...
 *   ✓ Indexing  12.3s
 *   ✗ Indexing  disk full
 *   ◌ Indexing 45%  +2 more
 *
 * Returns an empty string when `tasks` is empty.
 * The returned string is fully ANSI-styled — no further wrapping needed.
 */
export function renderBackgroundTaskFooter(tasks: BackgroundTaskState[], width: number): string {
  if (tasks.length === 0) return '';

  const first = tasks[0]!;
  const parts: string[] = [];

  // Status indicator
  if (first.status === 'running') {
    parts.push(accent(RUNNING_SPINNER));
    parts.push(first.label);

    if (first.progress !== undefined) {
      // Determinate
      parts.push(dim(`${first.progress}%`));
      if (first.current !== undefined && first.total !== undefined) {
        const frac = `${formatCount(first.current)}/${formatCount(first.total)}`;
        parts.push(muted(frac));
      }
    } else {
      // Indeterminate — show ellipsis to indicate activity
      parts.push(dim('...'));
    }
  } else if (first.status === 'completed') {
    parts.push(success(COMPLETED_MARK));
    parts.push(dim(first.label));
    if (first.elapsedMs !== undefined) {
      parts.push(muted(formatDuration(first.elapsedMs)));
    }
  } else if (first.status === 'failed') {
    parts.push(error(FAILED_MARK));
    parts.push(dim(first.label));
    if (first.errorMessage) {
      parts.push(error(first.errorMessage));
    }
  }

  // Trailing " +N more" for overflow
  if (tasks.length > 1) {
    parts.push(ghost(`+${tasks.length - 1} more`));
  }

  let line = parts.join(' ');

  // Truncate gracefully if the line exceeds the allotted width
  if (visibleLength(line) > width) {
    // Strategy: drop the "rest" parts first, then truncate the label if still too long
    const spinner = parts[0]!;
    let label = parts[1]!;
    const rest = parts.slice(2).join(' ');
    const labelLen = visibleLength(label);
    const spinnerLen = visibleLength(spinner);

    // How much room after spinner?
    const roomForLabel = Math.max(8, width - spinnerLen - 2);

    if (labelLen > roomForLabel) {
      // Truncate the label itself
      const shortLabel = [...label].slice(0, Math.max(1, roomForLabel - 1)).join('') + '…';
      label = dim(shortLabel);
    }

    // Re-check with truncated label + rest
    const stLabelLen = visibleLength(label);
    const availableForRest = Math.max(0, width - spinnerLen - stLabelLen - 2);
    const shortRest =
      availableForRest < 4 ? '' : visibleLength(rest) > availableForRest ? dim('...') : rest;

    line = `${spinner} ${label}${shortRest ? ` ${shortRest}` : ''}`;
  }

  return line;
}

/**
 * Render expanded multi-line progress for a progress panel.
 *
 * Each task occupies one or two lines:
 *   ◌ Indexing  [████░░░░░░] 45%  567/1,234 files  12.3s
 *   ◌ Scanning  ░░░░░░░░░░ wave                 5.2s
 *   ✓ Indexing  completed                       15.3s
 *   ✗ Indexing  Error: disk full
 *
 * When `expanded` is false, renders a compact single-line summary per task
 * (label + percent only).
 *
 * @param tasks   Task states to render
 * @param width   Available width in characters
 * @param expanded  Full detail vs compact (default: true)
 * @returns ANSI-styled multi-line string
 */
export function renderBackgroundTaskProgress(
  tasks: BackgroundTaskState[],
  width: number,
  expanded: boolean = true,
): string {
  if (tasks.length === 0) return '';

  const lines: string[] = [];

  for (const task of tasks) {
    const indicator =
      task.status === 'running'
        ? accent(RUNNING_SPINNER)
        : task.status === 'completed'
          ? success(COMPLETED_MARK)
          : error(FAILED_MARK);

    const label = bold(task.label);

    if (expanded) {
      if (task.status === 'running' && task.progress !== undefined) {
        // Determinate — show progress bar
        const bar = renderProgressBar(task.progress, PROGRESS_BAR_WIDTH);
        const pct = dim(`${task.progress}%`);
        const frac =
          task.current !== undefined && task.total !== undefined
            ? muted(`${task.current.toLocaleString()}/${task.total.toLocaleString()}`)
            : '';
        const elapsed = task.elapsedMs !== undefined ? muted(formatDuration(task.elapsedMs)) : '';
        const meta = [bar, pct, frac, elapsed].filter(Boolean).join('  ');
        lines.push(`${indicator} ${label}  ${meta}`);
      } else if (task.status === 'running') {
        // Indeterminate
        const bar = renderIndeterminateBar(PROGRESS_BAR_WIDTH);
        const elapsed = task.elapsedMs !== undefined ? muted(formatDuration(task.elapsedMs)) : '';
        lines.push(`${indicator} ${label}  ${bar}  ${elapsed}`);
      } else if (task.status === 'completed') {
        const elapsed = task.elapsedMs !== undefined ? muted(formatDuration(task.elapsedMs)) : '';
        lines.push(`${indicator} ${label}  ${dim('completed')}  ${elapsed}`);
      } else if (task.status === 'failed') {
        const msg = task.errorMessage ? error(`Error: ${task.errorMessage}`) : error('failed');
        lines.push(`${indicator} ${label}  ${msg}`);
      }
    } else {
      // Compact mode: one line per task
      if (task.status === 'running') {
        const pct = task.progress !== undefined ? dim(`${task.progress}%`) : dim('...');
        lines.push(`${indicator} ${label}  ${pct}`);
      } else if (task.status === 'completed') {
        const elapsed = task.elapsedMs !== undefined ? muted(formatDuration(task.elapsedMs)) : '';
        lines.push(`${indicator} ${label}  ${dim('done')}  ${elapsed}`);
      } else if (task.status === 'failed') {
        const msg = task.errorMessage ?? 'failed';
        lines.push(`${indicator} ${label}  ${error(msg)}`);
      }
    }
  }

  return lines.join('\n');
}
