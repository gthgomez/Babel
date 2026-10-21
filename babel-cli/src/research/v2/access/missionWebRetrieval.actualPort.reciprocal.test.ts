/**
 * Actual-port characterization for mission web ref selection (A abd4/c3c553a).
 * Documents normalized URL dedupe and missing-ref limitations; migrate assertions when
 * A publishes URL-binding repair checkpoint (do not treat known faults as acceptance).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { RESEARCH_V2_CONTRACT_VERSION } from '../contracts/version.js'
import type { SourceRecord } from '../contracts/sources.js'
import { resolveMissionWebRetrievalCandidates } from './missionWebRetrievalSelection.js'

const mission = ResearchMissionV2Schema.parse({
  schema_version: 'research-mission-v2',
  contract_version: RESEARCH_V2_CONTRACT_VERSION,
  mission_id: 'mission-g-l2-web-refs-proxy',
  profile_id: 'general',
  profile_version: '0.1.0-m0',
  created_at: '2026-10-21T10:00:00.000Z',
  primary_question: 'Compare MDN and Cloudflare cache guidance',
  intended_decision: 'fixture',
  constraints: [],
  exclusions: [],
  as_of: '2026-10-21',
  jurisdiction: 'unknown',
  source_policy: {
    allowed_source_classes: ['web'],
    allowed_web_domains: ['developer.mozilla.org', 'developers.cloudflare.com'],
    selected_web_refs: [
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control',
      'https://developers.cloudflare.com/cache/concepts/cache-control/',
    ],
    visibility_retention: {
      source_visibility: 'public',
      retention: 'excerpt_only',
      export_may_omit_bytes: true,
    },
  },
  effort_policy: { preset_name: 'normal', resolved_budget_label: 'host-resolved-normal' },
  model_route: {
    backend_key: 'research-v2-cli',
    provider: 'openrouter',
    provider_model_id: 'deepseek/deepseek-v4-flash-0731',
  },
})

function webSource(id: string, url: string): SourceRecord {
  return {
    source_id: id,
    kind: 'web',
    canonical_key: url,
    observed_urls: [url],
    title: id,
  }
}

describe('mission web retrieval actual-port (production selection)', () => {
  it('dedupes discover hits and orders slots by selected_web_refs', () => {
    const mdn = webSource(
      'mdn',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control',
    )
    const cf = webSource(
      'cf',
      'https://developers.cloudflare.com/cache/concepts/cache-control/',
    )
    const resolution = resolveMissionWebRetrievalCandidates([cf, mdn, mdn], mission)
    assert.equal(resolution.slots.length, 2)
    assert.equal(resolution.slots[0]?.candidate.source_id, 'mdn')
    assert.equal(resolution.slots[1]?.candidate.source_id, 'cf')
  })

  it('records missing selected ref when discover lacks an admitted hit', () => {
    const mdn = webSource(
      'mdn',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control',
    )
    const resolution = resolveMissionWebRetrievalCandidates([mdn], mission)
    assert.equal(resolution.slots.length, 1)
    assert.ok(resolution.limitations.some((l) => l.startsWith('retrieval_web_ref_missing:')))
  })
})
