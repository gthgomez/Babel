import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readLiteProjectContext } from './liteProjectContext.js';

test('readLiteProjectContext appends repo map symbols when task is present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-context-map-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), '# Demo\n', 'utf-8');
    writeFileSync(
      join(root, 'src', 'demo.ts'),
      'export function demoFn() { return true; }\n',
      'utf-8',
    );

    const prompt = await readLiteProjectContext({
      projectRoot: root,
      task: 'where is demoFn defined?',
    });

    assert.match(prompt, /## Repo Map \(symbols\)/);
    assert.match(prompt, /src\/demo\.ts/);
    assert.match(prompt, /demoFn/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
