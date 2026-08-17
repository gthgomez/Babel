/**
 * Frozen human-escalation matrix: escalation is driven by ambiguity, not
 * consequence class.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHumanEscalation } from './taskClarity.js';

const CODING = [
  'inspect_repository',
  'search_repository',
  'edit_task_files',
  'run_tests',
  'run_build',
  'run_lint',
  'run_typecheck',
];

const PUBLICATION = [...CODING, 'commit_ship_set', 'push_feature_branch'];

test('Fix CI on PR #88 with coding lease → autonomous', () => {
  const r = resolveHumanEscalation({ task: 'Fix CI on PR #88', allowedCapabilities: CODING });
  assert.equal(r.kind, 'autonomous');
  assert.equal(r.clarity.outcome, 'clear');
});

test('Commit and push this feature branch with publication → autonomous + verify', () => {
  const r = resolveHumanEscalation({
    task: 'Commit and push this feature branch',
    allowedCapabilities: PUBLICATION,
  });
  assert.equal(r.kind, 'autonomous_verify');
});

test('Merge PR #88 into main with merge granted → autonomous', () => {
  const r = resolveHumanEscalation({
    task: 'Merge PR #88 into main',
    allowedCapabilities: [...PUBLICATION, 'merge'],
  });
  assert.equal(r.kind, 'autonomous');
  assert.equal(r.clarity.outcome, 'clear');
});

test('Merge it with #88 and #90 both plausible → clarification', () => {
  const r = resolveHumanEscalation({
    task: 'Merge it',
    allowedCapabilities: [...PUBLICATION, 'merge'],
    candidates: { pullRequests: ['#88', '#90'] },
  });
  assert.equal(r.kind, 'clarification');
  if (r.clarity.outcome === 'needs_clarification') {
    assert.equal(r.clarity.reason, 'multiple_plausible_targets');
  }
});

test('Deploy to production without prod deploy → deny', () => {
  const r = resolveHumanEscalation({
    task: 'Deploy to production',
    allowedCapabilities: PUBLICATION,
  });
  assert.equal(r.kind, 'deny');
  assert.equal(r.reasonCode, 'DENY_MISSING_AUTHORITY');
});

test('Deploy it with staging+prod plausible and deploy granted → clarification', () => {
  const r = resolveHumanEscalation({
    task: 'Deploy it',
    allowedCapabilities: [...PUBLICATION, 'production_deploy'],
    candidates: { environments: ['staging', 'production'] },
  });
  assert.equal(r.kind, 'clarification');
  if (r.clarity.outcome === 'needs_clarification') {
    assert.equal(r.clarity.reason, 'ambiguous_environment');
  }
});

test('Force-push feat/x with force_push granted → autonomous verify', () => {
  const r = resolveHumanEscalation({
    task: 'Force-push feat/x',
    allowedCapabilities: [...PUBLICATION, 'force_push'],
  });
  assert.equal(r.kind, 'autonomous_verify');
  assert.equal(r.clarity.outcome, 'clear');
});

test('Force-push it with multiple candidate branches → clarification', () => {
  const r = resolveHumanEscalation({
    task: 'Force-push it',
    allowedCapabilities: [...PUBLICATION, 'force_push'],
    candidates: { branches: ['feat/a', 'feat/b'] },
  });
  assert.equal(r.kind, 'clarification');
});

test('Delete old remote branches with unclear set → clarification', () => {
  const r = resolveHumanEscalation({
    task: 'Delete old remote branches',
    allowedCapabilities: [...PUBLICATION, 'destructive_data_delete'],
  });
  assert.equal(r.kind, 'clarification');
  if (r.clarity.outcome === 'needs_clarification') {
    assert.equal(r.clarity.reason, 'ambiguous_destructive_scope');
  }
});

test('Expose the API key so I can inspect it → deny forbidden', () => {
  const r = resolveHumanEscalation({
    task: 'Expose the API key so I can inspect it',
    allowedCapabilities: [...PUBLICATION, 'credential_access'],
  });
  assert.equal(r.kind, 'deny');
  assert.equal(r.reasonCode, 'DENY_CREDENTIAL_READ');
});

test('Fix tests with coding lease → autonomous', () => {
  const r = resolveHumanEscalation({ task: 'Fix tests', allowedCapabilities: CODING });
  assert.equal(r.kind, 'autonomous');
});

test('Choose the best implementation → autonomous; no clarification', () => {
  const r = resolveHumanEscalation({
    task: 'Choose the best implementation',
    allowedCapabilities: CODING,
  });
  assert.equal(r.kind, 'autonomous');
  assert.equal(r.clarity.outcome, 'clear');
});

test('clarification cannot expand a missing merge capability', () => {
  const r = resolveHumanEscalation({
    task: 'Merge it',
    allowedCapabilities: CODING,
    candidates: { pullRequests: ['#88', '#90'] },
  });
  assert.equal(r.kind, 'deny');
  assert.equal(r.reasonCode, 'DENY_MISSING_AUTHORITY');
});
