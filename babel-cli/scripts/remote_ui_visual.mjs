#!/usr/bin/env node
/**
 * Deterministic browser harness for the Remote PWA.
 *
 * Screenshots are review artifacts, not committed golden images. The same
 * scenario data, timestamps, IDs, and viewport names are used on every run.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = resolve(process.env.BABEL_REMOTE_UI_ARTIFACT_DIR || join(packageRoot, '..', 'artifacts', 'remote-ui'));
const taskTemp = join(packageRoot, '..', 'tmp', 'remote-ui-playwright');
mkdirSync(taskTemp, { recursive: true });
process.env.TEMP = taskTemp;
process.env.TMP = taskTemp;

const { chromium } = await import('playwright');
const { REMOTE_UI_FIXTURE_SCENARIOS, startRemoteUiFixtureServer } = await import('../dist/bridge/remoteUiFixture.js');

const viewports = [
  { id: 'narrow-320', width: 320, height: 568 },
  { id: 'phone-360', width: 360, height: 800 },
  { id: 'phone-384', width: 384, height: 854 },
  { id: 'phone-390', width: 390, height: 844 },
  { id: 'phone-412', width: 412, height: 915 },
  { id: 'phone-430', width: 430, height: 932 },
  { id: 'tablet-800', width: 800, height: 1280 },
  { id: 'desktop-1440', width: 1440, height: 900 },
  { id: 'keyboard-short-390', width: 390, height: 420 },
  { id: 'landscape-844', width: 844, height: 390 },
];

const screenshotScenarios = [
  'disconnected', 'connected-idle', 'running', 'long-transcript',
  'approval-required', 'changed-files', 'large-diff', 'verification-pass',
  'verification-failure', 'connection-lost', 'reconnecting', 'reconnected',
  'long-prompt',
];

const layoutScenarios = new Set(['connected-idle', 'approval-required', 'long-transcript', 'large-diff', 'long-prompt']);

function scenarioById(id) {
  const scenario = REMOTE_UI_FIXTURE_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `fixture scenario exists: ${id}`);
  return scenario;
}

async function assertResponsiveInvariants(page, scenarioId, viewport) {
  const result = await page.evaluate(() => {
    const visible = (selector) => [...document.querySelectorAll(selector)].filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    });
    const rectangles = (selector) => visible(selector).map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    });
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sections: rectangles('main > section'),
      buttons: rectangles('button'),
      composer: rectangles('#composer'),
      status: rectangles('#host-state, #thread-state, #turn-state'),
      approvalVisible: visible('#approval-card').length > 0,
      fixture: Boolean(window.BabelRemoteApp && window.BabelRemoteApp.fixture),
    };
  });
  assert.equal(result.fixture, true, `${scenarioId}/${viewport.id}: fixture mode is explicit`);
  assert.ok(result.documentWidth <= result.viewportWidth + 1, `${scenarioId}/${viewport.id}: no horizontal document overflow (${result.documentWidth} > ${result.viewportWidth})`);
  assert.ok(result.sections.every((box) => box.width > 0 && box.height > 0), `${scenarioId}/${viewport.id}: critical sections have size`);
  assert.ok(result.buttons.every((box) => box.height >= 40 && box.right <= result.viewportWidth + 1), `${scenarioId}/${viewport.id}: visible buttons are usable and in viewport`);
  assert.ok(result.composer.length === 1 && result.composer[0].width > 0, `${scenarioId}/${viewport.id}: composer is present and measurable`);
  assert.ok(result.status.every((box) => box.width > 0 && box.height > 0), `${scenarioId}/${viewport.id}: status indicators are visible`);
  if (scenarioId === 'approval-required') assert.equal(result.approvalVisible, true, `${scenarioId}: approval is prominent`);
}

async function run() {
  const fixture = await startRemoteUiFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    const matrix = [];
    for (const viewport of viewports) matrix.push({ scenarioId: 'connected-idle', viewport, capture: true });
    for (const scenarioId of screenshotScenarios) matrix.push({ scenarioId, viewport: viewports.find(({ id }) => id === 'phone-390'), capture: true });
    for (const scenarioId of ['approval-required', 'long-transcript', 'large-diff']) {
      for (const viewport of [viewports[0], viewports[7]]) matrix.push({ scenarioId, viewport, capture: true });
    }

    for (const item of matrix) {
      const scenario = scenarioById(item.scenarioId);
      const context = await browser.newContext({ viewport: { width: item.viewport.width, height: item.viewport.height } });
      await context.setOffline(false);
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      const externalRequests = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('requestfailed', (request) => failedRequests.push(request.url()));
      page.on('request', (request) => { if (!request.url().startsWith(new URL(fixture.url).origin)) externalRequests.push(request.url()); });
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(`${fixture.url}?scenario=${encodeURIComponent(scenario.id)}`, { waitUntil: 'networkidle' });
        await page.locator('#host-state').waitFor();
        await assertResponsiveInvariants(page, scenario.id, item.viewport);
        if (scenario.id === 'long-prompt') {
          await page.locator('#composer').evaluate((element) => { element.value = 'x'.repeat(10000); });
          await assertResponsiveInvariants(page, scenario.id + '-unbroken', item.viewport);
        }
        const outputPath = join(artifactRoot, scenario.id, `${item.viewport.id}.png`);
        mkdirSync(resolve(outputPath, '..'), { recursive: true });
        await page.screenshot({ path: outputPath, fullPage: true, animations: 'disabled' });
        if (scenario.id === 'approval-required') {
          await page.getByRole('button', { name: 'Allow once' }).click();
          await assert.equal(await page.locator('#approval-card').isHidden(), true, 'approval action resolves locally in fixture mode');
        }
        if (scenario.id === 'connected-idle' && item.viewport.id === 'phone-390') {
          await page.evaluate(() => { document.documentElement.style.fontSize = '125%'; });
          await assertResponsiveInvariants(page, 'connected-idle-text-zoom', item.viewport);
        }
        assert.deepEqual(consoleErrors, [], `${scenario.id}/${item.viewport.id}: no console errors`);
        assert.deepEqual(pageErrors, [], `${scenario.id}/${item.viewport.id}: no uncaught page errors`);
        assert.deepEqual(failedRequests, [], `${scenario.id}/${item.viewport.id}: no failed asset requests`);
        assert.deepEqual(externalRequests, [], `${scenario.id}/${item.viewport.id}: fixture made no external requests`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      } finally {
        await context.close();
      }
    }
    if (failures.length) throw new Error(`Remote UI visual harness failed:\n${failures.join('\n')}`);
    console.log(`[remote-ui] passed ${matrix.length} deterministic browser checks`);
    console.log(`[remote-ui] screenshots: ${artifactRoot}`);
    console.log(`[remote-ui] scenarios: ${screenshotScenarios.join(', ')}`);
  } finally {
    await browser.close();
    await fixture.close();
  }
}

await run();
