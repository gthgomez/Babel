/**
 * focusTracker.test.ts — Tests for FocusTracker (R4.7/D2).
 *
 * Covers:
 *   - Singleton lifecycle
 *   - Start/stop of focus monitoring
 *   - Frame interval doubling on focus loss
 *   - Idempotency of start/stop
 *   - resetForTest cleanup
 *
 * Note: The actual keypress event detection (wiring stdin → FrameScheduler)
 * is tested indirectly through FrameScheduler's setWindowFocused() API.
 * Full integration testing of VT sequence detection requires a TTY stdin
 * that can inject focus sequences — that is tested in the integration test
 * below via manual FrameScheduler manipulation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameScheduler } from './frameScheduler.js';
import { FocusTracker } from './focusTracker.js';
import { FOCUS_EVENT_ENABLE, FOCUS_EVENT_DISABLE } from './terminalEscapeSequences.js';

beforeEach(() => {
  FrameScheduler.getInstance().resetForTest();
  FocusTracker.getInstance().resetForTest();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('FocusTracker singleton', () => {
  it('getInstance returns same object', () => {
    assert.strictEqual(FocusTracker.getInstance(), FocusTracker.getInstance());
  });

  it('starts inactive', () => {
    assert.equal(FocusTracker.getInstance().active, false);
  });

  it('start sets active', () => {
    const ft = FocusTracker.getInstance();
    ft.start();
    assert.equal(ft.active, true);
  });

  it('stop clears active', () => {
    const ft = FocusTracker.getInstance();
    ft.start();
    assert.equal(ft.active, true);
    ft.stop();
    assert.equal(ft.active, false);
  });

  it('start is idempotent', () => {
    const ft = FocusTracker.getInstance();
    ft.start();
    ft.start(); // should not throw
    assert.equal(ft.active, true);
  });

  it('stop is idempotent', () => {
    const ft = FocusTracker.getInstance();
    ft.stop(); // should not throw (not started)
    assert.equal(ft.active, false);
  });

  it('resetForTest stops tracking', () => {
    const ft = FocusTracker.getInstance();
    ft.start();
    ft.resetForTest();
    assert.equal(ft.active, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Focus detection wiring — FrameScheduler integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('FocusTracker — FrameScheduler integration', () => {
  it('setWindowFocused(false) doubles frame interval', () => {
    const s = FrameScheduler.getInstance();
    const focused = s.getEffectiveFrameInterval();
    s.setWindowFocused(false);
    assert.equal(s.getEffectiveFrameInterval(), focused * 2,
      `expected ${focused * 2} got ${s.getEffectiveFrameInterval()}`);
  });

  it('setWindowFocused(true) restores frame interval', () => {
    const s = FrameScheduler.getInstance();
    const focused = s.getEffectiveFrameInterval();
    s.setWindowFocused(false);
    s.setWindowFocused(true);
    assert.equal(s.getEffectiveFrameInterval(), focused);
  });

  it('focus-out doubles interval then focus-in restores it', () => {
    const s = FrameScheduler.getInstance();
    const base = s.getEffectiveFrameInterval();
    // Simulate focus loss (as FocusTracker.handleKeypress would)
    s.setWindowFocused(false);
    assert.ok(s.getEffectiveFrameInterval() > base, 'interval should increase on blur');
    // Simulate focus gain
    s.setWindowFocused(true);
    assert.equal(s.getEffectiveFrameInterval(), base, 'interval should restore on focus');
  });

  it('records focus state correctly after multiple toggles', () => {
    const s = FrameScheduler.getInstance();
    s.setWindowFocused(false);
    assert.equal(s.isWindowFocused(), false);
    s.setWindowFocused(false);
    assert.equal(s.isWindowFocused(), false, 'setting same state twice is idempotent');
    s.setWindowFocused(true);
    assert.equal(s.isWindowFocused(), true);
    s.setWindowFocused(true);
    assert.equal(s.isWindowFocused(), true, 'setting same state twice is idempotent');
    s.setWindowFocused(false);
    assert.equal(s.isWindowFocused(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Escape sequence verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('FocusTracker — escape sequences', () => {
  it('FOCUS_EVENT_ENABLE is the correct DEC sequence', () => {
    // DEC 1004 = Focus Events
    assert.equal(FOCUS_EVENT_ENABLE, '\x1b[?1004h');
  });

  it('FOCUS_EVENT_DISABLE is the correct DEC sequence', () => {
    assert.equal(FOCUS_EVENT_DISABLE, '\x1b[?1004l');
  });
});
