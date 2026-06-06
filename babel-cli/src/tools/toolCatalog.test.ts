import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolCatalog, formatToolCatalogHuman } from './toolCatalog.js';
import type { ExecutorToolSnapshot } from './executorRegistry.js';

const TOOLS: ExecutorToolSnapshot[] = [
  {
    name: 'file_read',
    category: 'filesystem',
    description: 'Read a file.',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['read'],
    input: { required: ['path'], optional: [] },
  },
  {
    name: 'file_write',
    category: 'filesystem',
    description: 'Write a file.',
    mutating: true,
    dryRunBehavior: 'shadow_write',
    policyTags: ['write'],
    input: { required: ['path', 'content'], optional: [] },
  },
];

test('tool catalog explains run-level allowed and denied tools', () => {
  const catalog = buildToolCatalog(TOOLS, {
    allowedTools: ['file_read'],
    disallowedTools: ['file_write'],
  });

  assert.equal(catalog.find(entry => entry.name === 'file_read')?.policy.status, 'allowed');
  const writePolicy = catalog.find(entry => entry.name === 'file_write')?.policy;
  assert.equal(writePolicy?.status, 'disabled');
  assert.match(writePolicy?.reasons.join('\n') ?? '', /disallowed_tools/);
});

test('tool catalog can include profile-scoped capabilities', () => {
  const catalog = buildToolCatalog(TOOLS, {
    executionProfile: 'benchmark_container',
    includeCapabilities: true,
  });

  const capability = catalog.find(entry => entry.name === 'inspect.git_bundle');
  assert.equal(capability?.kind, 'capability');
  assert.equal(capability?.policy.status, 'advisory');
  assert.deepEqual(capability?.requirements, ['git']);
  assert.match(formatToolCatalogHuman(catalog), /inspect\.git_bundle/);
});
