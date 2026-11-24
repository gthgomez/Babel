import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
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
    assert.equal(registry.authenticateAcpSession(old.credential, 'instance-a')?.principalId, old.principalId);
    const retry = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.session.principalId, old.principalId, 'retry reuses the same principal');
    assert.equal(retry.session.registrationGeneration, old.registrationGeneration + 1);
    assert.equal(registry.authenticateAcpSession(old.credential, 'instance-a'), null, 'rotation revokes lost-response credential');
    assert.equal(registry.authenticateAcpSession(retry.session.credential, 'instance-a')?.principalId, old.principalId);
    const conflict = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'different-launch',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.deepEqual(conflict, { ok: false, reason: 'registration_fingerprint_conflict' });

    assert.equal(registry.authenticateAcpSession(retry.session.credential, 'instance-b'), null,
      'the previous host instance credential cannot authenticate on a restarted gateway');
    const requalified = registry.requalifyAcpSession({
      integrationCredential, principalId: retry.session.principalId, requestId: 'requal-1',
      sessionBinding: 'launch-a', expectedHostInstance: 'instance-b', currentHostInstance: 'instance-b',
    });
    assert.equal(requalified.ok, true);
    if (!requalified.ok) return;
    assert.equal(requalified.session.principalId, retry.session.principalId);
    assert.equal(requalified.session.hostInstanceId, 'instance-b');
    assert.equal(registry.authenticateAcpSession(retry.session.credential, 'instance-b'), null);
    assert.equal(registry.authenticateAcpSession(requalified.session.credential, 'instance-b')?.hostInstanceId, 'instance-b');
    const wrongBinding = registry.requalifyAcpSession({
      integrationCredential, principalId: retry.session.principalId, requestId: 'requal-2',
      sessionBinding: 'other-launch', expectedHostInstance: 'instance-b', currentHostInstance: 'instance-b',
    });
    assert.deepEqual(wrongBinding, { ok: false, reason: 'session_binding_denied' });

    registry.registerProject({ projectId: 'a', root: a });
    assert.equal(registry.authenticateAcpSession(requalified.session.credential, 'instance-b'), null, 'project generation change fences old grants');
    assert.deepEqual(registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    }), { ok: false, reason: 'registration_fingerprint_conflict' }, 'stale project grants cannot be revived by retry');
    const moved = join(root, 'project-a-moved');
    renameSync(a, moved);
    mkdirSync(a);
    assert.equal(registry.resolveProject('a'), null, 'same-path replacement is detected by filesystem identity');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ACP credentials expire after five minutes and parent renewal works on the same host', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-expiry-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  let now = 1_000;
  const registry = new IntegrationRegistry(join(privateDir, 'integration.sqlite'), () => undefined, { now: () => now });
  try {
    registry.registerProject({ projectId: 'project', root: project });
    const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.session.expiresAtMs, now + 5 * 60_000);
    assert.ok(registry.authenticateAcpSession(created.session.credential, 'instance'));
    now += 5 * 60_000;
    assert.equal(registry.authenticateAcpSession(created.session.credential, 'instance'), null);
    const renewed = registry.requalifyAcpSession({ integrationCredential: rootCredential,
      principalId: created.session.principalId, requestId: 'renew-1', sessionBinding: 'launch',
      expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(renewed.ok, true, 'same-instance parent renewal is permitted for exact binding');
    if (!renewed.ok) return;
    assert.equal(renewed.session.expiresAtMs, now + 5 * 60_000);
    assert.equal(registry.authenticateAcpSession(created.session.credential, 'instance'), null);
    assert.equal(registry.authenticateAcpSession(renewed.session.credential, 'instance')?.principalId, created.session.principalId);
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
