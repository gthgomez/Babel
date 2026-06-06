import logUpdate from 'log-update';
import { renderBadge } from './badges.js';
import { accentBright, muted } from './theme.js';

const FRAMES = ['◴', '◷', '◶', '◵'];

/**
 * Pure frame renderer — stable API, callers supply frameIndex.
 * Used directly by renderers and by createProgressSpinner internally.
 */
export function renderProgressLabel(text, options = {}) {
    const status = options.status ?? 'ACTIVE';
    const frame = FRAMES[Math.abs(options.frameIndex ?? 0) % FRAMES.length];
    const timestamp = options.timestamp ? `${muted(options.timestamp)} ` : '';
    return `${timestamp}${accentBright(frame)} ${renderBadge(status)} ${text}`;
}

/**
 * Live animated spinner backed by log-update.
 * Hides the cursor for the duration and restores it on stop().
 *
 * @example
 * const spinner = createProgressSpinner('Planning…');
 * spinner.start();
 * // … async work …
 * spinner.stop(renderProgressLabel('Planning', { status: 'PASS' }));
 *
 * @param {string} text        Label shown next to the spinner.
 * @param {object} [options]   Forwarded to renderProgressLabel (status, timestamp).
 * @returns {{ start: () => void, stop: (finalLine?: string) => void }}
 */
export function createProgressSpinner(text, options = {}) {
    let frame = 0;
    let timer = null;

    const start = () => {
        process.stdout.write('\u001B[?25l'); // hide cursor
        timer = setInterval(() => {
            logUpdate(renderProgressLabel(text, { ...options, frameIndex: frame++ }));
        }, 80);
    };

    const stop = (finalLine = '') => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        logUpdate.done(); // persist the last frame, move to next line
        if (finalLine) {
            process.stdout.write(finalLine + '\n');
        }
        process.stdout.write('\u001B[?25h'); // show cursor
    };

    return { start, stop };
}
