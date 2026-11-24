import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BABEL_PROTOCOL_METHODS, BABEL_PROTOCOL_NOTIFICATIONS, BABEL_PROTOCOL_VERSION } from '../protocol/types.js';
import type { IntegrationRegistry } from './integrationRegistry.js';
import type { NativeCommandJournal } from './commandJournal.js';
import type { ProtocolGateway } from './protocolGateway.js';
import { createScopedNativeThread } from './scopedNativeThreadCreate.js';

export interface IntegrationTlsOptions {
  port: number;
  gatewayId: string;
  certificate: string | Buffer;
  privateKey: string | Buffer;
  integrationCredential?: string;
  registry?: IntegrationRegistry;
  commandJournal?: NativeCommandJournal | ((instanceId: string) => NativeCommandJournal);
  /** The owning ProtocolGateway supplies its boot identity when attached. */
  instanceId?: string;
  gateway?: Pick<ProtocolGateway, 'dispatchScopedNativeThreadCreate'>;
  /** Effectful native create stays disabled until credential expiry/renewal is qualified. */
  enableNativeThreadCreate?: boolean;
}

export interface IntegrationProtocolInfo {
  protocol: 'babel-native-integration';
  protocol_version: string;
  schema_hash: string;
  gateway_id: string;
  instance_id: string;
  capabilities: string[];
  limits: { max_rpc_bytes: number };
}

