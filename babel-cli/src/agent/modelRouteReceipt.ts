import { createHash } from 'node:crypto';
import { PROVIDER_IDS, type ProviderId } from '../runners/providerRegistry.js';

export const MODEL_ROUTE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ModelRouteStage =
  | 'chat'
  | 'critic'
  | 'synthesis'
  | 'compaction'
  | 'verifier'
  | 'unknown';

/**
 * Content-free proof of the route selected for one provider inference.
 * References are identifiers or hashes; prompts and provider payloads never
 * belong in this receipt.
 */
export interface ModelRouteReceiptV1 {
  schema_version: typeof MODEL_ROUTE_RECEIPT_SCHEMA_VERSION;
  kind: 'babel_model_route_receipt';
  project_ref: string;
  task_ref: string;
  run_ref: string;
  contract_ref: string;
  inference_id: string;
  execution_stage: ModelRouteStage;
  requested_model_selector: string;
  normalized_babel_model: string;
  provider: ProviderId;
  exact_model_id_sent: string;
  observed_model_id: string | null;
  upstream_provider: string | null;
  /** Capability-aware provenance extensions; absent in historical v1 receipts. */
  gateway?: string;
  actual_endpoint_id?: string | null;
  endpoint_quantization?: string | null;
  endpoint_context_limit?: number | null;
  endpoint_output_limit?: number | null;
  routing_reason?: string | null;
  fallback_status?: 'none' | 'occurred' | 'unknown';
  router_attempt_count?: number | null;
  router_metadata_hash?: string | null;
  execution_envelope_hash?: string | null;
  retry_count: number;
  substitution_or_fallback: boolean;
  timestamp: string;
  receipt_hash: string;
}

