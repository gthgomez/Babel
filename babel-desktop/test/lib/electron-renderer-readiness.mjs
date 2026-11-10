// License: Apache-2.0
/**
 * Wait until the built renderer has loaded and the native handshake reports Ready.
 * Use before page.evaluate or viewport assertions that race first navigation (Windows CI).
 */
export async function waitForDesktopRendererReady(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => {
    const text = document.querySelector('#main-status')?.textContent;
    return Boolean(text && text !== 'Connecting');
  });
  await page.waitForFunction(() => document.querySelector('#main-status')?.textContent === 'Ready');
}
