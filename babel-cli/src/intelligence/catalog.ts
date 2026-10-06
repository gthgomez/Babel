import { deepFreeze, hashCanonical } from './hash.js'
import type { ModelRef } from './model-ref.js'
import { modelRefKey } from './model-ref.js'
import { createLabModelSpec, createProviderModelProfile } from './profiles.js'
import type { CatalogSnapshot, CatalogSnapshotInput, ProviderModelProfile } from './types.js'

const CATALOG_SCHEMA_VERSION = 1

/** Build an immutable catalog projection with one fact owner per model ref. */
export function createCatalogSnapshot(input: CatalogSnapshotInput): CatalogSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Catalog snapshot input must be an object.')
  }
  if (typeof input.observedAt !== 'string' || input.observedAt.length === 0) {
    throw new Error('Catalog snapshot input requires an observedAt timestamp.')
  }

  const labModels = (input.labModels ?? []).map((model) => createLabModelSpec(model))
  const providerModels = (input.providerModels ?? []).map((profile) =>
    createProviderModelProfile(profile),
  )

  // One ref has one fact owner; a second profile for the same provider+model is
  // ambiguous and cannot be silently merged.
  const owners = new Map<string, ProviderModelProfile>()
  for (const profile of providerModels) {
    const key = modelRefKey({ provider: profile.provider, modelId: profile.providerModelId })
    const existing = owners.get(key)
    if (existing) {
      throw new Error(
        `Catalog snapshot has duplicate provider+model identity ` +
          `"${profile.provider}/${profile.providerModelId}" for ` +
          `"${profile.canonicalModelId}" and "${existing.canonicalModelId}".`,
      )
    }
    owners.set(key, profile)
  }

  const revision =
    typeof input.revision === 'string' && input.revision.length > 0
      ? input.revision
      : hashCanonical({ labModels, providerModels })

  const snapshot: CatalogSnapshot = {
    schemaVersion: input.schemaVersion ?? CATALOG_SCHEMA_VERSION,
    revision,
    observedAt: input.observedAt,
    sourceResults: (input.sourceResults ?? []).map((result) => ({
      ...result,
      ...(Array.isArray(result.warnings) ? { warnings: [...result.warnings] } : {}),
    })),
    labModels,
    providerModels,
  }

  return deepFreeze(snapshot)
}

/**
 * Resolve the single provider profile for an exact-case model ref.
 *
 * Lookup is provider-qualified and case-sensitive; provider-provided model IDs
 * keep their exact spelling.
 */
export function findModelProfile(
  snapshot: CatalogSnapshot,
  ref: ModelRef,
): ProviderModelProfile | undefined {
  return snapshot.providerModels.find(
    (profile) => profile.provider === ref.provider && profile.providerModelId === ref.modelId,
  )
}
