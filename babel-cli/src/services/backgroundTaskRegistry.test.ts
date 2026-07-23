/**
 * backgroundTaskRegistry.test.ts — Tests for the BackgroundTaskRegistry singleton.
 *
 * Covers:
 *   1. register() returns a task ID and creates a task with correct fields
 *   2. updateProgress() updates current/total
 *   3. complete() marks task as completed
 *   4. fail() marks task as failed with optional error
 *   5. getActiveTasks() filters to only running tasks
 *   6. getAllTasks() includes recently completed/failed before auto-cleanup
 *   7. subscribe() fires callback on register/update/complete/fail with full snapshot
 *   8. unsubscribe() stops the callback from firing
 *   9. Auto-cleanup removes completed tasks after 5s, failed after 10s
 *  10. Edge cases: updateProgress on unknown ID, complete on already-completed task
 *
 * @module backgroundTaskRegistry.test
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// We import the singleton for most tests but create a fresh instance for
// auto-cleanup tests where we need to control the timer. The singleton's
// constructor has no side-effects — all state is in instance fields.
import { backgroundTaskRegistry } from './backgroundTaskRegistry.js';

// ─── Test lifecycle — reset between tests ─────────────────────────────────────

/**
 * Reset the registry by clearing its internal state.
 * We reach into the singleton because the module only exports one instance.
 * The Map and Set are the only mutable state — clearing them is equivalent
 * to creating a fresh registry.
 */
function resetRegistry(reg: typeof backgroundTaskRegistry): void {
  // Access the private tasks Map and listeners Set through bracket index
  // to avoid TypeScript private-access errors in tests.
  const tasks = (reg as unknown as { tasks: Map<string, unknown> }).tasks;
  const listeners = (reg as unknown as { listeners: Set<unknown> }).listeners;
  tasks.clear();
  listeners.clear();
}

test.beforeEach(() => {
  resetRegistry(backgroundTaskRegistry);
});

// ══════════════════════════════════════════════════════════════════════════════
// register
// ══════════════════════════════════════════════════════════════════════════════

test('register() returns a task ID', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  assert.ok(typeof id === 'string');
  assert.ok(id.length > 0);
});

test('register() creates a task with running status and correct label', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  const tasks = backgroundTaskRegistry.getAllTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.id, id);
  assert.equal(tasks[0]!.label, 'Indexing');
  assert.equal(tasks[0]!.status, 'running');
  assert.ok(tasks[0]!.startedAt > 0);
  assert.equal(tasks[0]!.progress, undefined);
  assert.equal(tasks[0]!.error, undefined);
});

test('register() produces unique task IDs for consecutive calls', () => {
  const id1 = backgroundTaskRegistry.register('Task A');
  const id2 = backgroundTaskRegistry.register('Task B');
  assert.notEqual(id1, id2);
});

test('register() increments internal counter for each call', () => {
  const id1 = backgroundTaskRegistry.register('Task A');
  const id2 = backgroundTaskRegistry.register('Task B');
  const id3 = backgroundTaskRegistry.register('Task C');
  assert.notEqual(id1, id2);
  assert.notEqual(id2, id3);
  assert.notEqual(id1, id3);
});

// ══════════════════════════════════════════════════════════════════════════════
// updateProgress
// ══════════════════════════════════════════════════════════════════════════════

test('updateProgress() sets current and total on a running task', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.updateProgress(id, 50, 100);
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.progress?.current, 50);
  assert.equal(task.progress?.total, 100);
});

test('updateProgress() is a no-op for an unknown task ID', () => {
  // Should not throw — silently ignored per implementation
  backgroundTaskRegistry.updateProgress('nonexistent', 10, 20);
  assert.equal(backgroundTaskRegistry.getAllTasks().length, 0);
});

test('updateProgress() is a no-op for a completed task', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.complete(id);
  backgroundTaskRegistry.updateProgress(id, 50, 100);
  // re-fetch; complete may auto-cleanup with timers but in sync code the task
  // still exists (timer hasn't fired yet)
  const tasks = backgroundTaskRegistry.getAllTasks();
  const task = tasks.find((t) => t.id === id);
  // Task should exist (timer hasn't fired) but progress should be undefined
  // because updateProgress was ignored (status !== 'running')
  if (task) {
    assert.equal(task.progress, undefined);
  }
});

