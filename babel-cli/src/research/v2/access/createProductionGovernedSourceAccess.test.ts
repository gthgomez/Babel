import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import largeManifest from '../fixtures/campaign/papers/production-cli-large-synthetic.manifest.json' with { type: 'json' }
import { createProductionGovernedSourceAccessForMission } from './createProductionGovernedSourceAccess.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'
import { DEFAULT_MAX_ADMITTED_BYTES } from './fetchSourceAccessPort.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const papersDir = join(campaignDir, 'papers')

function loadLargeDocumentMission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'production-cli-large-document-mission.json'), 'utf8')),
  )
}

function readLargeSyntheticPaperBytes(): Buffer {
  return readFileSync(join(papersDir, largeManifest.artifact_path))
}

async function largeDocumentSource(
  mission: ReturnType<typeof loadLargeDocumentMission>,
): Promise<SourceRecord> {
  const search = createMissionSelectedDocumentSearchProvider()
  const result = await search.search(
    {
      operationId: 'prod-factory-doc-search',
      query: 'babel-production-cli-large-synthetic',
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
  it('default host budget rejects complete large synthetic acquisition (truncated, not admitted)', async () => {
    const mission = loadLargeDocumentMission()
    const source = await largeDocumentSource(mission)
    const paperBytes = readLargeSyntheticPaperBytes()
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
          buffer: paperBytes.subarray(0, DEFAULT_MAX_ADMITTED_BYTES),
          bytesReceived: DEFAULT_MAX_ADMITTED_BYTES,
          truncated: true,
          requestedUrl: largeManifest.canonical_url,
          finalUrl: largeManifest.canonical_url,
          redirectChain: [largeManifest.canonical_url],
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

  it('explicit document host env admits full pinned synthetic bytes (acquisition complete)', async () => {
    const mission = loadLargeDocumentMission()
    const source = await largeDocumentSource(mission)
    const policy = mission.source_policy.admitted_document_sources![0]!
    const paperBytes = readLargeSyntheticPaperBytes()
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
          buffer: paperBytes,
          bytesReceived: paperBytes.length,
          truncated: false,
          requestedUrl: largeManifest.canonical_url,
          finalUrl: largeManifest.canonical_url,
          redirectChain: [largeManifest.canonical_url],
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
    const mission = loadLargeDocumentMission()
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
