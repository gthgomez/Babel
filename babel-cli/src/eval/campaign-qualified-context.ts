import {
  CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID,
  CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
  isCampaignQualifiedModelRoute,
} from './campaign-qualified-routes.js'

/**
 * OpenRouter model-page FAQ: 1,048,576 context tokens (verified exact).
 * @see CAMPAIGN_QUALIFIED_CONTEXT_EVIDENCE.openrouterDeepSeekFlash
 */
export const CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS = 1_048_576 as const

/** Decimal reading of Command Code rounded "1M" context copy (display not exact). */
export const CAMPAIGN_QUALIFIED_COMMAND_CODE_DECIMAL_M_CONTEXT = 1_000_000 as const

/** Binary mebibyte reading of rounded "1M" context copy (display not exact). */
export const CAMPAIGN_QUALIFIED_COMMAND_CODE_BINARY_M_CONTEXT = 1_048_576 as const

/**
 * Conservative Command Code input ceiling covering decimal and binary "1M"
 * interpretations without treating the rounded UI figure as exact.
 */
export const CAMPAIGN_QUALIFIED_COMMAND_CODE_MAX_INPUT_CONTEXT_TOKENS =
  CAMPAIGN_QUALIFIED_COMMAND_CODE_BINARY_M_CONTEXT

export const CAMPAIGN_QUALIFIED_CONTEXT_EVIDENCE = {
  openrouterDeepSeekFlash:
    'https://openrouter.ai/deepseek/deepseek-v4-flash-0731',
  commandCodeLimits:
    'https://commandcode.ai/docs/resources/pricing-limits',
} as const

export type CampaignQualifiedContextSource = 'campaign_route_authoritative'

export const CAMPAIGN_QUALIFIED_CONTEXT_SOURCE: CampaignQualifiedContextSource =
  'campaign_route_authoritative'

/** Pinned max input context for qualified campaign routes only. */
export function campaignQualifiedMaxInputContextTokens(
  provider: string,
  sentModelId: string,
): number | null {
  if (!isCampaignQualifiedModelRoute(provider, sentModelId)) return null
  if (
    provider === 'openrouter' &&
    sentModelId === CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID
  ) {
    return CAMPAIGN_QUALIFIED_OPENROUTER_MAX_INPUT_CONTEXT_TOKENS
  }
  if (
    provider === 'command-code' &&
    sentModelId === CAMPAIGN_QUALIFIED_COMMAND_CODE_MODEL_ID
  ) {
    return CAMPAIGN_QUALIFIED_COMMAND_CODE_MAX_INPUT_CONTEXT_TOKENS
  }
  return null
}
