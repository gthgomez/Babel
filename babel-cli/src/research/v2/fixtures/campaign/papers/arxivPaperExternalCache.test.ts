import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GeneralDocumentAdapter } from '../../../adapters/documents/generalDocumentAdapter.js'
import { ResearchMissionV2Schema } from '../../../contracts/mission.js'
import { createGovernedSourceAccessPort } from '../../../access/governedSourceAccessPort.js'
import { createMissionSelectedDocumentSearchProvider } from '../../../access/missionSelectedDocumentSearchProvider.js'
import arxivManifest from './1706.03762.manifest.json' with { type: 'json' }
import { resolveArxiv170603762PaperBytesFromExternalCache } from './arxivPaperExternalCache.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('arxiv 1706.03762 external paper cache', () => {
  it('reports missing cache without fabricating bytes', () => {
    const resolved = resolveArxiv170603762PaperBytesFromExternalCache()
    if (resolved.status === 'ok') {
      assert.equal(resolved.contentSha256, arxivManifest.content_sha256)
      return
    }
    assert.equal(resolved.status, 'missing')
    assert.match(resolved.expectedPath, /1706\.03762\.pdf$/)
    assert.equal(resolved.manifestSha256, arxivManifest.content_sha256)
  })
})

if (process.env.BABEL_RESEARCH_V2_VERIFY_ARXIV_PAPER_CACHE === '1') {
  describe('arxiv 1706.03762 external paper cache (opt-in verification)', () => {
    it('parses verified external-cache bytes with real pdfjs (not tracked in Git)', async () => {
      const resolved = resolveArxiv170603762PaperBytesFromExternalCache()
      assert.equal(
        resolved.status,
        'ok',
        resolved.status === 'missing'
          ? `external cache missing at ${resolved.expectedPath}`
          : `digest mismatch at ${resolved.resolvedPath}`,
      )
      if (resolved.status !== 'ok') return
      const mission = ResearchMissionV2Schema.parse(
        JSON.parse(readFileSync(join(campaignDir, 'T-L2-mission.json'), 'utf8')),
      )
      const search = createMissionSelectedDocumentSearchProvider()
      const searchResult = await search.search(
        {
          operationId: 'arxiv-cache-search',
          query: '1706.03762',
          sourceClasses: ['document'],
          signal: new AbortController().signal,
        },
        mission,
      )
      assert.equal(searchResult.status, 'ok')
      if (searchResult.status !== 'ok') return
      const source = searchResult.hits[0]!.source
      const access = createGovernedSourceAccessPort({
        mission,
        searchProvider: search,
        maxAdmittedBytes: 10_000_000,
        admittedGet: async ({ url }) => ({
          ok: true,
          status: 200,
          contentType: 'application/pdf',
          buffer: resolved.bytes,
          bytesReceived: resolved.bytes.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }),
      })
      const read = await new GeneralDocumentAdapter().read(
        { operationId: 'arxiv-cache-parser', source, signal: AbortSignal.timeout(120_000) },
        access,
      )
      assert.equal(read.status, 'ok')
      if (read.status !== 'ok') return
      assert.equal(read.revision.content_hash, arxivManifest.content_sha256)
      const lastPage = arxivManifest.expected_pdf_page_count ?? 15
      const lastPassage = read.passages.find(
        (p) => p.locator.kind === 'page' && p.locator.start_page === lastPage,
      )
      assert.ok(lastPassage)
      if (lastPassage!.text_ref.mode === 'inline') {
        assert.match(lastPassage!.text_ref.text, /Law/i)
      }
    })
  })
}
