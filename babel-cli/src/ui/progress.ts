import { renderBadge } from './badges.js';
import { accentBright, muted } from './theme.js';
import { SpinnerRenderer } from './spinner.js';

const FRAMES = ['◴', '◷', '◶', '◵'];

export interface ProgressLabelOptions {
  status?: string;
  frameIndex?: number;
  timestamp?: string;
}

/**
 * Pure frame renderer — stable API, callers supply frameIndex.
 * Used directly by renderers and by createProgressSpinner internally.
 */
export function renderProgressLabel(text: string, options: ProgressLabelOptions = {}): string {
  const status = options.status ?? 'ACTIVE';
  const frame = FRAMES[Math.abs(options.frameIndex ?? 0) % FRAMES.length]!;
  const timestamp = options.timestamp ? `${muted(options.timestamp)} ` : '';
  return `${timestamp}${accentBright(frame)} ${renderBadge(status)} ${text}`;
}

/**
 * Live animated spinner backed by SpinnerRenderer.
 * Hides the cursor for the duration and restores it on stop().
 */
export function createProgressSpinner(
  text: string,
  options: ProgressLabelOptions = {},
): SpinnerRenderer {
  const spinner = new SpinnerRenderer({
    frames: FRAMES,
    interval: 80,
    stream: process.stdout,
    format: (frame: string, label: string): string => {
      const timestamp = options.timestamp ? `${muted(options.timestamp)} ` : '';
      return `${timestamp}${accentBright(frame)} ${renderBadge(options.status ?? 'ACTIVE')} ${label}`;
    },
  });
  spinner.setText(text);
  return spinner;
}
