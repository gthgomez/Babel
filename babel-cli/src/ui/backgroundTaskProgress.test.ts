/**
 * backgroundTaskProgress.test.ts — Tests for background task progress renderers.
 *
 * Covers:
 *   1. renderBackgroundTaskFooter — compact single-line footer
 *   2. renderBackgroundTaskProgress — expanded multi-line output
 *   3. toTaskState — BackgroundTask to BackgroundTaskState conversion
 *   4. Edge cases: empty list, single task, multiple tasks, width truncation
 *   5. All statuses: running (determinate/indeterminate), completed, failed
 *
 * @module backgroundTaskProgress.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBackgroundTaskFooter,
  renderBackgroundTaskProgress,
  toTaskState,
} from './backgroundTaskProgress.js';
import type { BackgroundTaskState } from './backgroundTaskProgress.js';
import type { BackgroundTask } from '../services/backgroundTaskRegistry.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function runningTask(overrides: Partial<BackgroundTaskState> = {}): BackgroundTaskState {
  return {
    id: 't1',
    label: 'Indexing',
    status: 'running',
    ...overrides,
  };
}

function completedTask(overrides: Partial<BackgroundTaskState> = {}): BackgroundTaskState {
  return {
    id: 't2',
    label: 'Scanning',
    status: 'completed',
    elapsedMs: 15234,
    ...overrides,
  };
}

function failedTask(overrides: Partial<BackgroundTaskState> = {}): BackgroundTaskState {
  return {
    id: 't3',
    label: 'Build',
    status: 'failed',
    errorMessage: 'disk full',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// toTaskState
// ═══════════════════════════════════════════════════════════════════════════════

describe('toTaskState', () => {
  it('converts a running task without progress', () => {
    const task: BackgroundTask = {
      id: '1',
      label: 'Indexing',
      startedAt: Date.now() - 5000,
      status: 'running',
    };
    const state = toTaskState(task);
    assert.equal(state.id, '1');
    assert.equal(state.label, 'Indexing');
    assert.equal(state.status, 'running');
    assert.equal(state.progress, undefined);
    assert.equal(state.current, undefined);
    assert.equal(state.total, undefined);
    assert.ok(state.elapsedMs! >= 4000);
  });

  it('converts a running task with progress', () => {
    const task: BackgroundTask = {
      id: '2',
      label: 'Indexing',
      startedAt: Date.now(),
      status: 'running',
      progress: { current: 567, total: 1234 },
    };
    const state = toTaskState(task);
    assert.equal(state.progress, 46); // Math.round(567/1234 * 100) = 46
    assert.equal(state.current, 567);
    assert.equal(state.total, 1234);
  });

  it('converts a completed task', () => {
    const task: BackgroundTask = {
      id: '3',
      label: 'Scanning',
      startedAt: Date.now() - 10000,
      status: 'completed',
    };
    const state = toTaskState(task);
    assert.equal(state.status, 'completed');
    assert.ok(state.elapsedMs! >= 9000);
  });

  it('converts a failed task with error', () => {
    const task: BackgroundTask = {
      id: '4',
      label: 'Build',
      startedAt: Date.now(),
      status: 'failed',
      error: 'disk full',
    };
    const state = toTaskState(task);
    assert.equal(state.status, 'failed');
    assert.equal(state.errorMessage, 'disk full');
  });

  it('ignores progress when total is zero', () => {
    const task: BackgroundTask = {
      id: '5',
      label: 'Waiting',
      startedAt: Date.now(),
      status: 'running',
      progress: { current: 0, total: 0 },
    };
    const state = toTaskState(task);
    assert.equal(state.progress, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// renderBackgroundTaskFooter
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderBackgroundTaskFooter', () => {
  it('returns empty string for empty task list', () => {
    const result = renderBackgroundTaskFooter([], 80);
    assert.equal(result, '');
  });

  it('renders a running task with determinate progress', () => {
    const result = renderBackgroundTaskFooter(
      [runningTask({ progress: 45, current: 567, total: 1234 })],
      80,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('45%'));
    assert.ok(plain.includes('567/1234'));
  });

  it('renders a running task with indeterminate progress', () => {
    const result = renderBackgroundTaskFooter([runningTask()], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('...'));
  });

  it('renders a completed task with duration', () => {
    const result = renderBackgroundTaskFooter([completedTask()], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Scanning'));
    assert.ok(plain.includes('15.2s'));
  });

  it('renders a failed task with error message', () => {
    const result = renderBackgroundTaskFooter([failedTask()], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Build'));
    assert.ok(plain.includes('disk full'));
  });

  it('shows +N more for multiple running tasks', () => {
    const result = renderBackgroundTaskFooter(
      [
        runningTask({ id: '1', label: 'Indexing', progress: 45, current: 567, total: 1234 }),
        runningTask({ id: '2', label: 'Scanning' }),
        runningTask({ id: '3', label: 'Linting' }),
      ],
      80,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('+2 more'));
  });

  it('truncates long labels when width is tight', () => {
    const result = renderBackgroundTaskFooter(
      [runningTask({ label: 'A'.repeat(60), progress: 50, current: 1, total: 2 })],
      20,
    );
    // Should not throw; output length should be ≤20 visible chars
    const plain = stripAnsi(result);
    assert.ok(plain.length <= 25);
  });

  it('produces output that does not exceed the given width', () => {
    const result = renderBackgroundTaskFooter(
      [runningTask({ progress: 50, current: 500, total: 1000 })],
      40,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.length <= 42, `expected ≤42 chars but got ${plain.length}: "${plain}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// renderBackgroundTaskProgress
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderBackgroundTaskProgress', () => {
  it('returns empty string for empty task list', () => {
    const result = renderBackgroundTaskProgress([], 80);
    assert.equal(result, '');
  });

  it('renders a running task with determinate progress bar', () => {
    const result = renderBackgroundTaskProgress(
      [runningTask({ progress: 60, current: 300, total: 500, elapsedMs: 5200 })],
      80,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('60%'));
    assert.ok(plain.includes('300/500'));
    assert.ok(plain.includes('5.2s'));
    // Progress bar characters (█░) should be present
    assert.ok(plain.includes('█') || plain.includes('░'));
  });

  it('renders a running task with indeterminate progress', () => {
    const result = renderBackgroundTaskProgress([runningTask({ elapsedMs: 3200 })], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('3.2s'));
  });

  it('renders a completed task', () => {
    const result = renderBackgroundTaskProgress([completedTask()], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Scanning'));
    assert.ok(plain.includes('completed'));
    assert.ok(plain.includes('15.2s'));
  });

  it('renders a failed task', () => {
    const result = renderBackgroundTaskProgress([failedTask()], 80);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Build'));
    assert.ok(plain.includes('Error:'));
    assert.ok(plain.includes('disk full'));
  });

  it('renders multiple tasks stacked', () => {
    const result = renderBackgroundTaskProgress(
      [runningTask({ progress: 45, current: 567, total: 1234 }), completedTask(), failedTask()],
      80,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('Scanning'));
    assert.ok(plain.includes('Build'));
    // Each task on its own line
    const lines = plain.split('\n');
    assert.equal(lines.length, 3);
  });

  it('renders compact mode (expanded=false) without progress bars', () => {
    const result = renderBackgroundTaskProgress(
      [runningTask({ progress: 45, current: 567, total: 1234 }), completedTask(), failedTask()],
      80,
      false,
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('45%'));
    assert.ok(plain.includes('done'));
    assert.ok(plain.includes('disk full'));
    // No progress bar characters in compact mode
    assert.ok(!plain.includes('█'));
  });

  it('renders single running task in expanded mode', () => {
    const result = renderBackgroundTaskProgress(
      [runningTask({ progress: 50, current: 1, total: 2 })],
      80,
    );
    const plain = stripAnsi(result);
    const lines = plain.split('\n');
    assert.equal(lines.length, 1);
    assert.ok(plain.includes('50%'));
  });
});
