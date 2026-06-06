import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isExecutorToolShapePlaceholder,
  replaceExecutorRequestTarget,
} from './executorToolShape.js';

test('executor tool-shape placeholder detection accepts known placeholders only', () => {
  assert.equal(isExecutorToolShapePlaceholder('<project-relative-path>'), true);
  assert.equal(isExecutorToolShapePlaceholder('<cmd-without-cmd-slash-c-or-cd>'), true);
  assert.equal(isExecutorToolShapePlaceholder('src/index.ts'), false);
  assert.equal(isExecutorToolShapePlaceholder('<not-a-contract-token>'), false);
});

test('executor request target replacement preserves tool-specific target fields', () => {
  assert.deepEqual(
    replaceExecutorRequestTarget({ tool: 'file_read', path: '<project-relative-path>' }, 'src/index.ts'),
    { tool: 'file_read', path: 'src/index.ts' },
  );

  assert.deepEqual(
    replaceExecutorRequestTarget({ tool: 'shell_exec', command: '<cmd-without-cmd-slash-c-or-cd>' }, 'npm test'),
    { tool: 'shell_exec', command: 'npm test' },
  );

  assert.deepEqual(
    replaceExecutorRequestTarget({ tool: 'mcp_request', server: 'demo', query: 'ping' }, 'ignored'),
    { tool: 'mcp_request', server: 'demo', query: 'ping' },
  );
});
