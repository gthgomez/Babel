// License: Apache-2.0 — see LICENSE
// Actual built renderer with explicitly doubled native API. This is not installed proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

async function renderer(diagnostics, body, handshake = 'ready') {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(({diagnostics, handshake}) => {
      window.__runs = [];
      window.__info = {packaged: true, ready: true, officialCliReady: true, projectName: 'fixture-project', diagnostics};
      window.babelDesktop = {
        getInfo: async () => {
          if (handshake === 'rejected') throw new Error('Fixture handshake rejected');
          if (handshake === 'pending') await new Promise(resolve => {window.__resolveInfo = resolve;});
          return window.__info;
        },
        refreshDiagnostics: async () => window.__info,
        listDirectory: async () => [{name: 'README.md', type: 'file'}],
        listSessions: async () => ({sessions: [{id: 'history', title: 'Saved history fixture'}], total: 1}),
        readProviderRoute: async () => ({provider:'openrouter',model:'fixture-openrouter'}),
        openSession: async (id, {olderOffset = 0} = {}) => {
          const end = Math.max(0, 160 - olderOffset);
          const start = Math.max(0, end - 150);
          return {id, messages: Array.from({length: end - start}, (_, index) => ({role: (start + index) % 2 ? 'assistant' : 'user', text: `message-${start + index}`, status: 'unverified'})),
            history: {totalMessages: 160, messageLimit: 150, olderOffset, hasOlder: start > 0, windowStart: start}};
        },
        run: async request => {window.__runs.push(request); return {started: false};},
        onEvent() {},
      };
    }, {diagnostics, handshake});
    await page.setContent(html);
    if (handshake === 'ready') await page.waitForFunction(()=>!document.querySelector('#status-detail').textContent.includes('Connecting'));
    await body(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function connect(page) {
  if(await page.locator('#dialog[open]').count())await page.locator('#dialog [data-action="use-live"]').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#preview-badge').innerText(),'BABEL CLI');
}

async function blockedSubmissions(page) {
  await page.locator('#composer-input').fill('Read project documentation');
  await page.keyboard.press('Control+Enter');
  await page.locator('#composer-form').evaluate(form => form.requestSubmit());
  assert.equal(await page.evaluate(() => window.__runs.length), 0);
  assert.equal(await page.locator('.user-message').count(), 0);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
}

test('packaged connection permits latest → older → latest history with failed Docker diagnostics', async () => {
  await renderer({ready: false, docker: 'unavailable'}, async page => {
    await connect(page);
    await page.locator('button.session-button', {hasText: 'Saved history fixture'}).click();
    const conversation = page.locator('#conversation');
    await conversation.getByText('message-159', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-9', {exact: true}).count(), 0);
    await page.locator('[data-action="load-older-messages"]').click();
    await conversation.getByText('message-9', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-159', {exact: true}).count(), 0);
    await page.locator('[data-action="load-latest-messages"]').click();
    await conversation.getByText('message-159', {exact: true}).waitFor();
    assert.equal(await conversation.getByText('message-9', {exact: true}).count(), 0);
    assert.equal(await page.locator('#send-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__runs.length), 0);
  });
});

for (const [name, diagnostics] of [['missing', undefined], ['failed', {ready: false, docker: 'unavailable'}]]) {
  test(`packaged ${name} diagnostics block keyboard and form submissions before and after connection`, async () => {
    await renderer(diagnostics, async page => {
      await blockedSubmissions(page);
      await page.locator('#dialog [data-action="close-dialog"]').click();
      await page.locator('#preview-badge').click();
      await connect(page);
      await blockedSubmissions(page);
    });
  });
}

test('healthy packaged diagnostics enter the real harness automatically', async () => {
  await renderer({ready: true, docker: 'available'}, async page => {
    await connect(page);
    assert.equal(await page.locator('#send-button').isEnabled(), true);
    await page.locator('#composer-input').fill('Read project documentation');
    await page.keyboard.press('Control+Enter');
    await page.getByText('Run was not started. No model call was made.', {exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.__runs[0].mode), 'chat');
  });
});

for (const handshake of ['pending', 'rejected']) {
  test(`native ${handshake} handshake blocks synthetic preview submissions`, async () => {
    await renderer({ready: true, docker: 'available'}, async page => {
      await page.locator('#composer-input').fill('Read project documentation');
      const count = await page.locator('.user-message').count();
      await page.keyboard.press('Control+Enter');
      await page.locator('#composer-form').evaluate(form => form.requestSubmit());
      assert.equal(await page.locator('.user-message').count(), count);
      assert.equal(await page.locator('#send-button').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__runs.length), 0);
      if (handshake === 'pending') {
        await page.evaluate(() => window.__resolveInfo());
        await page.waitForFunction(()=>!document.querySelector('#send-button').disabled);
        assert.equal(await page.evaluate(()=>window.__runs.length),0);
      }
    }, handshake);
  });
}

test('refreshing diagnostics after connection revokes renderer execution admission', async () => {
  await renderer({ready: true, docker: 'available'}, async page => {
    await connect(page);
    await page.evaluate(() => {window.__info.diagnostics = {ready: false, docker: 'unavailable'};});
    await page.locator('#preview-badge').click();
    await page.locator('#dialog [data-action="refresh-diagnostics"]').click();
    await page.waitForFunction(() => document.querySelector('#send-button').disabled);
    await page.locator('#dialog [data-action="close-dialog"]').click();
    await blockedSubmissions(page);
  });
});
