import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildRepoMapPreamble } from './repoMapPreamble.js';

describe('buildRepoMapPreamble (L17 repo-map)', () => {
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
});
