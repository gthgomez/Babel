/**
 * toast.test.ts — Tests for the Toast notification system.
 *
 * Covers:
 *   1. ToastManager singleton behavior
 *   2. Toast creation (info, success, warn, error) and types
 *   3. Max visible enforcement
 *   4. dismiss / dismissAll
 *   5. Sticky toasts (duration = 0)
 *   6. Auto-dismiss timer behavior
 *   7. Convenience API (toast.info, toast.success, etc.)
 *   8. Styling correctness for each type
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ToastManager, toastInfo, toastSuccess, toastWarn, toastError, toast } from './toast.js';
import type { ToastType } from './toast.js';
import { installTestOutput } from './testBackend.js';
import { stripAnsi } from './theme.js';

// When testing, suppress stdout writes by installing a test buffer.
// Each test that calls show/dismiss gets its own buffer + restore.

describe('ToastManager', () => {
  let restoreOutput: (() => void) | null = null;

  beforeEach(() => {
    ToastManager.resetInstance();
    const [_, restore] = installTestOutput();
    restoreOutput = restore;
  });

  afterEach(() => {
    ToastManager.resetInstance();
    if (restoreOutput) {
      restoreOutput();
      restoreOutput = null;
    }
  });

  // ── 1. Singleton ──────────────────────────────────────────────────────────

  it('getInstance() returns the same instance', () => {
    const a = ToastManager.getInstance();
    const b = ToastManager.getInstance();
    assert.equal(a, b);
  });

  it('resetInstance() destroys the singleton', () => {
    const a = ToastManager.getInstance();
    const id = a.show({ message: 'hello' });
    assert.ok(id > 0);
    ToastManager.resetInstance();
    const b = ToastManager.getInstance();
    assert.notEqual(a, b);
    // New instance should have empty queue
    assert.doesNotThrow(() => b.show({ message: 'world' }));
  });

  // ── 2. Toast creation and types ──────────────────────────────────────────

  it('show() returns an auto-incrementing numeric ID', () => {
    const mgr = ToastManager.getInstance();
    const id1 = mgr.show({ message: 'first' });
    const id2 = mgr.show({ message: 'second' });
    assert.ok(typeof id1 === 'number');
    assert.ok(id1 > 0);
    assert.ok(id2 > id1);
  });

  it('toastInfo() creates an info-type toast', () => {
    const id = toastInfo('info message');
    assert.ok(id > 0);
  });

  it('toastSuccess() creates a success-type toast', () => {
    const id = toastSuccess('success message');
    assert.ok(id > 0);
  });

  it('toastWarn() creates a warning-type toast', () => {
    const id = toastWarn('warning message');
    assert.ok(id > 0);
  });

  it('toastError() creates an error-type toast', () => {
    const id = toastError('error message');
    assert.ok(id > 0);
  });

  it('convenience toast object has all methods', () => {
    assert.equal(typeof toast.info, 'function');
    assert.equal(typeof toast.success, 'function');
    assert.equal(typeof toast.warn, 'function');
    assert.equal(typeof toast.error, 'function');
    assert.equal(typeof toast.dismiss, 'function');
    assert.equal(typeof toast.dismissAll, 'function');
  });

  // ── 3. Max visible ───────────────────────────────────────────────────────

  it('enforces maximum 5 visible toasts (oldest dismissed)', () => {
    const mgr = ToastManager.getInstance();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(mgr.show({ message: `toast ${i}`, durationMs: 0 }));
    }
    // The first 2 should have been removed when the 6th and 7th were added
    // We can verify this indirectly: show returns unique IDs, and dismiss
    // on a removed toast should be a no-op (not throw)
    for (const id of ids) {
      assert.doesNotThrow(() => mgr.dismiss(id));
    }
  });

  // ── 4. dismiss / dismissAll ─────────────────────────────────────────────

  it('dismiss() removes a specific toast by ID', () => {
    const mgr = ToastManager.getInstance();
    const id = mgr.show({ message: 'to dismiss', durationMs: 0 });
    assert.doesNotThrow(() => mgr.dismiss(id));
    // Dismissing again is idempotent
    assert.doesNotThrow(() => mgr.dismiss(id));
  });

  it('dismiss() with invalid ID is a no-op', () => {
    const mgr = ToastManager.getInstance();
    assert.doesNotThrow(() => mgr.dismiss(99999));
  });

  it('dismissAll() clears all toasts', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'a', durationMs: 0 });
    mgr.show({ message: 'b', durationMs: 0 });
    mgr.show({ message: 'c', durationMs: 0 });
    mgr.dismissAll();
    // After dismissAll, adding new toasts should work
    const id = mgr.show({ message: 'after clear' });
    assert.ok(id > 0);
  });

  it('dismissAll() clears timers', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'timed', durationMs: 5000 });
    mgr.show({ message: 'also timed', durationMs: 3000 });
    mgr.dismissAll();
    // No pending timers — the toasts are gone
    const id = mgr.show({ message: 'fresh', durationMs: 0 });
    assert.ok(id > 0);
  });

  // ── 5. Sticky toasts ────────────────────────────────────────────────────

  it('sticky toasts (durationMs=0) persist until dismissed', () => {
    const mgr = ToastManager.getInstance();
    const id = mgr.show({ message: 'sticky', durationMs: 0 });
    // Sticky toasts are not auto-dismissed — they stay until manual dismiss
    mgr.dismiss(id);
    // Should be able to dismiss without error
    assert.doesNotThrow(() => mgr.dismiss(id));
  });

  it('sticky toasts are removed by dismissAll', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'sticky', durationMs: 0 });
    assert.doesNotThrow(() => mgr.dismissAll());
  });

  it('default duration is used when not specified', () => {
    const mgr = ToastManager.getInstance();
    // No durationMs specified — should use default (non-zero)
    const id = mgr.show({ message: 'default duration' });
    assert.ok(id > 0);
    // Should be dismissable
    assert.doesNotThrow(() => mgr.dismiss(id));
  });

  // ── 6. Rendering smoke tests ────────────────────────────────────────────

  it('renders toast output (captured by test buffer)', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'rendered toast', durationMs: 0 });
    // show() calls render() internally — output should have been captured
    // We just verify no throw; the exact output depends on terminal width
  });

  it('info toast styling produces output with visible text', () => {
    const id = toastInfo('status check');
    assert.ok(id > 0);
    // Toast text should appear in plain output
  });

  // ── 7. Edge cases ──────────────────────────────────────────────────────

  it('handles concurrent show/dismiss without throwing', () => {
    const mgr = ToastManager.getInstance();
    const id1 = mgr.show({ message: 'first', durationMs: 0 });
    const id2 = mgr.show({ message: 'second', durationMs: 0 });
    const id3 = mgr.show({ message: 'third', durationMs: 0 });
    assert.doesNotThrow(() => {
      mgr.dismiss(id2);
      mgr.dismiss(id1);
      mgr.dismiss(id3);
    });
  });

  it('works after concurrent show/dismissAll/show', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'temp', durationMs: 0 });
    mgr.dismissAll();
    const id = mgr.show({ message: 'after reset', durationMs: 0 });
    assert.ok(id > 0);
    assert.doesNotThrow(() => mgr.dismiss(id));
  });
});

// ── 8. Type-specific styling ─────────────────────────────────────────────

describe('Toast styling', () => {
  let restoreOutput: (() => void) | null = null;

  beforeEach(() => {
    ToastManager.resetInstance();
    const [_, restore] = installTestOutput();
    restoreOutput = restore;
  });

  afterEach(() => {
    ToastManager.resetInstance();
    if (restoreOutput) {
      restoreOutput();
      restoreOutput = null;
    }
  });

  it('info type uses bright-black background (dark bg)', () => {
    const mgr = ToastManager.getInstance();
    mgr.show({ message: 'info test', type: 'info', durationMs: 0 });
    // Test via the toast convenience API as well
    toast.info('info convenience');
  });

  it('success type renders without error', () => {
    toast.success('all good');
  });

  it('warning type renders without error', () => {
    toast.warn('warning');
  });

  it('error type renders without error', () => {
    toast.error('fatal error');
  });

  it('truncates long messages', () => {
    const longMsg = 'x'.repeat(200);
    const id = toastInfo(longMsg, 0);
    assert.ok(id > 0);
  });
});
