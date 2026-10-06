import { hashCanonical } from './hash.js'
import type { CatalogSnapshot } from './types.js'

/**
 * Explicit unit for one quote component.
 *
 * A quote states its own unit so callers cannot double-convert a rate. The
 * per-token normalization happens exactly once, in {@link quotePerTokenPrice}.
 */
export type PriceUnit = 'usd_per_million_tokens' | 'usd_per_token'

/** Quotes are denominated in USD by contract; no implicit currency conversion. */
export type PriceCurrency = 'USD'

/**
 * Route conditions a quote is valid for.
 *
 * A condition that is present must match the served request exactly. A quote
 * with no conditions is the provider/model base rate. Unknown route facts never
 * coerce to a match: a conditioned quote cannot price an unobserved route.
 */
export interface PriceConditions {
  upstream?: string
  endpoint?: string
  tier?: string
  timeWindow?: string
}

/**
 * One immutable catalog-backed price fact with explicit unit and provenance.
 *
 * A `null` component is unknown, never zero. Historical charge records retain
 * the exact quote (and `quoteRevision`) used at charge time; a later refresh
 * creates a new quote revision instead of repricing the old charge.
 */
export interface PriceQuote {
  schemaVersion: 1
  quoteId: string
  quoteRevision: string
  provider: string
  modelId: string
  unit: PriceUnit
  currency: PriceCurrency
  inputCost: number | null
  outputCost: number | null
  cacheReadCost: number | null
  cacheWriteCost: number | null
  cacheDiscountAvailable: boolean
  conditions: PriceConditions
  sourceUrl: string
  verifiedAt: string
}

