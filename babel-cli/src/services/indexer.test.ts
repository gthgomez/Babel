import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSemanticIndexForProject } from '../tools/chronicleMemory.js';
import { executeTool } from '../localTools.js';
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
    writeFileSync(
      join(root, 'src', 'worker.py'),
      'class Worker:\n    pass\ndef run_worker():\n    return True\n',
      'utf-8',
    );

    const repoMap = await buildRepoMap(root, { target: 'src', includePreview: true });
    assert.equal(repoMap.files_indexed, 2);
    assert.deepEqual(repoMap.entries.find((entry) => entry.path === 'src/agent.ts')?.symbols, [
      'AgentConfig',
      'AgentRuntime',
      'runAgent',
    ]);
    assert.deepEqual(repoMap.entries.find((entry) => entry.path === 'src/worker.py')?.symbols, [
      'run_worker',
      'Worker',
    ]);
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

test('semantic_search lazily indexes the active project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-semantic-lazy-'));
  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  try {
    writeFileSync(join(root, 'needle.ts'), 'export const needleToken = 42;\n', 'utf-8');
    process.env['BABEL_PROJECT_ROOT'] = root;
    await ensureSemanticIndexForProject(root);
    const result = await executeTool(
      {
        tool: 'semantic_search',
        query: 'needleToken',
      },
      {
        agentId: 'test-agent',
        runId: 'test-run',
        babelRoot: root,
      },
    );
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /needle\.ts/);
    assert.match(result.stdout, /needleToken/);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectTextFiles treats a file path as an empty index root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-index-file-root-'));
  try {
    const filePath = join(root, 'session-start.json');
    writeFileSync(filePath, '{"ProjectPath":"/tmp/example_game_suite/Demo"}\n', 'utf-8');

    assert.deepEqual(await collectTextFiles(filePath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Guardrail tests ──────────────────────────────────────────────────────────

test('collectTextFiles enforces maxFiles cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-maxfiles-'));
  try {
    // Create 50 files — with a cap of 10, only 10 should be collected
    for (let i = 0; i < 50; i++) {
      writeFileSync(
        join(root, `file_${String(i).padStart(3, '0')}.ts`),
        `export const x${i} = ${i};`,
        'utf-8',
      );
    }
    const files = await collectTextFiles(root, [], { maxFiles: 10 });
    assert.equal(files.length, 10, 'should stop at maxFiles cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectTextFiles enforces depth limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-depth-'));
  try {
    // Create a directory 5 levels deep with a file at each level
    let current = root;
    for (let d = 0; d < 10; d++) {
      writeFileSync(join(current, `level_${d}.txt`), `depth ${d}`, 'utf-8');
      current = join(current, `sub_${d}`);
      mkdirSync(current);
    }
    // With maxDepth=4, we should get at most ~5 files (depths 0-4)
    const files = await collectTextFiles(root, [], { maxDepth: 4 });
    assert.ok(files.length <= 10, `should not recurse deep: got ${files.length}`);
    // Verify no files from depth 8+ were collected
    const deepFiles = files.filter((f) => f.includes('level_8') || f.includes('level_9'));
    assert.equal(deepFiles.length, 0, 'should skip files beyond depth limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectTextFiles skips build and cache directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-skipdirs-'));
  try {
    // Create files in directories that should be skipped
    const skipDirs = ['node_modules', '.git', 'dist', 'target', '__pycache__', '.venv'];
    for (const dir of skipDirs) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'generated.ts'), 'export const junk = true;', 'utf-8');
    }
    // Create one legitimate file at root level
    writeFileSync(join(root, 'real.ts'), 'export const real = 1;', 'utf-8');

    const files = await collectTextFiles(root);
    assert.equal(files.length, 1, 'should only collect real.ts, skipping all cache dirs');
    assert.match(files[0] ?? '', /real\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectTextFiles defaults allow up to 50k files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-defaultcap-'));
  try {
    // Create 150 files — should all be collected (under the 50k default)
    for (let i = 0; i < 150; i++) {
      writeFileSync(
        join(root, `src_${String(i).padStart(4, '0')}.ts`),
        `export const v${i} = ${i};`,
        'utf-8',
      );
    }
    const files = await collectTextFiles(root);
    assert.equal(files.length, 150, '150 files under the 50k default cap should all be collected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
