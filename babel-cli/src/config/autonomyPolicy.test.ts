/**
 * autonomyPolicy.test.ts — default-lease bridge for the V2 authority.
 *
 * Every default lease must satisfy the lease schema, express its class's
 * capability contract to the PDP, and combine correctly with the legacy
 * preset through decideWithLease (deny > ask > allow).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLeaseForAutonomyClass } from './autonomyPolicy.js';
import { parseLeaseJson, validateLease } from '../authority/lease.js';
import { decideActionRequest } from '../authority/pdp.js';
import { decideWithLease } from '../authority/wire.js';
import { buildBaseline } from '../authority/integrity.js';
import type { AgentAction } from '../agent/actions.js';
import type { PermissionPreset } from '../agent/policy.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLASSES = ['A', 'B', 'C', 'D'] as const;
type ClassName = (typeof CLASSES)[number];

function leaseFor(cls: ClassName) {
  return defaultLeaseForAutonomyClass(cls);
}

test('defaultLeaseForAutonomyClass: every class lease round-trips the schema', () => {
  for (const cls of CLASSES) {
    const lease = leaseFor(cls);
    const parsed = parseLeaseJson(JSON.stringify(lease));
    assert.equal(parsed.ok, true, `${cls} lease must parse`);
    if (!parsed.ok) continue;
    const validated = validateLease(parsed.lease);
    assert.equal(validated.ok, true, `${cls} lease must validate`);
  }
});

test('defaultLeaseForAutonomyClass: capability scoping per class', () => {
  const a = leaseFor('A');
  const b = leaseFor('B');
  const c = leaseFor('C');
  const d = leaseFor('D');

  // A: local only — no publication capability.
  assert.ok(a.allowedCapabilities.includes('edit_task_files'));
  assert.ok(!a.allowedCapabilities.includes('push_feature_branch'));

  // B/C: local + publication.
  assert.ok(b.allowedCapabilities.includes('push_feature_branch'));
  assert.ok(c.allowedCapabilities.includes('push_feature_branch'));

  // D: read-only inspection only.
  assert.ok(d.allowedCapabilities.includes('inspect_repository'));
  assert.ok(!d.allowedCapabilities.includes('edit_task_files'));
  assert.ok(!d.allowedCapabilities.includes('run_tests'));

  // Gated capabilities never appear in allowedCapabilities.
  for (const cls of CLASSES) {
    const lease = leaseFor(cls);
    for (const gated of ['merge', 'force_push', 'release', 'credential_access'] as const) {
      assert.ok(
        !lease.allowedCapabilities.includes(gated),
        `${cls} lease must not allow ${gated}`,
      );
    }
  }
});

test('defaultLeaseForAutonomyClass: determinism and leaseId override', () => {
  assert.deepEqual(leaseFor('A'), defaultLeaseForAutonomyClass('A'));
  assert.deepEqual(leaseFor('D'), defaultLeaseForAutonomyClass('D'));
  assert.equal(leaseFor('A').leaseId, 'default-a');
  assert.equal(leaseFor('C').leaseId, 'default-c');
  const custom = defaultLeaseForAutonomyClass('A', { leaseId: 'session-42' });
  assert.equal(custom.leaseId, 'session-42');
});

test('PDP: class leases decide their contract', () => {
  // A: local allow, publication deny (not in lease).
  const a = leaseFor('A');
  assert.equal(decideActionRequest({ capability: 'run_tests' }, a).outcome, 'allow');
  assert.equal(
    decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'feat/x' }, a)
      .outcome,
    'deny',
  );

  // B: publication verify.
  const b = leaseFor('B');
  assert.equal(
    decideActionRequest({ capability: 'push_feature_branch', destinationBranch: 'feat/x' }, b)
      .outcome,
    'verify',
  );

  // D: read-only allow; mutations deny.
  const d = leaseFor('D');
  assert.equal(decideActionRequest({ capability: 'inspect_repository' }, d).outcome, 'allow');
  assert.equal(decideActionRequest({ capability: 'edit_task_files' }, d).outcome, 'deny');
});

test('decideWithLease: deny > ask > allow — preset deny beats PDP ask (Class D)', () => {
  const d = leaseFor('D');
  const run: AgentAction = { type: 'run_command', command: 'gh pr merge 5' };
  const preset: PermissionPreset = 'read_only';
  const root = mkdtempSync(join(tmpdir(), 'babel-autonomy-'));
  const result = decideWithLease(run, preset, {
    lease: d,
    baseline: { repoRoot: root, manifest: buildBaseline(root) },
  });
  assert.equal(result.decision, 'deny', 'read_only preset deny must beat PDP ask');
});
