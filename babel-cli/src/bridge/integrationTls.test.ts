import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import test from 'node:test';
import { IntegrationTlsServer } from './integrationTls.js';
import { IntegrationRegistry } from './integrationRegistry.js';
import { NativeCommandJournal } from './commandJournal.js';
import { ProtocolGateway } from './protocolGateway.js';
import { closeProtocolHostState } from '../protocol/client/host.js';
import {
  BABEL_INTEGRATION_CONTRACT_VERSION,
  BABEL_INTEGRATION_SCHEMA_SHA256,
  integrationRenewalRequestId,
} from '../protocol/remoteContract.js';

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function requestJson(
  port: number, ca: Buffer, authorization?: string, path = '/protocol.info',
  method = 'GET', body?: string, extraHeaders: Record<string, string> = {}, includeProfileHeaders = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, ca,
      rejectUnauthorized: true,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(includeProfileHeaders && path !== '/protocol.info' ? {
          'x-babel-contract': 'babel.integration',
          'x-babel-contract-version': BABEL_INTEGRATION_CONTRACT_VERSION,
          'x-babel-schema-sha256': BABEL_INTEGRATION_SCHEMA_SHA256,
        } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function compareIssuanceReplay(leftBody: string, rightBody: string, message: string): void {
  const left = JSON.parse(leftBody) as Record<string, unknown>;
  const right = JSON.parse(rightBody) as Record<string, unknown>;
  assert.equal(left['credential'] === right['credential'], true, message);
  const redact = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...value, credential: value['credential'] === undefined ? 'absent' : 'present',
  });
  assert.deepEqual(redact(left), redact(right), message);
}