test('updateProgress() is a no-op for a failed task', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.fail(id, 'something broke');
  backgroundTaskRegistry.updateProgress(id, 50, 100);
  const tasks = backgroundTaskRegistry.getAllTasks();
  const task = tasks.find((t) => t.id === id);
  if (task) {
    assert.equal(task.progress, undefined);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// complete
// ══════════════════════════════════════════════════════════════════════════════

test('complete() marks a running task as completed', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.complete(id);
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.status, 'completed');
});

test('complete() is a no-op for an unknown task ID', () => {
  // Should not throw
  backgroundTaskRegistry.complete('nonexistent');
  assert.equal(backgroundTaskRegistry.getAllTasks().length, 0);
});

test('complete() on already-completed task does not throw', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.complete(id);
  // Second complete should be idempotent
  backgroundTaskRegistry.complete(id);
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.status, 'completed');
});

// ══════════════════════════════════════════════════════════════════════════════
// fail
// ══════════════════════════════════════════════════════════════════════════════

test('fail() marks a running task as failed', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.fail(id);
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.status, 'failed');
});

test('fail() stores the error message when provided', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.fail(id, 'disk full');
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.error, 'disk full');
});

test('fail() does not set error when omitted', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.fail(id);
  const task = backgroundTaskRegistry.getAllTasks()[0]!;
  assert.equal(task.error, undefined);
});

test('fail() is a no-op for an unknown task ID', () => {
  backgroundTaskRegistry.fail('nonexistent');
  assert.equal(backgroundTaskRegistry.getAllTasks().length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// getActiveTasks
// ══════════════════════════════════════════════════════════════════════════════

test('getActiveTasks() returns only running tasks', () => {
  const id1 = backgroundTaskRegistry.register('Task A');
  const id2 = backgroundTaskRegistry.register('Task B');
  backgroundTaskRegistry.register('Task C');

  backgroundTaskRegistry.complete(id1);
  backgroundTaskRegistry.fail(id2);

  const active = backgroundTaskRegistry.getActiveTasks();
  assert.equal(active.length, 1);
  assert.equal(active[0]!.label, 'Task C');
});

test('getActiveTasks() returns empty array when no tasks are running', () => {
  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.complete(id);
  const active = backgroundTaskRegistry.getActiveTasks();
  assert.deepEqual(active, []);
});

test('getActiveTasks() returns empty array when registry is empty', () => {
  const active = backgroundTaskRegistry.getActiveTasks();
  assert.deepEqual(active, []);
});

// ══════════════════════════════════════════════════════════════════════════════
// getAllTasks
// ══════════════════════════════════════════════════════════════════════════════

test('getAllTasks() returns all tasks including completed and failed', () => {
  const id1 = backgroundTaskRegistry.register('Task A');
  const id2 = backgroundTaskRegistry.register('Task B');
  const id3 = backgroundTaskRegistry.register('Task C');

  backgroundTaskRegistry.complete(id1);
  backgroundTaskRegistry.fail(id2);
  // id3 remains running

  const all = backgroundTaskRegistry.getAllTasks();
  assert.equal(all.length, 3);
});

test('getAllTasks() returns empty array for empty registry', () => {
  assert.deepEqual(backgroundTaskRegistry.getAllTasks(), []);
});

// ══════════════════════════════════════════════════════════════════════════════
// subscribe / unsubscribe
// ══════════════════════════════════════════════════════════════════════════════

test('subscribe() fires callback on register with full snapshot', () => {
  const calls: string[][] = [];
  backgroundTaskRegistry.subscribe((tasks) => {
    calls.push(tasks.map((t) => t.label));
  });

  backgroundTaskRegistry.register('Indexing');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['Indexing']);
});

test('subscribe() fires callback on updateProgress', () => {
  const snapshots: number[] = [];
  backgroundTaskRegistry.subscribe((tasks) => {
    const t = tasks[0];
    snapshots.push(t?.progress?.current ?? -1);
  });

  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.updateProgress(id, 10, 100);
  assert.equal(snapshots.length, 2); // register + update
  assert.equal(snapshots[1], 10); // second call has the progress
});

test('subscribe() fires callback on complete', () => {
  const statuses: string[] = [];
  backgroundTaskRegistry.subscribe((tasks) => {
    statuses.push(tasks.map((t) => t.status).join(','));
  });

  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.complete(id);
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1], 'completed');
});

