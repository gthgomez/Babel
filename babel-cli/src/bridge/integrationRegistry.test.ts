import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  ACP_SESSION_CREDENTIAL_TTL_MS,
  ACP_SESSION_RENEWAL_HISTORY,
  IntegrationRegistry,
  type RegisteredAcpSession,
} from './integrationRegistry.js';
import {
  IntegrationAcpSessionStatusResponseSchema,
  integrationRenewalRequestId,
} from '../protocol/remoteContract.js';

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function denied(result: { ok: boolean }, reason: string): void {
  assert.deepEqual(result, { ok: false, reason });
  assert.equal(Object.hasOwn(result, 'session'), false, 'failures never expose a reusable credential');
}

/** Compare replay metadata without ever rendering a synthetic credential in failure output. */
function sameSession(left: RegisteredAcpSession, right: RegisteredAcpSession): void {
  assert.equal(left.principalId === right.principalId, true, 'replay principal differs');
  assert.equal(left.sessionId === right.sessionId, true, 'replay session differs');
  assert.equal(left.projectId === right.projectId, true, 'replay project differs');
  assert.equal(left.sessionBinding === right.sessionBinding, true, 'replay binding differs');
  assert.equal(left.registrationGeneration === right.registrationGeneration, true, 'replay generation differs');
  assert.equal(left.projectGeneration === right.projectGeneration, true, 'replay project generation differs');
  assert.equal(left.hostInstanceId === right.hostInstanceId, true, 'replay host incarnation differs');
  assert.equal(left.expiresAtMs === right.expiresAtMs, true, 'replay expiry differs');
  assert.equal(left.credential === right.credential, true, 'exact replay must reproduce the same credential');
}

function renew(registry: IntegrationRegistry, input: {
  integrationCredential: string; principalId: string; requestSequence: number;
  expectedRegistrationGeneration: number; host?: string; sessionBinding?: string;
}) {
  return registry.requalifyAcpSession({
    integrationCredential: input.integrationCredential, principalId: input.principalId,
    requestId: integrationRenewalRequestId(input.principalId, input.requestSequence),
    requestSequence: input.requestSequence, sessionBinding: input.sessionBinding ?? 'launch',
    expectedRegistrationGeneration: input.expectedRegistrationGeneration,
    expectedHostInstance: input.host ?? 'instance', currentHostInstance: input.host ?? 'instance',
  });
}

function inspect(registry: IntegrationRegistry, input: {
  integrationCredential: string; principalId: string; requestSequence: number;
  requestId?: string; projectId?: string; sessionBinding?: string; host?: string; currentHost?: string;
}) {
  return registry.inspectAcpSession({
    integrationCredential: input.integrationCredential, principalId: input.principalId,
    requestId: input.requestId ?? integrationRenewalRequestId(input.principalId, input.requestSequence),
    requestSequence: input.requestSequence,
    projectId: input.projectId ?? 'project', sessionBinding: input.sessionBinding ?? 'launch',
    expectedHostInstance: input.host ?? 'instance',
    currentHostInstance: input.currentHost ?? input.host ?? 'instance',
  });
}

function workerExecArgv(): string[] {
  // Only portable module-loader flags are valid for Worker.execArgv; the test
  // runner injects host V8 flags that Worker rejects.
  const argv: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index]!;
    if (argument === '--import') {
      const loader = process.execArgv[index + 1];
      if (loader) {
        argv.push(argument, loader);
        index += 1;
      }
      continue;
    }
    if (argument.startsWith('--import=') || argument.startsWith('--no-warnings')) argv.push(argument);
  }
  if (!argv.some((argument) => argument === '--import' || argument.startsWith('--import='))) {
    argv.push('--experimental-strip-types');
  }
  return argv;
}

const CONTENTION_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { IntegrationRegistry } = await import(workerData.moduleUrl);
  const registry = new IntegrationRegistry(workerData.dbPath, () => undefined);
  try {
    const cell = new Int32Array(workerData.barrier);
    if (Atomics.add(cell, 0, 1) === 0) Atomics.wait(cell, 0, 1, 10000);
    else Atomics.notify(cell, 0);
    const result = registry.requalifyAcpSession({
      integrationCredential: workerData.integrationCredential,
      principalId: workerData.principalId,
      requestId: workerData.requestId,
      requestSequence: workerData.requestSequence,
      expectedRegistrationGeneration: 1,
      sessionBinding: 'launch',
      expectedHostInstance: 'instance',
      currentHostInstance: 'instance',
    });
    parentPort.postMessage(result.ok
      ? { ok: true, generation: result.session.registrationGeneration, credential: result.session.credential }
      : { ok: false, reason: result.reason });
  } finally {
    registry.close();
  }
})().catch((error) => parentPort.postMessage({ ok: false, reason: 'worker_error',
  error: String(error && error.message ? error.message : error) }));
