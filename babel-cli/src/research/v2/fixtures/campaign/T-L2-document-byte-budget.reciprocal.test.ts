import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { DEFAULT_MAX_ADMITTED_BYTES } from '../../access/fetchSourceAccessPort.js'
import {
  intersectDocumentFetchByteBudgets,
  resolveMissionDocumentPolicyForFetchUrl,
} from '../../access/missionDocumentAcquisitionPolicy.js'
import pins from './T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const campaignDir = dirname(fileURLToPath(import.meta.url))

describe('T-L2 document byte budget reciprocal (factory policy, no live PDF)', () => {
  it('production host default 200000-byte clamp blocks full arXiv paper body', () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
    )
    const docSource = {
      source_id: 'doc-arxiv',
      kind: 'document' as const,
      canonical_key: pins.t_l2_paper.canonical_url,
      observed_urls: [pins.t_l2_paper.canonical_url],
      title: pins.t_l2_paper.title,
    }
    const policy = resolveMissionDocumentPolicyForFetchUrl(
      docSource,
      mission,
      pins.t_l2_paper.canonical_url,
    )
    assert.ok(policy)
    const hostDefault = intersectDocumentFetchByteBudgets(
      policy,
      DEFAULT_MAX_ADMITTED_BYTES,
      DEFAULT_MAX_ADMITTED_BYTES,
    )
    assert.equal(hostDefault.maxWireBytes, DEFAULT_MAX_ADMITTED_BYTES)
    assert.ok(pins.t_l2_paper.observed_content_length_bytes > hostDefault.maxWireBytes)
    assert.equal(pins.t_l2_paper.observed_content_length_bytes, 2_215_244)
  })

  it('mission declares 2.3MB budgets but host clamp wins until A wires explicit scoped CLI document budget', () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
    )
    const admitted = mission.source_policy.admitted_document_sources?.[0]
    assert.equal(admitted?.wire_byte_budget, 2_300_000)
    const policy = resolveMissionDocumentPolicyForFetchUrl(
      {
        source_id: 'doc',
        kind: 'document',
        canonical_key: pins.t_l2_paper.canonical_url,
        observed_urls: [pins.t_l2_paper.canonical_url],
        title: 'paper',
      },
      mission,
      pins.t_l2_paper.canonical_url,
    )
    assert.ok(policy)
    const effective = intersectDocumentFetchByteBudgets(
      policy,
      DEFAULT_MAX_ADMITTED_BYTES,
      DEFAULT_MAX_ADMITTED_BYTES,
    )
    assert.ok(effective.maxWireBytes < admitted!.wire_byte_budget!)
  })

  it('raised host ceiling would admit full paper bytes (pending A production wiring)', () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
    )
    const policy = resolveMissionDocumentPolicyForFetchUrl(
      {
        source_id: 'doc',
        kind: 'document',
        canonical_key: pins.t_l2_paper.canonical_url,
        observed_urls: [pins.t_l2_paper.canonical_url],
        title: 'paper',
      },
      mission,
      pins.t_l2_paper.canonical_url,
    )
    assert.ok(policy)
    const raised = intersectDocumentFetchByteBudgets(policy, 10_000_000, 10_000_000)
    assert.ok(raised.maxWireBytes >= pins.t_l2_paper.observed_content_length_bytes)
  })
})
