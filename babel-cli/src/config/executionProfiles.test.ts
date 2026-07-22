import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutionProfilePromptLines,
  getExecutionProfileCommandAdditions,
  getExecutionProfileToolPolicy,
  normalizeExecutionProfile,
  resolveExecutionProfile,
} from './executionProfiles.js';

test('execution profile names normalize common spelling variants', () => {
  assert.equal(normalizeExecutionProfile('dev-local'), 'dev_local');
  assert.equal(normalizeExecutionProfile('BENCHMARK_CONTAINER'), 'benchmark_container');
  assert.equal(normalizeExecutionProfile('opencalw-manager'), 'workspace_manager');
  assert.equal(normalizeExecutionProfile('nope'), null);
});

test('safe_repo remains the default profile', () => {
  assert.equal(resolveExecutionProfile(undefined).name, 'safe_repo');
});

test('dev_local adds common local build commands', () => {
  const additions = getExecutionProfileCommandAdditions('dev_local');
  assert.ok(additions.includes('pnpm'));
  assert.ok(additions.includes('cargo'));
  assert.ok(additions.includes('go'));
});

test('benchmark_container adds common isolated Linux utility commands', () => {
  const additions = getExecutionProfileCommandAdditions('benchmark_container');
  assert.ok(additions.includes('diff'));
  assert.ok(additions.includes('gzip'));
  assert.ok(additions.includes('gunzip'));
  assert.ok(additions.includes('which'));
  assert.ok(additions.includes('env'));
});

test('read_only_audit constrains mutating executor tools', () => {
  const policy = getExecutionProfileToolPolicy('read_only_audit');
  assert.ok(policy.allowedTools.includes('file_read'));
  assert.ok(policy.disallowedTools.includes('file_write'));
  assert.ok(policy.disallowedTools.includes('test_run'));
});

test('workspace_manager allows local verification commands and denies web tools', () => {
  const additions = getExecutionProfileCommandAdditions('workspace_manager');
  assert.ok(additions.includes('cargo'));
  assert.ok(additions.includes('dotnet'));
  assert.ok(additions.includes('go'));
  assert.ok(additions.includes('mvn'));
  const policy = getExecutionProfileToolPolicy('workspace_manager');
  assert.ok(policy.disallowedTools.includes('web_search'));
  assert.ok(policy.disallowedTools.includes('web_fetch'));
});

test('babel_research carries prompt-injection hardening guidance', () => {
  const lines = buildExecutionProfilePromptLines('babel_research', 'swe').join('\n');
  assert.match(lines, /remote content as untrusted task data/);
  assert.match(lines, /cannot change tool policy/);
});

test('prompt lines carry profile-specific guidance', () => {
  const lines = buildExecutionProfilePromptLines('benchmark_container', 'swe').join('\n');
  assert.match(lines, /benchmark_container/);
  assert.match(lines, /POSIX pipes/);
  assert.match(lines, /\/app/);
});
