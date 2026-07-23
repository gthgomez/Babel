import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runProposalLane } from './proposalLane.js';

describe('runProposalLane', () => {
  it('writes proposal artifacts without mutating repo source files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-proposal-lane-'));
    const source = join(repo, 'sample.txt');
    writeFileSync(source, 'before\n', 'utf-8');
    const beforeHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    try {
      const result = await runProposalLane(
        {
          task: 'Propose a safe README tweak',
          projectRoot: repo,
          provider: 'mock',
        },
        'propose',
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'PROPOSAL_READY');
      assert.equal(result.payload.execution_mode, 'offline_demo');
      assert.equal(result.payload.changed_files.length, 0);
      const afterHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      assert.equal(afterHash, beforeHash);
      assert.ok(result.payload.run_dir?.replace(/\\/g, '/').includes('runs/babel-lite'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
