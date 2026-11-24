import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  BABEL_INTEGRATION_CONTRACT,
  BABEL_INTEGRATION_CONTRACT_VERSION,
  BABEL_INTEGRATION_SCHEMA_DESCRIPTOR,
  BABEL_INTEGRATION_SCHEMA_SHA256,
  IntegrationProtocolInfoSchema,
  IntegrationRpcResponseSchema,
  IntegrationRpcRequestSchema,
  IntegrationTransportCreateRequestSchema,
  negotiateIntegrationContract,
} from '../protocol/remoteContract.js';

test('integration contract hash is stable over the exported versioned schema descriptor', () => {
  assert.equal(BABEL_INTEGRATION_SCHEMA_SHA256, '316b1320837ab2b1546b0487118853e50a1d8e164aa146390bee20416fbc1299',
    'schema changes require an explicit reviewed profile/hash fixture update');
  assert.equal(BABEL_INTEGRATION_SCHEMA_SHA256,
    createHash('sha256').update(JSON.stringify(BABEL_INTEGRATION_SCHEMA_DESCRIPTOR)).digest('hex'));
  assert.equal(BABEL_INTEGRATION_CONTRACT, 'babel.integration');
  assert.equal(BABEL_INTEGRATION_CONTRACT_VERSION, '1.0.0');
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
  assert.deepEqual(negotiateIntegrationContract({}), { ok: true });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT }),
    { ok: false, reason: 'incomplete_contract_profile' });
  assert.deepEqual(negotiateIntegrationContract({ contract: 'other', version: '1.0.0', schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: false, reason: 'unsupported_contract' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: '2.0.0', schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: false, reason: 'unsupported_version' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION, schemaHash: '0'.repeat(64) }),
    { ok: false, reason: 'schema_mismatch' });
  assert.deepEqual(negotiateIntegrationContract({ contract: BABEL_INTEGRATION_CONTRACT, version: BABEL_INTEGRATION_CONTRACT_VERSION, schemaHash: BABEL_INTEGRATION_SCHEMA_SHA256 }),
    { ok: true });
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
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    command_id: 'cmd-1', state: 'unknown', reason: 'no_admission_record',
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    thread_id: 'c1b6af6e-cb97-4317-aa4c-9831f9f2c3cb',
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', error: {
    code: -32601, message: 'unsupported_capability', data: { reason: 'unsupported_capability' },
  } }).success, true);
  assert.equal(IntegrationRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 'cmd-1', result: {
    thread_id: 'not-a-uuid', project_root: '/private/path',
  } }).success, false);
});
