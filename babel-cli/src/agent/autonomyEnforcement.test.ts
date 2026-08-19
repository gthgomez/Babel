import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  benchmarkAutoApproveEnabled,
  commandTextForAction,
  isCredentialTargetPath,
  resolveAutonomyPreset,
  resolveClassCGateDecision,
} from './autonomyEnforcement.js';
import type { AgentAction } from './actions.js';

// ─── Credential paths (P0-C) ─────────────────────────────────────────────────

test('isCredentialTargetPath: live credential stores are flagged', () => {
  assert.equal(isCredentialTargetPath('.env'), true);
  assert.equal(isCredentialTargetPath('.env.local'), true);
  assert.equal(isCredentialTargetPath('babel-cli/.env'), true);
  assert.equal(isCredentialTargetPath('C:\\proj\\.env.production'), true);
  assert.equal(isCredentialTargetPath('~/.ssh/id_rsa'), true);
  assert.equal(isCredentialTargetPath('secrets/credentials.json'), true);
  assert.equal(isCredentialTargetPath('.aws/credentials'), true);
  assert.equal(isCredentialTargetPath('keys/private.pem'), true);
  assert.equal(isCredentialTargetPath('.git-credentials'), true);
});

test('isCredentialTargetPath: non-credential paths are not flagged', () => {
  assert.equal(isCredentialTargetPath('.env.example'), false);
  assert.equal(isCredentialTargetPath('src/agent/policy.ts'), false);
  assert.equal(isCredentialTargetPath('config/model-policy.json'), false);
  assert.equal(isCredentialTargetPath('docs/architecture/HARNESS_ARCHITECTURE_V1.md'), false);
  assert.equal(isCredentialTargetPath('node_modules/.bin/tsx'), false);
  // .env.example.local is documentation, not a live store.
  assert.equal(isCredentialTargetPath('.env.example.local'), false);
});

// ─── Preset resolution (P0-A) ────────────────────────────────────────────────

test('resolveAutonomyPreset: plan is always read_only', () => {
  assert.equal(resolveAutonomyPreset('plan', null), 'read_only');
  assert.equal(resolveAutonomyPreset('plan', 'A'), 'read_only');
  assert.equal(resolveAutonomyPreset('plan', 'D'), 'read_only');
});

test('resolveAutonomyPreset: class D maps to read_only, C to workspace_write', () => {
  assert.equal(resolveAutonomyPreset('chat', 'D'), 'read_only');
  assert.equal(resolveAutonomyPreset('deep', 'D'), 'read_only');
  assert.equal(resolveAutonomyPreset('chat', 'C'), 'workspace_write');
});

test('resolveAutonomyPreset: A/B/unset keep workspace_write (status quo)', () => {
  assert.equal(resolveAutonomyPreset('chat', null), 'workspace_write');
  assert.equal(resolveAutonomyPreset('chat', 'A'), 'workspace_write');
  assert.equal(resolveAutonomyPreset('deep', 'B'), 'workspace_write');
});

// ─── Benchmark-mode gate (P0-B) ──────────────────────────────────────────────

test('benchmarkAutoApproveEnabled: unset env is disabled', () => {
  assert.equal(benchmarkAutoApproveEnabled({}), false);
  assert.equal(benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_AUTO_APPROVE: '0' }), false);
});

test('benchmarkAutoApproveEnabled: honored in explicit benchmark mode', () => {
  assert.equal(
    benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_AUTO_APPROVE: '1', BABEL_BENCHMARK_MODE: '1' }),
    true,
  );
});

test('benchmarkAutoApproveEnabled: headless/CI does not establish benchmark authority', () => {
  // P0-4: headless/CI NEVER establishes benchmark authority — both
  // BABEL_BENCHMARK_AUTO_APPROVE=1 and BABEL_BENCHMARK_MODE=1 are required.
  assert.equal(
    benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_AUTO_APPROVE: '1', CI: 'true' }),
    false,
  );
  assert.equal(
    benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_AUTO_APPROVE: '1', BABEL_HEADLESS: '1' }),
    false,
  );
});

test('benchmarkAutoApproveEnabled: benchmark mode without auto-approve fails closed', () => {
  // P0-4: both flags are required — BABEL_BENCHMARK_MODE alone grants nothing.
  assert.equal(benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_MODE: '1' }), false);
});

test('resolveClassCGateDecision: TTY and headless make the same authority decision', () => {
  assert.equal(
    resolveClassCGateDecision({ executionProfile: 'chat', isTTY: false, env: { CI: 'true' } }),
    'authority',
  );
  assert.equal(
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: false,
      env: { BABEL_HEADLESS: '1' },
    }),
    'authority',
  );
  assert.equal(
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: true,
      env: { BABEL_BENCHMARK_AUTO_APPROVE: '1', CI: 'true' },
    }),
    'authority',
  );
  assert.equal(
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: true,
      env: { BABEL_BENCHMARK_AUTO_APPROVE: '1' },
    }),
    'authority',
  );
  assert.equal(
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: true,
      env: {},
    }),
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: false,
      env: { CI: 'true' },
    }),
  );
  assert.equal(
    resolveClassCGateDecision({
      executionProfile: 'chat',
      isTTY: false,
      env: { BABEL_BENCHMARK_AUTO_APPROVE: '1', BABEL_BENCHMARK_MODE: '1' },
    }),
    'allow',
  );
  assert.equal(
    resolveClassCGateDecision({ executionProfile: 'plan', isTTY: true, env: {} }),
    'deny',
  );
});

test('benchmarkAutoApproveEnabled: interactive TTY without benchmark mode fails closed', () => {
  // The bypass the audit found: env var set in an interactive session with no
  // benchmark marker must NOT grant auto-approval.
  assert.equal(benchmarkAutoApproveEnabled({ BABEL_BENCHMARK_AUTO_APPROVE: '1' }), false);
});

// ─── Command text extraction ─────────────────────────────────────────────────

test('commandTextForAction: extracts from run_command/test_run only', () => {
  const run: AgentAction = { type: 'run_command', command: 'git push --force origin main' };
  const testRun: AgentAction = { type: 'test_run', command: 'npm test' };
  const read: AgentAction = { type: 'read_file', path: '.env' };
  assert.equal(commandTextForAction(run), 'git push --force origin main');
  assert.equal(commandTextForAction(testRun), 'npm test');
  assert.equal(commandTextForAction(read), null);
});
