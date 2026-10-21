import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceAcquisitionDiagnosticsSchema } from '../contracts/sourceAcquisitionDiagnostics.js'
import type { AdmittedHttpGetResult } from './admittedHttpGet.js'
import { HTTP_FAILURE_FIELD_LIMITS } from './sanitizedHttpFailureFieldLimits.js'
import { parseAcquisitionDiagnosticsFromHttpGet } from './parseAcquisitionDiagnosticsFromHttpGet.js'
import {
  HTTP_FAILURE_PUBLIC_MESSAGE_QUALIFIER,
  sanitizedHttpFailureMetadataFromGet,
} from './sanitizedHttpFailureMetadata.js'

function oversizedField(char: string, length: number): string {
  return char.repeat(length) + 'tail'
}

describe('sanitizedHttpFailureMetadata field limits', () => {
  it('truncates each http_failure field to schema-specific max before parse', () => {
    const response: AdmittedHttpGetResult = {
      ok: false,
      status: 403,
      contentType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ message: oversizedField('m', HTTP_FAILURE_FIELD_LIMITS.public_message) }),
        'utf8',
      ),
      bytesReceived: 0,
      truncated: false,
      requestedUrl: 'https://api.github.com/repos/o/r/git/trees/sha',
      finalUrl: 'https://api.github.com/repos/o/r/git/trees/sha',
      redirectChain: [],
      transportCoding: null,
      responseHeaders: {
        'x-github-request-id': oversizedField('r', HTTP_FAILURE_FIELD_LIMITS.request_id),
        'retry-after': oversizedField('a', HTTP_FAILURE_FIELD_LIMITS.retry_after),
        'x-ratelimit-remaining': oversizedField('b', HTTP_FAILURE_FIELD_LIMITS.rate_limit_remaining),
        'x-ratelimit-reset': oversizedField('c', HTTP_FAILURE_FIELD_LIMITS.rate_limit_reset),
        'x-ratelimit-resource': oversizedField('d', HTTP_FAILURE_FIELD_LIMITS.rate_limit_resource),
      },
    }
    const metadata = sanitizedHttpFailureMetadataFromGet(response)
    assert.ok(metadata)
    assert.equal(metadata!.public_message!.length, HTTP_FAILURE_FIELD_LIMITS.public_message)
    assert.equal(metadata!.request_id!.length, HTTP_FAILURE_FIELD_LIMITS.request_id)
    assert.equal(metadata!.retry_after!.length, HTTP_FAILURE_FIELD_LIMITS.retry_after)
    assert.equal(metadata!.rate_limit_remaining!.length, HTTP_FAILURE_FIELD_LIMITS.rate_limit_remaining)
    assert.equal(metadata!.rate_limit_reset!.length, HTTP_FAILURE_FIELD_LIMITS.rate_limit_reset)
    assert.equal(metadata!.rate_limit_resource!.length, HTTP_FAILURE_FIELD_LIMITS.rate_limit_resource)
    assert.equal(metadata!.public_message_qualifier, HTTP_FAILURE_PUBLIC_MESSAGE_QUALIFIER)

    const diagnostics = SourceAcquisitionDiagnosticsSchema.parse({
      evidence_role: 'attempted_source',
      attempted_url: 'https://api.github.com/repos/o/r/git/trees/sha',
      http_status: 403,
      http_failure: metadata,
    })
    assert.equal(diagnostics.http_failure?.public_message?.length, HTTP_FAILURE_FIELD_LIMITS.public_message)
  })

  it('preserves http_status when http_failure fails schema validation', () => {
    const response: AdmittedHttpGetResult = {
      ok: false,
      status: 418,
      contentType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ message: 'teapot' }), 'utf8'),
      bytesReceived: 0,
      truncated: false,
      requestedUrl: 'https://api.github.com/repos/o/r/git/trees/sha',
      finalUrl: 'https://api.github.com/repos/o/r/git/trees/sha',
      redirectChain: [],
      transportCoding: null,
      responseHeaders: {
        'x-github-request-id': 'x'.repeat(200),
      },
    }
    const limits = HTTP_FAILURE_FIELD_LIMITS as { request_id: number }
    const schemaMax = 128
    const previous = limits.request_id
    limits.request_id = 200
    try {
      const diagnostics = parseAcquisitionDiagnosticsFromHttpGet(response, {
        attemptedUrl: response.requestedUrl,
      })
      assert.equal(diagnostics.http_status, 418)
      assert.equal(diagnostics.http_failure, undefined)
      assert.equal(diagnostics.attempted_url, response.requestedUrl)
      const rejected = SourceAcquisitionDiagnosticsSchema.safeParse({
        ...diagnostics,
        http_failure: { request_id: 'x'.repeat(schemaMax + 1) },
      })
      assert.equal(rejected.success, false)
    } finally {
      limits.request_id = previous
    }
  })
})
