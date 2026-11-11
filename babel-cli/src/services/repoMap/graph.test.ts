import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildRepoMapGraph,
  buildRepoMapGraphDetailed,
  buildFileGraph,
  invalidateRepoMapFile,
  repoMapTagSource,
  setRepoMapProjectRoot,
} from './graph.js';
import { repoMapWorkerState, shutdownRepoMapWorker } from './graphWorkerClient.js';

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-repomap-graph-'));
  mkdirSync(join(root, 'src', 'core'), { recursive: true });
  mkdirSync(join(root, 'src', 'util'), { recursive: true });
  mkdirSync(join(root, 'misc', 'other'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'core', 'engine.ts'),
    [
      'import { parseConfig } from "./config.js";',
      'export function engineMain(): void {',
      '  const cfg = parseConfig("x");',
      '  if (cfg.enabled) { runEngineCycle(cfg); }',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'core', 'config.ts'),
    [
      'import { writeLog } from "../util/log.js";',
      'export function parseConfig(raw: string): { enabled: boolean } {',
      '  writeLog("parse");',
      '  return { enabled: raw.length > 0 };',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'util', 'log.ts'),
    ['export function writeLog(message: string): void {', '  console.log(message);', '}'].join('\n'),
  );
  writeFileSync(
    join(root, 'misc', 'other', 'random.ts'),
    [
      'export function unrelatedThing(): void {',
      '  console.log("unrelated");',
      '}',
    ].join('\n'),
  );
  return root;
}

