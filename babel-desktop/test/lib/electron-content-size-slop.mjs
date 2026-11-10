// License: Apache-2.0
/** CSS-pixel slack after native setContentSize when devicePixelRatio is not exactly 1. */
export function electronContentSizeSlack(devicePixelRatio) {
  if (typeof devicePixelRatio !== 'number' || !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new TypeError('devicePixelRatio must be a positive finite number');
  }
  if (Math.abs(devicePixelRatio - 1) < 0.001) return 1;
  return Math.max(2, Math.ceil(3 / devicePixelRatio));
}

/** Returns true when innerWidth/innerHeight are within slack of the requested content size. */
export function contentSizeMatches({ width, height, innerWidth, innerHeight, devicePixelRatio }) {
  const slack = electronContentSizeSlack(devicePixelRatio);
  return Math.abs(innerWidth - width) <= slack && Math.abs(innerHeight - height) <= slack;
}

/**
 * Renderer-side slack (must match electronContentSizeSlack). Duplicated in empty-state Electron
 * waitForFunction to avoid page.evaluate during first navigation on Windows CI.
 */
export function electronContentSizeSlackInPage(devicePixelRatio) {
  if (Math.abs(devicePixelRatio - 1) < 0.001) return 1;
  return Math.max(2, Math.ceil(3 / devicePixelRatio));
}
