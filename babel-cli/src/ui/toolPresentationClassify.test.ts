/**
 * does X when Y tests for blocked vs failed presentation classification.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyToolPresentation,
  isBlockedDetail,
  isKnownFailureDetail,
} from './toolPresentationClassify.js';

describe('classifyToolPresentation', () => {
  it('does treat plan-gate blocked as warning not failure when exitCode is fabricated', () => {
    const cls = classifyToolPresentation({
      detail: 'plan-gate',
      error: 'blocked',
      exitCode: 1,
    });
    assert.equal(cls.isBlocked, true);
    assert.equal(cls.isFailure, false);
    assert.equal(cls.tone, 'warning');
    assert.equal(cls.status, 'blocked');
    assert.equal(cls.availability, 'blocked');
    assert.notEqual(cls.tone, 'error');
  });

  it('does treat hard-plan-mode detail-only as blocked without inventing failure', () => {
    const cls = classifyToolPresentation({ detail: 'hard-plan-mode' });
    assert.equal(cls.isBlocked, true);
    assert.equal(cls.isFailure, false);
    assert.equal(cls.isSuccess, false);
    assert.equal(cls.tone, 'warning');
  });

  it('does treat actual nonzero execution as failure', () => {
    const cls = classifyToolPresentation({
      detail: 'exit 1',
      error: 'Command failed with exit code 1',
      exitCode: 1,
    });
    assert.equal(cls.isFailure, true);
    assert.equal(cls.isBlocked, false);
    assert.equal(cls.tone, 'error');
    assert.equal(cls.status, 'failure');
  });

  it('does treat exit 0 without error as success', () => {
    const cls = classifyToolPresentation({ exitCode: 0 });
    assert.equal(cls.isSuccess, true);
    assert.equal(cls.tone, 'success');
    assert.equal(cls.status, 'success');
  });

  it('does keep missing exit and missing error as unknown', () => {
    const cls = classifyToolPresentation({ detail: 'line 10' });
    assert.equal(cls.status, 'unknown');
    assert.equal(cls.tone, 'muted');
    assert.equal(cls.isFailure, false);
    assert.equal(cls.isBlocked, false);
  });

  it('does treat platform_unusable as unavailable warning not execution failure', () => {
    const cls = classifyToolPresentation({
      detail: 'platform_unusable',
      error: 'platform_unusable',
      exitCode: 1,
    });
    assert.equal(cls.availability, 'unavailable');
    assert.equal(cls.isFailure, false);
    assert.equal(cls.tone, 'warning');
  });
});

describe('isKnownFailureDetail', () => {
  it('does not classify blocked as failure', () => {
    assert.equal(isKnownFailureDetail('blocked'), false);
    assert.equal(isKnownFailureDetail('plan-gate'), false);
    assert.equal(isKnownFailureDetail('hard-plan-mode'), false);
    assert.equal(isKnownFailureDetail('phase-gate'), false);
  });

  it('does classify actual failure details as failure', () => {
    assert.equal(isKnownFailureDetail('failed'), true);
    assert.equal(isKnownFailureDetail('error'), true);
    assert.equal(isKnownFailureDetail('exit 1'), true);
    assert.equal(isKnownFailureDetail('exit 0'), false);
  });
});

describe('isBlockedDetail', () => {
  it('does recognize policy block details', () => {
    assert.equal(isBlockedDetail('blocked'), true);
    assert.equal(isBlockedDetail('plan-gate'), true);
    assert.equal(isBlockedDetail('failed'), false);
  });
});
