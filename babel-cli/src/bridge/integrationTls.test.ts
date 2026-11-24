import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import test from 'node:test';
import { IntegrationTlsServer } from './integrationTls.js';
import { IntegrationRegistry } from './integrationRegistry.js';
import { NativeCommandJournal } from './commandJournal.js';
import { ProtocolGateway } from './protocolGateway.js';
import { closeProtocolHostState } from '../protocol/client/host.js';
import { BABEL_INTEGRATION_SCHEMA_SHA256 } from '../protocol/remoteContract.js';

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
  method = 'GET', body?: string, extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, ca,
      rejectUnauthorized: true,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(path !== '/protocol.info' ? {
          'x-babel-contract': 'babel.integration',
          'x-babel-contract-version': '1.0.0',
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

test('integration TLS serves only authenticated version info and rejects an unpinned peer', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-tls-'));
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
    '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', windowsHide: true });
  if (generated.error || generated.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    t.skip('openssl is required to generate a synthetic local TLS identity');
    return;
  }
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
    assert.equal(info.version, '1.0.0');
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
        'x-babel-contract': info.contract, 'x-babel-contract-version': '2.0.0',
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

test('TLS ACP registration issues a project-scoped principal and never opens legacy RPC', async (t) => {
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
    rmSync(root, { recursive: true, force: true });
    t.skip('openssl is required to generate a synthetic local TLS identity');
    return;
  }
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const port = await freePort();
  const project = join(root, 'project');
  const privateDir = join(root, 'private');
  const dbPath = join(privateDir, 'integration.sqlite');
  const { mkdirSync } = await import('node:fs');
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
    assert.equal(infoReply.status, 200);
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
    const requalified = await requestJson(restartedPort, cert, auth,
      `/integrations/acp-sessions/${session.principal_id}/renew`, 'POST', JSON.stringify({
        request_id: 'requal-1', session_binding: 'launch-1', expected_host_instance: service.info.instance_id,
      }));
    assert.equal(requalified.status, 200);
    const renewed = JSON.parse(requalified.body) as { credential: string; principal_id: string };
    assert.equal(renewed.principal_id, session.principal_id);
    const recoveredInfo = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`);
    assert.equal(recoveredInfo.status, 200);
    const renewedTransportReply = await requestJson(restartedPort, cert, `Babel-Acp-Session ${renewed.credential}`, '/sessions', 'POST',
      JSON.stringify({ project_id: 'project-one', expected_host_instance: service.info.instance_id }));
    const renewedTransport = JSON.parse(renewedTransportReply.body) as { session_id: string };
    const recoveredCommand = await rpcAt(restartedPort, renewed.credential, 'lookup-recovered', 'command.lookup', {
      project_id: 'project-one', session_id: renewedTransport.session_id, command_id: 'cmd-1', expected_host_instance: service.info.instance_id,
    });
    assert.equal(JSON.parse(recoveredCommand.body).result.state, 'settled');
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