/** Per-token components normalized from a quote exactly once. `null` is unknown. */
export interface PerTokenPrice {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/** Token usage used to price one attempt. Missing counts stay unknown. */
export interface QuoteUsageTokens {
  promptTokens?: number | null | undefined
  completionTokens?: number | null | undefined
  cacheHitTokens?: number | null | undefined
  cacheMissTokens?: number | null | undefined
}

/** Pure cost breakdown for one quote and one usage observation. */
export interface QuoteCostBreakdown {
  inputCostUsd: number | null
  outputCostUsd: number | null
  estimatedCostUsd: number | null
}

/** Resolution outcome, always explicit. Exact means "one applicable quote". */
export type PriceQuoteStatus = 'exact' | 'unknown'

/** Result of resolving a quote for an exact tuple and served route. */
export interface PriceQuoteResult {
  status: PriceQuoteStatus
  quote: PriceQuote | null
  quoteRevision: string | null
  /** Normalized per-token components; `null` components are unknown, not zero. */
  perToken: PerTokenPrice | null
  reason: string | null
}

/** Input for {@link resolvePriceQuote}. Unknown route facts must stay null. */
export interface PriceQuoteInput {
  provider: string | null | undefined
  modelId: string | null | undefined
  /** Actual served upstream gateway/provider, when observed. */
  upstream?: string | null
  endpoint?: string | null
  tier?: string | null
  /** Applicable pricing window (for example `peak`), when observed. */
  timeWindow?: string | null
  /** Pin a historical quote revision; this never reprices an existing charge. */
  quoteRevision?: string | null
  /** Resolve from a catalog projection instead of the pinned built-in quotes. */
  catalog?: CatalogSnapshot
  /** Explicit quote set (refresh tooling/tests) overriding the built-in table. */
  quotes?: readonly PriceQuote[]
}

const PRICE_QUOTE_SCHEMA_VERSION = 1

export const DEEPSEEK_PRICING_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const DEEPINFRA_PRICING_SOURCE_URL =
  'https://docs.deepinfra.com/api-reference/models/models-list'
export const OPENROUTER_PRICING_SOURCE_URL = 'https://openrouter.ai/api/v1/models'
export const MODEL_PRICING_VERIFIED_AT = '2026-06-04'

const CATALOG_QUOTE_SOURCE_URL = 'catalog:provider-model-profile'

function normalizeTokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function conditionSignature(conditions: PriceConditions): string {
  const parts = [
    conditions.upstream ?? '',
    conditions.endpoint ?? '',
    conditions.tier ?? '',
    conditions.timeWindow ?? '',
  ]
  return parts.join('|')
}

function conditionCount(conditions: PriceConditions): number {
  let count = 0
  if (conditions.upstream !== undefined) count += 1
  if (conditions.endpoint !== undefined) count += 1
  if (conditions.tier !== undefined) count += 1
  if (conditions.timeWindow !== undefined) count += 1
  return count
}

/**
 * Build a quote, deriving its stable id and revision from the price facts and
 * their applicability. Provenance timestamps never create a new revision.
 */
export function buildPriceQuote(
  input: Omit<PriceQuote, 'schemaVersion' | 'quoteId' | 'quoteRevision'>,
): PriceQuote {
  const signature = conditionSignature(input.conditions)
  const quoteId =
    signature === '|||' ? `${input.provider}:${input.modelId}` : `${input.provider}:${input.modelId}#${signature}`
  const quoteRevision = hashCanonical({
    version: PRICE_QUOTE_SCHEMA_VERSION,
    provider: input.provider,
    modelId: input.modelId,
    unit: input.unit,
    currency: input.currency,
    inputCost: input.inputCost,
    outputCost: input.outputCost,
    cacheReadCost: input.cacheReadCost,
    cacheWriteCost: input.cacheWriteCost,
    cacheDiscountAvailable: input.cacheDiscountAvailable,
    conditions: input.conditions,
  })
  return {
    schemaVersion: PRICE_QUOTE_SCHEMA_VERSION,
    quoteId,
    quoteRevision,
    ...input,
  }
}

function baseQuote(input: {
  provider: string
  modelId: string
  inputCost: number
  outputCost: number
  cacheReadCost?: number
  cacheWriteCost?: number
  cacheDiscountAvailable?: boolean
  sourceUrl: string
  verifiedAt?: string
}): PriceQuote {
  return buildPriceQuote({
    provider: input.provider,
    modelId: input.modelId,
    unit: 'usd_per_million_tokens',
    currency: 'USD',
    inputCost: input.inputCost,
    outputCost: input.outputCost,
    cacheReadCost: input.cacheReadCost ?? null,
    cacheWriteCost: input.cacheWriteCost ?? null,
    cacheDiscountAvailable: input.cacheDiscountAvailable ?? false,
    conditions: {},
    sourceUrl: input.sourceUrl,
    verifiedAt: input.verifiedAt ?? MODEL_PRICING_VERIFIED_AT,
  })
}

/**
 * The single pinned quote table.
 *
 * These are the only hard-coded price facts. The `modelPricingRegistry`
 * compatibility layer, DeepSeek helpers and the catalog projection all derive
 * from this table instead of duplicating mutable rates.
 */
export const CANONICAL_PRICE_QUOTES: readonly PriceQuote[] = Object.freeze([
  baseQuote({
    provider: 'deepinfra',
    modelId: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    inputCost: 0.08,
    outputCost: 0.3,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepinfra',
    modelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    inputCost: 0.071,
    outputCost: 0.1,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepinfra',
    modelId: 'stepfun-ai/Step-3.5-Flash',
    inputCost: 0.09,
    outputCost: 0.3,
    cacheDiscountAvailable: true,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepinfra',
    modelId: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    inputCost: 0.1,
    outputCost: 0.5,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepinfra',
    modelId: 'deepseek-ai/DeepSeek-V3-0324',
    inputCost: 0.2,
    outputCost: 0.77,
    cacheDiscountAvailable: true,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepinfra',
    modelId: 'Qwen/Qwen3-32B',
    inputCost: 0.08,
    outputCost: 0.28,
    sourceUrl: DEEPINFRA_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    inputCost: 0.14,
    outputCost: 0.28,
    cacheReadCost: 0.0028,
    cacheWriteCost: 0.14,
    cacheDiscountAvailable: true,
    sourceUrl: DEEPSEEK_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    inputCost: 0.435,
    outputCost: 0.87,
    cacheReadCost: 0.003625,
    cacheWriteCost: 0.435,
    cacheDiscountAvailable: true,
    sourceUrl: DEEPSEEK_PRICING_SOURCE_URL,
  }),
  baseQuote({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3-flash',
    inputCost: 0.075,
    outputCost: 0.25,
    sourceUrl: OPENROUTER_PRICING_SOURCE_URL,
    verifiedAt: '2026-08-26',
  }),
])

/**
 * Normalize quote components to per-token.
 *
 * Conversion happens at most once per component: a per-token quote passes
 * through unchanged and a per-million quote is divided by 1,000,000 exactly
 * once. `null` stays `null`; unknown is never coerced to zero.
 */
export function quotePerTokenPrice(quote: PriceQuote): PerTokenPrice {
  const toPerToken = (value: number | null): number | null => {
    if (value === null || !Number.isFinite(value)) return null
    return quote.unit === 'usd_per_token' ? value : value / 1_000_000
  }
  return {
    input: toPerToken(quote.inputCost),
    output: toPerToken(quote.outputCost),
    cacheRead: toPerToken(quote.cacheReadCost),
    cacheWrite: toPerToken(quote.cacheWriteCost),
  }
}

/**
 * Price one usage observation from a quote.
 *
 * Input cache-hit/cache-miss arithmetic mirrors provider usage: a missing split
 * falls back to the base input rate, and any unknown rate yields `null` for that
 * component rather than a guessed zero. A partially observed cache split (only
 * one side, or a side whose rate is unknown) also yields `null`: a missing token
 * count is unknown, never zero, so pricing only the observed side would silently
 * understate the input cost.
 */
export function computeQuoteCostUsd(
  quote: PriceQuote,
  usage: QuoteUsageTokens,
): QuoteCostBreakdown {
  const perToken = quotePerTokenPrice(quote)
  const promptTokens = normalizeTokenCount(usage.promptTokens)
  const completionTokens = normalizeTokenCount(usage.completionTokens)
  const cacheHitTokens = normalizeTokenCount(usage.cacheHitTokens)
  const cacheMissTokens = normalizeTokenCount(usage.cacheMissTokens)

  let inputCostUsd: number | null = null
  if (cacheHitTokens !== null || cacheMissTokens !== null) {
    const hitRate = perToken.cacheRead ?? perToken.input
    const missRate = perToken.cacheWrite ?? perToken.input
    // Derive the unobserved side from the prompt total when it is known; a
    // missing side with no derivable total stays unknown, never zero.
    const hitTokens =
      cacheHitTokens ??
      (promptTokens !== null && cacheMissTokens !== null
        ? Math.max(promptTokens - cacheMissTokens, 0)
        : null)
    const missTokens =
      cacheMissTokens ??
      (promptTokens !== null && cacheHitTokens !== null
        ? Math.max(promptTokens - cacheHitTokens, 0)
        : null)
    if (hitRate !== null && missRate !== null && hitTokens !== null && missTokens !== null) {
      inputCostUsd = hitTokens * hitRate + missTokens * missRate
    }
  } else if (promptTokens !== null && perToken.input !== null) {
    inputCostUsd = promptTokens * perToken.input
  }

  const outputCostUsd =
    completionTokens !== null && perToken.output !== null
      ? completionTokens * perToken.output
      : null
  // When a cache split was observed, the input cost is a required part of the
  // total. If it could not be priced, the total is unknown -- reporting the
  // output half alone would be a misleadingly exact-looking number.
  const estimatedCostUsd =
    (cacheHitTokens !== null || cacheMissTokens !== null) && inputCostUsd === null
      ? null
      : inputCostUsd !== null || outputCostUsd !== null
        ? (inputCostUsd ?? 0) + (outputCostUsd ?? 0)
        : null
  return { inputCostUsd, outputCostUsd, estimatedCostUsd }
}

function unknownResult(reason: string): PriceQuoteResult {
  return { status: 'unknown', quote: null, quoteRevision: null, perToken: null, reason }
}

function exactResult(quote: PriceQuote): PriceQuoteResult {
  return {
    status: 'exact',
    quote,
    quoteRevision: quote.quoteRevision,
    perToken: quotePerTokenPrice(quote),
    reason: null,
  }
}

function conditionsMatch(conditions: PriceConditions, input: PriceQuoteInput): boolean {
  if (conditions.upstream !== undefined && conditions.upstream !== input.upstream) return false
  if (conditions.endpoint !== undefined && conditions.endpoint !== input.endpoint) return false
  if (conditions.tier !== undefined && conditions.tier !== input.tier) return false
  if (conditions.timeWindow !== undefined && conditions.timeWindow !== input.timeWindow) return false
  return true
}

function quotesFromCatalog(snapshot: CatalogSnapshot): PriceQuote[] {
  const quotes: PriceQuote[] = []
  for (const profile of snapshot.providerModels) {
    const pricing = profile.pricing
    if (!pricing) continue
    const hasAnyComponent =
      pricing.inputPerToken !== undefined ||
      pricing.outputPerToken !== undefined ||
      pricing.cacheReadPerToken !== undefined ||
      pricing.cacheWritePerToken !== undefined
    if (!hasAnyComponent) continue
    quotes.push(
      buildPriceQuote({
        provider: profile.provider,
        modelId: profile.providerModelId,
        unit: 'usd_per_token',
        currency: 'USD',
        inputCost: pricing.inputPerToken ?? null,
        outputCost: pricing.outputPerToken ?? null,
        cacheReadCost: pricing.cacheReadPerToken ?? null,
        cacheWriteCost: pricing.cacheWritePerToken ?? null,
        cacheDiscountAvailable: pricing.cacheReadPerToken !== undefined,
        conditions: {},
        sourceUrl: profile.sourceEvidence[0]?.uri ?? CATALOG_QUOTE_SOURCE_URL,
        verifiedAt: snapshot.observedAt,
      }),
    )
  }
  return quotes
}

/**
 * Resolve the one quote that applies to an exact tuple and served route.
 *
 * Selection is provider/model exact case, then the most specific quote whose
 * every stated condition matches the observed route. A pinned `quoteRevision`
 * returns that historical quote even after a price refresh. Missing facts,
 * unobserved routes, ambiguous ties and unregistered pairs all resolve to an
 * explicit `unknown` with a reason; an exact price is never invented.
 */
export function resolvePriceQuote(input: PriceQuoteInput): PriceQuoteResult {
  if (!input || typeof input !== 'object') {
    return unknownResult('No price quote input was provided.')
  }
  if (!input.provider || !input.modelId) {
    return unknownResult('A provider and model id are required to resolve a price quote.')
  }
  const quotes =
    input.quotes ?? (input.catalog ? quotesFromCatalog(input.catalog) : CANONICAL_PRICE_QUOTES)
  const candidates = quotes.filter(
    (quote) => quote.provider === input.provider && quote.modelId === input.modelId,
  )
  if (candidates.length === 0) {
    return unknownResult(`No price quote is registered for ${input.provider}:${input.modelId}.`)
  }

  if (typeof input.quoteRevision === 'string' && input.quoteRevision.length > 0) {
    const pinned = candidates.find((quote) => quote.quoteRevision === input.quoteRevision)
    return pinned
      ? exactResult(pinned)
      : unknownResult(
          `No quote revision "${input.quoteRevision}" is retained for ${input.provider}:${input.modelId}.`,
        )
  }

  const applicable = candidates.filter((quote) => conditionsMatch(quote.conditions, input))
  if (applicable.length === 0) {
    return unknownResult(
      `No price quote applies to the served route for ${input.provider}:${input.modelId}.`,
    )
  }
  const mostSpecific = Math.max(...applicable.map((quote) => conditionCount(quote.conditions)))
  const best = applicable.filter((quote) => conditionCount(quote.conditions) === mostSpecific)
  const revisions = new Set(best.map((quote) => quote.quoteRevision))
  if (revisions.size > 1) {
    return unknownResult(
      `Multiple equally specific price quotes apply to ${input.provider}:${input.modelId}; the price is ambiguous.`,
    )
  }
  const chosen = best[0]
  return chosen
    ? exactResult(chosen)
    : unknownResult(`No price quote applies for ${input.provider}:${input.modelId}.`)
}
