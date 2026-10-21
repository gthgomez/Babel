import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { SourceAccessPort, SourceFetchRequest, SourceRecord } from '../frozenPorts0ccd1733.js'
import { GeneralDocumentAdapter } from './generalDocumentAdapter.js'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../profiles/general/fixtures/dev-corpus',
)

function admittedPayload(bytes: Buffer, operationId: string, sourceId: string) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    operation_id: operationId,
    revision: {
      revision_id: `rev-${sourceId}`,
      source_id: sourceId,
      content_hash: hash,
      retrieved_at: '2026-10-21T00:00:00.000Z',
      completeness_status: 'complete' as const,
    },
    media_type: 'text/plain',
    provenance: {
      requested_url: 'file://fixture/local',
      final_url: 'file://fixture/local',
      redirect_chain: [] as string[],
    },
    payload: {
      mode: 'inline_bytes' as const,
      bytes_base64: bytes.toString('base64'),
      byte_length: bytes.length,
      content_hash: hash,
    },
  }
}

function fixtureFetchPort(fixtureRelPath: string): SourceAccessPort {
  const abs = resolveQuarantinedFixturePath(devCorpusRoot, fixtureRelPath)
  const bytes = readFileSync(abs)
  return {
    async fetchContent(request: SourceFetchRequest) {
      return {
        operationId: request.operationId,
        status: 'ok',
        admitted: admittedPayload(bytes, request.operationId, request.source.source_id),
      }
    },
  }
}

test('GeneralDocumentAdapter.read: admitted plain text via port only (G-DEV-03)', async () => {
  const source: SourceRecord = {
    source_id: 'src-policy',
    kind: 'document',
    canonical_key: 'fixture:G-DEV-03:official-policy',
    observed_urls: [],
  }
  const adapter = new GeneralDocumentAdapter()
  const result = await adapter.read(
    { operationId: 'op-1', source, signal: AbortSignal.timeout(5_000) },
    fixtureFetchPort('G-DEV-03/sources/official-policy.txt'),
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.ok(result.passages.length >= 1)
  assert.equal(result.extraction_version, 'general-plain-text/0.1.0')
  assert.equal(result.passages[0]?.source_id, 'src-policy')
})

test('GeneralDocumentAdapter.read: propagates port cancelled', async () => {
  const port: SourceAccessPort = {
    async fetchContent(request) {
      return { operationId: request.operationId, status: 'cancelled' }
    },
  }
  const source: SourceRecord = {
    source_id: 's',
    kind: 'document',
    canonical_key: 'k',
    observed_urls: [],
  }
  const adapter = new GeneralDocumentAdapter()
  const result = await adapter.read(
    { operationId: 'op-cancel', source, signal: AbortSignal.abort() },
    port,
  )
  assert.equal(result.status, 'cancelled')
})

test('GeneralDocumentAdapter.read: propagates port failed', async () => {
  const port: SourceAccessPort = {
    async fetchContent(request) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'policy_blocked',
        message: 'blocked',
      }
    },
  }
  const source: SourceRecord = {
    source_id: 's',
    kind: 'document',
    canonical_key: 'k',
    observed_urls: [],
  }
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-fail', source, signal: AbortSignal.timeout(1_000) },
    port,
  )
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.failureCategory, 'policy_blocked')
})

test('GeneralDocumentAdapter.read: extraction_failed on hash mismatch admitted bytes', async () => {
  const bytes = Buffer.from('line\n', 'utf8')
  const port: SourceAccessPort = {
    async fetchContent(request) {
      const admitted = admittedPayload(bytes, request.operationId, request.source.source_id)
      admitted.payload.content_hash = '0'.repeat(64)
      return { operationId: request.operationId, status: 'ok', admitted }
    },
  }
  const source: SourceRecord = {
    source_id: 's',
    kind: 'document',
    canonical_key: 'k',
    observed_urls: [],
  }
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-bad-hash', source, signal: AbortSignal.timeout(1_000) },
    port,
  )
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(result.failureCategory, 'extraction_failed')
    assert.match(result.message, /content_hash/)
  }
})