describe('repoMap/graph (packet B1)', () => {
  test('golden: two-hop symbols ranked in, irrelevant dirs out', async () => {
    const root = writeFixture();
    try {
      const result = await buildRepoMapGraph(root, {
        budgetTokens: 400,
        seedFiles: [join(root, 'src', 'core', 'engine.ts')],
      });
      assert.ok(result, 'graph map should build for the fixture');
      const map = result.map;
      // Direct + two-hop dependencies of the seeded file must appear.
      assert.match(map, /parseConfig/);
      assert.match(map, /writeLog/);
      assert.match(map, /src\/core\/config\.ts/);
      assert.match(map, /src\/util\/log\.ts/);
      // Irrelevant subtree with no reference from the seed must be omitted.
      assert.doesNotMatch(map, /unrelatedThing/);
      assert.doesNotMatch(map, /random\.ts/);
      assert.equal(result.tagSource, repoMapTagSource());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('budget: rendered map never exceeds the budget at any setting', async () => {
    const root = writeFixture();
    try {
      for (const budget of [50, 100, 250, 1_000, 5_000]) {
        const result = await buildRepoMapGraph(root, { budgetTokens: budget });
        assert.ok(result, `map should build at budget=${budget}`);
        assert.ok(
          result.tokens <= budget,
          `expected ${result.tokens} <= ${budget} tokens`,
        );
      }
      // No seeds: budget expansion default keeps the map bounded too.
      const unseeded = await buildRepoMapGraph(root, {});
      assert.ok(unseeded);
      assert.ok(unseeded.tokens <= 2_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cache: warm rebuild is fast and write invalidation refreshes tags', async () => {
    const root = writeFixture();
    try {
      const first = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(first);

      // Warm cache rebuild on this repo-sized tree must stay well under 2s.
      const started = Date.now();
      const warm = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      const elapsed = Date.now() - started;
      assert.ok(warm);
      assert.ok(elapsed < 2_000, `warm rebuild took ${elapsed}ms`);

      // Incremental update: touch a file's content, invalidate, rebuild —
      // the new symbol appears without touching the cache for other files.
      const logPath = join(root, 'src', 'util', 'log.ts');
      writeFileSync(
        logPath,
        [
          'export function writeLog(message: string): void {',
          '  console.log(message);',
          '}',
          'export function brandNewSymbol(): void {}',
        ].join('\n'),
      );
      invalidateRepoMapFile(logPath);
      const refreshed = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(refreshed);
      assert.match(refreshed.map, /brandNewSymbol/);

      // mtime+hash keyed cache: a touch (mtime change, same content) must not
      // change the map (cache hit via hash).
      const before = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(before);
      const future = new Date(Date.now() + 60_000);
      utimesSync(logPath, future, future);
      const afterTouch = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(afterTouch);
      assert.equal(afterTouch.map, before.map);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repoMap isolation and budgets', () => {
  test('concurrent projects retain their own relative paths', async () => {
    const firstRoot = writeFixture();
    const secondRoot = writeFixture();
    try {
      const [first, second] = await Promise.all([
        buildRepoMapGraph(firstRoot, { budgetTokens: 1_000 }),
        buildRepoMapGraph(secondRoot, { budgetTokens: 1_000 }),
      ]);
      assert.ok(first);
      assert.ok(second);
      for (const result of [first, second]) {
        assert.match(result.map, /src\/core\/config\.ts/);
        assert.doesNotMatch(result.map, /babel-repomap-graph-/);
      }
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test('legacy low-level callers snapshot their root before interleaving', async () => {
    const firstRoot = writeFixture();
    const secondRoot = writeFixture();
    try {
      setRepoMapProjectRoot(firstRoot);
      const first = buildFileGraph([join(firstRoot, 'src', 'core', 'config.ts'), join(firstRoot, 'src', 'util', 'log.ts')]);
      setRepoMapProjectRoot(secondRoot);
      const second = buildFileGraph([join(secondRoot, 'src', 'core', 'config.ts'), join(secondRoot, 'src', 'util', 'log.ts')]);
      for (const result of await Promise.all([first, second])) {
        assert.ok(result.graph.nodes.length > 0);
        assert.ok(result.graph.nodes.every((node) => !node.includes('babel-repomap-graph-')));
      }
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test('external same-size edits with unchanged timestamp refresh cached tags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-external-'));
    try {
      const file = join(root, 'change.ts');
      const timestamp = new Date('2020-01-01T00:00:00Z');
      writeFileSync(file, 'export function alphaName() {}\n');
      utimesSync(file, timestamp, timestamp);
      const first = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(first);
      assert.match(first.map, /alphaName/);

      writeFileSync(file, 'export function bravoName() {}\n');
      utimesSync(file, timestamp, timestamp);
      const updated = await buildRepoMapGraph(root, { budgetTokens: 1_000 });
      assert.ok(updated);
      assert.match(updated.map, /bravoName/);
      assert.doesNotMatch(updated.map, /alphaName/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('edge and file budgets return fallback instead of a partial graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-budget-'));
    try {
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(root, `file${i}.ts`), 'export function sharedName() { return sharedName(); }\n');
      }
      const allowed = await buildRepoMapGraph(root, { budgetTokens: 1_000, maxEdges: 16 });
      assert.ok(allowed);
      const tooMany = await buildRepoMapGraph(root, { budgetTokens: 1_000, maxEdges: 15 });
      assert.equal(tooMany, null);
      const tooMuchInput = await buildRepoMapGraph(root, { budgetTokens: 1_000, maxSourceBytes: 10 });
      assert.equal(tooMuchInput, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('already aborted work starts no worker and reports cancellation', async () => {
    await shutdownRepoMapWorker();
    const root = writeFixture();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await buildRepoMapGraphDetailed(root, { signal: controller.signal });
      assert.deepEqual(result, { status: 'cancelled', reason: 'aborted' });
      assert.equal(repoMapWorkerState().processId, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('aborting active indexing terminates its worker before returning', async () => {
    await shutdownRepoMapWorker();
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-abort-'));
    try {
      writeFileSync(join(root, 'slow.ts'), 'export function repeatName() { return repeatName(); }\n'.repeat(8_000));
      const controller = new AbortController();
      const pending = buildRepoMapGraphDetailed(root, { signal: controller.signal, maxDurationMs: 10_000 });
      const until = Date.now() + 5_000;
      while (!repoMapWorkerState().started && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(repoMapWorkerState().started, true, 'worker must enter the indexing path');
      const ownedProcess = repoMapWorkerState().processId;
      assert.ok(ownedProcess, 'the indexer runs in a separately terminable process');
      controller.abort();
      const outcome = await pending;
      assert.deepEqual(outcome, { status: 'cancelled', reason: 'aborted' });
      assert.equal(repoMapWorkerState().processId, null);
      assert.equal(repoMapWorkerState().terminating, false);
      assert.throws(() => process.kill(ownedProcess, 0), 'the owned indexer has exited before return');

      // A new generation can start after cancellation without accepting the
      // abandoned worker's result or inheriting its unfinished cache.
      const next = await buildRepoMapGraph(root, { maxDurationMs: 10_000 });
      assert.ok(next);
    } finally {
      await shutdownRepoMapWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deadline and empty project have distinct outcomes', async () => {
    await shutdownRepoMapWorker();
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-empty-'));
    try {
      const expired = await buildRepoMapGraphDetailed(root, { maxDurationMs: 1 });
      assert.deepEqual(expired, { status: 'cancelled', reason: 'deadline' });
      assert.equal(repoMapWorkerState().processId, null);
      const empty = await buildRepoMapGraphDetailed(root, { maxDurationMs: 10_000 });
      assert.equal(empty.status, 'empty');
    } finally {
      await shutdownRepoMapWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('healthy sequential scans reuse the same worker', async () => {
    await shutdownRepoMapWorker();
    const root = writeFixture();
    try {
      assert.ok(await buildRepoMapGraph(root, { maxDurationMs: 10_000 }));
      const firstThread = repoMapWorkerState().processId;
      assert.ok(firstThread);
      assert.ok(await buildRepoMapGraph(root, { maxDurationMs: 10_000 }));
      assert.equal(repoMapWorkerState().processId, firstThread);
    } finally {
      await shutdownRepoMapWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
