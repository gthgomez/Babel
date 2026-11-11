import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildRepoMapPreamble, collectChatSeedFiles } from './repoMapPreamble.js';

describe('buildRepoMapPreamble (L17 repo-map)', () => {
  test('seed extraction accepts relative names without disk probes and rejects traversal', () => {
    const seeds = collectChatSeedFiles([{ content: 'Inspect missing.ts and ../outside.ts.' }], 'unused-root');
    assert.ok(seeds.includes('missing.ts'));
    assert.ok(!seeds.some((seed) => seed.split('/').includes('..')));
  });

  test('includes top-level dirs, key files, and npm scripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'node_modules')); // skipped
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          scripts: { build: 'tsc', test: 'node --test', typecheck: 'tsc --noEmit' },
        }),
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFileSync(join(root, 'README.md'), '# fixture');

      const map = await buildRepoMapPreamble(root);
      assert.match(map, /## Repository Map/);
      assert.match(map, /Top-level:.*src\//);
      assert.doesNotMatch(map, /node_modules/);
      assert.match(map, /Key files:.*package\.json/);
      assert.match(map, /Key files:.*tsconfig\.json/);
      assert.match(map, /- Build: npm run build/);
      assert.match(map, /- Test: npm test/);
      assert.match(map, /- TypeCheck: npm run typecheck/);
      assert.match(map, /TypeScript strict mode: true/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns header-only map for empty directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-empty-'));
    try {
      const map = await buildRepoMapPreamble(root);
      assert.equal(map, '## Repository Map');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('oversized source uses the legacy summary and reports the budget reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-large-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'large.ts'), 'x'.repeat(512 * 1024 + 1));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      let status = '';
      const map = await buildRepoMapPreamble(root, {
        maxDurationMs: 10_000,
        onGraphOutcome: (outcome) => {
          status = outcome.status === 'limited' ? outcome.reason : outcome.status;
        },
      });
      assert.equal(status, 'file_size_limit');
      assert.match(map, /Top-level:.*src\//);
      assert.match(map, /- Test: npm test/);
      assert.doesNotMatch(map, /large\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an aborted scan returns a safe fallback and exposes cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-repomap-cancelled-'));
    try {
      const controller = new AbortController();
      controller.abort();
      let status = '';
      const map = await buildRepoMapPreamble(root, {
        signal: controller.signal,
        onGraphOutcome: (outcome) => { status = outcome.status; },
      });
      assert.equal(map, '## Repository Map');
      assert.equal(status, 'cancelled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