function credentialMatches(header: string | undefined, credential: string): boolean {
  const prefix = 'Babel-Integration ';
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(credential);
  if (!supplied.length || supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Dedicated HTTPS bootstrap surface. It is deliberately unable to dispatch RPCs
 * until scoped ACP principals and session binding have been provisioned.
 */
export class IntegrationTlsServer {
  readonly info: IntegrationProtocolInfo;
  private readonly server: HttpsServer;
  private readonly commandJournal: NativeCommandJournal | undefined;

  constructor(private readonly options: IntegrationTlsOptions) {
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
      throw new Error('integration TLS port must be a fixed non-privileged port');
    }
    if (!options.gatewayId.trim() || (!options.registry && (options.integrationCredential?.length ?? 0) < 32)) {
      throw new Error('integration TLS requires a gateway identity and registry or high-entropy credential');
    }
    this.info = {
      protocol: 'babel-native-integration',
      protocol_version: BABEL_PROTOCOL_VERSION,
      // This hash identifies the currently exported catalog, not full JSON schemas.
      schema_hash: createHash('sha256')
        .update(JSON.stringify({ methods: BABEL_PROTOCOL_METHODS, notifications: BABEL_PROTOCOL_NOTIFICATIONS }))
        .digest('hex'),
      gateway_id: options.gatewayId,
      instance_id: options.instanceId ?? randomUUID(),
      capabilities: [
        ...(options.registry ? ['transport.create'] : []),
        ...(options.registry && options.commandJournal ? ['command.lookup'] : []),
        ...(options.registry && options.commandJournal && options.gateway && options.enableNativeThreadCreate === true ? ['thread.create'] : []),
      ],
      limits: { max_rpc_bytes: 16 * 1024 },
    };
    this.commandJournal = typeof options.commandJournal === 'function'
      ? options.commandJournal(this.info.instance_id)
      : options.commandJournal;
    this.server = createServer(
      { cert: options.certificate, key: options.privateKey, minVersion: 'TLSv1.2' },
      (req, res) => {
        void this.handle(req, res).catch(() => {
          if (!res.headersSent) reply(res, 500, { error: 'integration_request_failed' });
          else res.destroy();
        });
      },
    );
  }

  private integrationCredential(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    const prefix = 'Babel-Integration ';
    return header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;
  }

  private acpCredential(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    const prefix = 'Babel-Acp-Session ';
    return header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;
  }

  private isIntegrationAuthenticated(req: IncomingMessage): boolean {
    const credential = this.integrationCredential(req);
    if (!credential) return false;
    return this.options.registry
      ? this.options.registry.authenticateIntegration(credential)
      : credentialMatches(req.headers.authorization, this.options.integrationCredential ?? '');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/sessions' && req.method === 'POST' && this.options.registry) {
      const credential = this.acpCredential(req);
      if (!credential) { reply(res, 401, { error: 'acp_session_authentication_required' }); return; }
      const raw = await this.readBody(req, res);
      if (raw === null) return;
      let body: unknown;
      try { body = JSON.parse(raw); } catch { reply(res, 400, { error: 'invalid_transport_session' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { reply(res, 400, { error: 'invalid_transport_session' }); return; }
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some((key) => !['project_id', 'expected_host_instance'].includes(key)) ||
          typeof value['project_id'] !== 'string' || typeof value['expected_host_instance'] !== 'string' ||
          value['expected_host_instance'] !== this.info.instance_id) {
        reply(res, 400, { error: value['expected_host_instance'] !== this.info.instance_id ? 'stale_host_instance' : 'invalid_transport_session' });
        return;
      }
      const result = this.options.registry.createTransportSession({ acpCredential: credential,
        projectId: value['project_id'], expectedHostInstance: value['expected_host_instance'] });
      if (!result.ok) { reply(res, 403, { error: result.reason }); return; }
      reply(res, 201, { session_id: result.sessionId, project_id: result.principal.projectId,
        host_instance_id: result.principal.hostInstanceId, registration_generation: result.principal.registrationGeneration,
        expires_at_ms: result.principal.expiresAtMs });
      return;
    }
    if (req.url === '/rpc' && req.method === 'POST') {
      await this.handleScopedRpc(req, res);
      return;
    }
    if (req.url === '/protocol.info' && req.method === 'GET') {
      const integrationOk = this.isIntegrationAuthenticated(req);
      const acpCredential = this.acpCredential(req);
      const acpOk = !!acpCredential && !!this.options.registry?.authenticateAcpSession(acpCredential, this.info.instance_id);
      if (!integrationOk && !acpOk) {
        reply(res, 401, { error: 'integration_authentication_required' });
        return;
      }
      reply(res, 200, this.info);
      return;
    }
    if (req.url === '/integrations/acp-sessions' && req.method === 'POST' && this.options.registry) {
      if (!this.isIntegrationAuthenticated(req)) {
        reply(res, 401, { error: 'integration_authentication_required' });
        return;
      }
      const raw = await this.readBody(req, res);
      if (raw === null) return;
      let body: unknown;
      try { body = JSON.parse(raw); } catch { reply(res, 400, { error: 'invalid_registration' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reply(res, 400, { error: 'invalid_registration' });
        return;
      }
      const value = body as Record<string, unknown>;
      const allowedKeys = new Set(['request_id', 'project_id', 'session_binding', 'expected_host_instance', 'discovery_ref']);
      if (Object.keys(value).some((key) => !allowedKeys.has(key)) ||
          typeof value['request_id'] !== 'string' || value['request_id'].length < 1 || value['request_id'].length > 128 ||
          typeof value['project_id'] !== 'string' || value['project_id'].length < 1 || value['project_id'].length > 64 ||
          typeof value['session_binding'] !== 'string' || value['session_binding'].length < 1 || value['session_binding'].length > 256 ||
          typeof value['expected_host_instance'] !== 'string' || value['expected_host_instance'].length > 128) {
        reply(res, 400, { error: 'invalid_registration' });
        return;
      }
      if (value['discovery_ref'] !== undefined) {
        reply(res, 403, { error: 'unsupported_capability', reason: 'thread_scope_denied' });
        return;
      }
      const result = this.options.registry.createAcpSession({
        integrationCredential: this.integrationCredential(req) ?? '',
        requestId: value['request_id'], projectId: value['project_id'],
        sessionBinding: value['session_binding'], expectedHostInstance: value['expected_host_instance'],
        currentHostInstance: this.info.instance_id,
      });
      if (!result.ok) { reply(res, 403, { error: result.reason }); return; }
      reply(res, 201, { principal_id: result.session.principalId, session_id: result.session.sessionId,
        project_id: result.session.projectId, registration_generation: result.session.registrationGeneration,
        expires_at_ms: result.session.expiresAtMs, renew_after_ms: 60_000,
        credential: result.session.credential });
      return;
    }
    const requalifyPath = /^\/integrations\/acp-sessions\/([0-9a-f-]{36})\/renew$/.exec(req.url ?? '');
    if (req.method === 'POST' && requalifyPath && this.options.registry) {
      if (!this.isIntegrationAuthenticated(req)) {
        reply(res, 401, { error: 'integration_authentication_required' });
        return;
      }
      const raw = await this.readBody(req, res);
      if (raw === null) return;
      let body: unknown;
      try { body = JSON.parse(raw); } catch { reply(res, 400, { error: 'invalid_requalification' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reply(res, 400, { error: 'invalid_requalification' });
        return;
      }
      const value = body as Record<string, unknown>;
      const allowedKeys = new Set(['request_id', 'session_binding', 'expected_host_instance']);
      if (Object.keys(value).some((key) => !allowedKeys.has(key)) ||
          typeof value['request_id'] !== 'string' || value['request_id'].length < 1 || value['request_id'].length > 128 ||
          typeof value['session_binding'] !== 'string' || value['session_binding'].length < 1 || value['session_binding'].length > 256 ||
          typeof value['expected_host_instance'] !== 'string' || value['expected_host_instance'].length > 128) {
        reply(res, 400, { error: 'invalid_requalification' });
        return;
      }
      const result = this.options.registry.requalifyAcpSession({
        integrationCredential: this.integrationCredential(req) ?? '', principalId: requalifyPath[1]!,
        requestId: value['request_id'], sessionBinding: value['session_binding'],
        expectedHostInstance: value['expected_host_instance'], currentHostInstance: this.info.instance_id,
      });
      if (!result.ok) { reply(res, 403, { error: result.reason }); return; }
      reply(res, 200, { principal_id: result.session.principalId, session_id: result.session.sessionId,
        project_id: result.session.projectId, registration_generation: result.session.registrationGeneration,
        expires_at_ms: result.session.expiresAtMs, renew_after_ms: 60_000,
        credential: result.session.credential });
      return;
    }
    reply(res, 404, { error: 'unsupported_integration_operation' });
  }

  private async handleScopedRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credential = this.acpCredential(req);
    if (!credential || !this.options.registry) { reply(res, 401, { error: 'acp_session_authentication_required' }); return; }
    const raw = await this.readBody(req, res);
    if (raw === null) return;
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { reply(res, 400, { error: 'invalid_rpc_request' }); return; }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) { reply(res, 400, { error: 'invalid_rpc_request' }); return; }
    const request = envelope as Record<string, unknown>;
    if (Object.keys(request).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
        request['jsonrpc'] !== '2.0' || (typeof request['id'] !== 'string' && typeof request['id'] !== 'number') ||
        typeof request['method'] !== 'string' || !request['params'] || typeof request['params'] !== 'object' ||
        Array.isArray(request['params'])) {
      reply(res, 400, { error: 'invalid_rpc_request' });
      return;
    }
    const params = request['params'] as Record<string, unknown>;
    const method = request['method'];
    const expectedFields = method === 'thread.create'
      ? ['project_id', 'session_id', 'command_id', 'expected_host_instance']
      : method === 'command.lookup'
        ? ['project_id', 'session_id', 'command_id', 'expected_host_instance']
        : null;
    if (!expectedFields || Object.keys(params).some((key) => !expectedFields.includes(key)) ||
        expectedFields.some((key) => !(key in params)) || typeof params['project_id'] !== 'string' ||
        typeof params['session_id'] !== 'string' || typeof params['command_id'] !== 'string' ||
        typeof params['expected_host_instance'] !== 'string') {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32602, message: 'unsupported or invalid scoped RPC', data: { reason: 'unsupported_capability' } } });
      return;
    }
    if (params['expected_host_instance'] !== this.info.instance_id) {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32008, message: 'stale_host_instance', data: { reason: 'stale_host_instance' } } });
      return;
    }
    if (method === 'thread.create' && request['id'] !== params['command_id']) {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32602, message: 'command ID must match request ID', data: { reason: 'command_fingerprint_conflict' } } });
      return;
    }
    const transport = this.options.registry.resolveTransportSession({ sessionId: params['session_id'],
      acpCredential: credential, expectedHostInstance: this.info.instance_id });
    if (!transport) {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32602, message: 'transport session scope denied', data: { reason: 'thread_scope_denied' } } });
      return;
    }
    if (params['project_id'] !== transport.projectId) {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32602, message: 'project scope denied', data: { reason: 'project_scope_denied' } } });
      return;
    }
    if (method === 'command.lookup') {
      if (!this.commandJournal) { reply(res, 503, { error: 'command_journal_unavailable' }); return; }
      const record = this.commandJournal.lookup({ commandId: params['command_id'],
        principalId: transport.principalId, projectId: transport.projectId });
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], result: record ? {
        command_id: record.commandId, fingerprint: record.fingerprint, state: record.state,
        thread_id: record.threadId, host_instance_id: record.hostInstanceId,
        registration_generation: record.registrationGeneration,
        result: record.resultJson === null ? null : JSON.parse(record.resultJson),
      } : { command_id: params['command_id'], state: 'unknown', reason: 'no_admission_record' } });
      return;
    }
    if (this.options.enableNativeThreadCreate !== true) {
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code: -32601,
        message: 'unsupported_capability', data: { reason: 'unsupported_capability' } } });
      return;
    }
    if (!this.options.gateway || !this.commandJournal) { reply(res, 503, { error: 'native_create_unavailable' }); return; }
    const result = await createScopedNativeThread({
      acpCredential: credential, transportSessionId: transport.transportSessionId,
      commandId: params['command_id'], projectId: params['project_id'],
      sessionBinding: transport.sessionBinding, expectedProjectGeneration: transport.projectGeneration,
      expectedHostInstance: params['expected_host_instance'],
    }, {
      resolveTransportSession: (session) => this.options.registry!.resolveTransportSession(session),
      resolveProject: (projectId) => this.options.registry!.resolveProject(projectId),
      currentHostInstance: this.info.instance_id, gateway: this.options.gateway, journal: this.commandJournal,
    });
    if (!result.ok) {
      const code = result.reason === 'stale_host_instance' ? -32008 : -32602;
      reply(res, 200, { jsonrpc: '2.0', id: request['id'], error: { code, message: result.reason,
        data: { reason: result.reason, ...(result.threadId ? { thread_id: result.threadId } : {}) } } });
      return;
    }
    reply(res, 200, result.response);
  }

  private readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const maxBytes = 16 * 1024;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let oversized = false;
      req.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) {
          oversized = true;
          chunks.length = 0;
        } else if (!oversized) chunks.push(buffer);
      });
      req.on('end', () => {
        if (oversized) {
          reply(res, 413, { error: 'registration_payload_too_large' });
          resolve(null);
        } else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => resolve(null));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.options.port, '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }
}
