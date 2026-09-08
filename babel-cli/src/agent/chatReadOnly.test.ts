import assert from 'node:assert/strict';
import test from 'node:test';
import { deniesReadOnlyChatAction } from './chatReadOnly.js';
import { computeTerminalOutcome } from './chatEngineObservability.js';

test('completed read-only investigation does not claim an unverified patch', () => {
  assert.equal(computeTerminalOutcome({ finalStatus: 'completed', budgetExceeded: false, hasAnyWrites: false, readOnly: true }), 'NO_CHANGE_REQUIRED');
  assert.equal(computeTerminalOutcome({ finalStatus: 'completed', budgetExceeded: false, hasAnyWrites: true, readOnly: true }), 'UNVERIFIED_PATCH');
  assert.equal(computeTerminalOutcome({ finalStatus: 'failed', budgetExceeded: true, hasAnyWrites: false, readOnly: true }), 'BUDGET_EXHAUSTED');
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
