import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  BABEL_INTEGRATION_CONTRACT,
  BABEL_INTEGRATION_CONTRACT_VERSION,
  BABEL_INTEGRATION_SCHEMA_DESCRIPTOR,
  BABEL_INTEGRATION_SCHEMA_SHA256,
  IntegrationAcpSessionCredentialResponseSchema,
  IntegrationAcpSessionRenewalSchema,
  IntegrationAcpSessionStatusRequestSchema,
  IntegrationAcpSessionStatusResponseSchema,
  IntegrationProtocolInfoSchema,
  IntegrationRpcResponseSchema,
  IntegrationRpcRequestSchema,
  IntegrationTransportCreateRequestSchema,
  NATIVE_THREAD_ID_PATTERN,
  negotiateIntegrationContract,
} from '../protocol/remoteContract.js';

test('integration contract hash is stable over the exported versioned schema descriptor', () => {
  assert.equal(BABEL_INTEGRATION_SCHEMA_SHA256, 'a0a5f8d89701055bd4b2b4934a22490d4c1051f62c5e93632cb2e30b15003e36',
    'schema changes require an explicit reviewed profile/hash fixture update');
  assert.equal(BABEL_INTEGRATION_SCHEMA_SHA256,
    createHash('sha256').update(JSON.stringify(BABEL_INTEGRATION_SCHEMA_DESCRIPTOR)).digest('hex'));
  assert.equal(BABEL_INTEGRATION_CONTRACT, 'babel.integration');
  assert.equal(BABEL_INTEGRATION_CONTRACT_VERSION, '2.0.0');
});

test('strict protocol.info profile describes only bounded, implemented native capabilities', () => {
  const info = {
    contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION,
    schema_sha256: BABEL_INTEGRATION_SCHEMA_SHA256, gateway_id: 'gateway-fixture',
    instance_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb', build_revision: null,
    capabilities: ['transport.create', 'command.lookup'],
    limits: { max_rpc_bytes: 16_384, max_history_page: 0, max_ws_frame_bytes: 0, ws_ticket_ttl_ms: 0 },
    authority: { execution_owner: 'protocol_host', native_only: true, lease_required_for_turns: true },
  };
  assert.equal(IntegrationProtocolInfoSchema.safeParse(info).success, true);
  assert.equal(IntegrationProtocolInfoSchema.safeParse({ ...info, unsupported: true }).success, false);
  assert.equal(IntegrationProtocolInfoSchema.safeParse({ ...info, capabilities: [...info.capabilities, 'turn.submit'] }).success, false);
});

test('negotiation accepts only exact contract, version, and schema hash profiles', () => {
  assert.deepEqual(negotiateIntegrationContract({}), { ok: false, reason: 'incomplete_contract_profile' });
  assert.deepEqual(negotiateIntegrationContract({}, 'discovery'), { ok: true });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT }),
    { ok: false, reason: 'incomplete_contract_profile' });
  assert.deepEqual(negotiateIntegrationContract({ contract: 'other', version: '1.0.0', schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: false, reason: 'unsupported_contract' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: '9.0.0', schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: false, reason: 'unsupported_version' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION, schemaHash: '0'.repeat(64) }),
    { ok: false, reason: 'schema_mismatch' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION, schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: true });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: '1.0.0', schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: false, reason: 'unsupported_version' }, 'the superseded draft profile is never a fallback');
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION,
    schemaHash: 'b2f1f0f7668dc4557367f6ad85b7a54686491108312dc1f6ab8c0c1bd18e1d49' }),
  { ok: false, reason: 'schema_mismatch' }, 'the prior 2.0.0 draft hash is rejected without fallback');
  assert.deepEqual((BABEL_INTEGRATION_SCHEMA_DESCRIPTOR as { negotiation: { exactMatchOnly: boolean } })
    .negotiation.exactMatchOnly, true);
});

