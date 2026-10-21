import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseExaLiteProviderEstimatedCostUsd,
  reportLimitationsFromSearchProviderReceipt,
  sanitizeSourceSearchProviderReceipt,
  usageSettlementFromSearchProviderReceipt,
} from './sourceDiscoverSearchReceipt.js'

describe('sourceDiscoverSearchReceipt', () => {
  it('sanitizes compatible B handoff receipt and labels provider-estimated cost', () => {
    const receipt = sanitizeSourceSearchProviderReceipt({
      configured_provider_id: 'exa_lite',
      effective_provider_id: 'duckduckgo_html_fallback',
      degradation: {
        from_provider_id: 'exa_lite',
        to_provider_id: 'duckduckgo_html_fallback',
        reason: 'exa_zero_hits',
      },
      exa_lite: {
        requestId: 'req-abc',
        costDollars: 0.0025,
      },
    })
    const usage = usageSettlementFromSearchProviderReceipt(
      receipt,
      'att-1',
      '2026-10-21T12:00:00.000Z',
    )
    assert.ok(usage)
    assert.equal(usage?.cost.status, 'estimated')
    assert.equal(usage?.cost.amount_usd, 0.0025)
    assert.equal(usage?.cost.method, 'exa_lite_provider_costDollars')
    const limitations = reportLimitationsFromSearchProviderReceipt(receipt)
    assert.ok(limitations.some((l) => l.includes('exa_lite_request_id:req-abc')))
    assert.ok(limitations.some((l) => l.includes('exa_lite_provider_estimated_cost_usd:0.0025')))
    assert.ok(limitations.some((l) => l.includes('exa_lite_highlights_discovery_only')))
  })

  it('preserves unknown cost without inventing usage settlement', () => {
    assert.equal(parseExaLiteProviderEstimatedCostUsd(undefined), null)
    const receipt = sanitizeSourceSearchProviderReceipt({
      configured_provider_id: 'exa_lite',
      effective_provider_id: 'exa_lite',
      exa_lite: { requestId: 'req-x', costDollars: 'not-a-number' },
    })
    assert.equal(
      usageSettlementFromSearchProviderReceipt(receipt, 'att-2', '2026-10-21T12:00:00.000Z'),
      undefined,
    )
    const limitations = reportLimitationsFromSearchProviderReceipt(receipt)
    assert.ok(limitations.some((l) => l === 'exa_lite_provider_estimated_cost_usd:unknown'))
  })

  it('rejects malformed receipt payloads', () => {
    assert.throws(() =>
      sanitizeSourceSearchProviderReceipt({
        configured_provider_id: 'exa_lite',
        effective_provider_id: 'exa_lite',
        unexpected: true,
      } as never),
    )
  })
})
