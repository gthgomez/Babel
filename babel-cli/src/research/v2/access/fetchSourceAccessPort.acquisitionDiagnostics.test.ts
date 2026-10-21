import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import { ExternalOperationCompletionSchema } from '../contracts/operations.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort acquisition diagnostics on failure', () => {
  it('records attempted_source HTTP metadata on failed status without admitting bytes', async () => {
    const url = 'https://www.python.org/downloads/'
    const port = new FetchSourceAccessPort({
      dispatchGet: async () => ({
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
        },
        body: { buffer: Buffer.alloc(0), bytesReceived: 0, truncated: false },
      }),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-404',
      kind: 'web',
      title: 'missing',
      observed_urls: [url],
      canonical_key: 'web:python.org/downloads',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-404',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.acquisition_diagnostics?.evidence_role, 'attempted_source')
      assert.equal(result.acquisition_diagnostics?.attempted_url, url)
      assert.equal(result.acquisition_diagnostics?.http_status, 404)
      assert.equal(result.acquisition_diagnostics?.content_type, 'text/html; charset=utf-8')
      assert.equal(result.acquisition_diagnostics?.content_encoding, 'gzip')
    }
  })

  it('accepts acquisition_diagnostics on external_operation_completion contract', () => {
    const completion = ExternalOperationCompletionSchema.parse({
      mission_id: 'mission-1',
      operation_id: 'fetch-op',
      attempt_id: 'fetch-att',
      completed_at: '2026-10-21T07:35:00.000Z',
      settlement: 'failed',
      failure_category: 'network_error',
      message: 'HTTP 500',
      acquisition_diagnostics: {
        evidence_role: 'attempted_source',
        attempted_url: 'https://example.test/page',
        http_status: 500,
        content_type: 'text/plain',
      },
    })
    assert.equal(completion.acquisition_diagnostics?.evidence_role, 'attempted_source')
  })
})