test('renewal requires positive safe-integer generation and sequence fences', () => {
  const renewal = { request_id: 'renewal:c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb:1', request_sequence: 1,
    session_binding: 'launch-1', expected_host_instance: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb',
    expected_registration_generation: 1 };
  assert.equal(IntegrationAcpSessionRenewalSchema.safeParse(renewal).success, true);
  assert.equal(IntegrationAcpSessionRenewalSchema.safeParse({ ...renewal, request_id: 'renew-1' }).success, false,
    'renewal IDs must use the canonical namespace');
  for (const field of ['request_sequence', 'expected_registration_generation'] as const) {
    assert.equal(IntegrationAcpSessionRenewalSchema.safeParse({ ...renewal, [field]: Number.MAX_SAFE_INTEGER }).success, true);
    for (const invalid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      assert.equal(IntegrationAcpSessionRenewalSchema.safeParse({ ...renewal, [field]: invalid }).success, false,
        `rejects ${field}=${String(invalid)}`);
    }
  }
  for (const field of ['request_sequence', 'expected_registration_generation'] as const) {
    const missing = { ...renewal } as Record<string, unknown>;
    delete missing[field];
    assert.equal(IntegrationAcpSessionRenewalSchema.safeParse(missing).success, false);
  }
  const descriptorRenewal = (BABEL_INTEGRATION_SCHEMA_DESCRIPTOR as {
    schemas: { acpSessionRenewal: { required: string[]; properties: Record<string, unknown> } };
  }).schemas.acpSessionRenewal;
  assert.deepEqual(descriptorRenewal.required,
    ['request_id', 'request_sequence', 'session_binding', 'expected_host_instance', 'expected_registration_generation']);
  for (const field of ['request_sequence', 'expected_registration_generation']) {
    assert.deepEqual(descriptorRenewal.properties[field],
      { maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' });
  }
});

test('status reconciliation exposes only disposition and authoritative metadata', () => {
  const statusRequest = { request_id: 'renew-1', request_sequence: 2, project_id: 'p1',
    session_binding: 'launch-1', expected_host_instance: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb' };
  assert.equal(IntegrationAcpSessionStatusRequestSchema.safeParse(statusRequest).success, true);
  assert.equal(IntegrationAcpSessionStatusRequestSchema.safeParse({ ...statusRequest, extra: true }).success, false);
  assert.equal(IntegrationAcpSessionStatusRequestSchema.safeParse({ ...statusRequest, request_sequence: 0 }).success, false);
  const response = { principal_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb', project_id: 'p1',
    session_binding: 'launch-1', request_id: 'renewal:c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb:2',
    request_sequence: 2, renewal_sequence: 2, host_instance_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb',
    registration_generation: 3, expires_at_ms: 1000, disposition: 'issued' };
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse(response).success, true);
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response, disposition: 'rotated' }).success, false);
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response, disposition: 'retired' }).success, true);
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response, credential: 'secret' }).success, false,
    'status can never carry a credential');
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response, renewal_sequence: -1 }).success, false);
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response,
    disposition: 'revoked', expires_at_ms: 0 }).success, true,
  'status accepts the legacy disabled-row expiry sentinel');
  assert.equal(IntegrationAcpSessionStatusResponseSchema.safeParse({ ...response, expires_at_ms: -1 }).success, false);

  const credentialResponse = { principal_id: response.principal_id, session_id: response.principal_id,
    project_id: response.project_id, registration_generation: 1, expires_at_ms: 1,
    renew_after_ms: 60_000, credential: 'x'.repeat(43) };
  assert.equal(IntegrationAcpSessionCredentialResponseSchema.safeParse(credentialResponse).success, true);
  assert.equal(IntegrationAcpSessionCredentialResponseSchema.safeParse({ ...credentialResponse, expires_at_ms: 0 }).success, false,
    'live credential responses remain strictly positive');
  const descriptorStatus = (BABEL_INTEGRATION_SCHEMA_DESCRIPTOR as {
    schemas: {
      acpSessionStatusRequest: { required: string[] };
      acpSessionStatusResponse: { required: string[]; properties: Record<string, unknown> };
    };
  }).schemas;
  assert.deepEqual(descriptorStatus.acpSessionStatusRequest.required,
    ['request_id', 'request_sequence', 'project_id', 'session_binding', 'expected_host_instance']);
  assert.deepEqual(descriptorStatus.acpSessionStatusResponse.required,
    ['principal_id', 'project_id', 'session_binding', 'request_id', 'request_sequence',
      'renewal_sequence', 'host_instance_id', 'registration_generation', 'expires_at_ms', 'disposition']);
  assert.equal(Object.hasOwn(descriptorStatus.acpSessionStatusResponse.properties, 'credential'), false);
});

test('strict ingress schemas reject unsupported methods and authority-bearing fields', () => {
  const base = { jsonrpc: '2.0', id: 'cmd-1', method: 'thread.create', params: {
    project_id: 'p1', session_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb', command_id: 'cmd-1',
    expected_host_instance: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb',
  } };
  assert.equal(IntegrationRpcRequestSchema.safeParse(base).success, true);
  assert.equal(IntegrationRpcRequestSchema.safeParse({ ...base, method: 'turn.submit' }).success, false);
  assert.equal(IntegrationRpcRequestSchema.safeParse({ ...base, params: { ...base.params, project_root: '/private/path' } }).success, false);
  assert.equal(IntegrationTransportCreateRequestSchema.safeParse({ project_id: 'p1', expected_host_instance: base.params.expected_host_instance, extra: true }).success, false);
});

test('versioned RPC response schema covers scoped results and bounded errors', () => {
  const nativeThreadId = 'chat-0123456789ab';
  assert.equal(NATIVE_THREAD_ID_PATTERN.source, '^chat-[0-9a-f]{12}$',
    'validator is bound to the canonical allocator format');
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    command_id: 'cmd-1', state: 'unknown', reason: 'no_admission_record',
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    command_id: 'cmd-1', fingerprint: 'a'.repeat(64), state: 'settled', thread_id: nativeThreadId,
    host_instance_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb', registration_generation: 1, result: null,
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    thread_id: nativeThreadId,
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', error: {
    code: -32601, message: 'unsupported_capability', data: { reason: 'unsupported_capability' },
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', error: {
    code: -32602, message: 'reconcile_required',
    data: { reason: 'reconcile_required', thread_id: nativeThreadId },
  } }).success, true);
  for (const invalid of ['c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb', 'chat-0123456789AB',
    'chat-0123456789a', 'chat-0123456789abc', 'chat_0123456789ab', 'chat-0123456789a_']) {
    assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1',
      result: { thread_id: invalid } }).success, false, `rejects ${invalid}`);
    assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', error: {
      code: -32602, message: 'reconcile_required',
      data: { reason: 'reconcile_required', thread_id: invalid },
    } }).success, false, `rejects error thread ID ${invalid}`);
  }
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    thread_id: nativeThreadId, project_root: '/private/path',
  } }).success, false);
});
