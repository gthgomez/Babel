/**
 * backgroundTaskOverlay.ts — Function-based bridge from BackgroundTaskRegistry
 * to the renderBackgroundTaskProgress panel renderer.
 *
 * This is a stateless function-based renderer (matching the existing pattern in
 * renderers.ts / timeline.ts / tables.ts). It is NOT a Component subclass and
 * does NOT own a rendering loop. The caller invokes it on each render tick and
 * writes the returned string (or handles the null case) as appropriate.
 *
 * @module backgroundTaskOverlay
 */

import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { toTaskState, renderBackgroundTaskProgress } from './backgroundTaskProgress.js';
import { getEffectiveTerminalWidth } from './theme.js';

/**
 * Render the expanded background-task progress panel, or return null when
 * there are no active background tasks.
 *
 * @param width  Available render width in characters (defaults to terminal width).
 * @returns ANSI-styled multi-line string, or null if no tasks are active.
 */
export function renderBackgroundTaskOverlay(width?: number): string | null {
  const tasks = backgroundTaskRegistry.getAllTasks();
  const activeCount = tasks.filter((t) => t.status === 'running').length;
  if (activeCount === 0) return null;

  const w = width ?? getEffectiveTerminalWidth();
  const states = tasks.map((t) => toTaskState(t));

  // Use compact mode when more than 3 tasks are running to avoid wasting
  // vertical space on full progress bars.
  return renderBackgroundTaskProgress(states, w, activeCount <= 3);
}
