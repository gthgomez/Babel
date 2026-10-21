import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { GeneralDocumentAdapter } from '../adapters/documents/generalDocumentAdapter.js'
import { PassageRecordSchema } from '../contracts/passages.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { SourceRecord } from '../contracts/sources.js'
import { createGovernedSourceAccessPort } from './governedSourceAccessPort.js'
import { DEFAULT_MAX_ADMITTED_BYTES, FetchSourceAccessPort } from './fetchSourceAccessPort.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'
import {
  intersectDocumentFetchByteBudgets,
  resolveMissionDocumentPolicyForFetchUrl,
} from './missionDocumentAcquisitionPolicy.js'
import paperManifest from '../fixtures/campaign/papers/1706.03762.manifest.json' with { type: 'json' }

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const paperBytes = readFileSync(join(campaignDir, 'papers/1706.03762.pdf'))

function loadT2Mission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
  )
}

function missionWithAdmissionBudgets(
  base: ReturnType<typeof loadT2Mission>,
  wire: number,
  decompressed: number,
) {
  const sources = base.source_policy.admitted_document_sources ?? []
  return {
    ...base,
    source_policy: {
      ...base.source_policy,
      admitted_document_sources: sources.map((entry) => ({
        ...entry,
        wire_byte_budget: wire,
        decompressed_byte_budget: decompressed,
      })),
    },
  }
}