test('subscribe() fires callback on fail', () => {
  const statuses: string[] = [];
  backgroundTaskRegistry.subscribe((tasks) => {
    statuses.push(tasks.map((t) => t.status).join(','));
  });

  const id = backgroundTaskRegistry.register('Indexing');
  backgroundTaskRegistry.fail(id, 'oops');
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1], 'failed');
});

test('subscribe() snapshot includes all tasks, not just the changed one', () => {
  const id1 = backgroundTaskRegistry.register('Task A');
  backgroundTaskRegistry.register('Task B');

  const snapshots: number[] = [];
  backgroundTaskRegistry.subscribe((tasks) => {
    snapshots.push(tasks.length);
  });

  backgroundTaskRegistry.complete(id1);
  // Snapshot should include both Task A (now completed) and Task B (still running)
  assert.equal(snapshots[0], 2);
});

test('unsubscribe() stops the callback from firing', () => {
  const calls: string[] = [];
  const unsub = backgroundTaskRegistry.subscribe((tasks) => {
    calls.push(tasks.map((t) => t.label).join(','));
  });

  backgroundTaskRegistry.register('First');
  unsub();
  backgroundTaskRegistry.register('Second');

  assert.equal(calls.length, 1); // only the first register fired
  assert.equal(calls[0], 'First');
});

test('subscribe() supports multiple listeners', () => {
  const callsA: number[] = [];
  const callsB: number[] = [];

  backgroundTaskRegistry.subscribe(() => callsA.push(1));
  backgroundTaskRegistry.subscribe(() => callsB.push(1));

  backgroundTaskRegistry.register('Indexing');
  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 1);
});

test('swallows listener exceptions without affecting other listeners', () => {
  const calls: string[] = [];

  backgroundTaskRegistry.subscribe(() => {
    throw new Error('listener error');
  });
  backgroundTaskRegistry.subscribe((tasks) => {
    calls.push(tasks[0]!.label);
  });

  backgroundTaskRegistry.register('Indexing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'Indexing');
});

// ══════════════════════════════════════════════════════════════════════════════
// Auto-cleanup
// ══════════════════════════════════════════════════════════════════════════════

test('auto-cleanup removes completed tasks after 5 seconds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  try {
    const id = backgroundTaskRegistry.register('Indexing');
    backgroundTaskRegistry.complete(id);

    // Task should still be visible immediately
    assert.equal(backgroundTaskRegistry.getAllTasks().length, 1);

    // Advance past the 5s cleanup threshold
    mock.timers.tick(5_001);

    // Task should now be cleaned up
    assert.equal(backgroundTaskRegistry.getAllTasks().length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('auto-cleanup removes failed tasks after 10 seconds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  try {
    const id = backgroundTaskRegistry.register('Indexing');
    backgroundTaskRegistry.fail(id, 'error');

    // Task should still be visible immediately
    assert.equal(backgroundTaskRegistry.getAllTasks().length, 1);

    // At 5 seconds, completed tasks would be cleaned, but failed should remain
    mock.timers.tick(5_001);
    assert.equal(backgroundTaskRegistry.getAllTasks().length, 1);

    // Advance past the 10s cleanup threshold
    mock.timers.tick(5_001);

    assert.equal(backgroundTaskRegistry.getAllTasks().length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('auto-cleanup for completed task does not affect other running tasks', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  try {
    const id1 = backgroundTaskRegistry.register('Task A');
    backgroundTaskRegistry.register('Task B');

    backgroundTaskRegistry.complete(id1);

    // Advance past 5s
    mock.timers.tick(5_001);

    const tasks = backgroundTaskRegistry.getAllTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.label, 'Task B');
    assert.equal(tasks[0]!.status, 'running');
  } finally {
    mock.timers.reset();
  }
});
