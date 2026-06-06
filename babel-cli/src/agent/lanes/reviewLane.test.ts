import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runReviewLane } from './reviewLane.js';

describe('runReviewLane', () => {
  it('writes review artifacts under runs/babel-lite without mutating repo source files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-review-lane-'));
    assert.equal(spawnSync('git', ['init'], { cwd: repo, encoding: 'utf-8' }).status, 0);
    const source = join(repo, 'sample.txt');
    writeFileSync(source, 'before\n', 'utf-8');
    const beforeHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    try {
      const result = runReviewLane({
        task: 'Review current diff',
        projectRoot: repo,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'REVIEW_READY');
      assert.ok(result.payload.changed_files.includes('sample.txt'));
      const afterHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      assert.equal(afterHash, beforeHash);
      assert.ok(result.payload.run_dir?.replace(/\\/g, '/').includes('runs/babel-lite'));
      assert.ok(result.payload.evidence.artifacts.length > 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
