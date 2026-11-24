import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BABEL_INTEGRATION_CONTRACT = 'babel.integration' as const;
export const BABEL_INTEGRATION_CONTRACT_VERSION = '1.0.0' as const;

export const IntegrationCapabilitySchema = z.enum([
  'transport.create',
  'command.lookup',
  'thread.create',
]);

export const IntegrationProtocolInfoSchema = z.object({
  contract: z.literal(BABEL_INTEGRATION_CONTRACT),
  version: z.literal(BABEL_INTEGRATION_CONTRACT_VERSION),
  schema_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  gateway_id: z.string().min(1).max(128),
  instance_id: z.string().uuid(),
  build_revision: z.string().max(128).nullable(),
  capabilities: z.array(IntegrationCapabilitySchema).max(16),
  limits: z.object({
    max_rpc_bytes: z.number().int().min(1).max(1_048_576),
    max_history_page: z.number().int().min(0).max(10_000),
    max_ws_frame_bytes: z.number().int().min(0).max(1_048_576),
    ws_ticket_ttl_ms: z.number().int().min(0).max(300_000),
  }).strict(),
  authority: z.object({
    execution_owner: z.literal('protocol_host'),
    native_only: z.literal(true),
    lease_required_for_turns: z.literal(true),
  }).strict(),
}).strict();

export const IntegrationTransportCreateRequestSchema = z.object({
  project_id: z.string().min(1).max(64),
  expected_host_instance: z.string().uuid(),
}).strict();

export const IntegrationAcpSessionRegistrationSchema = z.object({
  request_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(64),
  session_binding: z.string().min(1).max(256),
  expected_host_instance: z.string().uuid(),
  discovery_ref: z.string().min(1).max(256).optional(),
}).strict();

export const IntegrationAcpSessionRenewalSchema = z.object({
  request_id: z.string().min(1).max(128),
  session_binding: z.string().min(1).max(256),
  expected_host_instance: z.string().uuid(),
}).strict();

export const IntegrationAcpSessionCredentialResponseSchema = z.object({
  principal_id: z.string().uuid(),
  session_id: z.string().uuid(),
  project_id: z.string().min(1).max(64),
  registration_generation: z.number().int().min(1),
  expires_at_ms: z.number().int().positive(),
  renew_after_ms: z.literal(60_000),
  credential: z.string().min(43).max(128),
}).strict();

export const IntegrationTransportSessionResponseSchema = z.object({
  session_id: z.string().uuid(),
  project_id: z.string().min(1).max(64),
  host_instance_id: z.string().uuid(),
  registration_generation: z.number().int().min(1),
  expires_at_ms: z.number().int().positive(),
}).strict();

const ScopedRpcParamsSchema = z.object({
  project_id: z.string().min(1).max(64),
  session_id: z.string().uuid(),
  command_id: z.string().min(1).max(128),
  expected_host_instance: z.string().uuid(),
}).strict();

export const IntegrationRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0'), id: z.string().min(1).max(128), method: z.literal('thread.create'),
    params: ScopedRpcParamsSchema,
  }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'), id: z.string().min(1).max(128), method: z.literal('command.lookup'),
    params: ScopedRpcParamsSchema,
  }).strict(),
]);

export const IntegrationCommandLookupResultSchema = z.union([
  z.object({ command_id: z.string().min(1).max(128), state: z.literal('unknown'), reason: z.literal('no_admission_record') }).strict(),
  z.object({ command_id: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['admitted', 'settled', 'unknown']), thread_id: z.string().uuid().nullable(),
    host_instance_id: z.string().uuid(), registration_generation: z.number().int().min(1), result: z.unknown().nullable() }).strict(),
]);

