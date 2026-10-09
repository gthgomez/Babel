import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  buildRepoMapGraph,
  invalidateRepoMapFile,
  repoMapTagSource,
} from './graph.js';

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
