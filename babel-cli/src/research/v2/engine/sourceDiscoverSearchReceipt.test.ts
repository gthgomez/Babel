import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  exaLiteProviderEstimatedCostUsd,
  reportLimitationsFromSearchProviderReceipt,
  sanitizeSourceSearchProviderReceipt,
  usageSettlementFromSearchProviderReceipt,
} from './sourceDiscoverSearchReceipt.js'

describe('sourceDiscoverSearchReceipt', () => {
  it('sanitizes B handoff receipt and labels provider-estimated cost', () => {
    const receipt = sanitizeSourceSearchProviderReceipt({
      configured_provider_id: 'exa_lite',
      effective_provider_id: 'duckduckgo_html_fallback',
      exa_participation: 'exa_degraded_fallback',
      degradation: {
        from_provider_id: 'exa_lite',
        to_provider_id: 'duckduckgo_html_fallback',
        reason: 'exa_zero_hits',
      },
      exa_lite: {
        request_id: 'req-abc',
        resolved_search_type: 'auto',
        warnings: [{ code: 'w1', path: null, message: 'warning one', details: null }],
        notices: [{ code: 'n1', path: null, message: 'notice one', details: null }],
        estimated_cost_dollars: 0.0025,
        estimated_cost_detail: { search: 0.0025 },
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
    assert.equal(usage?.cost.method, 'exa_lite_estimated_cost_dollars')
    assert.equal(exaLiteProviderEstimatedCostUsd(receipt.exa_lite), 0.0025)
    const limitations = reportLimitationsFromSearchProviderReceipt(receipt)
    assert.ok(limitations.some((l) => l === 'exa_participation:exa_degraded_fallback'))
    assert.ok(limitations.some((l) => l.includes('exa_lite_request_id:req-abc')))
    assert.ok(limitations.some((l) => l.includes('exa_lite_provider_estimated_cost_usd:0.0025')))
    assert.ok(limitations.some((l) => l.includes('exa_lite_highlights_discovery_only')))
  })

  it('does not sum estimated_cost_detail when estimated_cost_dollars is absent', () => {
    const receipt = sanitizeSourceSearchProviderReceipt({
      configured_provider_id: 'exa_lite',
      effective_provider_id: 'exa_lite',
      exa_participation: 'exa_primary_empty_billed',
      exa_lite: {
        request_id: 'req-x',
        resolved_search_type: null,
        warnings: [],
        notices: [],
        estimated_cost_dollars: null,
        estimated_cost_detail: { search: 0.01 },
      },
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