export const IntegrationRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.string().min(1).max(128),
    result: z.union([IntegrationCommandLookupResultSchema, z.object({ thread_id: z.string().uuid() }).strict()]) }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id: z.string().min(1).max(128),
    error: z.object({ code: z.number().int(), message: z.string().min(1).max(256),
      data: z.object({ reason: z.string().min(1).max(128), thread_id: z.string().uuid().optional() }).strict().optional() }).strict() }).strict(),
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/** Strict JSON Schemas are generated from the same Zod schemas used at ingress. */
export const BABEL_INTEGRATION_SCHEMA_DESCRIPTOR = canonicalize({
  contract: BABEL_INTEGRATION_CONTRACT,
  version: BABEL_INTEGRATION_CONTRACT_VERSION,
  schemas: {
    protocolInfo: z.toJSONSchema(IntegrationProtocolInfoSchema, { io: 'input' }),
    transportCreateRequest: z.toJSONSchema(IntegrationTransportCreateRequestSchema, { io: 'input' }),
    acpSessionRegistration: z.toJSONSchema(IntegrationAcpSessionRegistrationSchema, { io: 'input' }),
    acpSessionRenewal: z.toJSONSchema(IntegrationAcpSessionRenewalSchema, { io: 'input' }),
    rpcRequest: z.toJSONSchema(IntegrationRpcRequestSchema, { io: 'input' }),
    rpcResponse: z.toJSONSchema(IntegrationRpcResponseSchema, { io: 'output' }),
    acpSessionCredentialResponse: z.toJSONSchema(IntegrationAcpSessionCredentialResponseSchema, { io: 'output' }),
    transportSessionResponse: z.toJSONSchema(IntegrationTransportSessionResponseSchema, { io: 'output' }),
    commandLookupResult: z.toJSONSchema(IntegrationCommandLookupResultSchema, { io: 'output' }),
  },
  negotiation: {
    discovery: { method: 'GET', path: '/protocol.info' },
    missingProfileAllowedForDiscovery: true,
    missingProfileAllowedForOperations: false,
    requiredHeadersForOperations: {
      'x-babel-contract': BABEL_INTEGRATION_CONTRACT,
      'x-babel-contract-version': BABEL_INTEGRATION_CONTRACT_VERSION,
      'x-babel-schema-sha256': 'sha256-of-canonical-schema-descriptor',
    },
    exactMatchOnly: true,
  },
  unavailable: ['thread.resume', 'turn.submit', 'turn.cancel', 'history.lookup', 'approval.decide', 'approval.lookup', 'workspace.changes', 'verification.lookup', 'websocket', 'tickets'],
  authority: { execution_owner: 'protocol_host', native_only: true, lease_required_for_turns: true },
});

export const BABEL_INTEGRATION_SCHEMA_SHA256 = createHash('sha256')
  .update(JSON.stringify(BABEL_INTEGRATION_SCHEMA_DESCRIPTOR))
  .digest('hex');

export interface IntegrationNegotiationHeaders {
  contract?: string;
  version?: string;
  schemaHash?: string;
}

export type IntegrationNegotiationPurpose = 'operation' | 'discovery';

export type IntegrationNegotiationResult =
  | { ok: true }
  | { ok: false; reason: 'incomplete_contract_profile' | 'unsupported_contract' | 'unsupported_version' | 'schema_mismatch' };

/** Exact profile matching is intentional; no implicit downgrade or major-version guess. */
export function negotiateIntegrationContract(
  headers: IntegrationNegotiationHeaders,
  purpose: IntegrationNegotiationPurpose = 'operation',
): IntegrationNegotiationResult {
  const present = [headers.contract, headers.version, headers.schemaHash].filter((value) => value !== undefined).length;
  if (present === 0) return purpose === 'discovery' ? { ok: true } : { ok: false, reason: 'incomplete_contract_profile' };
  if (present !== 3) return { ok: false, reason: 'incomplete_contract_profile' };
  if (headers.contract !== BABEL_INTEGRATION_CONTRACT) return { ok: false, reason: 'unsupported_contract' };
  if (headers.version !== BABEL_INTEGRATION_CONTRACT_VERSION) return { ok: false, reason: 'unsupported_version' };
  if (headers.schemaHash !== BABEL_INTEGRATION_SCHEMA_SHA256) return { ok: false, reason: 'schema_mismatch' };
  return { ok: true };
}
