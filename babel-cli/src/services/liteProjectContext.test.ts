import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readLiteProjectContext } from './liteProjectContext.js';

test('readLiteProjectContext pastes AGENTS.md and ENGINEERING.md, not CLAUDE.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-context-instructions-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'AGENT_RULE\n', 'utf-8');
    writeFileSync(join(root, 'ENGINEERING.md'), 'ENG_RULE\n', 'utf-8');
    writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE_SHOULD_NOT_LOAD\n', 'utf-8');
    writeFileSync(join(root, 'PROJECT_CONTEXT.md'), 'PROJECT_CONTEXT_SHOULD_NOT_LOAD\n', 'utf-8');

    const prompt = await readLiteProjectContext({ projectRoot: root });

    assert.match(prompt, /AGENT_RULE/);
    assert.match(prompt, /ENG_RULE/);
    assert.doesNotMatch(prompt, /CLAUDE_SHOULD_NOT_LOAD/);
    assert.doesNotMatch(prompt, /PROJECT_CONTEXT_SHOULD_NOT_LOAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