test('integration TLS serves only authenticated version info and rejects an unpinned peer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-tls-'));
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (generated.error || generated.status !== 0) rmSync(root, { recursive: true, force: true });
  assert.equal(generated.error, undefined,
    'openssl is a required precondition for the synthetic local TLS identity; install it on the test host');
  assert.equal(generated.status === 0, true,
    `openssl failed to generate the synthetic local TLS identity (status ${String(generated.status)})`);
  const cert = readFileSync(join(root, 'cert.pem'));
  const key = readFileSync(join(root, 'key.pem'));
  const port = await freePort();
  const service = new IntegrationTlsServer({
    port, gatewayId: 'synthetic-gateway', certificate: cert, privateKey: key,
    integrationCredential: 'synthetic-credential-' + 'x'.repeat(40),
  });
  try {
    await service.listen();
    const denied = await requestJson(port, cert);
    assert.equal(denied.status, 401);
    const adminDenied = await requestJson(port, cert, 'Bearer synthetic-admin-token');
    assert.equal(adminDenied.status, 401, 'legacy host bearer is not an integration credential');
    const allowed = await requestJson(port, cert, 'Babel-Integration synthetic-credential-' + 'x'.repeat(40));
    assert.equal(allowed.status, 200);
    const info = JSON.parse(allowed.body) as typeof service.info;
    assert.equal(info.contract, 'babel.integration');
    assert.equal(info.version, BABEL_INTEGRATION_CONTRACT_VERSION);
    assert.equal(info.gateway_id, 'synthetic-gateway');
    assert.equal(info.schema_sha256.length, 64);
    assert.equal(info.instance_id, service.info.instance_id);
    assert.deepEqual(info.capabilities, [], 'no scoped operation is advertised without a registry');
    const acceptedNegotiation = await requestJson(port, cert,
      'Babel-Integration synthetic-credential-' + 'x'.repeat(40), '/protocol.info', 'GET', undefined, {
        'x-babel-contract': info.contract, 'x-babel-contract-version': info.version,
        'x-babel-schema-sha256': info.schema_sha256,
      });
    assert.equal(acceptedNegotiation.status, 200);
    const wrongVersion = await requestJson(port, cert,
      'Babel-Integration synthetic-credential-' + 'x'.repeat(40), '/protocol.info', 'GET', undefined, {
        'x-babel-contract': info.contract, 'x-babel-contract-version': '9.0.0',
        'x-babel-schema-sha256': info.schema_sha256,
      });
    assert.equal(wrongVersion.status, 406);
    const rpcDenied = await requestJson(
      port,
      cert,
      'Babel-Integration synthetic-credential-' + 'x'.repeat(40),
      '/rpc',
    );
    assert.equal(rpcDenied.status, 404, 'integration credential cannot reach the legacy RPC dispatcher');

    await assert.rejects(
      requestJson(port, Buffer.from('-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----')),
      /certificate|self-signed|authority|issuer/i,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('TLS ACP registration issues a project-scoped principal and never opens legacy RPC', async () => {
  const priorRuns = process.env['BABEL_RUNS_DIR'];
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-acp-tls-'));
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  const certPath = join(root, 'cert.pem');
  const keyPath = join(root, 'key.pem');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (generated.error || generated.status !== 0) {
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(generated.error, undefined,
    'openssl is a required precondition for the synthetic local TLS identity; install it on the test host');
  assert.equal(generated.status === 0, true,
    `openssl failed to generate the synthetic local TLS identity (status ${String(generated.status)})`);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const port = await freePort();
  const project = join(root, 'project');
  const privateDir = join(root, 'private');
  const dbPath = join(privateDir, 'integration.sqlite');
  mkdirSync(project);
  mkdirSync(privateDir, { mode: 0o700 });
  const registry = new IntegrationRegistry(dbPath, (directory) => assert.equal(directory, privateDir));
  let journal!: NativeCommandJournal;
  let gateway = new ProtocolGateway({ allowedWorkspaceRoot: root, remoteSurface: true, enforceControlLease: true });
  let loseNextReply = false;
  let dispatchCount = 0;
  const gatewayPort = () => ({ dispatchScopedNativeThreadCreate: async (input: Parameters<ProtocolGateway['dispatchScopedNativeThreadCreate']>[0]) => {
    dispatchCount += 1;
    const response = await gateway.dispatchScopedNativeThreadCreate(input);
    if (loseNextReply) { loseNextReply = false; throw new Error('synthetic reply loss after native thread admission'); }
    return response;
  } });
  registry.registerProject({ projectId: 'project-one', root: project });
  const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project-one'] });
  const makeService = (listenPort: number) => new IntegrationTlsServer({ port: listenPort, gatewayId: 'gw', certificate: cert, privateKey: key, registry,
    instanceId: gateway.instanceId, gateway: gatewayPort(), enableNativeThreadCreate: true,
    commandJournal: (instanceId) => {
      journal = new NativeCommandJournal(join(privateDir, 'commands.sqlite'), {
        hostInstanceId: instanceId, protectStoreDirectory: (directory) => assert.equal(directory, privateDir),
      });
      return journal;
    },
  });
  let service = makeService(port);
  try {
    await service.listen();
    const auth = `Babel-Integration ${rootCredential}`;
    const infoReply = await requestJson(port, cert, auth);
    assert.equal(infoReply.status, 200, 'authenticated zero-profile GET /protocol.info remains discovery');
    const info = JSON.parse(infoReply.body) as typeof service.info;
    assert.deepEqual(info.capabilities, ['transport.create', 'command.lookup', 'thread.create']);
    const missingNegotiation = await requestJson(port, cert, 'Babel-Acp-Session placeholder', '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: info.instance_id }), {
        'x-babel-contract-version': '9.0.0',
      });
    assert.equal(missingNegotiation.status, 401, 'authentication is checked before negotiation details');
    const body = JSON.stringify({ request_id: 'request-1', project_id: 'project-one', session_binding: 'launch-1', expected_host_instance: info.instance_id });
    const created = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', body);
    assert.equal(created.status, 201);
    const session = JSON.parse(created.body) as { principal_id: string; credential: string; registration_generation: number };
    assert.ok(session.principal_id);
    assert.equal(session.registration_generation, 1);
    const registrationReplay = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', body);
    assert.equal(registrationReplay.status, 201);
    compareIssuanceReplay(registrationReplay.body, created.body,
      'a lost registration response replays the same credential, generation, and expiry');
    const conflictingIntent = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', JSON.stringify({
      request_id: 'request-1', project_id: 'project-one', session_binding: 'launch-conflict', expected_host_instance: info.instance_id,
    }));
    assert.equal(conflictingIntent.status, 403);
    assert.equal(JSON.parse(conflictingIntent.body).error, 'registration_fingerprint_conflict');
    assert.equal(JSON.parse(conflictingIntent.body).credential === undefined, true, 'failures never return a credential');
    const schemaMismatch = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: info.instance_id }), {
        'x-babel-schema-sha256': '0'.repeat(64),
      });
    assert.equal(schemaMismatch.status, 406);
    const acpInfo = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`);
    assert.equal(acpInfo.status, 200);
    const transportReply = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: service.info.instance_id }));
    assert.equal(transportReply.status, 201);
    const transport = JSON.parse(transportReply.body) as { session_id: string };
    const rpcAt = (listenPort: number, token: string, id: string, method: string, params: Record<string, unknown>) => requestJson(listenPort, cert,
      `Babel-Acp-Session ${token}`, '/rpc', 'POST', JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const rpc = (token: string, id: string, method: string, params: Record<string, unknown>) => rpcAt(port, token, id, method, params);
    const createParams = { project_id: 'project-one', session_id: transport.session_id,
      command_id: 'cmd-1', expected_host_instance: service.info.instance_id };

    const profileMismatch = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`, '/rpc', 'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 'cmd-1', method: 'thread.create', params: createParams }),
      { 'x-babel-schema-sha256': '0'.repeat(64) });
    assert.equal(profileMismatch.status, 406);
    assert.equal(dispatchCount, 0, 'schema negotiation failure happens before native admission');
    const createdThread = await rpc(session.credential, 'cmd-1', 'thread.create', createParams);
    assert.equal(createdThread.status, 200);
    const createResponse = JSON.parse(createdThread.body) as { result: { thread_id: string } };
    assert.ok(createResponse.result.thread_id);
    const duplicateThread = await rpc(session.credential, 'cmd-1', 'thread.create', createParams);
    assert.deepEqual(JSON.parse(duplicateThread.body), createResponse, 'duplicate create replays its durable response without dispatch');
    assert.equal(dispatchCount, 1);
    const lookup = await rpc(session.credential, 'lookup-1', 'command.lookup', { ...createParams, command_id: 'cmd-1' });
    const lookupResult = JSON.parse(lookup.body) as { result: { state: string; thread_id: string } };
    assert.equal(lookupResult.result.state, 'settled');
    assert.equal(lookupResult.result.thread_id, createResponse.result.thread_id);

    const secondCreated = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', JSON.stringify({
      request_id: 'request-2', project_id: 'project-one', session_binding: 'launch-2', expected_host_instance: info.instance_id,
    }));
    const secondSession = JSON.parse(secondCreated.body) as { credential: string };
    const secondTransportReply = await requestJson(port, cert, `Babel-Acp-Session ${secondSession.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: service.info.instance_id }));
    const secondTransport = JSON.parse(secondTransportReply.body) as { session_id: string };
    const isolated = await rpc(secondSession.credential, 'lookup-other', 'command.lookup', {
      project_id: 'project-one', session_id: secondTransport.session_id, command_id: 'cmd-1', expected_host_instance: service.info.instance_id,
    });
    assert.deepEqual(JSON.parse(isolated.body).result, { command_id: 'cmd-1', state: 'unknown', reason: 'no_admission_record' });
    const invalidRawProject = await rpc(session.credential, 'cmd-invalid', 'thread.create', {
      ...createParams, command_id: 'cmd-invalid', project_root: root,
    });
    assert.equal(invalidRawProject.status, 400);
    assert.equal(JSON.parse(invalidRawProject.body).error, 'invalid_rpc_request');
    const denied = await requestJson(port, cert, 'Bearer ' + rootCredential, '/integrations/acp-sessions', 'POST', body);
    assert.equal(denied.status, 401);

    loseNextReply = true;
    const lostParams = { ...createParams, command_id: 'cmd-lost' };
    const lost = await rpc(session.credential, 'cmd-lost', 'thread.create', lostParams);
    const lostResponse = JSON.parse(lost.body) as { error: { data: { reason: string; thread_id: string } } };
    assert.equal(lostResponse.error.data.reason, 'reconcile_required');
    const lostThreadId = lostResponse.error.data.thread_id;
    const countAfterLoss = dispatchCount;
    const noReplay = await rpc(session.credential, 'cmd-lost', 'thread.create', lostParams);
    assert.equal(JSON.parse(noReplay.body).error.data.thread_id, lostThreadId);
    assert.equal(dispatchCount, countAfterLoss, 'unknown create is not replayed automatically');
    const lostLookup = await rpc(session.credential, 'lookup-lost', 'command.lookup', { ...lostParams, command_id: 'cmd-lost' });
    assert.equal(JSON.parse(lostLookup.body).result.state, 'unknown');
    assert.equal(JSON.parse(lostLookup.body).result.thread_id, lostThreadId);

    const previousInstance = info.instance_id;
    await service.close();
    journal.close();
    closeProtocolHostState(gateway.host);
    gateway = new ProtocolGateway({ allowedWorkspaceRoot: root, remoteSurface: true, enforceControlLease: true });
    const restartedPort = await freePort();
    service = makeService(restartedPort);
    await service.listen();
    assert.notEqual(service.info.instance_id, previousInstance);
    const oldCredential = await requestJson(restartedPort, cert, `Babel-Acp-Session ${session.credential}`);
    assert.equal(oldCredential.status, 401, 'a prior host instance token cannot authenticate after restart');
    const renewalBody = JSON.stringify({
      request_id: integrationRenewalRequestId(session.principal_id, 1), request_sequence: 1,
      session_binding: 'launch-1', expected_host_instance: service.info.instance_id,
      expected_registration_generation: 1,
    });
    const requalified = await requestJson(restartedPort, cert, auth,
      `/integrations/acp-sessions/${session.principal_id}/renew`, 'POST', renewalBody);
    assert.equal(requalified.status, 200);
    const renewed = JSON.parse(requalified.body) as { credential: string; principal_id: string; registration_generation: number };
    assert.equal(renewed.principal_id, session.principal_id);
    assert.equal(renewed.registration_generation, 2);
    const renewalReplay = await requestJson(restartedPort, cert, auth,
      `/integrations/acp-sessions/${session.principal_id}/renew`, 'POST', renewalBody);
    assert.equal(renewalReplay.status, 200);
    compareIssuanceReplay(renewalReplay.body, requalified.body,
      'a lost renewal response replays the same credential and generation');
    const staleRenewal = await requestJson(restartedPort, cert, auth,
      `/integrations/acp-sessions/${session.principal_id}/renew`, 'POST', JSON.stringify({
        request_id: integrationRenewalRequestId(session.principal_id, 2), request_sequence: 2,
        session_binding: 'launch-1', expected_host_instance: service.info.instance_id,
        expected_registration_generation: 1,
      }));
    assert.equal(staleRenewal.status, 403);
    assert.equal(JSON.parse(staleRenewal.body).error, 'stale_registration_generation');
    assert.equal(JSON.parse(staleRenewal.body).credential === undefined, true, 'stale renewal never returns a credential');
    assert.equal((await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`)).status, 200,
      'a stale renewal cannot rotate the current credential');
    const recoveredInfo = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`);
    assert.equal(recoveredInfo.status, 200);
    const renewedTransportReply = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: service.info.instance_id }));
    const renewedTransport = JSON.parse(renewedTransportReply.body) as { session_id: string };
    const recoveredCommand = await rpcAt(restartedPort, renewed.credential, 'lookup-recovered', 'command.lookup', {
      project_id: 'project-one', session_id: renewedTransport.session_id, command_id: 'cmd-1', expected_host_instance: service.info.instance_id,
    });
    assert.equal(JSON.parse(recoveredCommand.body).result.state, 'settled');

    const noProfileDispatchBaseline = dispatchCount;
    const noProfileRegistration = await requestJson(restartedPort, cert, auth, '/integrations/acp-sessions', 'POST', JSON.stringify({
      request_id: 'unnegotiated-registration', project_id: 'project-one', session_binding: 'unnegotiated-launch',
      expected_host_instance: service.info.instance_id,
    }), {}, false);
    const noProfileTransport = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: service.info.instance_id }), {}, false);
    const noProfileRpc = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`, '/rpc', 'POST',
      JSON.stringify({ jsonrpc: '2.0', id: 'unnegotiated-command', method: 'thread.create', params: {
        project_id: 'project-one', session_id: renewedTransport.session_id, command_id: 'unnegotiated-command',
        expected_host_instance: service.info.instance_id,
      } }), {}, false);
    const noProfileRenewal = await requestJson(restartedPort, cert, auth,
      `/integrations/acp-sessions/${renewed.principal_id}/renew`, 'POST', JSON.stringify({
        request_id: integrationRenewalRequestId(renewed.principal_id, 2), request_sequence: 2,
        session_binding: 'launch-1', expected_host_instance: service.info.instance_id,
        expected_registration_generation: 2,
      }), {}, false);
    assert.deepEqual({ statuses: [noProfileRegistration.status, noProfileTransport.status, noProfileRpc.status, noProfileRenewal.status],
      dispatchCount: dispatchCount - noProfileDispatchBaseline }, { statuses: [406, 406, 406, 406], dispatchCount: 0 },
    'all four scoped mutation classes require an exact profile and zero-profile RPC cannot dispatch native work');
  } finally {
    await service.close();
    journal.close();
    closeProtocolHostState(gateway.host);
    registry.close();
    rmSync(root, { recursive: true, force: true });
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
  }
});

