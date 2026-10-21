import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../documents/testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from '../documents/quarantinePath.js'
import { GeneralWebAdapter, GENERAL_WEB_ADAPTER_ID } from './generalWebAdapter.js'
import { STATIC_HTML_EXTRACTION_VERSION } from './htmlFromAdmittedBytes.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

function stubPort(fetchContent: SourceAccessPort['fetchContent']): SourceAccessPort {
  return {
    async search(request: SourceSearchRequest) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'search_provider_unavailable',
        message: 'test stub',
      }
    },
    fetchContent,
  }
}

function webSource(id: string): SourceRecord {
  return {
    source_id: id,
    kind: 'web',
    canonical_key: `fixture:web:${id}`,
    observed_urls: ['https://example.invalid/plan-a'],
  }
}

test('GeneralWebAdapter.read: static HTML via port (G-DEV-01 plan-a)', async () => {
  const rel = 'G-DEV-01/sources/plan-a.html'
  const bytes = readFileSync(resolveQuarantinedFixturePath(devCorpusRoot, rel))
  const port = stubPort(async (request: SourceFetchRequest) => ({
    operationId: request.operationId,
    status: 'ok',
    admitted: buildAdmittedContent(
      request.operationId,
      request.source.source_id,
      'rev-web',
      bytes,
      'text/html',
      {
        requestedUrl: 'https://example.invalid/plan-a',
        finalUrl: 'https://example.invalid/plan-a',
        redirectChain: ['https://example.invalid/plan-a'],
      },
    ),
  }))
  const result = await new GeneralWebAdapter().read(
    { operationId: 'op-web', source: webSource('src'), signal: AbortSignal.timeout(5_000) },
    port,
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.extraction_version, STATIC_HTML_EXTRACTION_VERSION)
  assert.ok(result.passages.length >= 1)
})

test('GeneralWebAdapter: adapter id and kinds', () => {
  const a = new GeneralWebAdapter()
  assert.equal(a.adapterId, GENERAL_WEB_ADAPTER_ID)
  assert.deepEqual(a.supportedKinds, ['web'])
})
