/**
 * BackgroundTaskRegistry — singleton tracking in-flight background work.
 *
 * Feed by fire-and-forget services (index warmup, pipeline preflight).
 * Consumed by the REPL status bar to show the user what's happening behind
 * the prompt.  All operations are synchronous — Node.js single-threaded
 * execution means no locks are needed.
 *
 * @module backgroundTaskRegistry
 */

let _nextId = 1;

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackgroundTask {
  id: string;
  label: string;
  startedAt: number;
  /** Running progress counters. Omitted when unknown. */
  progress?: { current: number; total: number };
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

type Listener = (tasks: BackgroundTask[]) => void;

// ── Singleton ──────────────────────────────────────────────────────────────

class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();
  private listeners = new Set<Listener>();

  // ── Registration ───────────────────────────────────────────────────────

  /** Register a new background task. Returns an opaque task ID. */
  register(label: string): string {
    const id = String(_nextId++);
    this.tasks.set(id, {
      id,
      label,
      startedAt: Date.now(),
      status: 'running',
    });
    this.notify();
    return id;
  }

  /** Update the progress counters for a running task. */
  updateProgress(id: string, current: number, total: number): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.progress = { current, total };
    this.notify();
  }

  /** Mark a task as successfully completed. */
  complete(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'completed';
    this.notify();
    // Auto-clean completed tasks after a short delay so the status bar
    // has time to show the final state before it disappears.
    setTimeout(() => this.tasks.delete(id), 5_000);
  }

  /** Mark a task as failed with an optional error message. */
  fail(id: string, error?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    if (error !== undefined) task.error = error;
    this.notify();
    setTimeout(() => this.tasks.delete(id), 10_000);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to task-list changes. Returns an unsubscribe function.
   * The callback fires synchronously on every register/update/complete/fail.
   */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Return all tasks that are currently running. */
  getActiveTasks(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'running');
  }

  /** Return all known tasks (running, recently completed, failed). */
  getAllTasks(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private notify(): void {
    const snapshot = this.getAllTasks();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* swallow */
      }
    }
  }
}

/** Singleton instance — import and use directly. */
export const backgroundTaskRegistry = new BackgroundTaskRegistry();
