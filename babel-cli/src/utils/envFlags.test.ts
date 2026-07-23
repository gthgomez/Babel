import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isBabelHeadlessEnv, isFalsyEnvFlag, isTruthyEnvFlag } from './envFlags.js';

describe('envFlags', () => {
  test('isTruthyEnvFlag accepts common truthy forms', () => {
    assert.equal(isTruthyEnvFlag('1'), true);
    assert.equal(isTruthyEnvFlag('true'), true);
    assert.equal(isTruthyEnvFlag('TRUE'), true);
    assert.equal(isTruthyEnvFlag('yes'), true);
    assert.equal(isTruthyEnvFlag('on'), true);
    assert.equal(isTruthyEnvFlag('0'), false);
    assert.equal(isTruthyEnvFlag('false'), false);
    assert.equal(isTruthyEnvFlag(''), false);
    assert.equal(isTruthyEnvFlag(undefined), false);
  });

  test('isFalsyEnvFlag accepts common falsy forms', () => {
    assert.equal(isFalsyEnvFlag('0'), true);
    assert.equal(isFalsyEnvFlag('false'), true);
    assert.equal(isFalsyEnvFlag('FALSE'), true);
    assert.equal(isFalsyEnvFlag('off'), true);
    assert.equal(isFalsyEnvFlag('OFF'), true);
    assert.equal(isFalsyEnvFlag('no'), true);
    assert.equal(isFalsyEnvFlag('NO'), true);
    assert.equal(isFalsyEnvFlag('1'), false);
    assert.equal(isFalsyEnvFlag('true'), false);
    assert.equal(isFalsyEnvFlag(''), false);
    assert.equal(isFalsyEnvFlag(undefined), false);
    assert.equal(isFalsyEnvFlag(null), false);
  });

  test('isBabelHeadlessEnv accepts BABEL_HEADLESS=true (not only 1)', () => {
    assert.equal(isBabelHeadlessEnv({ BABEL_HEADLESS: 'true' }), true);
    assert.equal(isBabelHeadlessEnv({ BABEL_HEADLESS: '1' }), true);
    assert.equal(isBabelHeadlessEnv({ CI: 'true' }), true);
    assert.equal(isBabelHeadlessEnv({ CI: '1' }), true);
    assert.equal(isBabelHeadlessEnv({}), false);
    assert.equal(isBabelHeadlessEnv({ BABEL_HEADLESS: '0' }), false);
  });
});
