import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPrivateNetworkAddress,
  parseDuckDuckGoHtml,
} from './webContext.js';

test('parseDuckDuckGoHtml extracts result links and decodes redirect targets', () => {
  const html = [
    '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example &amp; Docs</a>',
    '<a class="result__a" href="https://example.org/guide">Guide</a>',
  ].join('\n');

  const results = parseDuckDuckGoHtml(html, 5);

  assert.deepEqual(results, [
    { title: 'Example & Docs', url: 'https://example.com/docs' },
    { title: 'Guide', url: 'https://example.org/guide' },
  ]);
});

test('parseDuckDuckGoHtml respects max result limit', () => {
  const html = [
    '<a class="result__a" href="https://one.example">One</a>',
    '<a class="result__a" href="https://two.example">Two</a>',
  ].join('\n');

  const results = parseDuckDuckGoHtml(html, 1);

  assert.deepEqual(results, [
    { title: 'One', url: 'https://one.example/' },
  ]);
});

test('isPrivateNetworkAddress blocks localhost and private ranges', () => {
  assert.equal(isPrivateNetworkAddress('127.0.0.1'), true);
  assert.equal(isPrivateNetworkAddress('10.2.3.4'), true);
  assert.equal(isPrivateNetworkAddress('172.20.1.1'), true);
  assert.equal(isPrivateNetworkAddress('192.168.1.5'), true);
  assert.equal(isPrivateNetworkAddress('169.254.1.5'), true);
  assert.equal(isPrivateNetworkAddress('::1'), true);
  assert.equal(isPrivateNetworkAddress('fd00::1'), true);
  assert.equal(isPrivateNetworkAddress('::'), true);
  assert.equal(isPrivateNetworkAddress('ff02::1'), true);
  assert.equal(isPrivateNetworkAddress('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateNetworkAddress('0:0:0:0:0:ffff:192.168.1.1'), true);
  assert.equal(isPrivateNetworkAddress('::ffff:c0a8:101'), true);
  assert.equal(isPrivateNetworkAddress('8.8.8.8'), false);
  assert.equal(isPrivateNetworkAddress('2001:4860:4860::8888'), false);
});