export function hashRouteReference(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unsignedReceipt(input: Omit<ModelRouteReceiptV1, 'receipt_hash'>): Omit<ModelRouteReceiptV1, 'receipt_hash'> {
  return input;
}

export function buildModelRouteReceipt(input: {
  projectRef: string;
  taskRef: string;
  runRef: string;
  contractRef: string;
  inferenceId: string;
  executionStage?: ModelRouteStage;
  requestedModelSelector: string;
  normalizedBabelModel: string;
  provider: ProviderId;
  exactModelIdSent: string;
  observedModelId?: string | null;
  upstreamProvider?: string | null;
  gateway?: string;
  actualEndpointId?: string | null;
  endpointQuantization?: string | null;
  endpointContextLimit?: number | null;
  endpointOutputLimit?: number | null;
  routingReason?: string | null;
  fallbackStatus?: 'none' | 'occurred' | 'unknown';
  routerAttemptCount?: number | null;
  routerMetadataHash?: string | null;
  executionEnvelopeHash?: string | null;
  retryCount?: number;
  substitutionOrFallback?: boolean;
  timestamp?: string;
}): ModelRouteReceiptV1 {
  const unsigned = unsignedReceipt({
    schema_version: MODEL_ROUTE_RECEIPT_SCHEMA_VERSION,
    kind: 'babel_model_route_receipt',
    project_ref: input.projectRef,
    task_ref: input.taskRef,
    run_ref: input.runRef,
    contract_ref: input.contractRef,
    inference_id: input.inferenceId,
    execution_stage: input.executionStage ?? 'unknown',
    requested_model_selector: input.requestedModelSelector,
    normalized_babel_model: input.normalizedBabelModel,
    provider: input.provider,
    exact_model_id_sent: input.exactModelIdSent,
    observed_model_id: input.observedModelId ?? null,
    upstream_provider: input.upstreamProvider ?? null,
    ...(input.gateway === undefined ? {} : { gateway: input.gateway }),
    ...(input.actualEndpointId === undefined ? {} : { actual_endpoint_id: input.actualEndpointId }),
    ...(input.endpointQuantization === undefined ? {} : { endpoint_quantization: input.endpointQuantization }),
    ...(input.endpointContextLimit === undefined ? {} : { endpoint_context_limit: input.endpointContextLimit }),
    ...(input.endpointOutputLimit === undefined ? {} : { endpoint_output_limit: input.endpointOutputLimit }),
    ...(input.routingReason === undefined ? {} : { routing_reason: input.routingReason }),
    ...(input.fallbackStatus === undefined ? {} : { fallback_status: input.fallbackStatus }),
    ...(input.routerAttemptCount === undefined ? {} : { router_attempt_count: input.routerAttemptCount }),
    ...(input.routerMetadataHash === undefined ? {} : { router_metadata_hash: input.routerMetadataHash }),
    ...(input.executionEnvelopeHash === undefined ? {} : { execution_envelope_hash: input.executionEnvelopeHash }),
    retry_count: input.retryCount ?? 0,
    substitution_or_fallback: input.substitutionOrFallback ?? false,
    timestamp: input.timestamp ?? new Date().toISOString(),
  });
  return {
    ...unsigned,
    receipt_hash: hashRouteReference(JSON.stringify(unsigned)),
  };
}

export function validateModelRouteReceipt(value: unknown): asserts value is ModelRouteReceiptV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('route receipt must be an object');
  }
  const receipt = value as Partial<ModelRouteReceiptV1>;
  const requiredStrings: Array<keyof ModelRouteReceiptV1> = [
    'project_ref',
    'task_ref',
    'run_ref',
    'contract_ref',
    'inference_id',
    'requested_model_selector',
    'normalized_babel_model',
    'exact_model_id_sent',
    'timestamp',
    'receipt_hash',
  ];
  if (
    receipt.schema_version !== MODEL_ROUTE_RECEIPT_SCHEMA_VERSION ||
    receipt.kind !== 'babel_model_route_receipt' ||
    requiredStrings.some((field) => typeof receipt[field] !== 'string' || receipt[field]!.length === 0) ||
    !['chat', 'critic', 'synthesis', 'compaction', 'verifier', 'unknown'].includes(receipt.execution_stage as string) ||
    !(PROVIDER_IDS as readonly string[]).includes(receipt.provider as string) ||
    (receipt.observed_model_id !== null && typeof receipt.observed_model_id !== 'string') ||
    (receipt.upstream_provider !== null && typeof receipt.upstream_provider !== 'string') ||
    (receipt.gateway !== undefined && typeof receipt.gateway !== 'string') ||
    (receipt.actual_endpoint_id !== undefined && receipt.actual_endpoint_id !== null && typeof receipt.actual_endpoint_id !== 'string') ||
    (receipt.endpoint_quantization !== undefined && receipt.endpoint_quantization !== null && typeof receipt.endpoint_quantization !== 'string') ||
    (receipt.endpoint_context_limit !== undefined && receipt.endpoint_context_limit !== null && (!Number.isInteger(receipt.endpoint_context_limit) || receipt.endpoint_context_limit < 0)) ||
    (receipt.endpoint_output_limit !== undefined && receipt.endpoint_output_limit !== null && (!Number.isInteger(receipt.endpoint_output_limit) || receipt.endpoint_output_limit < 0)) ||
    (receipt.routing_reason !== undefined && receipt.routing_reason !== null && typeof receipt.routing_reason !== 'string') ||
    (receipt.fallback_status !== undefined && !['none', 'occurred', 'unknown'].includes(receipt.fallback_status)) ||
    (receipt.router_attempt_count !== undefined && receipt.router_attempt_count !== null && (!Number.isInteger(receipt.router_attempt_count) || receipt.router_attempt_count < 0)) ||
    (receipt.router_metadata_hash !== undefined && receipt.router_metadata_hash !== null && typeof receipt.router_metadata_hash !== 'string') ||
    (receipt.execution_envelope_hash !== undefined && receipt.execution_envelope_hash !== null && typeof receipt.execution_envelope_hash !== 'string') ||
    !Number.isInteger(receipt.retry_count) || receipt.retry_count! < 0 ||
    typeof receipt.substitution_or_fallback !== 'boolean'
  ) {
    throw new Error('route receipt has invalid fields');
  }
  const { receipt_hash: actualHash, ...unsigned } = receipt as ModelRouteReceiptV1;
  if (hashRouteReference(JSON.stringify(unsigned)) !== actualHash) {
    throw new Error('route receipt hash does not match its content');
  }
}
