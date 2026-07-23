import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  handleMemoryQuery,
  handleMemoryStore,
  resetChronicleStoreForTests,
} from './chronicleMemory.js';

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
          });

          assert.equal(storeResult.exit_code, 0);

          const queryResult = await handleMemoryQuery({
            tool: 'memory_query',
            key: 'phase',
          });

          assert.equal(queryResult.exit_code, 0);
          assert.equal(queryResult.stdout, 'json backend active');

          const allResult = await handleMemoryQuery({
            tool: 'memory_query',
            key: 'ALL',
          });
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
        });

        assert.equal(result.exit_code, 1);
        assert.match(result.stderr, /Invalid BABEL_CHRONICLE_BACKEND/);
      },
    );
  });
});
