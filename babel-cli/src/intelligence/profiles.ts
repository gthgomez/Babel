import { deepFreeze, hashCanonical } from './hash.js'
import type {
  HarnessTuningProfile,
  LabModelSpec,
  ProviderModelProfile,
  ModelQualificationRecord,
} from './types.js'

const COMPATIBILITY_FINGERPRINT_VERSION = 1
const PRICING_REVISION_VERSION = 1

/**
 * Additive, versioned identity fields kept alongside the legacy `profileHash`.
 *
 * `compatibilityFingerprint` binds only the semantic facts a qualification
 * actually tested (protocol/router/adapter, model revision, capabilities and
 * material limits). `pricingRevision` tracks price facts separately so a
 * price-only refresh does not masquerade as a semantic capability failure.
 * The legacy full `profileHash` still includes pricing for conservative
 * matching of pre-existing qualification records.
 */
export interface ProfileCompatibilityIdentity {
  compatibilityFingerprintVersion: number
  compatibilityFingerprint: string
  pricingRevisionVersion: number
  pricingRevision: string
}

/** A lab model spec carrying its versioned compatibility identity. */
export type VersionedLabModelSpec = LabModelSpec & ProfileCompatibilityIdentity

/** A provider model profile carrying its versioned compatibility identity. */
export type VersionedProviderModelProfile = ProviderModelProfile &
  ProfileCompatibilityIdentity

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'observedAt' && key !== 'retrievedAt')
      .map(([key, child]) => [key, materialize(child)]),
  )
}

function buildCompatibilityIdentity(input: {
  semanticValue: Record<string, unknown>
  pricing: unknown
}): ProfileCompatibilityIdentity {
  return {
    compatibilityFingerprintVersion: COMPATIBILITY_FINGERPRINT_VERSION,
    compatibilityFingerprint: hashCanonical(
      materialize({ version: COMPATIBILITY_FINGERPRINT_VERSION, profile: input.semanticValue }),
    ),
    pricingRevisionVersion: PRICING_REVISION_VERSION,
    pricingRevision: hashCanonical({
      version: PRICING_REVISION_VERSION,
      pricing: materialize(input.pricing ?? null),
    }),
  }
}

function withHash<T extends { profileHash: string }>(
  value: Omit<T, 'profileHash'>,
): T {
  const profile = { ...value, profileHash: '' } as T
  // Retrieval timestamps describe provenance, not model/provider identity.
  // Excluding them prevents harmless metadata refreshes from staling a
  // qualification while retaining all timestamps in the stored profile.
  profile.profileHash = hashCanonical(
    materialize({ ...profile, profileHash: undefined }),
  )
  return deepFreeze(profile)
}

/** Build a model profile whose identity excludes its derived hash field. */
export function createLabModelSpec(
  input: Omit<LabModelSpec, 'profileHash'> & Partial<ProfileCompatibilityIdentity>,
): VersionedLabModelSpec {
  const {
    compatibilityFingerprint: _compatibilityFingerprint,
    compatibilityFingerprintVersion: _compatibilityFingerprintVersion,
    pricingRevision: _pricingRevision,
    pricingRevisionVersion: _pricingRevisionVersion,
    ...base
  } = input
  // Lab facts never carry provider pricing, so the legacy hash is already
  // semantic; pricingRevision stays a stable constant for this profile.
  const legacyBase: Record<string, unknown> = { ...base, profileHash: undefined }
  const profile = {
    ...base,
    profileHash: hashCanonical(materialize(legacyBase)),
    ...buildCompatibilityIdentity({ semanticValue: legacyBase, pricing: null }),
  } as VersionedLabModelSpec
  return deepFreeze(profile)
}

/** Build a provider-hosted profile with stable semantic and pricing identities. */
export function createProviderModelProfile(
  input: Omit<ProviderModelProfile, 'profileHash'> & Partial<ProfileCompatibilityIdentity>,
): VersionedProviderModelProfile {
  const {
    compatibilityFingerprint: _compatibilityFingerprint,
    compatibilityFingerprintVersion: _compatibilityFingerprintVersion,
    pricingRevision: _pricingRevision,
    pricingRevisionVersion: _pricingRevisionVersion,
    ...base
  } = input
  // The legacy full hash intentionally retains pricing for conservative
  // comparison against records created before this split existed.
  const legacyBase: Record<string, unknown> = { ...base, profileHash: undefined }
  const semanticValue: Record<string, unknown> = { ...legacyBase }
  delete semanticValue.pricing
  const profile = {
    ...base,
    profileHash: hashCanonical(materialize(legacyBase)),
    ...buildCompatibilityIdentity({ semanticValue, pricing: base.pricing ?? null }),
  } as VersionedProviderModelProfile
  return deepFreeze(profile)
}

/** Build a provisional harness recommendation profile. */
export function createHarnessTuningProfile(
  input: Omit<HarnessTuningProfile, 'profileHash'>,
): HarnessTuningProfile {
  return withHash(input)
}

const MATERIAL_PROVIDER_FIELDS = [
  'provider',
  'canonicalModelId',
  'providerModelId',
  'upstreamProvider',
  'endpointId',
  'protocolProfiles',
  'endpointProfiles',
  'providerLimits',
  'tokenizer',
  'quantization',
  'pricing',
  'routingCapabilities',
  'cacheCapabilities',
  'lifecycle',
] as const

/**
 * Detect capability drift without treating source timestamps as capability drift.
 *
 * `semanticFields` and `pricingChanged` separate the price-only refreshes that
 * must not be read as capability failures from genuine semantic drift.
 */
