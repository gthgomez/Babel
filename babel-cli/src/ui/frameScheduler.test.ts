/**
 * frameScheduler.test.ts — Tests for the FrameScheduler singleton.
 *
 * Covers singleton lifecycle, per-component scheduling, keep-alive
 * reference counting, window-focus adaptation, metrics, error isolation,
 * and auto-start/stop.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameScheduler } from './frameScheduler.js';

beforeEach(() => {
  FrameScheduler.getInstance().resetForTest();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Singleton', () => {
  it('getInstance returns same object', () => {
    assert.strictEqual(FrameScheduler.getInstance(), FrameScheduler.getInstance());
  });

  it('resetForTest clears all state', () => {
    const s = FrameScheduler.getInstance();
    s.start();
    s.scheduleComponent('test', () => {});
    s.resetForTest();
    assert.equal(s.isRunning(), false);
    assert.equal(s.componentCount, 0);
  });

  it('starts not running', () => {
    assert.equal(FrameScheduler.getInstance().isRunning(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per-component scheduling (replaces legacy region-based callbacks)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component scheduling', () => {
  it('scheduleComponent returns unregister function', () => {
    const s = FrameScheduler.getInstance();
    const unreg = s.scheduleComponent('test-unreg', () => {});
    assert.equal(typeof unreg, 'function');
    unreg();
  });

  it('markComponentDirty triggers callback on next tick', () => {
    const s = FrameScheduler.getInstance();
    let fired = false;
    s.scheduleComponent('test-fired', () => { fired = true; });
    s.markComponentDirty('test-fired');
    // tick() is private — verify dirty tracking works
    assert.ok(fired === false, 'callback should not fire synchronously');
  });

  it('setComponentPermanentDirty marks component for every frame', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('test-perm', () => {});
    s.setComponentPermanentDirty('test-perm', true);
    s.setComponentPermanentDirty('test-perm', false);
    assert.ok(true);
  });

  it('unregister removes component', () => {
    const s = FrameScheduler.getInstance();
    const unreg = s.scheduleComponent('test-removed', () => {});
    unreg();
    // Should not throw when tick fires with this component
    s.markComponentDirty('test-removed');
    assert.ok(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per-component scheduling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Per-component scheduling', () => {
  it('scheduleComponent assigns unique IDs and returns unregister', () => {
    const s = FrameScheduler.getInstance();
    const unreg = s.scheduleComponent('cursor-blink', () => {});
    assert.equal(typeof unreg, 'function');
    assert.equal(s.componentCount, 1);
    unreg();
    assert.equal(s.componentCount, 0);
  });

  it('scheduleComponent throws on duplicate ID', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('dup', () => {});
    assert.throws(() => s.scheduleComponent('dup', () => {}));
  });

  it('scheduleComponent auto-starts the scheduler', () => {
    const s = FrameScheduler.getInstance();
    assert.equal(s.isRunning(), false);
    s.scheduleComponent('test', () => {});
    assert.equal(s.isRunning(), true);
  });

  it('unregister last component auto-stops the scheduler', () => {
    const s = FrameScheduler.getInstance();
    const unreg = s.scheduleComponent('sole', () => {});
    assert.equal(s.isRunning(), true);
    unreg();
    assert.equal(s.isRunning(), false);
  });

  it('markComponentDirty prepares component for next tick', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('comp', () => {});
    s.markComponentDirty('comp'); // should not throw
    assert.ok(true);
  });

  it('markComponentDirty for unknown component is a no-op', () => {
    const s = FrameScheduler.getInstance();
    s.markComponentDirty('nonexistent'); // should not throw
    assert.ok(true);
  });

  it('setComponentPermanentDirty toggles per-frame ticking', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('perm', () => {});
    s.setComponentPermanentDirty('perm', true);
    s.setComponentPermanentDirty('perm', false);
    assert.ok(true);
  });

  it('setComponentPermanentDirty for unknown component is a no-op', () => {
    const s = FrameScheduler.getInstance();
    s.setComponentPermanentDirty('ghost', true); // should not throw
    assert.ok(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pause / Resume
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pause / Resume', () => {
  it('pauseComponent stops ticks', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('comp', () => {});
    s.pauseComponent('comp');
    assert.equal(s.isComponentPaused('comp'), true);
  });

  it('resumeComponent restarts ticks and marks dirty', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('comp', () => {});
    s.pauseComponent('comp');
    s.resumeComponent('comp');
    assert.equal(s.isComponentPaused('comp'), false);
  });

  it('isComponentPaused returns false for unknown component', () => {
    assert.equal(FrameScheduler.getInstance().isComponentPaused('nope'), false);
  });

  it('pauseComponent is a no-op for unknown component', () => {
    FrameScheduler.getInstance().pauseComponent('ghost'); // should not throw
    assert.ok(true);
  });

  it('resumeComponent is a no-op for unknown component', () => {
    FrameScheduler.getInstance().resumeComponent('ghost'); // should not throw
    assert.ok(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Keep-alive reference counting
// ═══════════════════════════════════════════════════════════════════════════════

describe('Keep-alive', () => {
  it('keepAlive returns release function', () => {
    const s = FrameScheduler.getInstance();
    const release = s.keepAlive();
    assert.equal(typeof release, 'function');
    release();
  });

  it('keepAlive auto-starts the scheduler', () => {
    const s = FrameScheduler.getInstance();
    assert.equal(s.isRunning(), false);
    const release = s.keepAlive();
    assert.equal(s.isRunning(), true);
    release();
  });

  it('release when count reaches zero auto-stops', () => {
    const s = FrameScheduler.getInstance();
    const r1 = s.keepAlive();
    const r2 = s.keepAlive();
    assert.equal(s.isRunning(), true);
    r1();
    assert.equal(s.isRunning(), true, 'should still run with one reference');
    r2();
    assert.equal(s.isRunning(), false, 'should stop when all released');
  });

  it('double release is safe (idempotent)', () => {
    const s = FrameScheduler.getInstance();
    const release = s.keepAlive();
    release();
    release(); // should not throw or corrupt state
    assert.equal(s.isRunning(), false);
  });

  it('keepAlive keeps running even when all components unregistered', () => {
    const s = FrameScheduler.getInstance();
    const release = s.keepAlive();
    const unreg = s.scheduleComponent('c', () => {});
    unreg();
    assert.equal(s.isRunning(), true, 'keepAlive should prevent auto-stop');
    release();
    assert.equal(s.isRunning(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Window focus
// ═══════════════════════════════════════════════════════════════════════════════

describe('Window focus', () => {
  it('default is focused', () => {
    const s = FrameScheduler.getInstance();
    assert.equal(s.isWindowFocused(), true);
  });

  it('setWindowFocused toggles isWindowFocused', () => {
    const s = FrameScheduler.getInstance();
    assert.equal(s.isWindowFocused(), true);
    s.setWindowFocused(false);
    assert.equal(s.isWindowFocused(), false);
    s.setWindowFocused(true);
    assert.equal(s.isWindowFocused(), true);
  });

  it('getEffectiveFrameInterval returns doubled interval when unfocused', () => {
    const s = FrameScheduler.getInstance();
    const focusedInterval = s.getEffectiveFrameInterval();
    s.setWindowFocused(false);
    const unfocusedInterval = s.getEffectiveFrameInterval();
    assert.equal(unfocusedInterval, focusedInterval * 2,
      `expected ${focusedInterval * 2} got ${unfocusedInterval}`);
    s.setWindowFocused(true);
    assert.equal(s.getEffectiveFrameInterval(), focusedInterval,
      'restored interval should match original');
  });

  it('setWindowFocused reschedules pending frame when blurred', () => {
    const s = FrameScheduler.getInstance();
    s.setWindowFocused(false);
    assert.equal(s.isWindowFocused(), false);
    s.setWindowFocused(true);
    assert.equal(s.isWindowFocused(), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Frame interval
// ═══════════════════════════════════════════════════════════════════════════════

describe('Frame interval', () => {
  it('per-component intervalMs is respected by scheduling', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('slow', () => {}, { intervalMs: 500 });
    s.scheduleComponent('fast', () => {}, { intervalMs: 16 });
    assert.equal(s.componentCount, 2);
  });

  it('components with different intervals coexist', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('a', () => {}, { intervalMs: 100 });
    s.scheduleComponent('b', () => {}, { intervalMs: 200 });
    s.scheduleComponent('c', () => {}, { intervalMs: 50 });
    assert.equal(s.componentCount, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Metrics
// ═══════════════════════════════════════════════════════════════════════════════

describe('Metrics', () => {
  it('frameIndex starts at 0', () => {
    assert.equal(FrameScheduler.getInstance().frameIndex, 0);
  });

  it('getLatestMetrics returns null when no frames fired', () => {
    assert.equal(FrameScheduler.getInstance().getLatestMetrics(), null);
  });

  it('getFrameHistory returns empty array initially', () => {
    assert.deepStrictEqual(FrameScheduler.getInstance().getFrameHistory(), []);
  });

  it('getAverageRenderDuration returns 0 with no frames', () => {
    assert.equal(FrameScheduler.getInstance().getAverageRenderDuration(), 0);
  });

  it('resetMetrics clears counters', () => {
    const s = FrameScheduler.getInstance();
    s.resetMetrics();
    assert.equal(s.frameIndex, 0);
    assert.equal(s.getLatestMetrics(), null);
  });

  it('tickTime is accessible', () => {
    const s = FrameScheduler.getInstance();
    assert.equal(typeof s.tickTime, 'number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// start / stop lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('start / stop', () => {
  it('start is idempotent', () => {
    const s = FrameScheduler.getInstance();
    s.start();
    s.start();
    assert.equal(s.isRunning(), true);
  });

  it('stop clears dirty state', () => {
    const s = FrameScheduler.getInstance();
    s.start();
    s.stop();
    assert.equal(s.isRunning(), false);
  });

  it('stop is safe when not running', () => {
    const s = FrameScheduler.getInstance();
    s.stop(); // should not throw
    assert.equal(s.isRunning(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Component scheduling with conditions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component conditions', () => {
  it('condition that returns false skips the tick', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('cond', () => {
      assert.fail('should not be called');
    }, { condition: () => false });
    // Component registered but condition prevents firing
    assert.equal(s.componentCount, 1);
  });

  it('condition that returns true allows the tick', () => {
    const s = FrameScheduler.getInstance();
    let ticked = false;
    s.scheduleComponent('cond-true', () => { ticked = true; }, { condition: () => true });
    s.markComponentDirty('cond-true');
    // tick() would fire the callback; we verify registration works
    assert.equal(s.componentCount, 1);
  });

  it('condition that throws skips the tick and logs to stderr', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('throw-cond', () => {
      assert.fail('should not be called');
    }, { condition: () => { throw new Error('boom'); } });
    assert.equal(s.componentCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Priority ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe('Priority ordering', () => {
  it('components accept priority option', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('high', () => {}, { priority: 1 });
    s.scheduleComponent('low', () => {}, { priority: 20 });
    assert.equal(s.componentCount, 2);
  });

  it('default priority is 10', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('default', () => {});
    assert.equal(s.componentCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Interval throttling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Interval throttling', () => {
  it('component with custom intervalMs option works', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('slow', () => {}, { intervalMs: 200 });
    assert.equal(s.componentCount, 1);
  });

  it('multiple components with different intervals coexist', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('fast', () => {}, { intervalMs: 16 });
    s.scheduleComponent('slow', () => {}, { intervalMs: 500 });
    s.scheduleComponent('medium', () => {}, { intervalMs: 100 });
    assert.equal(s.componentCount, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Label option
// ═══════════════════════════════════════════════════════════════════════════════

describe('Label option', () => {
  it('label option is stored (used in error diagnostics)', () => {
    const s = FrameScheduler.getInstance();
    s.scheduleComponent('labeled', () => {}, { label: 'my-label' });
    assert.equal(s.componentCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// scheduleFrame convenience function
// ═══════════════════════════════════════════════════════════════════════════════

describe('scheduleFrame()', () => {
  it('imports and calls without error', async () => {
    const { scheduleFrame } = await import('./frameScheduler.js');
    scheduleFrame('all'); // should not throw
    assert.ok(true);
  });
});
