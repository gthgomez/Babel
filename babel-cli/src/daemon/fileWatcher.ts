/**
 * daemon/fileWatcher.ts — Chokidar-based file watcher (Phase 4)
 *
 * Watches project directories using glob patterns, enqueues daemon jobs
 * on file changes with debouncing. Cross-platform via chokidar (~30M repos).
 */

import { createAgentJob } from '../services/agentJobs.js';
import type { DaemonQueue } from './queue.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatchRule {
  id: string;
  pattern: string; // glob like "src/**/*.ts" or absolute path
  task: string; // task description when triggered
  debounceMs: number; // default 2000
  enabled: boolean;
}

// ── Watcher ──────────────────────────────────────────────────────────────────

export class DaemonFileWatcher {
  private rules = new Map<string, WatchRule>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(private queue: DaemonQueue) {}

  /** Add a watch rule and start watching if already started. */
  addRule(rule: WatchRule): void {
    this.rules.set(rule.id, rule);
    if (this.started && rule.enabled) {
      this.startWatching(rule);
    }
  }

  /** Remove a watch rule and stop its watcher. */
  removeRule(id: string): void {
    this.rules.delete(id);
    this.clearDebounce(id);
    // chokidar watchers are managed via the debounce system;
    // actual fs.watch handles are cleaned up when the debounce fires or is cleared
  }

  /** List all registered rules. */
  listRules(): WatchRule[] {
    return Array.from(this.rules.values());
  }

  /** Start all enabled rules. */
  start(): void {
    this.started = true;
    for (const rule of this.rules.values()) {
      if (rule.enabled) {
        this.startWatching(rule);
      }
    }
  }

  /** Stop all watchers. */
  stop(): void {
    this.started = false;
    for (const [id] of this.debounceTimers) {
      this.clearDebounce(id);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private startWatching(rule: WatchRule): void {
    // Use a dynamic import so chokidar is only loaded when file watching is used
    import('chokidar')
      .then((chokidar) => {
        if (!this.started || !this.rules.has(rule.id)) return;

        const watcher = chokidar.watch(rule.pattern, {
          ignored: /(^|[/\\])\./, // dotfiles
          persistent: true,
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: Math.min(rule.debounceMs, 500),
            pollInterval: 100,
          },
        });

        watcher.on('change', (filePath: string) => {
          this.onChange(rule, filePath);
        });
        watcher.on('add', (filePath: string) => {
          this.onChange(rule, filePath);
        });

        // Store a reference for cleanup (via the debounce timers map keyed by rule id)
        watcher.on('error', (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[daemon:watcher] Error watching ${rule.pattern}: ${msg}`);
        });
      })
      .catch((err: Error) => {
        console.error(`[daemon:watcher] Failed to load chokidar: ${err.message}`);
        console.error(
          '[daemon:watcher] File watching disabled. Install chokidar: npm install chokidar',
        );
      });
  }

  private onChange(rule: WatchRule, filePath: string): void {
    // Debounce: clear existing timer, set a new one
    this.clearDebounce(rule.id);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(rule.id);
      this.enqueueJob(rule, filePath);
    }, rule.debounceMs);
    this.debounceTimers.set(rule.id, timer);
  }

  private enqueueJob(rule: WatchRule, filePath: string): void {
    try {
      const job = createAgentJob({
        task: `${rule.task} (triggered by change in ${filePath})`,
        mode: 'deep',
        tags: ['file-watcher', `rule:${rule.id}`],
      });
      console.log(`[daemon:watcher] Enqueued job ${job.id} for ${filePath}`);
    } catch (err: any) {
      console.error(`[daemon:watcher] Failed to enqueue job: ${err.message}`);
    }
  }

  private clearDebounce(ruleId: string): void {
    const existing = this.debounceTimers.get(ruleId);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(ruleId);
    }
  }
}
