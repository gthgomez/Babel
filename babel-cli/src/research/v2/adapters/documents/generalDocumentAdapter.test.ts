import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceSearchRequest,
} from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { GeneralDocumentAdapter } from './generalDocumentAdapter.js'
import { PLAIN_TEXT_EXTRACTION_VERSION } from './plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from './testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

function stubAccessPort(
  fetchContent: SourceAccessPort['fetchContent'],
): SourceAccessPort {
  return {
    async search(request: SourceSearchRequest) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'search_provider_unavailable',
        message: 'test stub search',
      }
    },
    fetchContent,
  }
}

function sampleSource(sourceId: string): SourceRecord {
  return {
    source_id: sourceId,
    kind: 'document',
    canonical_key: `fixture:${sourceId}`,
    observed_urls: ['https://example.invalid/source'],
  }
}

function fixtureFetchPort(fixtureRelPath: string, overrides?: {
  operationId?: string
  sourceId?: string
}): SourceAccessPort {
  const abs = resolveQuarantinedFixturePath(devCorpusRoot, fixtureRelPath)
  const bytes = readFileSync(abs)
  return stubAccessPort(async (request: SourceFetchRequest) => {
    const op = overrides?.operationId ?? request.operationId
    const sid = overrides?.sourceId ?? request.source.source_id
    return {
      operationId: op,
      status: 'ok',
      admitted: buildAdmittedContent(op, sid, `rev-${sid}`, bytes, 'text/plain'),
    }
  })
}

test('GeneralDocumentAdapter.read: admitted plain text via port only (G-DEV-03)', async () => {
  const source = sampleSource('src-policy')
  const adapter = new GeneralDocumentAdapter()
  const result = await adapter.read(
    { operationId: 'op-1', source, signal: AbortSignal.timeout(5_000) },
    fixtureFetchPort('G-DEV-03/sources/official-policy.txt'),
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.ok(result.passages.length >= 1)
  assert.equal(result.extraction_version, PLAIN_TEXT_EXTRACTION_VERSION)
  assert.equal(result.revision.source_id, 'src-policy')
})

test('GeneralDocumentAdapter.read: propagates port cancelled', async () => {
  const port = stubAccessPort(async (request) => {
    return { operationId: request.operationId, status: 'cancelled' }
  })
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-cancel', source: sampleSource('s'), signal: AbortSignal.abort() },
    port,
  )
  assert.equal(result.status, 'cancelled')
})

test('GeneralDocumentAdapter.read: pre-await abort returns cancelled', async () => {
  const port = stubAccessPort(async () => {
    throw new Error('fetch should not run when already aborted')
  })
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-pre', source: sampleSource('s'), signal: AbortSignal.abort() },
    port,
  )
  assert.equal(result.status, 'cancelled')
})

test('GeneralDocumentAdapter.read: post-await abort returns cancelled', async () => {
  const port = stubAccessPort(async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const bytes = Buffer.from('late\n', 'utf8')
    return {
      operationId: request.operationId,
      status: 'ok',
      admitted: buildAdmittedContent(
        request.operationId,
        request.source.source_id,
        'rev-late',
        bytes,
        'text/plain',
      ),
    }
  })
  const controller = new AbortController()
  const readPromise = new GeneralDocumentAdapter().read(
    { operationId: 'op-post', source: sampleSource('s'), signal: controller.signal },
    port,
  )
  controller.abort()
  const result = await readPromise
  assert.equal(result.status, 'cancelled')
})

test('GeneralDocumentAdapter.read: fails on port operationId mismatch', async () => {
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-outer', source: sampleSource('s'), signal: AbortSignal.timeout(1_000) },
    fixtureFetchPort('G-DEV-03/sources/official-policy.txt', { operationId: 'op-inner' }),
  )
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.match(result.message, /operationId/)
})

test('GeneralDocumentAdapter.read: fails on admitted source_id mismatch', async () => {
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-bind', source: sampleSource('requested-src'), signal: AbortSignal.timeout(1_000) },
    fixtureFetchPort('G-DEV-03/sources/official-policy.txt', { sourceId: 'other-src' }),
  )
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.match(result.message, /source_id/)
})

test('GeneralDocumentAdapter.read: extraction_failed on hash mismatch', async () => {
  const bytes = Buffer.from('line\n', 'utf8')
  const port = stubAccessPort(async (request) => {
    const admitted = buildAdmittedContent(
      request.operationId,
      request.source.source_id,
      'rev-x',
      bytes,
      'text/plain',
      { corruptPayloadHash: true },
    )
    return { operationId: request.operationId, status: 'ok', admitted }
  })
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-bad-hash', source: sampleSource('s'), signal: AbortSignal.timeout(1_000) },
    port,
  )
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.match(result.message, /content_hash/)
})

test('GeneralDocumentAdapter.discover: not_supported without network', async () => {
  const port = stubAccessPort(async () => ({ operationId: 'x', status: 'cancelled' }))
  const result = await new GeneralDocumentAdapter().discover(
    { operationId: 'disc-1', query: 'q', signal: AbortSignal.timeout(1_000) },
    port,
  )
  assert.equal(result.status, 'failed')
})
