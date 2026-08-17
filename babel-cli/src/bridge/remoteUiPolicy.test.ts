import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { appendTranscriptEvent, htmlLooksUnsafeForInnerHtml } from './remoteUiRender.js';
import { shouldCacheRemoteUiRequest } from './remoteUiCachePolicy.js';
import { remoteUiFileForPath } from './remoteUiAssets.js';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'remote-ui');

describe('remote UI policy and assets', () => {
  it('service worker policy never caches runtime or auth paths', () => {
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/ui/app.js' }), true);
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/rpc', method: 'POST' }), false);
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/rpc' }), false);
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/ws' }), false);
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/ws/ticket' }), false);
    assert.equal(shouldCacheRemoteUiRequest({ pathname: '/sessions' }), false);
    assert.equal(
      shouldCacheRemoteUiRequest({ pathname: '/ui/app.js', hasAuthorization: true }),
      false,
    );
  });

  it('renders untrusted HTML as text nodes, not innerHTML', () => {
    const children: unknown[] = [];
    const target = {
      textContent: '',
      appendChild(node: unknown) {
        children.push(node);
        return node;
      },
    };
    const doc = {
      createElement(tag: string) {
        const el = {
          nodeType: 1,
          className: '',
          textContent: '',
          children: [] as unknown[],
          setAttribute() {},
          appendChild(node: unknown) {
            this.children.push(node);
            return node;
          },
        };
        void tag;
        return el;
      },
      createTextNode(text: string) {
        return { nodeType: 3, textContent: text };
      },
    };
    appendTranscriptEvent(
      target,
      { type: 'answer_chunk', text: '<img src=x onerror=alert(1)>' },
      doc,
    );
    assert.equal(children.length, 1);
    assert.equal(htmlLooksUnsafeForInnerHtml('<script>alert(1)</script>'), true);
  });

  it('serves the product PWA shell without ALLOW_SESSION or query bearer construction', () => {
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    const app = readFileSync(join(uiDir, 'app.js'), 'utf8');
    const sw = readFileSync(join(uiDir, 'sw.js'), 'utf8');
    assert.match(html, /ALLOW ONCE/);
    assert.match(html, /DENY/);
    assert.doesNotMatch(html, /ALLOW_SESSION/);
    assert.match(html, /host-state/);
    assert.match(html, /composer/);
    assert.match(app, /ticket=/);
    assert.doesNotMatch(app, /token=/);
    assert.doesNotMatch(app, /localStorage/);
    assert.doesNotMatch(app, /indexedDB/i);
    assert.match(sw, /\/rpc/);
    assert.match(sw, /NETWORK_ONLY/);
    assert.ok(remoteUiFileForPath('/ui'));
    assert.equal(remoteUiFileForPath('/rpc'), null);
  });

  it('loads UI scripts in a browser-like environment without Node module/require', () => {
    const sandbox: Record<string, unknown> = {
      window: {},
      document: {
        getElementById: () => ({
          value: '',
          disabled: false,
          classList: { toggle() {} },
          textContent: '',
          onclick: null,
        }),
        createElement: () => ({
          className: '',
          setAttribute() {},
          appendChild() {},
        }),
        createTextNode: (t: string) => ({ textContent: t }),
      },
      location: { protocol: 'http:', host: '127.0.0.1:4545' },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      navigator: {},
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    };
    sandbox['window'] = sandbox;
    sandbox['globalThis'] = sandbox;
    const context = vm.createContext(sandbox);
    for (const file of ['state.js', 'render.js']) {
      const code = readFileSync(join(uiDir, file), 'utf8');
      assert.doesNotMatch(code, /\brequire\s*\(/);
      assert.doesNotMatch(code, /\bmodule\.exports\b/);
      vm.runInContext(code, context, { filename: file });
    }
    const state = sandbox['BabelRemoteState'] as { apply: (m: string, from: string, ev: string) => string };
    assert.equal(state.apply('host', 'UNKNOWN', 'start'), 'CONNECTING');
  });
});
