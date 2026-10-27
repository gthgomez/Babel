import { createHash } from 'node:crypto'
import type { PricingProvider } from '../services/modelPricingRegistry.js'
import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  isCampaignQualifiedModelRoute,
} from './campaign-qualified-routes.js'
/** Independent owner for legacy campaign ceilings — not usage-estimate registry rates. */
export const CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER =
  'campaign_legacy_reservation_ceiling_table_v1' as const

/**
 * Preserved baseline adoption (Task1 pin). Numeric rates match registry snapshot at adoption;
 * not an assertion of current market verification.
 */
export const CAMPAIGN_LEGACY_RESERVATION_BASELINE_ADOPTION_SOURCE =
  'preserved_model_pricing_registry_snapshot_at_legacy_ceiling_adoption' as const

export const CAMPAIGN_LEGACY_RESERVATION_ADOPTED_AT = '2026-10-26' as const

/** Legacy holds are conservative reservation math only; not bounded-continuation certification. */
export type CampaignLegacyReservationRateRole = 'legacy_non_certifying_reservation'

export interface CampaignLegacyReservationRateEntry {
  readonly owner: typeof CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER
  readonly role: CampaignLegacyReservationRateRole
  readonly provider: PricingProvider
  readonly modelId: string
  readonly inputUsdPerMillion: number
  readonly outputUsdPerMillion: number
  readonly adoptedAt: string
  readonly baselineAdoptionSource: string
}

export type CampaignLegacyReservationRateIdentity = Pick<
  CampaignLegacyReservationRateEntry,
  | 'owner'
  | 'role'
  | 'provider'
  | 'modelId'
  | 'inputUsdPerMillion'
  | 'outputUsdPerMillion'
  | 'adoptedAt'
  | 'baselineAdoptionSource'
>

const OPENROUTER_LEGACY_RATES: CampaignLegacyReservationRateEntry = {
  owner: CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER,
  role: 'legacy_non_certifying_reservation',
  provider: 'openrouter',
  modelId: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  inputUsdPerMillion: 0.14,
  outputUsdPerMillion: 0.28,
  adoptedAt: CAMPAIGN_LEGACY_RESERVATION_ADOPTED_AT,
  baselineAdoptionSource: CAMPAIGN_LEGACY_RESERVATION_BASELINE_ADOPTION_SOURCE,
}

const COMMAND_CODE_LEGACY_RATES: CampaignLegacyReservationRateEntry = {
  owner: CAMPAIGN_LEGACY_RESERVATION_RATES_OWNER,
  role: 'legacy_non_certifying_reservation',
  provider: 'command-code',
  modelId: CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  adoptedAt: CAMPAIGN_LEGACY_RESERVATION_ADOPTED_AT,
  baselineAdoptionSource: CAMPAIGN_LEGACY_RESERVATION_BASELINE_ADOPTION_SOURCE,
}

const CAMPAIGN_LEGACY_RESERVATION_RATE_TABLE: Readonly<
  Record<string, CampaignLegacyReservationRateEntry>
> = {
  [`openrouter:${CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID}`]: OPENROUTER_LEGACY_RATES,
  [`command-code:${CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID}`]: COMMAND_CODE_LEGACY_RATES,
}

function tableKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

export function campaignLegacyReservationRateContentHash(
  identity: CampaignLegacyReservationRateIdentity,
): string {
  const payload = {
    owner: identity.owner,
    role: identity.role,
    provider: identity.provider,
    modelId: identity.modelId,
    inputUsdPerMillion: identity.inputUsdPerMillion,
    outputUsdPerMillion: identity.outputUsdPerMillion,
    adoptedAt: identity.adoptedAt,
    baselineAdoptionSource: identity.baselineAdoptionSource,
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

export function resolveCampaignLegacyReservationRates(
  provider: string,
  modelId: string,
): CampaignLegacyReservationRateEntry | null {
  if (!isCampaignQualifiedModelRoute(provider, modelId)) return null
  return CAMPAIGN_LEGACY_RESERVATION_RATE_TABLE[tableKey(provider, modelId)] ?? null
}

/** Reservation/wire hold math from legacy ceiling rates only (never usage estimates). */
export function legacyReservationUpperBoundMicroUsd(
  rates: Pick<CampaignLegacyReservationRateEntry, 'inputUsdPerMillion' | 'outputUsdPerMillion'>,
  promptTokens: number,
  completionTokens: number,
): number {
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens <= 0
  ) {
    throw new Error('campaign legacy reservation token bounds invalid')
  }
  const usd =
    (promptTokens / 1_000_000) * rates.inputUsdPerMillion +
    (completionTokens / 1_000_000) * rates.outputUsdPerMillion
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error('campaign legacy reservation cost invalid')
  }
  return Math.max(1, Math.ceil(usd * 1_000_000))
}
