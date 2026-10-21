import assert from 'node:assert/strict'
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

function fixtureFetchPort(fixtureRelPath: string): SourceAccessPort {
  const abs = resolveQuarantinedFixturePath(devCorpusRoot, fixtureRelPath)
  const bytes = readFileSync(abs)
  return {
    async fetchContent(request: SourceFetchRequest) {
      const hash = Buffer.from(bytes).toString('base64')
      return {
        operationId: request.operationId,
        status: 'ok',
        admitted: {
          operation_id: request.operationId,
          revision: {
            revision_id: `rev-${request.source.source_id}`,
            source_id: request.source.source_id,
            content_hash: 'fixture-hash-not-checked',
            retrieved_at: '2026-10-21T00:00:00.000Z',
            completeness_status: 'complete',
          },
          media_type: 'text/plain',
          provenance: {
            requested_url: `file://fixture/${fixtureRelPath}`,
            final_url: `file://fixture/${fixtureRelPath}`,
            redirect_chain: [],
          },
          payload: {
            mode: 'inline_bytes',
            bytes_base64: Buffer.from(bytes).toString('base64'),
            byte_length: bytes.length,
            content_hash: 'fixture-hash-not-checked',
          },
        },
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
})
