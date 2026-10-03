/** Pure window-lifecycle decisions. Electron stays in main.mjs. */

/** Grace after cancel so the 1.5s process-tree kill can finish. */
export const CLOSE_GRACE_MS = 3500;

/**
 * @param {{ busy?: boolean, closing?: boolean }} state
 * @returns {'close' | 'cancel-then-close'}
 */
export function decideWindowClose(state) {
  if (state?.closing) return 'close';
  if (state?.busy) return 'cancel-then-close';
  return 'close';
}

/** The last window always ends the process, including during a run. */
export function decideLastWindow() {
  return 'quit';
}
