import { resolve } from 'node:path';

import { globalIndexer } from './indexer.js';
import { ensureSemanticIndexForProject } from '../tools/chronicleMemory.js';
import { backgroundTaskRegistry } from './backgroundTaskRegistry.js';

const warmupPromises = new Map<string, Promise<void>>();

export function isSemanticIndexReady(projectRoot: string): boolean {
  const root = resolve(projectRoot);
  return globalIndexer.indexedProjectRoot === root && globalIndexer.count > 0;
}

export function startLiteIndexWarmup(projectRoot: string, onStatus?: (line: string) => void): void {
  const root = resolve(projectRoot);
  if (isSemanticIndexReady(root)) {
    return;
  }
  if (warmupPromises.has(root)) {
    return;
  }

  const taskId = backgroundTaskRegistry.register('Indexing workspace…');
  onStatus?.('Indexing…');
  // Defer indexing by one tick so it doesn't compete with the first task's
  // execution for CPU and I/O. Large repos can keep the event loop busy for
  // minutes; this one-tick delay lets the REPL prompt render first.
  const promise = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => {
      // Inject progress callback so the status bar shows e.g.
      // "[Indexing workspace… 1240/5000]" instead of a static label that
      // is indistinguishable from a hung process.
      return ensureSemanticIndexForProject(root, (indexed, total) => {
        backgroundTaskRegistry.updateProgress(taskId, indexed, total);
      });
    })
    .then(() => {
      backgroundTaskRegistry.complete(taskId);
      if (globalIndexer.count > 0) {
        onStatus?.(`Indexed ${globalIndexer.count} files.`);
      }
    })
    .catch((err) => {
      backgroundTaskRegistry.fail(taskId, err instanceof Error ? err.message : undefined);
      onStatus?.('Indexing skipped (non-fatal).');
    })
    .finally(() => {
      warmupPromises.delete(root);
    });
  warmupPromises.set(root, promise);
}

export function resetLiteIndexWarmupForTests(): void {
  warmupPromises.clear();
}
