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
