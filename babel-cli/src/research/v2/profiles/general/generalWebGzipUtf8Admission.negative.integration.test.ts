/**
 * B negative regression: gzip-compressed HTML body must not pass fatal UTF-8 admission as-is.
 * Evidence: G-L1 attempt2 selected https://www.python.org/downloads/ (see review-artifacts diagnosis).
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import type { SourceAccessPort } from '../../ports/sourceAccessPort.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { GeneralWebAdapter } from '../../adapters/web/generalWebAdapter.js'
import type { SourceRecord } from '../../contracts/sources.js'

const PYTHON_DOWNLOADS = 'https://www.python.org/downloads/'

function portReturningGzipHtml(): SourceAccessPort {
  const html = '<html><body><h1>Test</h1><p>stable</p></body></html>'
  const gzipBody = gzipSync(Buffer.from(html, 'utf8'))
  return {
    async search() {
      return { operationId: 'search', status: 'failed', failureCategory: 'search_provider_unavailable', message: 'stub' }
    },
    async fetchContent(request) {
      return {
        operationId: request.operationId,
        status: 'ok',
        admitted: buildAdmittedContent(
          request.operationId,
          request.source.source_id,
          'rev-gzip-negative',
          gzipBody,
          'text/html',
          {
            requestedUrl: PYTHON_DOWNLOADS,
            finalUrl: PYTHON_DOWNLOADS,
            redirectChain: [PYTHON_DOWNLOADS],
          },
        ),
      }
    },
  }
}

describe('general web gzip UTF-8 admission negative (G-L1 attempt2 class)', () => {
  it('read fails with admitted bytes are not valid UTF-8 when body is gzip-compressed', async () => {
    const adapter = new GeneralWebAdapter()
    const source: SourceRecord = {
      source_id: 'src-web-gzip-negative',
      kind: 'web',
      canonical_key: PYTHON_DOWNLOADS,
      observed_urls: [PYTHON_DOWNLOADS],
      title: 'Download Python',
    }
    const result = await adapter.read(
      { operationId: 'fetch-op', source, signal: new AbortController().signal },
      portReturningGzipHtml(),
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.message, 'admitted bytes are not valid UTF-8')
      assert.equal(result.failureCategory, 'extraction_failed')
    }
  })
})
