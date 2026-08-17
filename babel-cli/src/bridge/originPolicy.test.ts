import assert from 'node:assert/strict';
import { test } from 'node:test';
import { originAllowed } from './originPolicy.js';

const loopback = ['http://127.0.0.1', 'http://localhost'];

test('allows loopback ports when policy lists host without port', () => {
  assert.equal(originAllowed('http://localhost:4545', loopback), true);
  assert.equal(originAllowed('http://127.0.0.1:9999', loopback), true);
});

test('denies lookalike hosts and schemes', () => {
  assert.equal(originAllowed('http://localhost.evil.example:4545', loopback), false);
  assert.equal(originAllowed('http://localhost@evil.example:4545', loopback), false);
  assert.equal(originAllowed('https://localhost:4545', loopback), false);
  assert.equal(originAllowed('http://127.0.0.1.evil.example', loopback), false);
  assert.equal(originAllowed('not-a-url', loopback), false);
  assert.equal(originAllowed('null', loopback), false);
});

test('missing Origin is fail-closed off loopback and allowed on loopback CLI', () => {
  assert.equal(originAllowed(undefined, loopback, '8.8.8.8'), false);
  assert.equal(originAllowed(undefined, loopback, '127.0.0.1'), true);
});
