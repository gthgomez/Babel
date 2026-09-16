import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolResultCache } from './toolResultCache.js';

test('failed mutating commands invalidate prior read/search results', () => {
  const cache = new ToolResultCache();
  const input = { path: 'src/example.ts', project_root: 'C:/project' };
  cache.set('file_read', input, { exit_code: 0, stdout: 'old', stderr: '' });
  assert.equal(cache.size, 1);
  cache.invalidateOnMutation('shell_exec', 1);
  assert.equal(cache.size, 0);
});

test('non-mutating failures do not evict unrelated cached observations', () => {
  const cache = new ToolResultCache();
  const input = { path: 'src/example.ts', project_root: 'C:/project' };
  cache.set('file_read', input, { exit_code: 0, stdout: 'old', stderr: '' });
  cache.invalidateOnMutation('grep', 1);
  assert.equal(cache.size, 1);
});
