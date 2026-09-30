import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  handleMemoryQuery,
  handleSemanticSearch,
  handleMemoryStore,
  resetChronicleStoreForTests,
} from './chronicleMemory.js';
import { globalIndexer } from '../services/indexer.js';
import { runWithExecutionContext } from '../agent/executionContext.js';

async function withChronicleEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  const originalLog = console.log;

  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  console.log = () => {};
  resetChronicleStoreForTests();

  try {
    return await fn();
  } finally {
    resetChronicleStoreForTests();
    console.log = originalLog;

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('Chronicle memory backends', () => {
  it('does not treat an ambient root seed as authorization for direct handlers', async () => {
    await withChronicleEnv({ BABEL_PROJECT_ROOT: path.join(tmpdir(), 'ambient-only') }, async () => {
      await assert.rejects(
        () => handleMemoryQuery({ tool: 'memory_query', key: 'owner' }),
        /requires execution context or an explicit root/,
      );
    });
  });

  it('keeps overlapping task roots isolated despite a process-wide root seed', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'babel-chronicle-overlap-'));
    try {
      await withChronicleEnv({
        BABEL_CHRONICLE_BACKEND: 'json',
        BABEL_CHRONICLE_JSON_PATH: path.join(tempRoot, 'chronicle.json'),
        BABEL_PROJECT_ROOT: path.join(tempRoot, 'wrong-root'),
        BABEL_LIVE: 'true',
      }, async () => {
        const roots = [path.join(tempRoot, 'A'), path.join(tempRoot, 'B')];
        await Promise.all(roots.map((root, index) => runWithExecutionContext({
          threadId: `thread-${index}`,
          turnId: `turn-${index}`,
          root,
          indexWritePolicy: 'allow',
        }, async () => {
          const stored = await handleMemoryStore({ tool: 'memory_store', key: 'owner', value: `task-${index}` }, root);
          assert.equal(stored.exit_code, 0);
          await Promise.resolve();
          const own = await handleMemoryQuery({ tool: 'memory_query', key: 'owner' }, root);
          assert.equal(own.stdout, `task-${index}`);
        })));
        await assert.rejects(() => runWithExecutionContext({
          threadId: 'thread-A', turnId: 'turn-A', root: roots[0]!, indexWritePolicy: 'allow',
        }, () => handleMemoryQuery({ tool: 'memory_query', key: 'owner' }, roots[1])), /authorized execution root/);
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('stores and queries facts through the JSON backend without SQLite', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'babel-chronicle-json-'));
    const jsonPath = path.join(tempRoot, 'chronicle.json');
    const projectRoot = path.join(tempRoot, 'project');

    try {
      await withChronicleEnv(
        {
          BABEL_CHRONICLE_BACKEND: 'json',
          BABEL_CHRONICLE_JSON_PATH: jsonPath,
          BABEL_PROJECT_ROOT: projectRoot,
          BABEL_LIVE: 'true',
        },
        async () => {
          const storeResult = await handleMemoryStore({
            tool: 'memory_store',
            key: 'phase',
            value: 'json backend active',
          }, projectRoot);

          assert.equal(storeResult.exit_code, 0);

          const queryResult = await handleMemoryQuery({
            tool: 'memory_query',
            key: 'phase',
          }, projectRoot);

          assert.equal(queryResult.exit_code, 0);
          assert.equal(queryResult.stdout, 'json backend active');

          const allResult = await handleMemoryQuery({
            tool: 'memory_query',
            key: 'ALL',
          }, projectRoot);
          const rows = JSON.parse(allResult.stdout) as Array<Record<string, unknown>>;
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.['fact_key'], 'phase');
          assert.equal(rows[0]?.['fact_value'], 'json backend active');
        },
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns a Chronicle error for invalid backend configuration', async () => {
    await withChronicleEnv(
      {
        BABEL_CHRONICLE_BACKEND: 'bogus',
      },
      async () => {
        const result = await handleMemoryQuery({
          tool: 'memory_query',
          key: 'ALL',
        }, process.cwd());

        assert.equal(result.exit_code, 1);
        assert.match(result.stderr, /Invalid BABEL_CHRONICLE_BACKEND/);
      },
    );
  });

  it('does not create or rebuild a semantic index from the read-only lane', async () => {
    const projectRoot = path.join(tmpdir(), `babel-read-only-semantic-${Date.now()}`);
    const previousRoot = globalIndexer.indexedProjectRoot;
    await withChronicleEnv(
      {
        BABEL_PROJECT_ROOT: projectRoot,
        BABEL_READ_ONLY_NO_INDEX_WRITE: '1',
      },
      async () => {
        const result = await handleSemanticSearch({
          tool: 'semantic_search',
          query: 'anything',
        }, projectRoot);

        assert.equal(result.exit_code, 1);
        assert.match(result.stderr, /read-only lane/);
        assert.equal(globalIndexer.indexedProjectRoot, previousRoot);
      },
    );
  });
});
