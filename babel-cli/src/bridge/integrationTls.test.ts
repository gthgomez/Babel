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
  method = 'GET', body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method, ca,
      rejectUnauthorized: true,
      ...(body ? { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(authorization ? { authorization } : {}) } } : {}),
      ...(!body && authorization ? { headers: { authorization } } : {}),
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
    assert.equal(info.protocol, 'babel-native-integration');
    assert.equal(info.gateway_id, 'synthetic-gateway');
    assert.equal(info.instance_id, service.info.instance_id);
    assert.deepEqual(info.capabilities, [], 'no execution RPC is advertised before scoped ACP auth exists');
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
  const root = mkdtempSync(join(tmpdir(), 'babel-integration-acp-tls-'));
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
  registry.registerProject({ projectId: 'project-one', root: project });
  const rootCredential = registry.registerIntegration({ integrationId: 'bridge', name: 'fixture', allowedProjectIds: ['project-one'] });
  const service = new IntegrationTlsServer({ port, gatewayId: 'gw', certificate: cert, privateKey: key, registry,
    commandJournal: (instanceId) => {
      journal = new NativeCommandJournal(join(privateDir, 'commands.sqlite'), {
        hostInstanceId: instanceId, protectStoreDirectory: (directory) => assert.equal(directory, privateDir),
      });
      return journal;
    },
  });
  try {
    await service.listen();
    const auth = `Babel-Integration ${rootCredential}`;
    const infoReply = await requestJson(port, cert, auth);
    assert.equal(infoReply.status, 200);
    const info = JSON.parse(infoReply.body) as typeof service.info;
    const body = JSON.stringify({ request_id: 'request-1', project_id: 'project-one', session_binding: 'launch-1', expected_host_instance: info.instance_id });
    const created = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', body);
    assert.equal(created.status, 201);
    const session = JSON.parse(created.body) as { principal_id: string; credential: string; registration_generation: number };
    assert.ok(session.principal_id);
    assert.equal(session.registration_generation, 1);
    const acpInfo = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`);
    assert.equal(acpInfo.status, 200);
    const reserved = journal.reserve({ commandId: 'cmd-1', principalId: session.principal_id,
      projectId: 'project-one', hostInstanceId: service.info.instance_id, registrationGeneration: session.registration_generation,
      payload: { method: 'turn.submit', text: 'synthetic' } });
    assert.equal(reserved.ok, true);
    if (reserved.ok) journal.settle({ commandId: 'cmd-1', principalId: session.principal_id, result: { terminal: 'fixture' } });
    const command = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`, '/commands/cmd-1');
    assert.equal(command.status, 200);
    assert.deepEqual(JSON.parse(command.body), {
      command_id: 'cmd-1', fingerprint: reserved.ok ? reserved.record.fingerprint : '', state: 'settled',
      host_instance_id: service.info.instance_id, registration_generation: 1, result: { terminal: 'fixture' },
    });
    const secondCreated = await requestJson(port, cert, auth, '/integrations/acp-sessions', 'POST', JSON.stringify({
      request_id: 'request-2', project_id: 'project-one', session_binding: 'launch-2', expected_host_instance: info.instance_id,
    }));
    const secondSession = JSON.parse(secondCreated.body) as { credential: string };
    const isolated = await requestJson(port, cert, `Babel-Acp-Session ${secondSession.credential}`, '/commands/cmd-1');
    assert.deepEqual(JSON.parse(isolated.body), { command_id: 'cmd-1', state: 'unknown', reason: 'no_admission_record' });
    const rpc = await requestJson(port, cert, `Babel-Acp-Session ${session.credential}`, '/rpc');
    assert.equal(rpc.status, 404);
    const denied = await requestJson(port, cert, 'Bearer ' + rootCredential, '/integrations/acp-sessions', 'POST', body);
    assert.equal(denied.status, 401);
  } finally {
    await service.close();
    journal.close();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