async function paperSource(mission: ReturnType<typeof loadT2Mission>) {
  const search = createMissionSelectedDocumentSearchProvider()
  const result = await search.search(
    {
      operationId: 'paper-search',
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

describe('mission document acquisition policy', () => {
  it('intersects host ceiling with mission budgets (lower host wins)', () => {
    const mission = loadT2Mission()
    const source = {
      source_id: 'x',
      kind: 'document' as const,
      canonical_key: paperManifest.canonical_url,
      observed_urls: [paperManifest.canonical_url],
    }
    const policy = resolveMissionDocumentPolicyForFetchUrl(
      source,
      mission,
      paperManifest.canonical_url,
    )
    assert.ok(policy)
    const budgets = intersectDocumentFetchByteBudgets(policy, 100_000, 100_000)
    assert.equal(budgets.maxWireBytes, 100_000)
    assert.equal(budgets.maxDecodedBytes, 100_000)
  })

  it('applies independent wire vs decompressed ceilings (unequal mission budgets)', () => {
    const mission = missionWithAdmissionBudgets(loadT2Mission(), 80_000, 5_000_000)
    const source = {
      source_id: 'x',
      kind: 'document' as const,
      canonical_key: paperManifest.canonical_url,
      observed_urls: [paperManifest.canonical_url],
    }
    const policy = resolveMissionDocumentPolicyForFetchUrl(
      source,
      mission,
      paperManifest.canonical_url,
    )
    assert.ok(policy)
    const budgets = intersectDocumentFetchByteBudgets(policy, 10_000_000, 10_000_000)
    assert.equal(budgets.maxWireBytes, 80_000)
    assert.equal(budgets.maxDecodedBytes, 5_000_000)
  })

  it('does not apply admitted policy when fetch URL is unrelated first observed_url', async () => {
    const mission = loadT2Mission()
    const arxivUrl = paperManifest.canonical_url
    const unrelated = 'https://evil.example.invalid/not-the-paper.pdf'
    const source: SourceRecord = {
      source_id: 'borrow-budget',
      kind: 'document',
      canonical_key: arxivUrl,
      observed_urls: [unrelated, arxivUrl],
    }
    let seenMaxWire: number | undefined
    const port = new FetchSourceAccessPort({
      mission,
      maxAdmittedBytes: DEFAULT_MAX_ADMITTED_BYTES,
      admittedGet: async (params) => {
        seenMaxWire = params.maxWireBytes ?? params.maxBytes
        return {
          ok: false,
          status: 404,
          contentType: 'application/octet-stream',
          buffer: Buffer.alloc(0),
          bytesReceived: 0,
          truncated: false,
          requestedUrl: params.url,
          finalUrl: params.url,
          redirectChain: [params.url],
          transportCoding: null,
        }
      },
    })
    await port.fetchContent({
      operationId: 'unrelated-first',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(seenMaxWire, DEFAULT_MAX_ADMITTED_BYTES)
    assert.equal(
      resolveMissionDocumentPolicyForFetchUrl(source, mission, unrelated),
      undefined,
    )
  })

  it('rejects forbidden redirect hop before body admission', async () => {
    const mission = loadT2Mission()
    const source = await paperSource(mission)
    const port = new FetchSourceAccessPort({
      mission,
      maxAdmittedBytes: 10_000_000,
      admittedGet: async () => {
        throw new Error('admittedGet should not run when redirect hop is denied')
      },
      dispatchGet: async (url, _target, _max, signal) => {
        if (url.href === paperManifest.canonical_url) {
          return {
            status: 302,
            headers: { location: 'https://evil.example.invalid/redirected.pdf' },
            body: { buffer: Buffer.alloc(0), bytesReceived: 0, truncated: false },
          }
        }
        throw new Error('unexpected hop')
      },
    })
    const result = await port.fetchContent({
      operationId: 'forbidden-redirect',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.match(result.message, /allowed_web_domains|redirect/i)
  })

  it('real parser extracts multi-page passages including last page (not digest-only proof)', async () => {
    const mission = loadT2Mission()
    const source = await paperSource(mission)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createMissionSelectedDocumentSearchProvider(),
      maxAdmittedBytes: 10_000_000,
      admittedGet: async ({ url, maxWireBytes, maxDecodedBytes }) => {
        assert.ok((maxWireBytes ?? 0) >= paperBytes.length)
        assert.ok((maxDecodedBytes ?? 0) >= paperBytes.length)
        return {
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: paperBytes,
          bytesReceived: paperBytes.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })
    const read = await new GeneralDocumentAdapter().read(
      { operationId: 'real-parser', source, signal: AbortSignal.timeout(120_000) },
      access,
    )
    assert.equal(read.status, 'ok')
    if (read.status !== 'ok') return
    assert.equal(read.revision.completeness, 'complete')
    assert.equal(read.revision.content_hash, paperManifest.content_sha256)
    assert.ok(read.document_pdf_extraction_coverage)
    const cov = read.document_pdf_extraction_coverage!
    assert.equal(cov.pdf_page_count, paperManifest.expected_pdf_page_count ?? 15)
    assert.equal(cov.pages_processed, cov.pdf_page_count)
    assert.equal(cov.last_page_with_passage, cov.pdf_page_count)
    assert.ok(cov.pages_with_passages > 1)
    assert.equal(cov.extraction_complete, true)
    for (const passage of read.passages) {
      PassageRecordSchema.parse(passage)
      assert.equal(passage.locator.kind, 'page')
    }
    const lastPassage = read.passages.find(
      (p) => p.locator.kind === 'page' && p.locator.start_page === cov.pdf_page_count,
    )
    assert.ok(lastPassage)
    assert.equal(lastPassage!.text_ref.mode, 'inline')
    if (lastPassage!.text_ref.mode === 'inline') {
      assert.match(lastPassage!.text_ref.text, /Law/i)
    }
  })

  it('truncated body fails closed under mutable_locator_content_digest pin', async () => {
    const mission = loadT2Mission()
    const source = await paperSource(mission)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createMissionSelectedDocumentSearchProvider(),
      admittedGet: async ({ url }) => ({
        ok: true,
        status: 200,
        contentType: 'application/pdf',
        buffer: paperBytes.subarray(0, DEFAULT_MAX_ADMITTED_BYTES),
        bytesReceived: DEFAULT_MAX_ADMITTED_BYTES,
        truncated: true,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const read = await new GeneralDocumentAdapter().read(
      { operationId: 'truncated',
        source,
        signal: new AbortController().signal },
      access,
    )
    assert.equal(read.status, 'failed')
    if (read.status !== 'failed') return
    assert.equal(read.failureCategory, 'truncated')
  })
})
