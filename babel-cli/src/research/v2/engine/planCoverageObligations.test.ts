import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessPlanCoverageObligations,
  passageSupportsAudienceIntent,
  passageSupportsObligationCompleteness,
  passageSupportsTechnicalEffect,
} from './planCoverageObligations.js'

describe('planCoverageObligations', () => {
  it('does not treat Cache-Control header mention alone as max-age semantics', () => {
    const mdnOverview =
      'The HTTP cache stores a response and uses cache headers, including Cache-Control, to decide how responses are cached and reused.'
    assert.equal(passageSupportsTechnicalEffect(mdnOverview, 'max_age_or_ttl_semantics'), false)
    assert.equal(passageSupportsTechnicalEffect(mdnOverview, 'general_technical'), true)
  })

  it('accepts max-age TTL substance when present', () => {
    const text = 'Cache-Control max-age directive controls freshness.'
    assert.equal(passageSupportsTechnicalEffect(text, 'max_age_or_ttl_semantics'), true)
  })

  it('evidence signal helpers remain available for review input (not host obligation gates)', () => {
    assert.equal(
      passageSupportsTechnicalEffect('On this page: max-age | TTL | See also', 'max_age_or_ttl_semantics'),
      true,
    )
    assert.equal(
      passageSupportsAudienceIntent('This document is intended for a single user.'),
      true,
    )
    assert.equal(
      passageSupportsObligationCompleteness('Welcome to our website', {
        obligation_id: 'ob-tech',
        source_slot: 'web-ref-0',
        aspect: 'technical_effect',
        technical_effect: 'general_technical',
      }),
      true,
    )
  })

  it('distinguishes audience intent from cache-directive technical evidence', () => {
    const cacheOnly = 'Cache-Control max-age directive controls edge caching.'
    assert.equal(passageSupportsAudienceIntent(cacheOnly), false)
    assert.equal(passageSupportsTechnicalEffect(cacheOnly, 'max_age_or_ttl_semantics'), true)
    const audience = 'This guide is written for browser-facing web developers.'
    assert.equal(passageSupportsAudienceIntent(audience), true)
  })

  it('marks comparative obligations partial when one slot lacks max-age substance', () => {
    const assessment = assessPlanCoverageObligations(
      [
        {
          obligation_id: 'ob-a',
          source_slot: 'slot_a',
          aspect: 'technical_effect',
          technical_effect: 'max_age_or_ttl_semantics',
        },
        {
          obligation_id: 'ob-b',
          source_slot: 'slot_b',
          aspect: 'technical_effect',
          technical_effect: 'max_age_or_ttl_semantics',
        },
      ],
      [
        {
          passage: {
            passage_id: 'p-a',
            source_revision_id: 'r-a',
            locator: { kind: 'section', section_id: 'x' },
            text_ref: {
              mode: 'inline',
              text:
                'Uses cache headers, including Cache-Control, without stating how long responses remain fresh in this excerpt.',
              text_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
          source: {
            source_id: 's-a',
            kind: 'web',
            canonical_key: 'https://a.example',
            observed_urls: ['https://a.example'],
            coverage_source_slot: 'slot_a',
          },
        },
        {
          passage: {
            passage_id: 'p-b',
            source_revision_id: 'r-b',
            locator: { kind: 'section', section_id: 'y' },
            text_ref: {
              mode: 'inline',
              text: 'max-age controls freshness at the edge.',
              text_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
          source: {
            source_id: 's-b',
            kind: 'web',
            canonical_key: 'https://b.example',
            observed_urls: ['https://b.example'],
            coverage_source_slot: 'slot_b',
          },
        },
      ],
    )
    assert.equal(assessment.satisfiesAllObligations, false)
    assert.deepEqual(assessment.missingObligationIds, ['ob-a'])
  })
})
