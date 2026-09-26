import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
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

test('a capped reindex retains existing files outside the partial walk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-index-partial-'));
  const indexer = new SemanticIndexer();
  try {
    writeFileSync(join(root, 'a.ts'), 'export const AlphaNeedle = 1;');
    writeFileSync(join(root, 'z.ts'), 'export const ZetaNeedle = 2;');
    await indexer.indexProject(root);
    assert.equal(indexer.search('ZetaNeedle').length, 1);
    await indexer.indexProject(root, { maxFiles: 1 });
    assert.equal(indexer.search('ZetaNeedle').length, 1);
  } finally {
    indexer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo map marks a missing requested target incomplete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repo-map-missing-'));
  try {
    const map = await buildRepoMap(root, { target: 'missing' });
    assert.equal(map.coverage?.target_exists, false);
    assert.equal(map.coverage?.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not attribute an earlier root file to a directory at the same path', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-root-bound-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  const indexer = new SemanticIndexer(join(temp, 'index', 'fts.db'));
  try {
    mkdirSync(join(first, 'src'), { recursive: true });
    mkdirSync(join(second, 'src', 'shared.ts'), { recursive: true });
    writeFileSync(join(first, 'src', 'shared.ts'), 'export const AlphaPrivateNeedle = 1;');
    writeFileSync(join(second, 'own.ts'), 'export const BetaOwnedNeedle = 2;');
    await indexer.indexProject(first);

    const result = await indexer.withProjectIndex(second, true, async () => ({
      foreign: indexer.search('AlphaPrivateNeedle'),
      owned: indexer.search('BetaOwnedNeedle'),
    }));
    assert.deepEqual(result.foreign, []);
    assert.deepEqual(result.owned.map((hit) => hit.name), ['own.ts']);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a same-path symlink replacement removes the earlier indexed source', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-symlink-replace-'));
  const root = join(temp, 'project');
  const external = join(temp, 'external.ts');
  const indexer = new SemanticIndexer(join(temp, 'index', 'fts.db'));
  try {
    mkdirSync(root);
    const path = join(root, 'owned.ts');
    writeFileSync(path, 'export const FormerOwnedNeedle = 1;');
    writeFileSync(external, 'export const ExternalPrivateNeedle = 2;');
    await indexer.indexProject(root);
    assert.equal(indexer.search('FormerOwnedNeedle').length, 1);
    unlinkSync(path);
    try {
      symlinkSync(external, path, 'file');
    } catch (error) {
      t.skip(`file symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await indexer.indexProject(root);
    assert.deepEqual(indexer.search('FormerOwnedNeedle'), []);
    assert.deepEqual(indexer.search('ExternalPrivateNeedle'), []);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('index batch yield cannot admit a newly swapped outside-root symlink', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-symlink-race-'));
  const root = join(temp, 'project');
  const external = join(temp, 'external.ts');
  const indexer = new SemanticIndexer(join(temp, 'index', 'fts.db'));
  try {
    mkdirSync(root);
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, `a${String(i).padStart(2, '0')}.ts`), `export const Local${i} = 1;`);
    }
    const last = join(root, 'z.ts');
    writeFileSync(last, 'export const OriginalOwnedNeedle = 1;');
    writeFileSync(external, 'export const OutsidePrivateNeedle = 1;');
    let swapped = false;
    let unavailable = false;
    await indexer.indexProject(root, { onProgress: () => {
      if (swapped || unavailable) return;
      unlinkSync(last);
      try {
        symlinkSync(external, last, 'file');
        swapped = true;
      } catch {
        unavailable = true;
      }
    } });
    if (unavailable) {
      t.skip('file symlink unavailable on this host');
      return;
    }
    assert.equal(swapped, true);
    assert.deepEqual(indexer.search('OutsidePrivateNeedle'), []);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('does not create an index from read-only access after close', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-readonly-'));
  const root = join(temp, 'project');
  const db = join(temp, 'index', 'fts.db');
  const indexer = new SemanticIndexer(db);
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'file.ts'), 'export const OwnedNeedle = 1;');
    await indexer.indexProject(root);
    indexer.close();
    rmSync(join(temp, 'index'), { recursive: true, force: true });
    await assert.rejects(indexer.withProjectIndex(root, false, async () => indexer.search('OwnedNeedle')));
    assert.equal(existsSync(db), false);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an already-open FTS read does not lazily initialize a vector table', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-vector-readonly-'));
  const root = join(temp, 'project');
  const indexer = new SemanticIndexer(join(temp, 'index.db'));
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'file.ts'), 'export const OwnedNeedle = 1;');
    await indexer.indexProject(root);
    indexer.setEmbeddingFunction(() => new Float32Array(384));
    assert.equal(indexer.vectorIndex, null);
    const hits = await indexer.withProjectIndex(root, false,
      () => indexer.searchWithEmbedding('OwnedNeedle'));
    assert.equal(hits.length, 1);
    assert.equal(indexer.vectorIndex, null);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('retiring an index during a yielded batch prevents late readiness', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-retire-'));
  const root = join(temp, 'project');
  const indexer = new SemanticIndexer(join(temp, 'index', 'fts.db'));
  try {
    mkdirSync(root);
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, `file-${String(i).padStart(2, '0')}.ts`), `export const OwnedNeedle${i} = ${i};`);
    }
    await assert.rejects(indexer.indexProject(root, { onProgress: () => indexer.close() }));
    assert.equal(indexer.indexedProjectRoot, null);
    assert.equal(indexer.count, 0);
    await assert.rejects(indexer.withProjectIndex(root, false, async () => indexer.search('OwnedNeedle0')));
    assert.equal(await indexer.indexProject(root), 50);
    assert.equal(indexer.search('OwnedNeedle0').length, 1);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('closing an owned search while its callback awaits rejects the retired result', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-search-retire-'));
  const root = join(temp, 'project');
  const indexer = new SemanticIndexer(join(temp, 'index.db'));
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'owned.ts'), 'export const OwnedNeedle = 1;');
    await indexer.indexProject(root);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = indexer.withProjectIndex(root, false, async () => {
      const hits = indexer.search('OwnedNeedle');
      started();
      await waiting;
      return hits;
    });
    await callbackStarted;
    indexer.close();
    release();
    await assert.rejects(pending, /retired/);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('failed root switch cannot publish a mixed corpus', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-failed-switch-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  const indexer = new SemanticIndexer(join(temp, 'index', 'fts.db'));
  try {
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'owned.ts'), 'export const FirstOwnedNeedle = 1;');
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(second, `file-${String(i).padStart(2, '0')}.ts`), `export const SecondOwnedNeedle${i} = ${i};`);
    }
    await indexer.indexProject(first);
    await assert.rejects(indexer.indexProject(second, { onProgress: () => { throw new Error('stop replacement'); } }));
    assert.equal(indexer.indexedProjectRoot, first);
    assert.deepEqual(indexer.search('SecondOwnedNeedle0'), []);
    assert.equal(indexer.search('FirstOwnedNeedle').length, 1);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('scopes a small repo-map budget to the requested target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-map-target-budget-'));
  try {
    writeFileSync(join(root, 'a.ts'), 'export const unrelatedA = 1;');
    writeFileSync(join(root, 'b.ts'), 'export const unrelatedB = 2;');
    mkdirSync(join(root, 'zzz', 'target'), { recursive: true });
    writeFileSync(join(root, 'zzz', 'target', 'fix.ts'), 'export function targetFix() { return 1; }');
    const map = await buildRepoMap(root, { target: 'zzz/target', limit: 2 });
    assert.deepEqual(map.entries.map((entry) => entry.path), ['zzz/target/fix.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a repo-map target outside the requested root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-map-target-escape-'));
  try {
    writeFileSync(join(root, 'inside.ts'), 'export const inside = 1;');
    await assert.rejects(buildRepoMap(root, { target: '../outside' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo-map directory target matches path segments rather than sibling prefixes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-map-target-segments-'));
  try {
    mkdirSync(join(root, 'src', 'a'), { recursive: true });
    mkdirSync(join(root, 'src', 'ab'), { recursive: true });
    writeFileSync(join(root, 'src', 'a', 'own.ts'), 'export const own = 1;');
    writeFileSync(join(root, 'src', 'ab', 'other.ts'), 'export const other = 1;');
    const map = await buildRepoMap(root, { target: 'src/a' });
    assert.deepEqual(map.entries.map((entry) => entry.path), ['src/a/own.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo-map coverage reports when the depth fuse omits source files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-map-depth-coverage-'));
  try {
    let nested = root;
    for (let i = 0; i < 17; i++) {
      nested = join(nested, `level-${i}`);
      mkdirSync(nested);
    }
    writeFileSync(join(nested, 'deep.ts'), 'export const DeepNeedle = 1;');
    const map = await buildRepoMap(root);
    assert.equal(map.coverage?.complete, false);
    assert.equal(map.coverage?.depth_limited, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping project searches retain their own index root through the search', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-overlap-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  try {
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'one.ts'), 'export const firstUniqueNeedle = 1;', 'utf-8');
    writeFileSync(join(second, 'two.ts'), 'export const secondUniqueNeedle = 2;', 'utf-8');
    const indexer = new SemanticIndexer(join(temp, 'index.db'));
    const [a, b] = await Promise.all([
      indexer.withProjectIndex(first, true, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return indexer.search('firstUniqueNeedle');
      }),
      indexer.withProjectIndex(second, true, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return indexer.search('secondUniqueNeedle');
      }),
    ]);
    assert.deepEqual(a.map((hit) => hit.name), ['one.ts']);
    assert.deepEqual(b.map((hit) => hit.name), ['two.ts']);
    indexer.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('overlapping indexProject calls finish with the requested second root ready', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-two-roots-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  try {
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'one.ts'), 'export const firstOnlyNeedle = 1;', 'utf-8');
    writeFileSync(join(second, 'two.ts'), 'export const secondOnlyNeedle = 2;', 'utf-8');
    const indexer = new SemanticIndexer(join(temp, 'index.db'));
    const [firstCount, secondCount] = await Promise.all([
      indexer.indexProject(first), indexer.indexProject(second),
    ]);
    assert.equal(firstCount, 1);
    assert.equal(secondCount, 1);
    assert.equal(indexer.indexedProjectRoot, second);
    assert.deepEqual(indexer.search('secondOnlyNeedle').map((hit) => hit.name), ['two.ts']);
    assert.deepEqual(indexer.search('firstOnlyNeedle'), []);
    indexer.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an awaited vector query cannot resolve hits from a replacement root', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'babel-index-vector-retire-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  const indexer = new SemanticIndexer(join(temp, 'index.db'));
  try {
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'first.ts'), 'export const FirstVectorNeedle = 1;');
    writeFileSync(join(second, 'second.ts'), 'export const SecondVectorNeedle = 2;');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    indexer.setEmbeddingFunction(async (content) => {
      if (content === 'probe') {
        started();
        await waiting;
      }
      const vector = new Float32Array(384);
      vector[0] = 1;
      return vector;
    });
    await indexer.indexProject(first);
    if (!indexer.vectorIndex) {
      t.skip('sqlite-vec extension unavailable on this platform');
      return;
    }
    const pending = indexer.searchWithEmbedding('probe');
    await queryStarted;
    await indexer.indexProject(second);
    release();
    await assert.rejects(pending, /retired|unavailable/);
    assert.deepEqual(indexer.search('FirstVectorNeedle'), []);
    assert.equal(indexer.search('SecondVectorNeedle').length, 1);
  } finally {
    indexer.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an awaited vector query cannot publish a stale same-root revision', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-index-vector-revision-'));
  const indexer = new SemanticIndexer(join(root, 'index.db'));
  try {
    writeFileSync(join(root, 'owned.ts'), 'export const OldRevisionNeedle = 1;');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    indexer.setEmbeddingFunction(async (content) => {
      if (content === 'revision-probe') { started(); await waiting; }
      const vector = new Float32Array(384);
      vector[0] = 1;
      return vector;
    });
    await indexer.indexProject(root);
    if (!indexer.vectorIndex) {
      t.skip('sqlite-vec extension unavailable on this platform');
      return;
    }
    const pending = indexer.searchWithEmbedding('revision-probe');
    await queryStarted;
    writeFileSync(join(root, 'owned.ts'), 'export const NewRevisionNeedle = 2;');
    await indexer.indexProject(root);
    release();
    await assert.rejects(pending, /retired/);
    assert.equal(indexer.search('NewRevisionNeedle').length, 1);
    assert.deepEqual(indexer.search('OldRevisionNeedle'), []);
  } finally {
    indexer.close();
    rmSync(root, { recursive: true, force: true });
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
        projectRoot: root,
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
