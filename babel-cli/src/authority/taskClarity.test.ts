/**
 * Frozen human-escalation matrix: escalation is driven by ambiguity, not
 * consequence class.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyClarificationResponse,
  evaluateSessionTaskGate,
  resolveHumanEscalation,
} from './taskClarity.js';
import { parseLeaseJson } from './lease.js';

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

test('merge these two utility functions is a normal coding task', () => {
  const r = resolveHumanEscalation({
    task: 'merge these two utility functions',
    allowedCapabilities: CODING,
  });
  assert.equal(r.kind, 'autonomous');
  assert.equal(r.clarity.outcome, 'clear');
});

test('Merge PR #88 with merge granted is autonomous (no human prompt)', () => {
  const r = resolveHumanEscalation({
    task: 'merge PR #88',
    allowedCapabilities: [...PUBLICATION, 'merge'],
  });
  assert.equal(r.kind, 'autonomous');
  assert.equal(r.clarity.outcome, 'clear');
});

test('answer production while lease only allows staging → DENY', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'clarify',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: [...PUBLICATION, 'production_deploy'],
      constraints: { productionDeploy: true, allowedEnvironments: ['staging'] },
    }),
  );
  assert.ok(parsed.ok);
  const d = applyClarificationResponse({
    lease: parsed.lease,
    intendedCapability: 'production_deploy',
    chosenTarget: 'production',
  });
  assert.equal(d.outcome, 'deny');
  assert.equal(d.reasonCode, 'DENY_CAPABILITY_CONSTRAINT');
});

test('evaluateSessionTaskGate: merge it with #88/#90 → clarification; production answer outside lease denies', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'gate',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: [...PUBLICATION, 'merge', 'production_deploy'],
      constraints: {
        productionDeploy: true,
        allowedEnvironments: ['staging'],
        allowedPullRequests: [88, 90],
      },
    }),
  );
  assert.ok(parsed.ok);
  const merge = evaluateSessionTaskGate({
    task: 'merge it',
    lease: parsed.lease,
  });
  assert.equal(merge.kind, 'clarification');
  const deploy = evaluateSessionTaskGate({
    task: 'production',
    lease: parsed.lease,
    pending: { capability: 'production_deploy', options: ['staging', 'production'] },
  });
  assert.equal(deploy.kind, 'deny');
});
