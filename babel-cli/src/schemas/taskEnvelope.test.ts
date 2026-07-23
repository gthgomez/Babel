/**
 * taskEnvelope.test.ts — Structured goal envelope schema and loader
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TaskEnvelopeSchema,
  loadTaskEnvelope,
  formatTaskEnvelopeLines,
  setActiveTaskEnvelope,
  getActiveTaskEnvelope,
  clearActiveTaskEnvelope,
  enforceActiveTaskEnvelope,
  resetFileWriteCount,
} from './taskEnvelope.js';

// ─── TaskEnvelopeSchema.parse ─────────────────────────────────────────────────

test('TaskEnvelopeSchema.parse: validates minimal valid envelope', () => {
  const result = TaskEnvelopeSchema.parse({
    goal: 'Fix the login bug',
  });

  assert.equal(result.schema_version, 1);
  assert.equal(result.goal, 'Fix the login bug');
  assert.equal(result.mode, 'read_only');
  assert.equal(result.approvalPolicy, 'auto_safe');
  assert.equal(result.networkAccess, 'read_only');
});

test('TaskEnvelopeSchema.parse: accepts all fields', () => {
  const result = TaskEnvelopeSchema.parse({
    goal: 'Deploy to production',
    mode: 'mutate_gated',
    allowedTools: ['file_write', 'shell_exec'],
    deniedTools: ['web_search'],
    maxFileWrites: 10,
    protectedPaths: ['/etc/', '/secrets/'],
    approvalPolicy: 'ask_before_mutation',
    networkAccess: 'full',
    timeoutSeconds: 300,
    requiredVerifiers: ['npm test', 'npm run lint'],
  });

  assert.equal(result.goal, 'Deploy to production');
  assert.equal(result.mode, 'mutate_gated');
  assert.deepEqual(result.allowedTools, ['file_write', 'shell_exec']);
  assert.deepEqual(result.deniedTools, ['web_search']);
  assert.equal(result.maxFileWrites, 10);
  assert.deepEqual(result.protectedPaths, ['/etc/', '/secrets/']);
  assert.equal(result.approvalPolicy, 'ask_before_mutation');
  assert.equal(result.networkAccess, 'full');
  assert.equal(result.timeoutSeconds, 300);
  assert.deepEqual(result.requiredVerifiers, ['npm test', 'npm run lint']);
});

test('TaskEnvelopeSchema.parse: rejects invalid mode', () => {
  assert.throws(() => {
    TaskEnvelopeSchema.parse({ goal: 'test', mode: 'invalid_mode' });
  });
});

test('TaskEnvelopeSchema.parse: rejects empty goal', () => {
  assert.throws(() => {
    TaskEnvelopeSchema.parse({ goal: '' });
  });
});

test('TaskEnvelopeSchema.parse: applies defaults for optional fields', () => {
  const result = TaskEnvelopeSchema.parse({ goal: 'test' });

  assert.equal(result.schema_version, 1);
  assert.equal(result.mode, 'read_only');
  assert.equal(result.approvalPolicy, 'auto_safe');
  assert.equal(result.networkAccess, 'read_only');
  assert.equal(result.allowedTools, undefined);
  assert.equal(result.deniedTools, undefined);
  assert.equal(result.maxFileWrites, undefined);
  assert.equal(result.timeoutSeconds, undefined);
  assert.equal(result.requiredVerifiers, undefined);
});

test('TaskEnvelopeSchema.parse: allows plan_only mode', () => {
  const result = TaskEnvelopeSchema.parse({ goal: 'Plan the feature', mode: 'plan_only' });
  assert.equal(result.mode, 'plan_only');
});

// ─── loadTaskEnvelope ────────────────────────────────────────────────────────

test('loadTaskEnvelope: returns loaded=false for non-existent path', () => {
  const result = loadTaskEnvelope('/nonexistent/path/to/file.json');
  assert.equal(result.loaded, false);
});

test('loadTaskEnvelope: returns loaded=false when no path given and no .babel/task-envelope.json exists', () => {
  const result = loadTaskEnvelope();
  assert.equal(result.loaded, false);
});

// ─── formatTaskEnvelopeLines ──────────────────────────────────────────────────

test('formatTaskEnvelopeLines: produces expected output for minimal envelope', () => {
  const envelope = TaskEnvelopeSchema.parse({ goal: 'Fix the bug' });
  const lines = formatTaskEnvelopeLines(envelope);

  assert.ok(lines.length >= 6);
  assert.equal(lines[0], '');
  assert.match(lines[1]!, /TASK ENVELOPE CONSTRAINTS/);
  assert.match(lines[2]!, /Goal: Fix the bug/);
  assert.match(lines[3]!, /Mode: read_only/);
  assert.match(lines[4]!, /Approval: auto_safe/);
  assert.match(lines[5]!, /Network: read_only/);
  // Last line should be blank
  assert.equal(lines[lines.length - 1], '');
});

test('formatTaskEnvelopeLines: includes optional fields when present', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'Deploy',
    mode: 'mutate_gated',
    allowedTools: ['file_write'],
    deniedTools: ['web_search'],
    maxFileWrites: 5,
    protectedPaths: ['/secrets/'],
    timeoutSeconds: 120,
    requiredVerifiers: ['npm test'],
  });
  const lines = formatTaskEnvelopeLines(envelope);

  const text = lines.join('\n');
  assert.match(text, /Allowed tools: file_write/);
  assert.match(text, /Denied tools: web_search/);
  assert.match(text, /Max file writes: 5/);
  assert.match(text, /Protected paths: \/secrets\//);
  assert.match(text, /Timeout: 120s/);
  assert.match(text, /Required verifiers: npm test/);
});

test('formatTaskEnvelopeLines: does not include optional fields when absent', () => {
  const envelope = TaskEnvelopeSchema.parse({ goal: 'Read only task' });
  const lines = formatTaskEnvelopeLines(envelope);

  const text = lines.join('\n');
  assert.equal(text.includes('Allowed tools:'), false);
  assert.equal(text.includes('Denied tools:'), false);
  assert.equal(text.includes('Max file writes:'), false);
  assert.equal(text.includes('Protected paths:'), false);
  assert.equal(text.includes('Timeout:'), false);
  assert.equal(text.includes('Required verifiers:'), false);
});

test('formatTaskEnvelopeLines: starts and ends with blank lines', () => {
  const envelope = TaskEnvelopeSchema.parse({ goal: 'test' });
  const lines = formatTaskEnvelopeLines(envelope);

  assert.equal(lines[0], '');
  assert.equal(lines[lines.length - 1], '');
});

test('formatTaskEnvelopeLines: lists all denied tools when multiple', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    deniedTools: ['web_search', 'web_fetch', 'shell_exec'],
  });
  const lines = formatTaskEnvelopeLines(envelope);

  assert.match(lines.join('\n'), /Denied tools: web_search, web_fetch, shell_exec/);
});

test('formatTaskEnvelopeLines: required verifiers use semicolon separator', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    requiredVerifiers: ['npm test', 'npm run lint'],
  });
  const lines = formatTaskEnvelopeLines(envelope);

  assert.match(lines.join('\n'), /Required verifiers: npm test; npm run lint/);
});

// ─── Phase 1a: Runtime enforcement ──────────────────────────────────────────

test('enforceActiveTaskEnvelope: returns null when no envelope is active', () => {
  clearActiveTaskEnvelope();
  const result = enforceActiveTaskEnvelope('file_write', 'run-1', 'src/test.ts');
  assert.equal(result, null);
});

test('enforceActiveTaskEnvelope: blocks denied tool', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    deniedTools: ['shell_exec'],
  });
  setActiveTaskEnvelope(envelope);
  const result = enforceActiveTaskEnvelope('shell_exec', 'run-1');
  assert.notEqual(result, null);
  assert.ok(result!.stderr.includes('denied'));
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: allows non-denied tool', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    deniedTools: ['shell_exec'],
  });
  setActiveTaskEnvelope(envelope);
  const result = enforceActiveTaskEnvelope('file_read', 'run-1');
  assert.equal(result, null);
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: blocks tool not in allowed list', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    allowedTools: ['file_read', 'directory_list'],
  });
  setActiveTaskEnvelope(envelope);
  const result = enforceActiveTaskEnvelope('file_write', 'run-1');
  assert.notEqual(result, null);
  assert.ok(result!.stderr.includes('not in the envelope allowed-tools'));
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: allows tool in allowed list', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    allowedTools: ['file_read', 'file_write'],
  });
  setActiveTaskEnvelope(envelope);
  const result = enforceActiveTaskEnvelope('file_read', 'run-1');
  assert.equal(result, null);
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: blocks network tools when networkAccess is none', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    networkAccess: 'none',
  });
  setActiveTaskEnvelope(envelope);
  assert.notEqual(enforceActiveTaskEnvelope('web_search', 'run-1'), null);
  assert.notEqual(enforceActiveTaskEnvelope('web_fetch', 'run-1'), null);
  assert.notEqual(enforceActiveTaskEnvelope('mcp_request', 'run-1'), null);
  // Non-network tools still allowed
  assert.equal(enforceActiveTaskEnvelope('file_read', 'run-1'), null);
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: blocks mutations in read_only mode', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    mode: 'read_only',
  });
  setActiveTaskEnvelope(envelope);
  assert.notEqual(enforceActiveTaskEnvelope('file_write', 'run-1'), null);
  assert.notEqual(enforceActiveTaskEnvelope('shell_exec', 'run-1'), null);
  assert.equal(enforceActiveTaskEnvelope('file_read', 'run-1'), null);
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: enforces maxFileWrites', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    mode: 'mutate_gated',
    maxFileWrites: 2,
  });
  setActiveTaskEnvelope(envelope);
  resetFileWriteCount('run-max');
  // First two writes allowed
  assert.equal(enforceActiveTaskEnvelope('file_write', 'run-max', 'a.ts'), null);
  assert.equal(enforceActiveTaskEnvelope('file_write', 'run-max', 'b.ts'), null);
  // Third write blocked
  const blocked = enforceActiveTaskEnvelope('file_write', 'run-max', 'c.ts');
  assert.notEqual(blocked, null);
  assert.ok(blocked!.stderr.includes('File write limit exceeded'));
  clearActiveTaskEnvelope();
});

test('enforceActiveTaskEnvelope: blocks writes to protected paths', () => {
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    mode: 'mutate_gated',
    protectedPaths: ['/secrets/', 'config/secret.ts'],
  });
  setActiveTaskEnvelope(envelope);
  assert.notEqual(enforceActiveTaskEnvelope('file_write', 'run-1', '/secrets/keys.env'), null);
  assert.notEqual(enforceActiveTaskEnvelope('file_write', 'run-1', 'config/secret.ts'), null);
  // Other paths allowed
  assert.equal(enforceActiveTaskEnvelope('file_write', 'run-1', 'src/app.ts'), null);
  clearActiveTaskEnvelope();
});

test('setActiveTaskEnvelope / getActiveTaskEnvelope / clearActiveTaskEnvelope cycle', () => {
  clearActiveTaskEnvelope();
  assert.equal(getActiveTaskEnvelope(), null);

  const envelope = TaskEnvelopeSchema.parse({ goal: 'test' });
  setActiveTaskEnvelope(envelope);
  assert.equal(getActiveTaskEnvelope()!.goal, 'test');

  clearActiveTaskEnvelope();
  assert.equal(getActiveTaskEnvelope(), null);
});

test('enforceActiveTaskEnvelope: deniedTools takes precedence over allowedTools', () => {
  // Schema prevents overlap, so test that deniedTools blocking works
  // even when a broader allowedTools list is set
  const envelope = TaskEnvelopeSchema.parse({
    goal: 'test',
    allowedTools: ['file_write', 'file_read'],
    deniedTools: ['shell_exec'], // Different tool — no overlap with allowed
  });
  setActiveTaskEnvelope(envelope);
  // shell_exec is denied even though file_write is allowed
  assert.notEqual(enforceActiveTaskEnvelope('shell_exec', 'run-1'), null);
  // file_read is in allowed list
  assert.equal(enforceActiveTaskEnvelope('file_read', 'run-1'), null);
  // grep is not in allowed list
  assert.notEqual(enforceActiveTaskEnvelope('grep', 'run-1'), null);
  clearActiveTaskEnvelope();
});
