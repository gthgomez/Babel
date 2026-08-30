import { createHash } from 'node:crypto'

/** Version of the redacted per-inference context manifest. */
export const CONTEXT_MANIFEST_VERSION = 1 as const

export type ContextDeliveryMode = 'native' | 'text' | 'unknown'

/** Content-free evidence describing the context boundary of one inference. */
export interface ContextManifestV1 {
  schema_version: typeof CONTEXT_MANIFEST_VERSION
  inference_id: string
  conversation_state_hash: string | null
  system_policy_prompt_hash: string | null
  user_task_prompt_hash: string | null
  tool_schema_hash: string | null
  expected_prior_event_ids: string[]
  delivered_prior_event_ids: string[]
  missing_event_ids: string[]
  delivery_mode: ContextDeliveryMode
  compaction_occurred: boolean
  compaction_input_state_hash: string | null
  preserved_event_ids: string[]
  preservation_hash: string | null
  prompt_input_token_count: number | null
  context_truncated: boolean | null
  preservation_status: boolean | null
  manifest_hash: string
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/** Hash a redacted value without persisting its contents. */
export function hashContextValue(value: unknown): string {
  return hashValue(value)
}

/**
 * Build a Context Manifest V1 from the facts available at the provider
 * boundary. Prompt contents are represented only by hashes.
 */
export function buildContextManifest(input: {
  inferenceId: string
  conversationState?: unknown
  systemPolicyPrompt?: unknown
  userTaskPrompt?: unknown
  toolSchema?: unknown
  expectedPriorEventIds?: readonly string[]
  deliveredPriorEventIds?: readonly string[]
  deliveryMode?: ContextDeliveryMode
  compactionOccurred?: boolean
  compactionInputState?: unknown
  preservedEventIds?: readonly string[]
  promptInputTokenCount?: number | null
  contextTruncated?: boolean | null
}): ContextManifestV1 {
  const expected = sortedUnique(input.expectedPriorEventIds ?? [])
  const deliveredProvided = input.deliveredPriorEventIds !== undefined
  const delivered = sortedUnique(input.deliveredPriorEventIds ?? [])
  const missing = deliveredProvided ? expected.filter((id) => !delivered.includes(id)) : []
  const preserved = sortedUnique(input.preservedEventIds ?? [])
  const compactionOccurred = input.compactionOccurred === true
  const preservationStatus =
    input.contextTruncated === true || missing.length > 0
      ? false
      : input.deliveryMode === 'unknown' || !deliveredProvided
        ? null
        : compactionOccurred
          ? expected.every((id) => preserved.includes(id))
          : true
  const unsigned = {
    schema_version: CONTEXT_MANIFEST_VERSION,
    inference_id: input.inferenceId,
    conversation_state_hash:
      input.conversationState === undefined ? null : hashValue(input.conversationState),
    system_policy_prompt_hash:
      input.systemPolicyPrompt === undefined ? null : hashValue(input.systemPolicyPrompt),
    user_task_prompt_hash:
      input.userTaskPrompt === undefined ? null : hashValue(input.userTaskPrompt),
    tool_schema_hash: input.toolSchema === undefined ? null : hashValue(input.toolSchema),
    expected_prior_event_ids: expected,
    delivered_prior_event_ids: delivered,
    missing_event_ids: missing,
    delivery_mode: input.deliveryMode ?? 'unknown',
    compaction_occurred: compactionOccurred,
    compaction_input_state_hash:
      input.compactionInputState === undefined ? null : hashValue(input.compactionInputState),
    preserved_event_ids: preserved,
    preservation_hash: compactionOccurred ? hashValue(preserved) : null,
    prompt_input_token_count:
      input.promptInputTokenCount === undefined ? null : input.promptInputTokenCount,
    context_truncated: input.contextTruncated ?? null,
    preservation_status: preservationStatus,
  }
  return { ...unsigned, manifest_hash: hashValue(unsigned) }
}

/** Validate the invariant-bearing fields of a Context Manifest V1. */
export function validateContextManifest(manifest: ContextManifestV1): void {
  if (manifest.schema_version !== CONTEXT_MANIFEST_VERSION) {
    throw new Error(`Unsupported context manifest schema: ${String(manifest.schema_version)}`)
  }
  if (!manifest.inference_id) throw new Error('Context manifest inference_id is required')
  if (manifest.missing_event_ids.some((id) => !manifest.expected_prior_event_ids.includes(id))) {
    throw new Error('Context manifest missing_event_ids must be expected event ids')
  }
  const expectedStatus =
    manifest.context_truncated === true || manifest.missing_event_ids.length > 0
      ? false
      : manifest.delivery_mode === 'unknown'
        ? null
        : manifest.compaction_occurred
          ? manifest.expected_prior_event_ids.every((id) => manifest.preserved_event_ids.includes(id))
          : true
  if (manifest.preservation_status !== expectedStatus) {
    throw new Error('Context manifest preservation_status is inconsistent with its evidence')
  }
  const { manifest_hash: actualHash, ...unsigned } = manifest
  if (!/^[a-f0-9]{64}$/.test(actualHash) || hashValue(unsigned) !== actualHash) {
    throw new Error('Context manifest manifest_hash is invalid')
  }
}
