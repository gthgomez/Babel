import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRepoMap, collectTextFiles, SemanticIndexer } from './indexer.js';

test('repo map extracts compact symbols from source files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repo-map-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'agent.ts'),
      [
        'export interface AgentConfig { name: string }',
        'export class AgentRuntime {}',
        'export function runAgent() { return true; }',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'worker.py'), 'class Worker:\n    pass\ndef run_worker():\n    return True\n', 'utf-8');

    const repoMap = await buildRepoMap(root, { target: 'src', includePreview: true });
    assert.equal(repoMap.files_indexed, 2);
    assert.deepEqual(
      repoMap.entries.find(entry => entry.path === 'src/agent.ts')?.symbols,
      ['AgentConfig', 'AgentRuntime', 'runAgent'],
    );
    assert.deepEqual(
      repoMap.entries.find(entry => entry.path === 'src/worker.py')?.symbols,
      ['run_worker', 'Worker'],
    );
    assert.match(repoMap.entries[0]?.preview ?? '', /export/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic indexer resets between project indexes', async () => {
  const first = mkdtempSync(join(tmpdir(), 'babel-index-first-'));
  const second = mkdtempSync(join(tmpdir(), 'babel-index-second-'));
  try {
    writeFileSync(join(first, 'one.ts'), 'export const alpha = 1;', 'utf-8');
    writeFileSync(join(second, 'two.ts'), 'export const beta = 2;', 'utf-8');
    const indexer = new SemanticIndexer();
    assert.equal(await indexer.indexProject(first), 1);
    assert.equal(await indexer.indexProject(second), 1);
    assert.equal(indexer.count, 1);
    assert.equal(indexer.search('alpha').length, 0);
    assert.equal(indexer.search('beta').length, 1);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('collectTextFiles treats a file path as an empty index root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-index-file-root-'));
  try {
    const filePath = join(root, 'session-start.json');
    writeFileSync(filePath, '{"ProjectPath":"/workspace-root/example_game_suite/Demo"}\n', 'utf-8');

    assert.deepEqual(await collectTextFiles(filePath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
