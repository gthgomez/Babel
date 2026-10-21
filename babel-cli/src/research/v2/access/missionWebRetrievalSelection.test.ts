import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { RESEARCH_V2_CONTRACT_VERSION } from '../contracts/version.js'
import type { SourceRecord } from '../contracts/sources.js'
import {
  bindWebSourceToMissionRef,
  resolveMissionWebRetrievalCandidates,
  sourcePrimaryUrlMatchesSelectedWebRef,
} from './missionWebRetrievalSelection.js'

const baseMission = ResearchMissionV2Schema.parse({
  schema_version: 'research-mission-v2',
  contract_version: RESEARCH_V2_CONTRACT_VERSION,
  mission_id: 'mission-web-selection',
  profile_id: 'general',
  profile_version: '0.0.0-checkpoint',
  created_at: '2026-10-20T12:00:00.000Z',
  primary_question: 'Compare two official pages',
  intended_decision: 'fixture',
  constraints: [],
  exclusions: [],
  as_of: '2026-10-20',
  jurisdiction: 'unknown',
  source_policy: {
    allowed_source_classes: ['web'],
    allowed_web_domains: ['developer.mozilla.org', 'developers.cloudflare.com'],
    selected_web_refs: [
      'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
      'https://developers.cloudflare.com/workers/',
    ],
    visibility_retention: {
      source_visibility: 'public',
      retention: 'excerpt_only',
      export_may_omit_bytes: true,
    },
  },
  effort_policy: {
    preset_name: 'normal',
    resolved_budget_label: 'host-resolved-normal',
  },
  model_route: {
    backend_key: 'fixture-model-route',
    provider: 'fixture',
    provider_model_id: 'fixture/general',
    fixture_route: true,
  },
})

function webSource(id: string, primaryUrl: string, extraUrls: string[] = []): SourceRecord {
  return {
    source_id: id,
    kind: 'web',
    canonical_key: extraUrls[0] ?? primaryUrl,
    observed_urls: [primaryUrl, ...extraUrls],
    title: id,
  }
}

describe('missionWebRetrievalSelection', () => {
  it('matches selected refs on primary observed_urls[0] only', () => {
    const url = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    const source = webSource('a', url)
    assert.ok(sourcePrimaryUrlMatchesSelectedWebRef(source, url))
    const aliasOnly = webSource(
      'b',
      'https://developer.mozilla.org/en-US/docs/other',
      [url],
    )
    assert.equal(sourcePrimaryUrlMatchesSelectedWebRef(aliasOnly, url), false)
  })

  it('resolves mission ref order with dedupe and binds fetch URL to observed_urls[0]', () => {
    const mdn = webSource('mdn', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API')
    const cf = webSource('cf', 'https://developers.cloudflare.com/workers/')
    const resolution = resolveMissionWebRetrievalCandidates([cf, mdn, mdn], baseMission)
    assert.equal(resolution.slots.length, 2)
    assert.equal(resolution.slots[0]?.candidate.observed_urls[0], mdn.observed_urls[0])
    assert.equal(resolution.slots[1]?.candidate.observed_urls[0], cf.observed_urls[0])
    assert.deepEqual(resolution.limitations, [])
  })

  it('dedupes fragment aliases on the same HTTP resource', () => {
    const base = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    const mission = ResearchMissionV2Schema.parse({
      ...baseMission,
      source_policy: {
        ...baseMission.source_policy,
        selected_web_refs: [`${base}#a`, `${base}#b`],
      },
    })
    const mdn = webSource('mdn', base)
    const resolution = resolveMissionWebRetrievalCandidates([mdn], mission)
    assert.equal(resolution.slots.length, 1)
    assert.equal(resolution.slots[0]?.candidate.observed_urls[0], base)
    assert.ok(resolution.limitations.some((l) => l.startsWith('retrieval_web_ref_duplicate:')))
  })

  it('dedupes duplicate mission refs to a single fetch target', () => {
    const mission = ResearchMissionV2Schema.parse({
      ...baseMission,
      source_policy: {
        ...baseMission.source_policy,
        selected_web_refs: [
          'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
          'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
        ],
      },
    })
    const mdn = webSource('mdn', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API')
    const resolution = resolveMissionWebRetrievalCandidates([mdn], mission)
    assert.equal(resolution.slots.length, 1)
    assert.ok(resolution.limitations.some((l) => l.startsWith('retrieval_web_ref_duplicate:')))
  })

  it('direct-acquires selected refs when discover omits them', () => {
    const mdn = webSource('mdn', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API')
    const resolution = resolveMissionWebRetrievalCandidates([mdn], baseMission)
    assert.equal(resolution.slots.length, 2)
    assert.equal(
      resolution.slots[1]?.candidate.observed_urls[0],
      'https://developers.cloudflare.com/workers/',
    )
  })

  it('rebinds discover alias hits to mission ref before fetch', () => {
    const ref = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    const discoverHit = webSource(
      'alias',
      'https://developer.mozilla.org/en-US/docs/alias-primary',
      [ref],
    )
    const bound = bindWebSourceToMissionRef(discoverHit, ref)
    assert.equal(bound.observed_urls[0], ref)
  })

  it('binds fragment mission refs to fragment-free fetch URL with provenance preserved', () => {
    const ref = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API#Using_Fetch'
    const fetchUrl = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    const direct = bindWebSourceToMissionRef(
      webSource('mdn', 'https://developer.mozilla.org/en-US/docs/alias-primary'),
      ref,
    )
    assert.equal(direct.observed_urls[0], fetchUrl)
    assert.ok(direct.observed_urls.includes(ref))
  })

  it('legacy mode keeps first discover candidate (fetch-time admission unchanged)', () => {
    const legacyMission = ResearchMissionV2Schema.parse({
      ...baseMission,
      source_policy: {
        ...baseMission.source_policy,
        selected_web_refs: undefined,
      },
    })
    const first = webSource('first', 'https://developer.mozilla.org/en-US/docs/a')
    const second = webSource('second', 'https://developer.mozilla.org/en-US/docs/b')
    const resolution = resolveMissionWebRetrievalCandidates([second, first], legacyMission)
    assert.equal(resolution.slots.length, 1)
    assert.equal(resolution.slots[0]?.candidate.source_id, 'second')
  })
})
