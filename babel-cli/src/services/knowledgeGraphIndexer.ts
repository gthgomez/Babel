/**
 * Knowledge graph indexing lifecycle manager.
 *
 * Manages first-time codebase-memory-mcp index creation as a background task.
 * The index persists in ~/.cache/codebase-memory-mcp/ across sessions, so
 * subsequent launches are fast (sub-second SQLite load).
 *
 * Guards:
 * - BABEL_SKIP_KG_INDEX env var disables auto-indexing
 * - Concurrent indexing is prevented via _indexingInProgress flag
 * - Existing index cache directory is probed to avoid redundant re-indexing
 *
 * @module knowledgeGraphIndexer
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { backgroundTaskRegistry } from './backgroundTaskRegistry.js';
import { buildSpawnInvocation } from '../tools/mcpTransport.js';

// ── Parsing Helpers ────────────────────────────────────────────────────────

/**
 * Parse the LAST progress match from an accumulated stderr buffer.
 * Returns progress counters or null if no match found.
 */
export function parseProgress(
  buffer: string,
): { current: number; total: number } | null {
  const matches = [
    ...buffer.matchAll(
      /[Ii]ndex(?:ed|ing)\s+([\d,]+)\s*\/\s*([\d,]+)/g,
    ),
  ];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  return {
    current: Number(last[1]!.replace(/,/g, '')),
    total: Number(last[2]!.replace(/,/g, '')),
  };
}

/**
 * Parse the FIRST node/edge stats match from the final stderr buffer.
 * Returns counts or null if no match found.
 */
export function parseStats(
  buffer: string,
): { nodeCount: number; edgeCount: number } | null {
  const match = buffer.match(
    /(\d[\d,]*)\s*nodes?.*?(\d[\d,]*)\s*edges?/i,
  );
  if (!match) return null;
  return {
    nodeCount: Number(match[1]!.replace(/,/g, '')),
    edgeCount: Number(match[2]!.replace(/,/g, '')),
  };
}

// ── Cached Status ──────────────────────────────────────────────────────────

let _cachedStatus: { nodeCount: number; edgeCount: number } | null = null;
let _indexingInProgress = false;

/** Captured promise for lifecycle inspection (per babel-cli/CLAUDE.md Fire-and-Forget Disciplines). */
let _indexingPromise: Promise<void> | null = null;

/**
 * Start background indexing of the codebase knowledge graph.
 *
 * Fire-and-forget via `setImmediate` — registers with the background task
 * registry and spawns `npx -y codebase-memory-mcp index`. Progress updates
 * are parsed from stderr output.
 *
 * Respects `BABEL_SKIP_KG_INDEX` env var to disable auto-indexing.
 * Skips indexing if the persistent cache directory already exists.
 * Guards against concurrent indexing runs.
 * Never throws — errors are surfaced via the task registry.
 */
export function startBackgroundIndexing(): void {
  if (process.env['BABEL_SKIP_KG_INDEX']) return;
  if (_indexingInProgress) return;

  // Probe whether the persistent index already exists to avoid redundant re-indexing
  const cacheDir = path.join(os.homedir(), '.cache', 'codebase-memory-mcp');
  if (existsSync(cacheDir)) return;

  setImmediate(() => {
    _indexingPromise = runIndexing();
  });
}

async function runIndexing(): Promise<void> {
  _indexingInProgress = true;
  const taskId = backgroundTaskRegistry.register('Indexing knowledge graph');

  try {
    const invocation = buildSpawnInvocation('npx', [
      '-y',
      'codebase-memory-mcp',
      'index',
    ]);
    const child = spawn(invocation.command, invocation.args, {
      // stdout is ignored to prevent pipe-buffer deadlock when the child writes
      // more than the 16 KB highWaterMark — only stderr is consumed for progress.
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderrBuf = '';

    child.on('error', (err: Error) => {
      // Async spawn failure (permissions, DLL load, etc.) — the 'exit' event
      // never fires in this scenario. Fail the task immediately.
      backgroundTaskRegistry.fail(
        taskId,
        `Failed to start indexing: ${err.message}`,
      );
      _indexingInProgress = false;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      const progress = parseProgress(stderrBuf);
      if (progress) {
        backgroundTaskRegistry.updateProgress(
          taskId,
          progress.current,
          progress.total,
        );
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 300_000); // 5-minute timeout

      child.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });

      // Belt-and-suspenders: if the child closes without an 'exit' event
      // (rare on some platforms), resolve with the close code.
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== null) resolve(code);
      });
    });

    if (exitCode === 0) {
      // Indexing succeeded — attempt to parse final node/edge counts.
      // Only set _cachedStatus when the regex matches, so consumers can
      // distinguish "stats unavailable" (null) from "empty index" (0).
      const stats = parseStats(stderrBuf);
      if (stats) {
        _cachedStatus = stats;
      }
      backgroundTaskRegistry.complete(taskId);
    } else {
      backgroundTaskRegistry.fail(
        taskId,
        exitCode !== null
          ? `Indexing exited with code ${exitCode}`
          : 'Indexing timed out after 5 minutes',
      );
    }
  } catch (err) {
    backgroundTaskRegistry.fail(
      taskId,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    _indexingInProgress = false;
  }
}

/**
 * Get cached index status from the last successful indexing run.
 * Returns null if indexing has never completed or if stats could not be parsed.
 */
export function getCachedIndexStatus(): {
  nodeCount: number;
  edgeCount: number;
} | null {
  return _cachedStatus;
}

/**
 * Return the captured indexing promise for lifecycle inspection.
 * Returns null if indexing has never been started.
 */
export function getIndexingPromise(): Promise<void> | null {
  return _indexingPromise;
}

// Exposed for testing
export { _cachedStatus as __testCachedStatus };

/** Reset all module-level state between tests. */
export function __testReset(): void {
  _indexingInProgress = false;
  _indexingPromise = null;
  _cachedStatus = null;
}
