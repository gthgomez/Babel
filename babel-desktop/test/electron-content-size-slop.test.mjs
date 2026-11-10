// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contentSizeMatches,
  electronContentSizeSlack,
} from './lib/electron-content-size-slop.mjs';

test('integer devicePixelRatio keeps one CSS pixel of slack', () => {
  assert.equal(electronContentSizeSlack(1), 1);
  assert.ok(electronContentSizeSlack(2) >= 1);
  assert.ok(contentSizeMatches({
    width: 1200,
    height: 680,
    innerWidth: 1201,
    innerHeight: 681,
    devicePixelRatio: 1,
  }));
});

test('fractional devicePixelRatio on Linux CI allows bounded rounding (regression)', () => {
  const dpr = 0.984375;
  const slack = electronContentSizeSlack(dpr);
  assert.equal(slack, 4);
  assert.ok(contentSizeMatches({
    width: 1200,
    height: 680,
    innerWidth: 1203,
    innerHeight: 683,
    devicePixelRatio: dpr,
  }));
  assert.equal(contentSizeMatches({
    width: 1200,
    height: 680,
    innerWidth: 1205,
    innerHeight: 685,
    devicePixelRatio: dpr,
  }), false);
});
