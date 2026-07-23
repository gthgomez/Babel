import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isSemanticIndexReady,
  resetLiteIndexWarmupForTests,
  startLiteIndexWarmup,
} from './liteIndexWarmup.js';

test('startLiteIndexWarmup indexes project root in the background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-warmup-'));
  const statuses: string[] = [];
  try {
    writeFileSync(join(root, 'alpha.ts'), 'export const alpha = 1;\n', 'utf-8');
    resetLiteIndexWarmupForTests();
    assert.equal(isSemanticIndexReady(root), false);
    startLiteIndexWarmup(root, (line) => statuses.push(line));
    assert.deepEqual(statuses, ['Indexing…']);
    for (let attempt = 0; attempt < 40 && !isSemanticIndexReady(root); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isSemanticIndexReady(root), true);
    assert.match(statuses.at(-1) ?? '', /Indexed 1 files\./);
  } finally {
    resetLiteIndexWarmupForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