`;

interface RaceOutcome {
  requestId: string;
  requestSequence: number;
  ok: boolean;
  reason?: string;
  generation?: number;
  credential?: string;
  error?: string;
}

function runRenewalWorker(input: {
  dbPath: string; principalId: string; integrationCredential: string; requestId: string;
  requestSequence: number; barrier: SharedArrayBuffer;
}): Promise<RaceOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CONTENTION_WORKER, {
      eval: true,
      execArgv: workerExecArgv(),
      workerData: { ...input, moduleUrl: new URL('./integrationRegistry.ts', import.meta.url).href },
    });
    worker.once('message', (message: Omit<RaceOutcome, 'requestId' | 'requestSequence'>) => resolve({
      ...message, requestId: input.requestId, requestSequence: input.requestSequence,
    }));
    worker.once('error', reject);
  });
}

test('integration registry scopes and replays one durable ACP principal per launch binding', () => {
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
    denied(registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'b', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    }), 'project_scope_denied');
    denied(registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'stale', currentHostInstance: 'instance-a',
    }), 'stale_host_instance');
    const created = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const original = created.session;
    assert.equal(registry.authenticateAcpSession(original.credential, 'instance-a')?.principalId, original.principalId);

    const replay = registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    sameSession(replay.session, original);

    denied(registry.createAcpSession({
      integrationCredential, requestId: 'request-a', projectId: 'a', sessionBinding: 'different-launch',
      expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a',
    }), 'registration_fingerprint_conflict');

    const requalified = renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1, host: 'instance-b', sessionBinding: 'launch-a' });
    assert.equal(requalified.ok, true);
    if (!requalified.ok) return;
    assert.equal(requalified.session.principalId, replay.session.principalId);
    assert.equal(requalified.session.hostInstanceId, 'instance-b');
    assert.equal(requalified.session.registrationGeneration, 2);

    const renewalReplay = renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1, host: 'instance-b', sessionBinding: 'launch-a' });
    assert.equal(renewalReplay.ok, true);
    if (!renewalReplay.ok) return;
    sameSession(renewalReplay.session, requalified.session);

    denied(renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 2, expectedRegistrationGeneration: 1, host: 'instance-b', sessionBinding: 'launch-a' }),
      'stale_registration_generation');
    denied(renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 2, expectedRegistrationGeneration: 3, host: 'instance-b', sessionBinding: 'launch-a' }),
      'registration_generation_conflict');
    denied(renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 2, expectedRegistrationGeneration: 2, host: 'instance-b', sessionBinding: 'other-launch' }),
      'session_binding_denied');
    assert.equal(registry.authenticateAcpSession(requalified.session.credential, 'instance-b')?.registrationGeneration, 2,
      'rejected renewals never rotate the current generation');

    registry.registerProject({ projectId: 'a', root: a });
    assert.equal(registry.authenticateAcpSession(requalified.session.credential, 'instance-b'), null,
      'project generation change fences old grants');
    denied(renew(registry, { integrationCredential, principalId: replay.session.principalId,
      requestSequence: 2, expectedRegistrationGeneration: 2, host: 'instance-b', sessionBinding: 'launch-a' }),
      'project_identity_changed');

    const moved = join(root, 'project-a-moved');
    renameSync(a, moved);
    mkdirSync(a);
    assert.equal(registry.resolveProject('a'), null, 'same-path replacement is detected by filesystem identity');
    denied(registry.createAcpSession({
      integrationCredential, requestId: 'request-after-replacement', projectId: 'a', sessionBinding: 'launch-a',
      expectedHostInstance: 'instance-b', currentHostInstance: 'instance-b',
    }), 'project_identity_changed');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ACP credentials expire after five minutes and renewal fences the observed generation', () => {
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
    assert.equal(created.session.expiresAtMs, now + ACP_SESSION_CREDENTIAL_TTL_MS);
    assert.ok(registry.authenticateAcpSession(created.session.credential, 'instance'));
    now += ACP_SESSION_CREDENTIAL_TTL_MS;
    assert.equal(registry.authenticateAcpSession(created.session.credential, 'instance'), null);

    denied(registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'registration_expired');

    const renewed = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(renewed.ok, true, 'same-instance parent renewal is permitted for exact binding');
    if (!renewed.ok) return;
    assert.equal(renewed.session.expiresAtMs, now + ACP_SESSION_CREDENTIAL_TTL_MS);
    assert.equal(renewed.session.registrationGeneration, 2);

    const renewedReplay = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(renewedReplay.ok, true);
    if (!renewedReplay.ok) return;
    sameSession(renewedReplay.session, renewed.session);

    const competing = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, expectedRegistrationGeneration: 2 });
    assert.equal(competing.ok, true);
    if (!competing.ok) return;
    denied(renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 3, expectedRegistrationGeneration: 2 }),
      'stale_registration_generation');
    assert.equal(registry.authenticateAcpSession(competing.session.credential, 'instance')?.registrationGeneration, 3);

    now = competing.session.expiresAtMs;
    denied(renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1 }),
      'requalification_superseded');
    denied(renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, expectedRegistrationGeneration: 2 }),
      'requalification_expired');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable sequences reject delayed reuse and canonical labels are route-disjoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-durable-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const registry = new IntegrationRegistry(join(privateDir, 'integration.sqlite'), () => undefined);
  try {
    registry.registerProject({ projectId: 'project', root: project });
    const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const principalId = created.session.principalId;

    const first = renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 2, expectedRegistrationGeneration: 2 });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 }), 'requalification_superseded');
    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 2, expectedRegistrationGeneration: 3 }), 'requalification_fingerprint_conflict');
    denied(registry.createAcpSession({ integrationCredential: rootCredential,
      requestId: integrationRenewalRequestId(principalId, 1), projectId: 'project', sessionBinding: 'launch',
      expectedHostInstance: 'instance', currentHostInstance: 'instance' }), 'invalid_registration');
    assert.equal(registry.authenticateAcpSession(second.session.credential, 'instance')?.registrationGeneration, 3);

    registry.revokeAcpSession(principalId);
    denied(registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'registration_revoked');
    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 3, expectedRegistrationGeneration: 4 }), 'registration_revoked');

    const replacement = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create-replacement',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(replacement.ok, true, 'a new request issues a new principal instead of resurrecting the revoked one');
    if (!replacement.ok) return;
    assert.notEqual(replacement.session.principalId, principalId);

    // Registration labels cannot be used on the renewal route, and a canonical
    // label cannot be relabeled under another principal or sequence.
    denied(registry.requalifyAcpSession({ integrationCredential: rootCredential, principalId: replacement.session.principalId,
      requestId: 'plain-registration-label', requestSequence: 1, expectedRegistrationGeneration: 1,
      sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'invalid_requalification');
    denied(registry.requalifyAcpSession({ integrationCredential: rootCredential, principalId: replacement.session.principalId,
      requestId: integrationRenewalRequestId(principalId, 1), requestSequence: 1, expectedRegistrationGeneration: 1,
      sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'invalid_requalification');
    denied(registry.requalifyAcpSession({ integrationCredential: rootCredential, principalId: replacement.session.principalId,
      requestId: integrationRenewalRequestId(replacement.session.principalId, 1), requestSequence: 2,
      expectedRegistrationGeneration: 1, sessionBinding: 'launch',
      expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'invalid_requalification');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two durable handles share replay state and serialize one winner per expected generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-handles-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const first = new IntegrationRegistry(dbPath, () => undefined);
  const second = new IntegrationRegistry(dbPath, () => undefined);
  try {
    first.registerProject({ projectId: 'project', root: project });
    const rootCredential = first.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = first.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const replay = second.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    sameSession(replay.session, created.session);

    const winner = renew(first, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(winner.ok, true);
    if (!winner.ok) return;
    denied(renew(second, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, expectedRegistrationGeneration: 1 }),
      'stale_registration_generation');
    assert.equal(second.authenticateAcpSession(winner.session.credential, 'instance')?.registrationGeneration, 2);
    const winnerReplay = renew(second, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(winnerReplay.ok, true);
    if (!winnerReplay.ok) return;
    sameSession(winnerReplay.session, winner.session);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-principal renewal history stays bounded and retired sequences are unusable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-history-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const registry = new IntegrationRegistry(dbPath, () => undefined);
  let principalId = '';
  let latest: RegisteredAcpSession | undefined;
  try {
    registry.registerProject({ projectId: 'project', root: project });
    const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    principalId = created.session.principalId;

    const total = ACP_SESSION_RENEWAL_HISTORY + 4;
    for (let sequence = 1; sequence <= total; sequence += 1) {
      const renewed = renew(registry, { integrationCredential: rootCredential, principalId,
        requestSequence: sequence, expectedRegistrationGeneration: sequence });
      assert.equal(renewed.ok, true, `renewal ${sequence} must not be capped`);
      if (!renewed.ok) return;
      latest = renewed.session;
    }
    assert.ok(latest);
    const replay = renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: total, expectedRegistrationGeneration: total });
    assert.equal(replay.ok, true);
    if (!replay.ok || !latest) return;
    sameSession(replay.session, latest);

    const raw = new DatabaseSync(dbPath);
    const renewalRows = raw.prepare(`SELECT COUNT(*) AS count FROM acp_session_issuances
      WHERE principal_id=? AND issuance_kind='requalification'`).get(principalId) as { count?: number };
    const registrationRows = raw.prepare(`SELECT COUNT(*) AS count FROM acp_session_issuances
      WHERE principal_id=? AND issuance_kind='registration'`).get(principalId) as { count?: number };
    raw.close();
    assert.equal(Number(renewalRows.count), ACP_SESSION_RENEWAL_HISTORY, 'renewal history is bounded per principal');
    assert.equal(Number(registrationRows.count), 1, 'registration idempotency row is retained');

    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: total + 1 }), 'request_sequence_retired');
    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: total + 1, expectedRegistrationGeneration: 1 }), 'stale_registration_generation');
    assert.equal(registry.authenticateAcpSession(latest.credential, 'instance')?.registrationGeneration, total + 1,
      'retired keys never rotate the current generation');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliation distinguishes retained, pruned, and unused sequences without leaking other scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-classify-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const registry = new IntegrationRegistry(join(privateDir, 'integration.sqlite'), () => undefined);
  try {
    registry.registerProject({ projectId: 'project', root: project });
    const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const principalId = created.session.principalId;
    const total = ACP_SESSION_RENEWAL_HISTORY + 2;
    for (let sequence = 1; sequence <= total; sequence += 1) {
      const renewed = renew(registry, { integrationCredential: rootCredential, principalId,
        requestSequence: sequence, expectedRegistrationGeneration: sequence });
      assert.equal(renewed.ok, true);
      if (!renewed.ok) return;
    }

    const current = inspect(registry, { integrationCredential: rootCredential, principalId, requestSequence: total });
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(current.status.disposition, 'issued');
    assert.equal(current.status.renewalSequence, total);
    assert.equal(current.status.hostInstanceId, 'instance');
    assert.equal(current.status.registrationGeneration, total + 1);
    assert.equal(Object.hasOwn(current.status, 'credential'), false);

    const retained = inspect(registry, { integrationCredential: rootCredential, principalId, requestSequence: total - 1 });
    assert.equal(retained.ok, true);
    if (!retained.ok) return;
    assert.equal(retained.status.disposition, 'superseded', 'retained historical row is proven superseded');

    const pruned = inspect(registry, { integrationCredential: rootCredential, principalId, requestSequence: 1 });
    assert.equal(pruned.ok, true);
    if (!pruned.ok) return;
    assert.equal(pruned.status.disposition, 'retired', 'pruned sequence is not falsely not-issued');
    assert.equal(pruned.status.renewalSequence, total);

    const unused = inspect(registry, { integrationCredential: rootCredential, principalId, requestSequence: total + 1 });
    assert.equal(unused.ok, true);
    if (!unused.ok) return;
    assert.equal(unused.status.disposition, 'not_issued', 'unused later sequence is proven not-issued');

    denied(inspect(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: total, sessionBinding: 'other-launch' }), 'session_binding_denied');
    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: total - 1, expectedRegistrationGeneration: total }), 'requalification_fingerprint_conflict');

    const other = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'other-create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(other.ok, true);
    if (!other.ok) return;
    denied(inspect(registry, { integrationCredential: rootCredential, principalId: other.session.principalId,
      requestSequence: total, requestId: integrationRenewalRequestId(principalId, total) }), 'invalid_requalification');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconciliation reports authoritative state without issuing or rotating', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-reconcile-'));
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
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance-a', currentHostInstance: 'instance-a' });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const pending = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, expectedRegistrationGeneration: 1, host: 'instance-a' });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const issued = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, host: 'instance-b' });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.status.disposition, 'issued');
    assert.equal(issued.status.registrationGeneration, 2);
    assert.equal(issued.status.renewalSequence, 1);
    assert.equal(issued.status.hostInstanceId, 'instance-b', 'status names the serving incarnation');
    assert.equal(Object.hasOwn(issued.status, 'credential'), false);
    const repeated = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, host: 'instance-b' });
    assert.equal(repeated.ok, true);
    if (!repeated.ok) return;
    assert.equal(repeated.status.registrationGeneration, 2, 'status never increments the generation');

    const unknown = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 9, host: 'instance-b' });
    assert.equal(unknown.ok, true);
    if (!unknown.ok) return;
    assert.equal(unknown.status.disposition, 'not_issued');
    assert.equal(unknown.status.registrationGeneration, 2);

    denied(inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1,
      sessionBinding: 'other-launch', host: 'instance-b' }), 'session_binding_denied');
    denied(inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1,
      projectId: 'other-project', host: 'instance-b' }), 'project_scope_denied');
    denied(inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1,
      host: 'instance-a', currentHost: 'instance-b' }), 'stale_host_instance');

    const next = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, expectedRegistrationGeneration: 2, host: 'instance-b' });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.session.registrationGeneration, 3);
    const superseded = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 1, host: 'instance-b' });
    assert.equal(superseded.ok, true);
    if (!superseded.ok) return;
    assert.equal(superseded.status.disposition, 'superseded');

    now = next.session.expiresAtMs;
    const expired = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, host: 'instance-b' });
    assert.equal(expired.ok, true);
    if (!expired.ok) return;
    assert.equal(expired.status.disposition, 'expired');
    assert.equal(Object.hasOwn(expired.status, 'credential'), false);
    denied(renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 2, expectedRegistrationGeneration: 2, host: 'instance-b' }),
      'requalification_expired');
    const fresh = renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 3, expectedRegistrationGeneration: 3, host: 'instance-b' });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    assert.equal(fresh.session.registrationGeneration, 4);

    registry.revokeAcpSession(created.session.principalId);
    const revoked = inspect(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 3, host: 'instance-b' });
    assert.equal(revoked.ok, true);
    if (!revoked.ok) return;
    assert.equal(revoked.status.disposition, 'revoked');
    assert.equal(Object.hasOwn(revoked.status, 'credential'), false);
    denied(renew(registry, { integrationCredential: rootCredential,
      principalId: created.session.principalId, requestSequence: 4, expectedRegistrationGeneration: 4, host: 'instance-b' }),
      'registration_revoked');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('renewal fails closed at safe-integer generation exhaustion', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-generation-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const setup = new IntegrationRegistry(dbPath, () => undefined);
  try {
    setup.registerProject({ projectId: 'project', root: project });
    const rootCredential = setup.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = setup.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE acp_principals SET generation=?, enabled=0 WHERE principal_id=?')
      .run(Number.MAX_SAFE_INTEGER, created.session.principalId);
    raw.prepare('UPDATE acp_principals SET enabled=1 WHERE principal_id=?').run(created.session.principalId);
    raw.close();
    const registry = new IntegrationRegistry(dbPath, () => undefined);
    try {
      denied(renew(registry, { integrationCredential: rootCredential,
        principalId: created.session.principalId, requestSequence: 1,
        expectedRegistrationGeneration: Number.MAX_SAFE_INTEGER }), 'registration_generation_exhausted');
      assert.equal(registry.authenticateAcpSession(created.session.credential, 'instance')?.registrationGeneration,
        Number.MAX_SAFE_INTEGER, 'exhaustion never mutates the generation');
    } finally {
      registry.close();
    }
  } finally {
    setup.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema initialization is atomic, version-checked, and fails closed on newer schemas', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-schema-'));
  const privateDir = join(root, 'private');
  mkdirSync(privateDir, { mode: 0o700 });
  try {
    const futurePath = join(privateDir, 'future.sqlite');
    const future = new DatabaseSync(futurePath);
    future.exec('PRAGMA user_version=6');
    future.close();
    assert.throws(() => new IntegrationRegistry(futurePath, () => undefined), /newer than supported 5/);

    const currentPath = join(privateDir, 'current.sqlite');
    new IntegrationRegistry(currentPath, () => undefined).close();
    const current = new DatabaseSync(currentPath);
    const version = current.prepare('PRAGMA user_version').get() as { user_version?: number };
    const triggers = current.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
      AND name IN ('acp_principals_issuance_insert','acp_principals_issuance_update')`).get() as { count?: number };
    current.close();
    assert.equal(Number(version.user_version), 5);
    assert.equal(Number(triggers.count), 2, 'credential writes require a durable issuance row');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v4 downgrade writes are rejected and reopening v5 preserves replay state', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-downgrade-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const setup = new IntegrationRegistry(dbPath, () => undefined);
  let rootCredential = '';
  let principalId = '';
  let latest: RegisteredAcpSession | undefined;
  try {
    setup.registerProject({ projectId: 'project', root: project });
    rootCredential = setup.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = setup.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    principalId = created.session.principalId;
    const renewed = renew(setup, { integrationCredential: rootCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(renewed.ok, true);
    if (!renewed.ok) return;
    latest = renewed.session;
    setup.close();

    const raw = new DatabaseSync(dbPath);
    assert.throws(() => raw.prepare(`INSERT INTO acp_principals(principal_id,integration_id,request_id,
      request_fingerprint,project_id,session_binding,credential_hash,generation,project_generation,
      integration_generation,host_instance_id,expires_at,enabled)
      VALUES(?,?,?,?,?,?,?,1,1,1,?,?,1)`).run(randomUUID(), 'bridge', 'v4-downgrade-create',
      'v4-fingerprint', 'project', 'launch', digest('v4-synthetic'), 'instance', 100_000),
      /acp_principal_issuance_required/);
    assert.throws(() => raw.prepare(`UPDATE acp_principals SET credential_hash=?,generation=generation+1,
      host_instance_id=?,expires_at=?,last_requalification_request_id=?,last_requalification_fingerprint=?
      WHERE principal_id=?`).run(digest('v4-synthetic-rotation'), 'instance', 100_000, 'v4-rotate',
      'v4-fingerprint', principalId), /acp_principal_issuance_required/);
    raw.exec('PRAGMA user_version=4');
    raw.close();

    const reopened = new IntegrationRegistry(dbPath, () => undefined);
    try {
      const replay = renew(reopened, { integrationCredential: rootCredential, principalId,
        requestSequence: 1, expectedRegistrationGeneration: 1 });
      assert.equal(replay.ok, true);
      if (!replay.ok || !latest) return;
      sameSession(replay.session, latest);
      const next = renew(reopened, { integrationCredential: rootCredential, principalId,
        requestSequence: 2, expectedRegistrationGeneration: 2 });
      assert.equal(next.ok, true, 'v5 writes still require and obtain durable issuance');
      if (!next.ok) return;
      assert.equal(next.session.registrationGeneration, 3);
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(dbPath);
    const version = check.prepare('PRAGMA user_version').get() as { user_version?: number };
    check.close();
    assert.equal(Number(version.user_version), 5);
  } finally {
    try { setup.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping renewals from separate SQLite connections admit exactly one winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-contention-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const setup = new IntegrationRegistry(dbPath, () => undefined);
  try {
    setup.registerProject({ projectId: 'project', root: project });
    const rootCredential = setup.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = setup.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const principalId = created.session.principalId;

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const outcomes = await Promise.all([
      runRenewalWorker({ dbPath, principalId, integrationCredential: rootCredential,
        requestId: integrationRenewalRequestId(principalId, 1), requestSequence: 1, barrier }),
      runRenewalWorker({ dbPath, principalId, integrationCredential: rootCredential,
        requestId: integrationRenewalRequestId(principalId, 2), requestSequence: 2, barrier }),
    ]);
    const workerError = outcomes.find((outcome) => outcome.error !== undefined);
    assert.equal(workerError === undefined, true, `contention worker failed: ${workerError?.error ?? ''}`);
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(winners.length, 1, `expected exactly one winner, losers: ${losers.map((loser) => loser.reason).join(',')}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0]!.reason, 'stale_registration_generation');
    const winner = winners[0]!;
    assert.equal(typeof winner.credential, 'string');
    const winnerCredential = winner.credential as string;
    assert.equal(winner.generation, 2);

    const verify = new IntegrationRegistry(dbPath, () => undefined);
    try {
      assert.equal(verify.authenticateAcpSession(winnerCredential, 'instance')?.registrationGeneration, 2);
      const replay = renew(verify, { integrationCredential: rootCredential, principalId,
        requestSequence: winner.requestSequence, expectedRegistrationGeneration: 1 });
      assert.equal(replay.ok, true);
      if (!replay.ok) return;
      assert.equal(replay.session.credential === winnerCredential, true, 'winner replay must reproduce the credential');
      denied(renew(verify, { integrationCredential: rootCredential, principalId,
        requestSequence: 3, expectedRegistrationGeneration: 1 }), 'stale_registration_generation');
    } finally {
      verify.close();
    }
  } finally {
    setup.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a CAS miss rolls back the inserted admission instead of committing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-cas-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const registry = new IntegrationRegistry(dbPath, () => undefined);
  try {
    registry.registerProject({ projectId: 'project', root: project });
    const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const principalId = created.session.principalId;
    const requestId = integrationRenewalRequestId(principalId, 1);

    // Force the CAS predicate to miss after the issuance row is inserted. The
    // update trigger is dropped only in this isolated DB so the injected bump
    // can execute; requalification must throw and roll the admission back.
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TRIGGER acp_principals_issuance_update');
    raw.exec(`CREATE TRIGGER force_cas_miss AFTER INSERT ON acp_session_issuances
      WHEN NEW.issuance_kind='requalification'
      BEGIN UPDATE acp_principals SET generation=generation+1 WHERE principal_id=NEW.principal_id; END;`);
    raw.close();

    denied(renew(registry, { integrationCredential: rootCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 }), 'stale_registration_generation');

    const check = new DatabaseSync(dbPath);
    const admission = check.prepare('SELECT COUNT(*) AS count FROM acp_session_issuances WHERE request_id=?')
      .get(requestId) as { count?: number };
    const principal = check.prepare('SELECT generation,last_request_sequence FROM acp_principals WHERE principal_id=?')
      .get(principalId) as { generation?: number; last_request_sequence?: number };
    check.close();
    assert.equal(Number(admission.count), 0, 'failed CAS admission row is rolled back');
    assert.equal(Number(principal.generation), 1, 'failed CAS does not advance the generation');
    assert.equal(Number(principal.last_request_sequence), 0, 'failed CAS does not consume the sequence');
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('prior free-form renewal labels remain reserved and cannot be relabeled', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-legacy-label-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const setup = new IntegrationRegistry(dbPath, () => undefined);
  let rootCredential = '';
  let principalId = '';
  try {
    setup.registerProject({ projectId: 'project', root: project });
    rootCredential = setup.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const created = setup.createAcpSession({ integrationCredential: rootCredential, requestId: 'create',
      projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    principalId = created.session.principalId;
    setup.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare(`INSERT INTO acp_session_issuances(integration_id,request_id,principal_id,issuance_kind,
      request_sequence,expected_generation,issued_generation,project_id,project_generation,project_identity,
      integration_generation,host_instance_id,session_binding,request_fingerprint,credential_scheme,
      credential_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('bridge', 'legacy-free-form', principalId, 'requalification', null, 1, 2, 'project', 1, '',
        1, 'instance', 'launch', 'legacy-fingerprint', 'hmac-sha256-v1', digest('legacy-synthetic'), 0, 100_000);
    raw.close();

    const registry = new IntegrationRegistry(dbPath, () => undefined);
    try {
      denied(registry.createAcpSession({ integrationCredential: rootCredential, requestId: 'legacy-free-form',
        projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
        'registration_fingerprint_conflict');
      denied(registry.requalifyAcpSession({ integrationCredential: rootCredential, principalId,
        requestId: 'legacy-free-form', requestSequence: 1, expectedRegistrationGeneration: 1,
        sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
        'invalid_requalification');
      const renewed = renew(registry, { integrationCredential: rootCredential, principalId,
        requestSequence: 1, expectedRegistrationGeneration: 1 });
      assert.equal(renewed.ok, true, 'a canonical renewal still works beside retained legacy tombstones');
      if (!renewed.ok) return;
      assert.equal(renewed.session.registrationGeneration, 2);
    } finally {
      registry.close();
    }
    const check = new DatabaseSync(dbPath);
    const retained = check.prepare('SELECT COUNT(*) AS count FROM acp_session_issuances WHERE request_id=?')
      .get('legacy-free-form') as { count?: number };
    check.close();
    assert.equal(Number(retained.count), 1, 'prior free-form label is retained, never silently evicted');
  } finally {
    try { setup.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy disabled row at the expiry sentinel returns revoked with nonnegative status expiry', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-legacy-disabled-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const info = statSync(project, { bigint: true });
  const integrationCredential = randomBytes(32).toString('base64url');
  const principalId = '22222222-2222-4222-8222-222222222222';
  const host = '33333333-3333-4333-8333-333333333333';
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE registered_projects (
      project_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
      filesystem_dev TEXT NOT NULL, filesystem_ino TEXT NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE integrations (
      integration_id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE integration_projects (
      integration_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(integration_id, project_id)
    );
    CREATE TABLE acp_principals (
      principal_id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL, session_binding TEXT NOT NULL,
      credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, project_generation INTEGER NOT NULL,
      integration_generation INTEGER NOT NULL, host_instance_id TEXT NOT NULL,
      last_requalification_request_id TEXT, last_requalification_fingerprint TEXT,
      enabled INTEGER NOT NULL, UNIQUE(integration_id, request_id)
    );
  `);
  legacy.prepare(`INSERT INTO registered_projects(project_id,canonical_root,generation,filesystem_dev,filesystem_ino,enabled)
    VALUES(?,?,1,?,?,1)`).run('project', project, String(info.dev), String(info.ino));
  legacy.prepare('INSERT INTO integrations(integration_id,name,credential_hash,generation,enabled) VALUES(?,?,?,1,1)')
    .run('bridge', 'fixture', digest(integrationCredential));
  legacy.prepare('INSERT INTO integration_projects(integration_id,project_id) VALUES(?,?)').run('bridge', 'project');
  legacy.prepare(`INSERT INTO acp_principals(principal_id,integration_id,request_id,request_fingerprint,
    project_id,session_binding,credential_hash,generation,project_generation,integration_generation,
    host_instance_id,last_requalification_request_id,last_requalification_fingerprint,enabled)
    VALUES(?,?,?,?,?,?,?,1,1,1,?,?,?,1)`)
    .run(principalId, 'bridge', 'legacy-disabled', 'legacy-fingerprint', 'project', 'launch',
      digest(randomBytes(32).toString('base64url')), 'instance', null, null);
  legacy.exec('PRAGMA user_version=4');
  legacy.close();

  const registry = new IntegrationRegistry(dbPath, () => undefined);
  try {
    const status = inspect(registry, { integrationCredential, principalId, requestSequence: 1, host });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.status.disposition, 'revoked');
    assert.equal(status.status.expiresAtMs, 0, 'disabled legacy row keeps the migration sentinel');
    assert.equal(status.status.registrationGeneration, 1);
    assert.equal(status.status.renewalSequence, 0);
    const wire = {
      principal_id: principalId, project_id: 'project', session_binding: 'launch',
      request_id: integrationRenewalRequestId(principalId, 1), request_sequence: 1,
      renewal_sequence: status.status.renewalSequence, host_instance_id: status.status.hostInstanceId,
      registration_generation: status.status.registrationGeneration,
      expires_at_ms: status.status.expiresAtMs, disposition: status.status.disposition,
    };
    assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse(wire).success, true,
      'strict status response accepts the legacy zero-expiry revoked body');
    assert.equal(Object.hasOwn(wire, 'credential'), false);
  } finally {
    registry.close();
  }
  const check = new DatabaseSync(dbPath);
  const migrated = check.prepare('SELECT enabled,expires_at FROM acp_principals WHERE principal_id=?')
    .get(principalId) as { enabled?: number; expires_at?: number };
  check.close();
  assert.equal(Number(migrated.enabled), 0);
  assert.equal(Number(migrated.expires_at), 0);
  rmSync(root, { recursive: true, force: true });
});

test('pre-migration principals reserve both recorded v4 IDs and never replay random credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-legacy-'));
  const privateDir = join(root, 'private');
  const project = join(root, 'project');
  mkdirSync(privateDir, { mode: 0o700 });
  mkdirSync(project);
  const dbPath = join(privateDir, 'integration.sqlite');
  const info = statSync(project, { bigint: true });
  const integrationCredential = randomBytes(32).toString('base64url');
  const legacyCredential = randomBytes(32).toString('base64url');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE registered_projects (
      project_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
      filesystem_dev TEXT NOT NULL, filesystem_ino TEXT NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE integrations (
      integration_id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL
    );
    CREATE TABLE integration_projects (
      integration_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(integration_id, project_id)
    );
    CREATE TABLE acp_principals (
      principal_id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, project_id TEXT NOT NULL, session_binding TEXT NOT NULL,
      credential_hash TEXT NOT NULL, generation INTEGER NOT NULL, project_generation INTEGER NOT NULL,
      integration_generation INTEGER NOT NULL, host_instance_id TEXT NOT NULL,
      last_requalification_request_id TEXT, last_requalification_fingerprint TEXT,
      expires_at INTEGER NOT NULL, enabled INTEGER NOT NULL, UNIQUE(integration_id, request_id)
    );
    CREATE TABLE integration_transport_sessions (
      session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
      registration_generation INTEGER NOT NULL, project_generation INTEGER NOT NULL,
      host_instance_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      UNIQUE(principal_id,host_instance_id,registration_generation)
    );
  `);
  legacy.prepare(`INSERT INTO registered_projects(project_id,canonical_root,generation,filesystem_dev,filesystem_ino,enabled)
    VALUES(?,?,1,?,?,1)`).run('project', project, String(info.dev), String(info.ino));
  legacy.prepare('INSERT INTO integrations(integration_id,name,credential_hash,generation,enabled) VALUES(?,?,?,1,1)')
    .run('bridge', 'fixture', digest(integrationCredential));
  legacy.prepare('INSERT INTO integration_projects(integration_id,project_id) VALUES(?,?)').run('bridge', 'project');
  legacy.prepare(`INSERT INTO acp_principals(principal_id,integration_id,request_id,request_fingerprint,project_id,
    session_binding,credential_hash,generation,project_generation,integration_generation,host_instance_id,
    last_requalification_request_id,last_requalification_fingerprint,expires_at,enabled)
    VALUES(?,?,?,?,?,?,?,1,1,1,?,?,?,?,1)`)
    .run('11111111-1111-4111-8111-111111111111', 'bridge', 'legacy-create', 'legacy-fingerprint', 'project',
      'launch', digest(legacyCredential), 'instance', 'legacy-known-renew', 'legacy-requal-fingerprint', 50_000);
  legacy.exec('PRAGMA user_version=4');
  legacy.close();

  const first = new IntegrationRegistry(dbPath, () => undefined, { now: () => 1_000 });
  const second = new IntegrationRegistry(dbPath, () => undefined, { now: () => 1_000 });
  const principalId = '11111111-1111-4111-8111-111111111111';
  try {
    for (const registry of [first, second]) {
      denied(registry.createAcpSession({ integrationCredential, requestId: 'legacy-create',
        projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
        'legacy_request_id_reserved');
      denied(registry.createAcpSession({ integrationCredential, requestId: 'legacy-known-renew',
        projectId: 'project', sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
        'legacy_request_id_reserved');
      denied(registry.requalifyAcpSession({ integrationCredential, principalId, requestId: 'legacy-create',
        requestSequence: 1, expectedRegistrationGeneration: 1, sessionBinding: 'launch',
        expectedHostInstance: 'instance', currentHostInstance: 'instance' }), 'legacy_request_id_reserved');
      denied(registry.requalifyAcpSession({ integrationCredential, principalId, requestId: 'legacy-known-renew',
        requestSequence: 1, expectedRegistrationGeneration: 1, sessionBinding: 'launch',
        expectedHostInstance: 'instance', currentHostInstance: 'instance' }), 'legacy_request_id_reserved');
      const reserved = inspect(registry, { integrationCredential, principalId,
        requestSequence: 1, requestId: 'legacy-known-renew' });
      assert.equal(reserved.ok, true);
      if (!reserved.ok) return;
      assert.equal(reserved.status.disposition, 'reserved');
      assert.equal(Object.hasOwn(reserved.status, 'credential'), false);
    }
    assert.equal(first.authenticateAcpSession(legacyCredential, 'instance')?.registrationGeneration, 1);

    const diagnostics = new DatabaseSync(dbPath);
    const reservedRows = diagnostics.prepare(`SELECT request_id,issuance_kind,expected_generation,credential_hash,
      credential_scheme,expires_at FROM acp_session_issuances WHERE principal_id=?
      ORDER BY request_id`).all(principalId) as Array<Record<string, unknown>>;
    diagnostics.close();
    assert.deepEqual(reservedRows.map((row) => row['request_id']), ['legacy-create', 'legacy-known-renew'],
      'both recorded v4 IDs are reserved');
    for (const row of reservedRows) {
      assert.equal(row['issuance_kind'], 'legacy_v4_reserved');
      assert.equal(Number(row['expected_generation']), -1, 'discarded v4 history is not reconstructed');
      assert.equal(row['credential_hash'], '');
      assert.equal(row['credential_scheme'], 'legacy-v4-reserved');
      assert.equal(Number(row['expires_at']), 0);
    }

    const upgraded = renew(first, { integrationCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(upgraded.ok, true);
    if (!upgraded.ok) return;
    assert.equal(upgraded.session.registrationGeneration, 2);
    assert.equal(first.authenticateAcpSession(legacyCredential, 'instance'), null);
    const replay = renew(second, { integrationCredential, principalId,
      requestSequence: 1, expectedRegistrationGeneration: 1 });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    sameSession(replay.session, upgraded.session);
    denied(second.requalifyAcpSession({ integrationCredential, principalId,
      requestId: 'legacy-known-renew', requestSequence: 2, expectedRegistrationGeneration: 2,
      sessionBinding: 'launch', expectedHostInstance: 'instance', currentHostInstance: 'instance' }),
      'legacy_request_id_reserved');
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
