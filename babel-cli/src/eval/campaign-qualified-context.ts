import { isCampaignQualifiedModelRoute } from './campaign-qualified-routes.js'

/** Authoritative campaign input ceiling — not model-policy or caller hints. */
export const CAMPAIGN_QUALIFIED_MAX_INPUT_CONTEXT_TOKENS = 1_000_000 as const

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
  return CAMPAIGN_QUALIFIED_MAX_INPUT_CONTEXT_TOKENS
}
