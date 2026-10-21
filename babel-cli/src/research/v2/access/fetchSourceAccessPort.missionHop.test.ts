import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SourceRecord } from '../contracts/sources.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { AdmittedNetworkPolicyError } from './admittedHttpGet.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort mission hop admission', () => {
  it('wires mission hop admission into admittedGet before dispatch', async () => {
    const source: SourceRecord = {
      source_id: 'web-hop',
      kind: 'web',
      canonical_key: 'web:allowed.example/start',
      observed_urls: ['https://allowed.example/start'],
    }
    const mission: ResearchMissionV2 = {
      ...exampleTechnicalMissionFixture,
      source_policy: {
        ...exampleTechnicalMissionFixture.source_policy,
        allowed_source_classes: ['web', 'repository_file'],
        allowed_web_domains: ['allowed.example'],
      },
    }
    let hopChecks = 0
    const port = new FetchSourceAccessPort({
      mission,
      admittedGet: async (params) => {
        hopChecks += 1
        await params.assertHopAdmitted?.(new URL('https://allowed.example/start'))
        await params.assertHopAdmitted?.(new URL('https://evil.example/private'))
        throw new AdmittedNetworkPolicyError('mission hop denied before forbidden dispatch')
      },
    })
    const result = await port.fetchContent({
      operationId: 'hop-op',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    assert.equal(hopChecks, 1)
  })
})
