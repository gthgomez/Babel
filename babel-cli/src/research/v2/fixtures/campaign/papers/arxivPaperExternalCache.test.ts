import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GeneralDocumentAdapter } from '../../../adapters/documents/generalDocumentAdapter.js'
import { ResearchMissionV2Schema } from '../../../contracts/mission.js'
import { createGovernedSourceAccessPort } from '../../../access/governedSourceAccessPort.js'
import { createMissionSelectedDocumentSearchProvider } from '../../../access/missionSelectedDocumentSearchProvider.js'
import arxivManifest from './1706.03762.manifest.json' with { type: 'json' }
import {
  readBoundedRegularFileAtPath,
  resolveArxiv170603762PaperBytesFromExternalCache,
  resolveManifestedPaperBytesFromExternalCache,
} from './arxivPaperExternalCache.js'
import { readFileSync } from 'node:fs'
import { dirname, join as pathJoin } from 'node:path'
import { fileURLToPath } from 'node:url'

const campaignDir = pathJoin(dirname(fileURLToPath(import.meta.url)), '..')

const tinyManifest = {
  artifact_path: 'tiny-fixture.pdf',
  content_sha256: createHash('sha256').update('hello-paper').digest('hex'),
  byte_length: 11,
}

function withTempCacheDir(run: (cacheRoot: string) => void): void {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'babel-arxiv-cache-'))
  try {
    run(cacheRoot)
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
}

describe('arxiv external paper cache (isolated temp dirs)', () => {
  it('reports missing cache without reading user home cache', () => {
    withTempCacheDir((cacheRoot) => {
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'missing')
      if (resolved.status !== 'missing') return
      assert.match(resolved.expectedPath, /tiny-fixture\.pdf$/)
      assert.equal(resolved.manifestByteLength, tinyManifest.byte_length)
    })
  })

  it('rejects wrong-size cache before digest work', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'short')
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'size_mismatch')
      if (resolved.status !== 'size_mismatch') return
      assert.equal(resolved.actualByteLength, 5)
    })
  })

  it('rejects oversized cache when file grew beyond manifest byte_length', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'x'.repeat(tinyManifest.byte_length + 1))
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'size_mismatch')
      if (resolved.status !== 'size_mismatch') return
      assert.match(resolved.message, /exceeds manifest/)
    })
  })

  it('reports digest_mismatch when size matches but hash differs', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'x'.repeat(tinyManifest.byte_length))
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'digest_mismatch')
    })
  })

  it('returns ok bytes for matching size and digest', () => {
    withTempCacheDir((cacheRoot) => {
      const path = join(cacheRoot, tinyManifest.artifact_path)
      writeFileSync(path, 'hello-paper')
      const resolved = resolveManifestedPaperBytesFromExternalCache(tinyManifest, { cacheRoot })
      assert.equal(resolved.status, 'ok')
      if (resolved.status !== 'ok') return
      assert.equal(resolved.bytes.toString('utf8'), 'hello-paper')
    })
  })

  it('readBoundedRegularFileAtPath rejects non-regular files', () => {
    withTempCacheDir((cacheRoot) => {
      const dirPath = join(cacheRoot, 'not-a-file')
      mkdirSync(dirPath)
      const read = readBoundedRegularFileAtPath(dirPath, 10)
      assert.equal(read.ok, false)
      if (read.ok) return
      assert.equal(read.status, 'not_regular_file')
    })
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
          : resolved.status === 'size_mismatch'
            ? `size mismatch at ${resolved.resolvedPath}: ${resolved.message}`
            : resolved.status === 'digest_mismatch'
              ? `digest mismatch at ${resolved.resolvedPath}`
              : resolved.status === 'read_failed'
                ? `read failed at ${resolved.resolvedPath}: ${resolved.message}`
                : `cache resolve failed: ${resolved.status}`,
      )
      if (resolved.status !== 'ok') return
      const mission = ResearchMissionV2Schema.parse(
        JSON.parse(readFileSync(pathJoin(campaignDir, 'T-L2-mission.json'), 'utf8')),
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