test('TLS issuance classification is stable across handles, expiry, revocation, and project change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-issuance-tls-'));
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (generated.error || generated.status !== 0) rmSync(root, { recursive: true, force: true });
  assert.equal(generated.error, undefined,
    'openssl is a required precondition for the synthetic local TLS identity; install it on the test host');
  assert.equal(generated.status === 0, true,
    `openssl failed to generate the synthetic local TLS identity (status ${String(generated.status)})`);
  const cert = readFileSync(join(root, 'cert.pem'));
  const key = readFileSync(join(root, 'key.pem'));
  const project = join(root, 'project');
  const privateDir = join(root, 'private');
  mkdirSync(project);
  mkdirSync(privateDir, { mode: 0o700 });
  const host = 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb';
  let now = 1_000;
  const dbPath = join(privateDir, 'integration.sqlite');
  const first = new IntegrationRegistry(dbPath, () => undefined, { now: () => now });
  const second = new IntegrationRegistry(dbPath, () => undefined, { now: () => now });
  let serviceA: IntegrationTlsServer | undefined;
  let serviceB: IntegrationTlsServer | undefined;
  try {
    first.registerProject({ projectId: 'project', root: project });
    const rootCredential = first.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const auth = `Babel-Integration ${rootCredential}`;
    const makeService = (port: number, registry: IntegrationRegistry) => new IntegrationTlsServer({
      port, gatewayId: 'synthetic-gateway', certificate: cert, privateKey: key, registry, instanceId: host,
    });
    const portA = await freePort();
    serviceA = makeService(portA, first);
    await serviceA.listen();
    const portB = await freePort();
    serviceB = makeService(portB, second);
    await serviceB.listen();

    const registrationBody = JSON.stringify({ request_id: 'api-create', project_id: 'project',
      session_binding: 'launch', expected_host_instance: host });
    const created = await requestJson(portA, cert, auth, '/integrations/acp-sessions', 'POST', registrationBody);
    assert.equal(created.status, 201);
    const session = JSON.parse(created.body) as { principal_id: string; credential: string; registration_generation: number };
    const replayed = await requestJson(portB, cert, auth, '/integrations/acp-sessions', 'POST', registrationBody);
    assert.equal(replayed.status, 201);
    compareIssuanceReplay(replayed.body, created.body,
      'the durable request ledger and reproducible credential are shared by two database handles');

    now += 5 * 60_000;
    const expiredRegistration = await requestJson(portA, cert, auth, '/integrations/acp-sessions', 'POST', registrationBody);
    assert.equal(expiredRegistration.status, 403);
    assert.deepEqual(JSON.parse(expiredRegistration.body), { error: 'registration_expired' },
      'expired request IDs never rotate or expose plaintext');

    const renewalPath = `/integrations/acp-sessions/${session.principal_id}/renew`;
    const renewalBody = JSON.stringify({ request_id: integrationRenewalRequestId(session.principal_id, 1),
      request_sequence: 1, session_binding: 'launch', expected_host_instance: host,
      expected_registration_generation: 1 });
    const renewed = await requestJson(portA, cert, auth, renewalPath, 'POST', renewalBody);
    assert.equal(renewed.status, 200);
    const renewedSession = JSON.parse(renewed.body) as { credential: string; registration_generation: number };
    assert.equal(renewedSession.registration_generation, 2);
    const renewalReplay = await requestJson(portB, cert, auth, renewalPath, 'POST', renewalBody);
    assert.equal(renewalReplay.status, 200);
    compareIssuanceReplay(renewalReplay.body, renewed.body,
      'a lost renewal response replays the same credential and generation across handles');

    now += 5 * 60_000;
    const expiredRenewal = await requestJson(portB, cert, auth, renewalPath, 'POST', renewalBody);
    assert.equal(expiredRenewal.status, 403);
    assert.deepEqual(JSON.parse(expiredRenewal.body), { error: 'requalification_expired' });
    const nextRenewal = await requestJson(portA, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: integrationRenewalRequestId(session.principal_id, 2), request_sequence: 2,
      session_binding: 'launch', expected_host_instance: host, expected_registration_generation: 2,
    }));
    assert.equal(nextRenewal.status, 200);
    const nextSession = JSON.parse(nextRenewal.body) as { credential: string; registration_generation: number };
    assert.equal(nextSession.registration_generation, 3);
    assert.equal((await requestJson(portB, cert, `Babel-Acp-Session ${nextSession.credential}`)).status, 200);

    second.revokeAcpSession(session.principal_id);
    const revokedReplay = await requestJson(portA, cert, auth, '/integrations/acp-sessions', 'POST', registrationBody);
    assert.equal(revokedReplay.status, 403);
    assert.deepEqual(JSON.parse(revokedReplay.body), { error: 'registration_revoked' });
    const revokedRenewal = await requestJson(portA, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: integrationRenewalRequestId(session.principal_id, 3), request_sequence: 3,
      session_binding: 'launch', expected_host_instance: host, expected_registration_generation: 3,
    }));
    assert.equal(revokedRenewal.status, 403);
    assert.deepEqual(JSON.parse(revokedRenewal.body), { error: 'registration_revoked' });
    assert.equal((await requestJson(portB, cert, `Babel-Acp-Session ${nextSession.credential}`)).status, 401);

    const replacementBody = JSON.stringify({ request_id: 'api-create-replacement', project_id: 'project',
      session_binding: 'launch', expected_host_instance: host });
    const replacement = await requestJson(portA, cert, auth, '/integrations/acp-sessions', 'POST', replacementBody);
    assert.equal(replacement.status, 201);
    const replacementSession = JSON.parse(replacement.body) as { principal_id: string };
    assert.notEqual(replacementSession.principal_id, session.principal_id,
      'a new request issues a new principal instead of resurrecting the revoked one');

    second.registerProject({ projectId: 'project', root: project });
    const identityChanged = await requestJson(portA, cert, auth,
      `/integrations/acp-sessions/${replacementSession.principal_id}/renew`, 'POST', JSON.stringify({
        request_id: integrationRenewalRequestId(replacementSession.principal_id, 1), request_sequence: 1,
        session_binding: 'launch', expected_host_instance: host, expected_registration_generation: 1,
      }));
    assert.equal(identityChanged.status, 403);
    assert.deepEqual(JSON.parse(identityChanged.body), { error: 'project_identity_changed' });
  } finally {
    if (serviceA) await serviceA.close();
    if (serviceB) await serviceB.close();
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('TLS restart reconciliation recovers a withheld renewal without duplicate generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-reconcile-tls-'));
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (generated.error || generated.status !== 0) rmSync(root, { recursive: true, force: true });
  assert.equal(generated.error, undefined,
    'openssl is a required precondition for the synthetic local TLS identity; install it on the test host');
  assert.equal(generated.status === 0, true,
    `openssl failed to generate the synthetic local TLS identity (status ${String(generated.status)})`);
  const cert = readFileSync(join(root, 'cert.pem'));
  const key = readFileSync(join(root, 'key.pem'));
  const project = join(root, 'project');
  const privateDir = join(root, 'private');
  mkdirSync(project);
  mkdirSync(privateDir, { mode: 0o700 });
  const hostA = 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb';
  const hostB = '6f0f3a52-4a1b-4c9e-9b2f-1a2b3c4d5e6f';
  let now = 1_000;
  const dbPath = join(privateDir, 'integration.sqlite');
  const registryA = new IntegrationRegistry(dbPath, () => undefined, { now: () => now });
  const registryB = new IntegrationRegistry(dbPath, () => undefined, { now: () => now });
  let serviceA: IntegrationTlsServer | undefined;
  let serviceB: IntegrationTlsServer | undefined;
  try {
    registryA.registerProject({ projectId: 'project', root: project });
    const rootCredential = registryA.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project'] });
    const auth = `Babel-Integration ${rootCredential}`;
    const portA = await freePort();
    serviceA = new IntegrationTlsServer({ port: portA, gatewayId: 'synthetic-gateway', certificate: cert,
      privateKey: key, registry: registryA, instanceId: hostA });
    await serviceA.listen();
    const registrationBody = JSON.stringify({ request_id: 'api-create', project_id: 'project',
      session_binding: 'launch', expected_host_instance: hostA });
    const created = await requestJson(portA, cert, auth, '/integrations/acp-sessions', 'POST', registrationBody);
    assert.equal(created.status, 201);
    const session = JSON.parse(created.body) as { principal_id: string; credential: string; registration_generation: number };
    const canonical = (sequence: number) => integrationRenewalRequestId(session.principal_id, sequence);
    const renewalPath = `/integrations/acp-sessions/${session.principal_id}/renew`;
    const statusPath = `/integrations/acp-sessions/${session.principal_id}/status`;
    const withheld = await requestJson(portA, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: canonical(1), request_sequence: 1, session_binding: 'launch',
      expected_host_instance: hostA, expected_registration_generation: 1,
    }));
    assert.equal(withheld.status, 200, 'the renewal commits while its response is withheld from the client');
    // The client never reads the withheld credential. A real gateway restart rotates boot identity.
    await serviceA.close();
    serviceA = undefined;
    const portB = await freePort();
    serviceB = new IntegrationTlsServer({ port: portB, gatewayId: 'synthetic-gateway', certificate: cert,
      privateKey: key, registry: registryB, instanceId: hostB });
    await serviceB.listen();
    assert.equal((await requestJson(portB, cert, `Babel-Acp-Session ${session.credential}`)).status, 401,
      'random boot identity invalidates the pre-restart session credential');

    const statusBody = (requestId: string, sequence: number, extra: Record<string, string> = {}) => JSON.stringify({
      request_id: requestId, request_sequence: sequence, project_id: 'project',
      session_binding: 'launch', expected_host_instance: hostB, ...extra,
    });
    const issued = await requestJson(portB, cert, auth, statusPath, 'POST', statusBody(canonical(1), 1));
    assert.equal(issued.status, 200);
    const issuedStatus = JSON.parse(issued.body) as Record<string, unknown>;
    assert.equal(issuedStatus['disposition'], 'issued');
    assert.equal(issuedStatus['registration_generation'], 2);
    assert.equal(issuedStatus['renewal_sequence'], 1, 'status reports the authoritative renewal sequence');
    assert.equal(issuedStatus['host_instance_id'], hostB, 'status reports the serving incarnation');
    assert.equal(Object.hasOwn(issuedStatus, 'credential'), false, 'status never returns a credential');
    const repeated = await requestJson(portB, cert, auth, statusPath, 'POST', statusBody(canonical(1), 1));
    assert.equal(repeated.status, 200);
    assert.equal(JSON.parse(repeated.body)['registration_generation'], 2, 'status never duplicates the generation');

    const wrongBinding = await requestJson(portB, cert, auth, statusPath, 'POST',
      statusBody(canonical(1), 1, { session_binding: 'other-launch' }));
    assert.equal(wrongBinding.status, 403);
    assert.deepEqual(JSON.parse(wrongBinding.body), { error: 'session_binding_denied' });
    const wrongProject = await requestJson(portB, cert, auth, statusPath, 'POST',
      statusBody(canonical(1), 1, { project_id: 'other-project' }));
    assert.equal(wrongProject.status, 403);
    assert.deepEqual(JSON.parse(wrongProject.body), { error: 'project_scope_denied' });

    const recovered = await requestJson(portB, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: canonical(2), request_sequence: 2, session_binding: 'launch',
      expected_host_instance: hostB, expected_registration_generation: 2,
    }));
    assert.equal(recovered.status, 200);
    const recoveredSession = JSON.parse(recovered.body) as { credential: string; registration_generation: number; expires_at_ms: number };
    assert.equal(recoveredSession.registration_generation, 3);
    const superseded = await requestJson(portB, cert, auth, statusPath, 'POST', statusBody(canonical(1), 1));
    assert.equal(JSON.parse(superseded.body)['disposition'], 'superseded');

    now = recoveredSession.expires_at_ms;
    const expired = await requestJson(portB, cert, auth, statusPath, 'POST', statusBody(canonical(2), 2));
    assert.equal(expired.status, 200);
    assert.equal(JSON.parse(expired.body)['disposition'], 'expired');
    assert.equal(JSON.parse(expired.body)['renewal_sequence'], 2);
    assert.equal(Object.hasOwn(JSON.parse(expired.body) as Record<string, unknown>, 'credential'), false);
    const expiredRetry = await requestJson(portB, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: canonical(2), request_sequence: 2, session_binding: 'launch',
      expected_host_instance: hostB, expected_registration_generation: 2,
    }));
    assert.equal(expiredRetry.status, 403);
    assert.deepEqual(JSON.parse(expiredRetry.body), { error: 'requalification_expired' });
    const fresh = await requestJson(portB, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: canonical(3), request_sequence: 3, session_binding: 'launch',
      expected_host_instance: hostB, expected_registration_generation: 3,
    }));
    assert.equal(fresh.status, 200);
    assert.equal(JSON.parse(fresh.body).registration_generation, 4);

    registryB.revokeAcpSession(session.principal_id);
    const revoked = await requestJson(portB, cert, auth, statusPath, 'POST', statusBody(canonical(3), 3));
    assert.equal(revoked.status, 200);
    assert.equal(JSON.parse(revoked.body)['disposition'], 'revoked');
    assert.equal(Object.hasOwn(JSON.parse(revoked.body) as Record<string, unknown>, 'credential'), false);
    const revokedRetry = await requestJson(portB, cert, auth, renewalPath, 'POST', JSON.stringify({
      request_id: canonical(4), request_sequence: 4, session_binding: 'launch',
      expected_host_instance: hostB, expected_registration_generation: 4,
    }));
    assert.equal(revokedRetry.status, 403);
    assert.deepEqual(JSON.parse(revokedRetry.body), { error: 'registration_revoked' });
  } finally {
    if (serviceA) await serviceA.close();
    if (serviceB) await serviceB.close();
    registryA.close();
    registryB.close();
    rmSync(root, { recursive: true, force: true });
  }
});
