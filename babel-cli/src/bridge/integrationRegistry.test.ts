import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IntegrationRegistry } from './integrationRegistry.js';

test('integration registry scopes and rotates one durable ACP principal per launch binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-registry-'));
  const protectedDir = join(root, 'private');
  mkdirSync(protectedDir, { mode: 0o700 });
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  mkdirSync(a);
  mkdirSync(b);
  mkdirSync(join(a, 'child'));
  const registry = new IntegrationRegistry(join(protectedDir, 'integration.sqlite'), (directory) => {
    assert.equal(directory, protectedDir);
  });
  try {
    registry.registerProject({ projectId: 'a', root: a });
    registry.registerProject({ projectId: 'b', root: b });
    assert.throws(() => registry.registerProject({ projectId: 'nested', root: join(a, 'child') }), /disjoint/);
    const integrationCredential = registry.registerIntegration({
      integrationId: 'happier', name: 'Synthetic bridge', allowedProjectIds: ['a'],
    });
    const denied = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'b', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.deepEqual(denied, { ok: false, reason: 'project_scope_denied' });
    const stale = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'stale', currentHostInstance: 'instance-a',
    });
    assert.deepEqual(stale, { ok: false, reason: 'stale_host_instance' });
    const created = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const old = created.session;
    assert.equal(registry.authenticateAcpSession(old.credential)?.principalId, old.principalId);
    const retry = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.session.principalId, old.principalId, 'retry reuses the same principal');
    assert.equal(retry.session.registrationGeneration, old.registrationGeneration + 1);
    assert.equal(registry.authenticateAcpSession(old.credential), null, 'rotation revokes lost-response credential');
    assert.equal(registry.authenticateAcpSession(retry.session.credential)?.principalId, old.principalId);
    const conflict = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'different-launch',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.deepEqual(conflict, { ok: false, reason: 'registration_fingerprint_conflict' });

    registry.registerProject({ projectId: 'a', root: a });
    assert.equal(registry.authenticateAcpSession(retry.session.credential), null, 'project generation change fences old grants');
    assert.deepEqual(registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    }), { ok: false, reason: 'registration_fingerprint_conflict' }, 'stale project grants cannot be revived by retry');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
