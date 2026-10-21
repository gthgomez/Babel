import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'
import largeManifest from '../fixtures/campaign/papers/production-cli-large-synthetic.manifest.json' with { type: 'json' }

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

function loadLargeDocumentMission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'production-cli-large-document-mission.json'), 'utf8')),
  )
}

async function largeDocumentSource(mission: ReturnType<typeof loadLargeDocumentMission>) {
  const search = createMissionSelectedDocumentSearchProvider()
  const result = await search.search(
    {
      operationId: 'ceiling-doc-search',
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

describe('fetchSourceAccessPort document host ceilings', () => {
  it('explicit lower maxAdmittedBytes wins over higher document wire allowance', async () => {
    const mission = loadLargeDocumentMission()
    const source = await largeDocumentSource(mission)
    let observedWire: number | undefined
    const port = new FetchSourceAccessPort({
      mission,
      maxAdmittedBytes: 50_000,
      maxDocumentWireBytes: 2_300_000,
      maxDocumentDecompressedBytes: 2_300_000,
      admittedGet: async ({ maxWireBytes }) => {
        observedWire = maxWireBytes
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: Buffer.alloc(1),
          bytesReceived: 1,
          truncated: true,
          requestedUrl: largeManifest.canonical_url,
          finalUrl: largeManifest.canonical_url,
          redirectChain: [largeManifest.canonical_url],
          transportCoding: null,
        }
      },
    })
    await port.fetchContent({
      operationId: 'lower-wire',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(observedWire, 50_000)
  })

  it('explicit lower maxDecompressedBytes wins over higher document decompressed allowance', async () => {
    const mission = loadLargeDocumentMission()
    const source = await largeDocumentSource(mission)
    let observedDecoded: number | undefined
    const port = new FetchSourceAccessPort({
      mission,
      maxAdmittedBytes: 2_300_000,
      maxDecompressedBytes: 80_000,
      maxDocumentWireBytes: 2_300_000,
      maxDocumentDecompressedBytes: 2_300_000,
      admittedGet: async ({ maxDecodedBytes }) => {
        observedDecoded = maxDecodedBytes
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: Buffer.alloc(1),
          bytesReceived: 1,
          truncated: true,
          requestedUrl: largeManifest.canonical_url,
          finalUrl: largeManifest.canonical_url,
          redirectChain: [largeManifest.canonical_url],
          transportCoding: null,
        }
      },
    })
    await port.fetchContent({
      operationId: 'lower-decoded',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(observedDecoded, 80_000)
  })
})