export function detectProviderProfileDrift(
  previous: ProviderModelProfile,
  current: ProviderModelProfile,
): {
  changed: boolean
  fields: string[]
  semanticChanged: boolean
  semanticFields: string[]
  pricingChanged: boolean
} {
  const fields = MATERIAL_PROVIDER_FIELDS.filter(
    (field) => hashCanonical(previous[field]) !== hashCanonical(current[field]),
  )
  const semanticFields = fields.filter((field) => field !== 'pricing')
  return {
    changed: fields.length > 0,
    fields: [...fields],
    semanticChanged: semanticFields.length > 0,
    semanticFields: [...semanticFields],
    pricingChanged: fields.includes('pricing'),
  }
}

/**
 * A qualification is stale when its semantic compatibility identity no longer
 * matches the current profile.
 *
 * This delegates to {@link qualificationCompatibility}: a price-only refresh
 * (`pricingRevision` changed but `compatibilityFingerprint` stable) does not
 * invalidate a semantic qualification, while a protocol/adapter/route/model/
 * capability/limit change does. Records that predate the versioned split have
 * no compatibility fields and remain conservative against the full provider
 * hash, which includes pricing. The `reason` wording is preserved for existing
 * callers; budget owners that must also react to a price change should call
 * {@link qualificationCompatibility} directly.
 */
export function qualificationStaleness(
  record: Pick<
    ModelQualificationRecord,
    'modelProfileHash' | 'providerProfileHash'
  > & {
    compatibilityFingerprint?: string
    pricingRevision?: string
  },
  current: Pick<ProviderModelProfile, 'profileHash'> & {
    modelProfileHash: string
    compatibilityFingerprint?: string
    pricingRevision?: string
  },
): { stale: boolean; reason?: string } {
  const compatibility = qualificationCompatibility(
    {
      modelProfileHash: record.modelProfileHash,
      providerProfileHash: record.providerProfileHash,
      ...(record.compatibilityFingerprint === undefined
        ? {}
        : { compatibilityFingerprint: record.compatibilityFingerprint }),
      ...(record.pricingRevision === undefined
        ? {}
        : { pricingRevision: record.pricingRevision }),
    },
    {
      modelProfileHash: current.modelProfileHash,
      profileHash: current.profileHash,
      compatibilityFingerprint: current.compatibilityFingerprint ?? '',
      pricingRevision: current.pricingRevision ?? '',
    },
  )
  // A price-only refresh does not stale a semantic qualification. The separate
  // `pricingChanged` flag remains available from qualificationCompatibility for
  // budget/quota owners that must react to it.
  if (!compatibility.semanticStale) return { stale: false }
  const reasons: string[] = []
  if (record.modelProfileHash !== current.modelProfileHash)
    reasons.push('lab model profile changed')
  if (record.providerProfileHash !== current.profileHash)
    reasons.push('provider model profile changed')
  const reason =
    reasons.length > 0 ? reasons.join('; ') : compatibility.reason
  return reason ? { stale: true, reason } : { stale: true }
}

/** Result of comparing a qualification against a current versioned profile. */
export interface QualificationCompatibility {
  /** Any difference (semantic or pricing) that affects the qualification. */
  stale: boolean
  /** A protocol/adapter/route/model/capability/limit change. */
  semanticStale: boolean
  /** A price-only change; a budget/policy qualification may still depend on it. */
  pricingChanged: boolean
  /** True when the record predates the versioned fingerprint split. */
  legacyFullHash: boolean
  reason?: string
}

/**
 * Compare a qualification record with a current profile, separating semantic
 * invalidation from a price-only refresh.
 *
 * A record without the versioned fields is conservative: any change to the
 * legacy full hash (which includes pricing) invalidates it until it is
 * requalified. A versioned record stays semantically valid across a price-only
 * refresh while still reporting `pricingChanged`.
 */
export function qualificationCompatibility(
  record: {
    modelProfileHash: string
    providerProfileHash: string
    compatibilityFingerprint?: string
    pricingRevision?: string
  },
  current: {
    modelProfileHash: string
    profileHash: string
    compatibilityFingerprint: string
    pricingRevision: string
  },
): QualificationCompatibility {
  const reasons: string[] = []
  const modelChanged = record.modelProfileHash !== current.modelProfileHash
  if (modelChanged) reasons.push('lab model profile changed')

  const versioned =
    typeof record.compatibilityFingerprint === 'string' &&
    typeof record.pricingRevision === 'string'
  if (!versioned) {
    // Legacy records only carry the full provider hash, which includes pricing.
    if (record.providerProfileHash !== current.profileHash) {
      reasons.push('provider model profile changed (legacy full-hash record)')
      return {
        stale: true,
        semanticStale: true,
        pricingChanged: false,
        legacyFullHash: true,
        reason: reasons.join('; '),
      }
    }
    return {
      stale: modelChanged,
      semanticStale: modelChanged,
      pricingChanged: false,
      legacyFullHash: true,
      ...(modelChanged ? { reason: reasons.join('; ') } : {}),
    }
  }

  const semanticStale =
    modelChanged || record.compatibilityFingerprint !== current.compatibilityFingerprint
  const pricingChanged = record.pricingRevision !== current.pricingRevision
  if (record.compatibilityFingerprint !== current.compatibilityFingerprint)
    reasons.push('provider semantic compatibility changed')
  if (pricingChanged) reasons.push('provider pricing revision changed')
  const stale = semanticStale || pricingChanged
  return {
    stale,
    semanticStale,
    pricingChanged,
    legacyFullHash: false,
    ...(stale ? { reason: reasons.join('; ') } : {}),
  }
}
