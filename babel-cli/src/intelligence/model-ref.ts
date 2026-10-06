import type { ProviderId } from '../runners/providerRegistry.js'

/**
 * Discovery identity for one provider-served model.
 *
 * `modelId` is the provider-defined served identifier and preserves its exact
 * case and embedded separators. It is not sufficient authorization or
 * reproducibility; a resolved execution still carries protocol/endpoint and
 * snapshot identities.
 */
export type ModelRef = Readonly<{ provider: ProviderId; modelId: string }>

/**
 * Serialize a {@link ModelRef} into an unambiguous tuple key.
 *
 * The structured array encoding cannot collide when a model ID contains a
 * slash or colon, and it never case-folds `modelId`, so provider-defined case
 * remains significant.
 */
export function modelRefKey(ref: ModelRef): string {
  return JSON.stringify([ref.provider, ref.modelId])
}
