import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SourceRecord } from '../contracts/sources.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort mission hop admission', () => {
  it('default wrapper forwards hop admission; forbidden redirect host gets zero requests', async () => {
    const source: SourceRecord = {
      source_id: 'web-hop',
      kind: 'web',
      canonical_key: 'web:allowed.example/start',
      observed_urls: ['https://93.184.216.34/start'],
    }
    const mission: ResearchMissionV2 = {
      ...exampleTechnicalMissionFixture,
      source_policy: {
        ...exampleTechnicalMissionFixture.source_policy,
        allowed_source_classes: ['web', 'repository_file'],
        allowed_web_domains: ['93.184.216.34'],
      },
    }
    let dispatchCount = 0
    const port = new FetchSourceAccessPort({
      mission,
      dispatchGet: async () => {
        dispatchCount += 1
        if (dispatchCount === 1) {
          return {
            status: 302,
            headers: { location: 'https://evil.example/private' },
            body: { buffer: Buffer.alloc(0), bytesReceived: 0, truncated: false },
          }
        }
        throw new Error('forbidden redirect host must not be requested')
      },
    })
    const result = await port.fetchContent({
      operationId: 'hop-op',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    assert.equal(dispatchCount, 1)
  })
})
