import assert from 'node:assert/strict';
import test from 'node:test';
import { deniesReadOnlyChatAction, filterReadOnlyChatTools } from './chatReadOnly.js';
import type { ToolDefinition } from '../runners/base.js';
import { computeTerminalOutcome } from './chatEngineObservability.js';
import { detectAndBuildBlockedReport } from './chatEngineSupport.js';

test('completed read-only investigation does not claim an unverified patch', () => {
  assert.equal(computeTerminalOutcome({ finalStatus: 'completed', budgetExceeded: false, hasAnyWrites: false, readOnly: true }), 'NO_CHANGE_REQUIRED');
  assert.equal(computeTerminalOutcome({ finalStatus: 'completed', budgetExceeded: false, hasAnyWrites: true, readOnly: true }), 'UNVERIFIED_PATCH');
  assert.equal(computeTerminalOutcome({ finalStatus: 'failed', budgetExceeded: true, hasAnyWrites: false, readOnly: true }), 'BUDGET_EXHAUSTED');
});

// ── D03/F4: typed reason authority over prose ───────────────────────────────

function blockedReport(fields: Record<string, unknown>) {
  return { reason: 'diagnostic text', missing: 'diagnostic text', ...fields } as never;
}

test('F4: a typed blocked reason is authoritative for every code', () => {
  const base = { finalStatus: 'blocked' as const, budgetExceeded: false, hasAnyWrites: false };
  const outcome = (reason_code: string) =>
    computeTerminalOutcome({ ...base, blockedReport: blockedReport({ reason_code }) });
  assert.equal(outcome('external_dependency'), 'BLOCKED_EXTERNAL');
  assert.equal(outcome('permission_denied'), 'BLOCKED_POLICY');
  assert.equal(outcome('recovery_exhausted'), 'BLOCKED_POLICY');
  assert.equal(outcome('unsupported_operation'), 'BLOCKED_POLICY');
  assert.equal(outcome('provider_failure'), 'INFRA_FAILURE');
  assert.equal(outcome('verification_failed'), 'AGENT_FAILURE');
  assert.equal(outcome('budget_exhausted'), 'BUDGET_EXHAUSTED');
  assert.equal(outcome('cancelled'), 'CANCELLED');
});

test('F4: typed external_dependency is not overridden by policy-looking prose', () => {
  assert.equal(
    computeTerminalOutcome({
      finalStatus: 'blocked',
      budgetExceeded: false,
      hasAnyWrites: false,
      blockedReport: blockedReport({
        reason_code: 'external_dependency',
        reason: 'policy gate rejected the work',
        missing: 'policy approval',
      }),
    }),
    'BLOCKED_EXTERNAL',
  );
});

test('F4: an explicit unknown reason fabricates neither policy nor external blame', () => {
  assert.equal(
    computeTerminalOutcome({
      finalStatus: 'blocked',
      budgetExceeded: false,
      hasAnyWrites: false,
      blockedReport: blockedReport({
        reason_code: 'unknown',
        cause_class: null,
        reason: 'BLOCKED: permission denied by policy',
        missing: 'policy',
      }),
    }),
    'NEEDS_HUMAN_DECISION',
  );
});

test('F4: legacy blocked text without a reason code keeps the prose fallback', () => {
  assert.equal(
    computeTerminalOutcome({
      finalStatus: 'blocked',
      budgetExceeded: false,
      hasAnyWrites: false,
      blockedReport: blockedReport({ reason: 'zero_write hard stop', missing: 'a patch' }),
    }),
    'BLOCKED_POLICY',
  );
});

test('F4: model prose cannot synthesize a policy block report', () => {
  // A stray uppercase word in prose is not a protocol declaration.
  assert.equal(
    detectAndBuildBlockedReport('The build is BLOCKED on I/O.', [
      { tool: 'read_file', target: 'a.ts' },
    ]),
    null,
  );
  // A protocol declaration is detected but stamped cause-unknown.
  const report = detectAndBuildBlockedReport('BLOCKED: permission denied by policy', [
    { tool: 'read_file', target: 'a.ts' },
  ]);
  assert.ok(report, 'protocol declaration is detected');
  assert.equal(report.reason_code, 'unknown');
  assert.equal(report.cause_class, null);
});

test('read-only chat denies mutation and delegation before special-case dispatch', () => {
  for (const env of [{ BABEL_READ_ONLY: 'true' }, { BABEL_EXECUTION_PROFILE: 'read_only_audit' }]) {
    for (const action of ['write_file', 'str_replace', 'apply_patch', 'run_command', 'test_run', 'sub_agent', 'mcp_request', 'memory_query', 'search', 'semantic_search', 'future_tool']) {
      assert.equal(deniesReadOnlyChatAction(action, env), true, action);
    }
    for (const action of ['read_file', 'read_range', 'list_dir', 'grep', 'glob']) {
      assert.equal(deniesReadOnlyChatAction(action, env), false, action);
    }
  }
  assert.equal(deniesReadOnlyChatAction('write_file', {}), false);
});

test('read-only tool advertisement matches enforcement without changing normal chat', () => {
  const definitions = ['read_file', 'read_range', 'grep', 'glob', 'list_dir', 'run_command', 'sub_agent', 'write_file', 'search', 'future_tool'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })) as ToolDefinition[];
  for (const env of [{ BABEL_READ_ONLY: 'true' }, { BABEL_EXECUTION_PROFILE: 'read_only_audit' }]) {
    assert.deepEqual(filterReadOnlyChatTools(definitions, env).map(tool => tool.function.name), ['read_file', 'read_range', 'grep', 'glob', 'list_dir']);
  }
  assert.equal(filterReadOnlyChatTools(definitions, {}), definitions);
});
