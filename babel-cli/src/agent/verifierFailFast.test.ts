import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatPlatformVerifierUnusableObservation,
  isFatalWindowsProcessExit,
  toUnsignedExitCode,
} from './verifierFailFast.js';

describe('verifierFailFast', () => {
  test('recognizes A06 DLL_INIT_FAILED exit', () => {
    assert.equal(isFatalWindowsProcessExit(3221225794), true);
  });

  test('recognizes signed NTSTATUS form', () => {
    // 0xC0000142 as signed int32
    const signed = 0xc0000142 | 0;
    assert.equal(isFatalWindowsProcessExit(signed), true);
    assert.equal(toUnsignedExitCode(signed), 3221225794);
  });

  test('does not treat normal test failures as fatal', () => {
    assert.equal(isFatalWindowsProcessExit(0), false);
    assert.equal(isFatalWindowsProcessExit(1), false);
    assert.equal(isFatalWindowsProcessExit(2), false);
    assert.equal(isFatalWindowsProcessExit(4), false);
    assert.equal(isFatalWindowsProcessExit(null), false);
  });

  test('observation tells model not to re-run', () => {
    const obs = formatPlatformVerifierUnusableObservation(
      'test_run',
      'python tests/runtests.py ...',
      3221225794,
    );
    assert.match(obs, /PLATFORM_VERIFIER_UNUSABLE/);
    assert.match(obs, /Do NOT re-run/);
    assert.match(obs, /0xC0000142/i);
  });
});
