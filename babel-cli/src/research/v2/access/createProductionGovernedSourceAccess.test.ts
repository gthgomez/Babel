import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { createProductionGovernedSourceAccessForMission } from './createProductionGovernedSourceAccess.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'
import { DEFAULT_MAX_ADMITTED_BYTES } from './fetchSourceAccessPort.js'
import arxivManifest from '../fixtures/campaign/papers/1706.03762.manifest.json' with { type: 'json' }

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const arxivPaperBytes = readFileSync(join(campaignDir, 'papers/1706.03762.pdf'))

function loadT2Mission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
  )
}

async function t2DocumentSource(mission: ReturnType<typeof loadT2Mission>): Promise<SourceRecord> {
  const search = createMissionSelectedDocumentSearchProvider()
  const result = await search.search(
    {
      operationId: 'prod-factory-doc-search',
      query: '1706.03762',
      sourceClasses: ['document'],
      signal: new AbortController().signal,
    },
    mission,
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') throw new Error('search failed')
  return result.hits[0]!.source
}

describe('createProductionGovernedSourceAccessForMission (CLI factory)', () => {
  it('default host budget rejects complete T-L2 paper acquisition (truncated, not admitted)', async () => {
    const mission = loadT2Mission()
    const source = await t2DocumentSource(mission)
    let observedMaxWire: number | undefined
    const access = createProductionGovernedSourceAccessForMission({
      mission,
      env: {},
      admittedGet: async ({ maxWireBytes, maxDecodedBytes }) => {
        observedMaxWire = maxWireBytes
        assert.equal(maxWireBytes, DEFAULT_MAX_ADMITTED_BYTES)
        assert.equal(maxDecodedBytes, DEFAULT_MAX_ADMITTED_BYTES)
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: arxivPaperBytes.subarray(0, DEFAULT_MAX_ADMITTED_BYTES),
          bytesReceived: DEFAULT_MAX_ADMITTED_BYTES,
          truncated: true,
          requestedUrl: arxivManifest.canonical_url,
          finalUrl: arxivManifest.canonical_url,
          redirectChain: [arxivManifest.canonical_url],
          transportCoding: null,
        }
      },
    })

    const result = await access.fetchContent({
      operationId: 'default-bounded-doc',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.failureCategory, 'truncated')
    assert.match(result.message, /complete body/i)
    assert.equal(observedMaxWire, DEFAULT_MAX_ADMITTED_BYTES)
  })

  it('explicit document host env admits full pinned paper bytes (acquisition complete)', async () => {
    const mission = loadT2Mission()
    const source = await t2DocumentSource(mission)
    const policy = mission.source_policy.admitted_document_sources![0]!
    let observedMaxWire: number | undefined
    let observedMaxDecoded: number | undefined
    const access = createProductionGovernedSourceAccessForMission({
      mission,
      env: {
        BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: String(policy.wire_byte_budget),
        BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: String(
          policy.decompressed_byte_budget,
        ),
      },
      admittedGet: async ({ maxWireBytes, maxDecodedBytes }) => {
        observedMaxWire = maxWireBytes
        observedMaxDecoded = maxDecodedBytes
        assert.equal(maxWireBytes, policy.wire_byte_budget)
        assert.equal(maxDecodedBytes, policy.decompressed_byte_budget)
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: arxivPaperBytes,
          bytesReceived: arxivPaperBytes.length,
          truncated: false,
          requestedUrl: arxivManifest.canonical_url,
          finalUrl: arxivManifest.canonical_url,
          redirectChain: [arxivManifest.canonical_url],
          transportCoding: null,
        }
      },
    })

    const result = await access.fetchContent({
      operationId: 'configured-complete-doc',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.admitted.revision.byte_length_received, policy.expected_byte_length)
    assert.equal(result.admitted.revision.completeness, 'complete')
    assert.equal(result.admitted.revision.content_hash, policy.expected_content_sha256)
    assert.equal(observedMaxWire, policy.wire_byte_budget)
    assert.equal(observedMaxDecoded, policy.decompressed_byte_budget)
  })

  it('raised document host does not raise general web host ceiling', async () => {
    const t2 = loadT2Mission()
    const mission = ResearchMissionV2Schema.parse({
      ...t2,
      source_policy: {
        ...t2.source_policy,
        allowed_source_classes: ['web', 'document', 'repository_file', 'structured'],
      },
    })
    const webUrl = 'https://arxiv.org/abs/1706.03762'
    const webSource: SourceRecord = {
      source_id: 'web-cap-check',
      kind: 'web',
      canonical_key: webUrl,
      observed_urls: [webUrl],
    }
    let webMaxWire: number | undefined
    const access = createProductionGovernedSourceAccessForMission({
      mission,
      env: {
        BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_WIRE_BYTES: '2300000',
        BABEL_RESEARCH_ADMITTED_DOCUMENT_HOST_DECOMPRESSED_BYTES: '2300000',
      },
      admittedGet: async ({ maxWireBytes }) => {
        webMaxWire = maxWireBytes
        return {
          ok: true,
          status: 200,
          contentType: 'text/html',
          buffer: Buffer.alloc(50),
          bytesReceived: 50,
          truncated: false,
          requestedUrl: webUrl,
          finalUrl: webUrl,
          redirectChain: [webUrl],
          transportCoding: null,
        }
      },
    })

    await access.fetchContent({
      operationId: 'web-only-cap',
      source: webSource,
      signal: new AbortController().signal,
    })
    assert.equal(webMaxWire, DEFAULT_MAX_ADMITTED_BYTES)
  })
})
